import {checkedText} from './scope.mjs';
import {canonical, fingerprint, integer} from './validation.mjs';
import {assertAuthority, contextOf, entryState, setEntry, write} from './store-internals.mjs';

/**
 * Candidate read and version publication (MC-API-06 / MC-API-09 partial).
 *
 * A published version is an immutable logical revision of the selected set. Publication uses a
 * compare-and-swap over the explicit expected candidate digest, epoch, scope revision and head
 * revision, copies the candidate body/sources/dependencies, and updates the local head pointer.
 * It never mutates or advances the original memory revision. No UI/search is included yet.
 */
function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function headOf(ctx, scopeRef) {
  const row = ctx.db.prepare('SELECT * FROM ledger.consolidation_head WHERE scope_ref=?').get(scopeRef);
  return row ? {revision: row.revision, versionId: row.version_id} : {revision: 0, versionId: null};
}
function dependenciesOf(ctx, scopeRef, ownerKind, ownerId) {
  return ctx.db.prepare('SELECT base_kind AS baseKind,base_id AS baseId,base_generation AS baseGeneration,base_digest AS baseDigest FROM ledger.consolidation_dependencies WHERE scope_ref=? AND owner_kind=? AND owner_id=? ORDER BY base_kind,base_id')
    .all(scopeRef, ownerKind, ownerId).map((row) => Object.freeze({...row}));
}
function requireLiveDependencies(ctx, scopeRef, dependencies) {
  for (const dependency of dependencies) {
    if (dependency.baseKind !== 'memory') throw failure('MC_DEPENDENCY_UNAVAILABLE', 'this increment only supports memory dependencies');
    const entry = entryState(ctx, 'memories', dependency.baseId);
    if (!entry || entry.state !== 'active' || entry.generation !== dependency.baseGeneration || entry.body_digest !== dependency.baseDigest) {
      throw failure('MC_DEPENDENCY_CHANGED', `dependency ${dependency.baseId} changed`);
    }
  }
}

export function createConsolidationVersions(store, {inputs, publication, now = () => new Date()} = {}) {
  if (!store || typeof store.scopeRef !== 'string') throw failure('MC_VERSION_UNAVAILABLE', 'memory store required');
  const ctx = contextOf(store);
  function clock() {
    try {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(+date)) throw new Error('clock');
      return date;
    } catch { return new Date(); }
  }
  function candidateOf(candidateId) {
    assertAuthority(ctx);
    const id = checkedText(candidateId, 'candidate id', 256);
    const entry = entryState(ctx, 'consolidation_candidates', id);
    if (!entry || entry.state !== 'active') throw failure('MC_CANDIDATE_UNAVAILABLE', 'candidate is not active');
    const body = ctx.db.prepare('SELECT * FROM consolidation_bodies WHERE id=? AND scope_ref=?').get(id, store.scopeRef);
    if (!body || body.body_kind !== 'candidate') throw failure('MC_CANDIDATE_UNAVAILABLE', 'candidate body is missing');
    const parsed = JSON.parse(body.payload);
    if (fingerprint(parsed) !== body.digest) throw failure('MC_CANDIDATE_TAMPERED', 'candidate body digest mismatch');
    return {body, digest: body.digest, parsed, entry, dependencies: dependenciesOf(ctx, store.scopeRef, 'candidate', id)};
  }
  function getCandidate(candidateId) {
    const {body, digest, parsed, dependencies} = candidateOf(candidateId);
    requireLiveDependencies(ctx, store.scopeRef, dependencies);
    return Object.freeze({
      candidateId: body.id,
      digest,
      jobId: parsed.jobId,
      manifestDigest: parsed.manifestDigest,
      groups: Object.freeze(parsed.groups ?? []),
      untouched: Object.freeze(parsed.untouched ?? []),
      coverage: parsed.coverage,
      warnings: Object.freeze(parsed.warnings ?? []),
      verification: parsed.verification,
      semanticValidation: parsed.semanticValidation,
      generator: parsed.generator,
      route: parsed.route,
      basis: Object.freeze(parsed.basis ?? []),
      excerptBasis: Object.freeze(parsed.excerptBasis ?? []),
      createdAt: parsed.createdAt,
    });
  }
  function publish({requestId, candidateId, expectedDigest, expectedEpoch, expectedScopeRevision, expectedHeadRevision, publication: callPublication} = {}) {
    assertAuthority(ctx);
    const request = checkedText(requestId, 'request id', 256);
    const id = checkedText(candidateId, 'candidate id', 256);
    const digest = checkedText(expectedDigest, 'candidate digest', 64);
    const epoch = integer(expectedEpoch, 0, Number.MAX_SAFE_INTEGER, 'expected epoch');
    const scopeRevision = integer(expectedScopeRevision, 0, Number.MAX_SAFE_INTEGER, 'expected scope revision');
    const headRevision = integer(expectedHeadRevision, 0, Number.MAX_SAFE_INTEGER, 'expected head revision');
    const operationFingerprint = fingerprint({id, digest, epoch, scopeRevision, headRevision});
    return write(ctx, () => {
      const previous = ctx.db.prepare('SELECT * FROM ledger.consolidation_operations WHERE scope_ref=? AND request_id=?').get(store.scopeRef, request);
      if (previous) {
        if (previous.fingerprint !== operationFingerprint) throw failure('OPERATION_CONFLICT', 'the same publish request has a different payload');
        return Object.freeze(JSON.parse(previous.result_json));
      }
      const candidate = candidateOf(id);
      if (candidate.digest !== digest) throw failure('MC_CANDIDATE_CHANGED', 'candidate digest does not match');
      if (store.generation() !== epoch) throw failure('MC_EPOCH_CHANGED', 'store epoch changed before publish');
      if (store.revision() !== scopeRevision) throw failure('MC_REVISION_CHANGED', 'store revision changed before publish');
      const head = headOf(ctx, store.scopeRef);
      if (head.revision !== headRevision) throw failure('MC_HEAD_CHANGED', 'consolidation head changed before publish');
      const job = ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND candidate_id=?').get(store.scopeRef, id);
      if (!job || job.state !== 'ready') throw failure('MC_JOB_NOT_READY', 'candidate has no ready job');
      if (!inputs || typeof inputs.assertCurrent !== 'function') throw failure('MC_PERMISSION_UNAVAILABLE', 'batch permission verifier is not attached');
      inputs.assertCurrent(JSON.parse(job.manifest_json), {phase: 'publish'});
      const verifier = callPublication ?? publication;
      if (!verifier || typeof verifier.authorize !== 'function') throw failure('MC_PUBLICATION_UNAVAILABLE', 'publication permission is not attached');
      const publishedPermission = verifier.authorize({candidateId: id, digest, manifestDigest: job.manifest_digest, scopeRef: store.scopeRef});
      if (!publishedPermission || typeof publishedPermission.permissionId !== 'string' || !publishedPermission.permissionId) throw failure('MC_PUBLICATION_UNAVAILABLE', 'publication permission was refused');
      requireLiveDependencies(ctx, store.scopeRef, candidate.dependencies);
      const versionId = `mc-version:${job.id}:${head.revision + 1}`;
      const candidateEntry = entryState(ctx, 'consolidation_candidates', id);
      if (!candidateEntry) throw failure('MC_CANDIDATE_UNAVAILABLE');
      const sources = ctx.db.prepare('SELECT source_ref AS sourceRef,source_version AS sourceVersion,fragment_ref AS fragmentRef FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=? ORDER BY source_ref,source_version,fragment_ref')
        .all(store.scopeRef, 'consolidation_candidates', id).map((row) => Object.freeze({...row}));
      if (sources.length === 0) throw failure('MC_SOURCE_UNAVAILABLE', 'candidate has no sources');
      const published = {
        ...candidate.parsed,
        versionId,
        versionRevision: head.revision + 1,
        publishedAt: clock().toISOString(),
        priorHeadRevision: head.revision,
      };
      const payload = canonical(published);
      const bodyDigest = fingerprint(published);
      ctx.db.prepare('INSERT INTO consolidation_bodies(id,scope_ref,body_kind,payload,digest) VALUES(?,?,?,?,?)').run(versionId, store.scopeRef, 'version', payload, bodyDigest);
      setEntry(ctx, {collection: 'consolidation_versions', id: versionId, bodyDigest, sources, generation: store.generation()});
      for (const dependency of candidate.dependencies) {
        ctx.db.prepare('INSERT OR IGNORE INTO ledger.consolidation_dependencies(scope_ref,owner_kind,owner_id,base_kind,base_id,base_generation,base_digest) VALUES(?,?,?,?,?,?,?)')
          .run(store.scopeRef, 'version', versionId, dependency.baseKind, dependency.baseId, dependency.baseGeneration, dependency.baseDigest);
      }
      ctx.db.prepare(`INSERT INTO consolidation_head(scope_ref,revision,version_id) VALUES(?,?,?)
 ON CONFLICT(scope_ref) DO UPDATE SET revision=excluded.revision,version_id=excluded.version_id`).run(store.scopeRef, head.revision + 1, versionId);
      ctx.db.prepare("UPDATE ledger.consolidation_jobs SET state='published',updated_at=?,reason=NULL WHERE scope_ref=? AND id=?").run(clock().toISOString(), store.scopeRef, job.id);
      const result = {versionId, revision: head.revision + 1, digest: bodyDigest, candidateId: id, jobId: job.id, state: 'published'};
      ctx.db.prepare('INSERT INTO ledger.consolidation_operations(scope_ref,request_id,fingerprint,result_json) VALUES(?,?,?,?)').run(store.scopeRef, request, operationFingerprint, canonical(result));
      return Object.freeze(result);
    });
  }
  function getVersion(versionId, {allowHistorical = false, actor = 'user'} = {}) {
    assertAuthority(ctx);
    const id = checkedText(versionId, 'version id', 256);
    const entry = entryState(ctx, 'consolidation_versions', id);
    if (!entry || entry.state !== 'active') throw failure('MC_VERSION_UNAVAILABLE', 'version is not active');
    const body = ctx.db.prepare('SELECT * FROM consolidation_bodies WHERE id=? AND scope_ref=?').get(id, store.scopeRef);
    if (!body || body.body_kind !== 'version') throw failure('MC_VERSION_UNAVAILABLE', 'version body is missing');
    const parsed = JSON.parse(body.payload);
    if (fingerprint(parsed) !== body.digest) throw failure('MC_VERSION_TAMPERED', 'version body digest mismatch');
    const head = headOf(ctx, store.scopeRef);
    const historical = head.versionId !== id;
    if (historical && !allowHistorical && actor !== 'user') throw failure('MC_HISTORICAL_DENIED', 'model actors cannot read historical consolidation versions');
    requireLiveDependencies(ctx, store.scopeRef, dependenciesOf(ctx, store.scopeRef, 'version', id));
    return Object.freeze({
      versionId: id,
      revision: parsed.versionRevision,
      digest: body.digest,
      historical,
      manifestDigest: parsed.manifestDigest,
      groups: Object.freeze(parsed.groups ?? []),
      untouched: Object.freeze(parsed.untouched ?? []),
      coverage: parsed.coverage,
      warnings: Object.freeze(parsed.warnings ?? []),
      verification: parsed.verification,
      semanticValidation: parsed.semanticValidation,
      generator: parsed.generator,
      route: parsed.route,
      basis: Object.freeze(parsed.basis ?? []),
      excerptBasis: Object.freeze(parsed.excerptBasis ?? []),
      publishedAt: parsed.publishedAt,
    });
  }
  function head() {
    assertAuthority(ctx);
    return Object.freeze(headOf(ctx, store.scopeRef));
  }
  return Object.freeze({getCandidate, publish, getVersion, head});
}
