import {randomUUID} from 'node:crypto';
import {checkedText, digest} from './scope.mjs';
import {canonical, fingerprint, shape} from './validation.mjs';
import {assertAuthority, contextOf, entryState, write} from './store-internals.mjs';

/**
 * Consolidation input manifest for the memory_only rollout (MC-API-01/02 partial).
 *
 * This module builds a bounded, pinned manifest from 2..16 active memories of one concrete
 * scope. It creates no model call, no queue and no candidate: the future enqueue/publish layers
 * use this contract. Excerpts are deliberately rejected until their permission/expiry layer is
 * wired; no host transcript is scanned and no absolute path enters the model input.
 */
const BUILD_VERIFICATION = 'unknown';
const DEFAULT_MAX_MEMORIES = 16;
const DEFAULT_MAX_INPUT_CHARS = 8000;
const DEFAULT_BATCH_TTL_HOURS = 24;

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function textOf(value, label, limit = 2048) {
  return checkedText(value, label, limit);
}
function sourceIdentity(value) {
  shape(value, ['sourceRef', 'sourceVersion', 'fragmentRef'], 'consolidation root source');
  return Object.freeze({
    sourceRef: textOf(value.sourceRef, 'source reference'),
    sourceVersion: textOf(value.sourceVersion, 'source version', 512),
    fragmentRef: textOf(value.fragmentRef, 'fragment reference', 512),
  });
}
function routeOf(value) {
  shape(value, ['routeRef', 'provider', 'model', 'routeVersion'], 'consolidation route');
  return Object.freeze({
    routeRef: textOf(value.routeRef, 'route reference', 512),
    provider: textOf(value.provider, 'provider', 512),
    model: textOf(value.model, 'model', 512),
    routeVersion: textOf(value.routeVersion, 'route version', 512),
  });
}

export function createConsolidationInputs(store, {
  registry,
  now = () => new Date(),
  maxMemories = DEFAULT_MAX_MEMORIES,
  maxInputChars = DEFAULT_MAX_INPUT_CHARS,
  batchTtlHours = DEFAULT_BATCH_TTL_HOURS,
  configDigest = 'local-config-v1',
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.scopeRef !== 'string') throw failure('CONSOLIDATION_INPUT_UNAVAILABLE', 'memory store required');
  if (!registry || typeof registry.bindingForScope !== 'function' || typeof registry.applicabilityForProject !== 'function') throw failure('CONSOLIDATION_INPUT_UNAVAILABLE', 'trusted registry required');
  if (!Number.isSafeInteger(maxMemories) || maxMemories < 2 || maxMemories > 16) throw failure('CONSOLIDATION_INPUT_UNAVAILABLE', 'invalid memory bound');
  if (!Number.isSafeInteger(maxInputChars) || maxInputChars < 2000 || maxInputChars > 8000) throw failure('CONSOLIDATION_INPUT_UNAVAILABLE', 'invalid input bound');
  if (!Number.isSafeInteger(batchTtlHours) || batchTtlHours < 1 || batchTtlHours > 72) throw failure('CONSOLIDATION_INPUT_UNAVAILABLE', 'invalid permission TTL');
  const ctx = contextOf(store);
  function clock() {
    try {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(+date)) throw new Error('clock');
      return date;
    } catch {
      return new Date();
    }
  }
  function bindingNow() {
    const binding = registry.bindingForScope(store.scopeRef);
    if (!binding || binding.projectState !== 'active') throw failure('MC_BINDING_UNAVAILABLE', 'project binding is not active');
    const project = registry.projectForScope?.(store.scopeRef);
    if (!project || project.state !== 'active') throw failure('MC_PROJECT_RETIRED', 'project is not active');
    return {binding, project};
  }
  function policyRevision() {
    return write(ctx, () => {
      ctx.db.prepare('INSERT INTO ledger.consolidation_policy(scope_ref,revision) VALUES(?,1) ON CONFLICT(scope_ref) DO NOTHING').run(store.scopeRef);
      return ctx.db.prepare('SELECT revision FROM ledger.consolidation_policy WHERE scope_ref=?').get(store.scopeRef).revision;
    });
  }
  function rootsOf(memoryId) {
    return ctx.db.prepare('SELECT source_ref AS sourceRef,source_version AS sourceVersion,fragment_ref AS fragmentRef FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=? ORDER BY source_ref,source_version,fragment_ref')
      .all(store.scopeRef, 'memories', memoryId).map((row) => sourceIdentity({sourceRef: row.sourceRef, sourceVersion: row.sourceVersion, fragmentRef: row.fragmentRef}));
  }
  function buildManifest({jobId, permissionId, memoryIds, mode, route, baseHeadRevision}) {
    assertAuthority(ctx);
    shape({jobId, permissionId, memoryIds, mode, route, baseHeadRevision}, ['jobId', 'permissionId', 'memoryIds', 'mode', 'route', 'baseHeadRevision'], 'consolidation snapshot');
    if (mode !== 'memory_only') throw failure('MC_EXCERPTS_NOT_READY', 'excerpt permissions are not wired in this increment');
    if (!Array.isArray(memoryIds) || memoryIds.length < 2 || memoryIds.length > maxMemories) throw failure('MC_SELECTION_INVALID', `memory selection must contain 2..${maxMemories} records`);
    if (new Set(memoryIds).size !== memoryIds.length) throw failure('MC_SELECTION_INVALID', 'memory selection must not repeat');
    if (!Number.isSafeInteger(baseHeadRevision) || baseHeadRevision < 0) throw failure('MC_SELECTION_INVALID', 'invalid head revision');
    const {binding, project} = bindingNow();
    const applicability = registry.applicabilityForProject(project.projectId)?.applicability;
    if (applicability !== 'current') throw failure('MC_APPLICABILITY_UNAVAILABLE', 'project source is not currently available');
    const memories = [];
    let rootCount = 0;
    for (let index = 0; index < memoryIds.length; index += 1) {
      const id = textOf(memoryIds[index], 'memory reference', 256);
      const record = store.get(id);
      if (!record || record.state !== 'active') throw failure('MC_MEMORY_NOT_ACTIVE', `memory ${id} is not active`);
      const entry = entryState(ctx, 'memories', id);
      if (!entry || entry.state !== 'active' || entry.generation !== record.generation) throw failure('MC_MEMORY_STALE', `memory ${id} authority is not active`);
      const roots = rootsOf(id);
      if (roots.length === 0) throw failure('MC_SOURCE_UNAVAILABLE', `memory ${id} has no roots`);
      rootCount += roots.length;
      if (rootCount > 64) throw failure('MC_SOURCE_LIMIT', 'batch has more than 64 root sources');
      memories.push(Object.freeze({
        ref: `m${index}`,
        id,
        recordGeneration: record.generation,
        bodyDigest: entry.body_digest,
        kind: record.kind,
        sourceRef: record.sourceRef,
        sourceVersion: record.sourceVersion,
        fragmentRef: roots[0]?.fragmentRef ?? 'whole',
        rootSources: Object.freeze(roots),
        sourceAssurance: 'memory_only',
        verification: 'unverified',
      }));
    }
    const routeValue = routeOf(route);
    const input = Object.freeze({
      schema_version: 1,
      mode: 'memory_only',
      context: Object.freeze({
        repoId: binding.repoId,
        buildVariant: binding.buildVariant,
        buildVerification: BUILD_VERIFICATION,
        applicability,
      }),
      memories: Object.freeze(memories.map((memory) => Object.freeze({ref: memory.ref, text: store.get(memory.id).text, kind: memory.kind}))),
      excerpts: Object.freeze([]),
    });
    const inputChars = canonical(input).length;
    if (inputChars > maxInputChars) throw failure('MC_INPUT_TOO_LARGE', `input has ${inputChars} characters; limit is ${maxInputChars}`);
    const inputDigest = fingerprint(input);
    const bindingDigest = fingerprint({
      projectId: binding.projectId, projectRevision: project.revision, repoId: binding.repoId,
      scopeRef: binding.scopeRef, bindingRevision: binding.bindingRevision, revision: binding.revision, buildVariant: binding.buildVariant,
    });
    const manifest = Object.freeze({
      schemaVersion: 1,
      jobId: textOf(jobId, 'job id', 128),
      scopeRef: store.scopeRef,
      projectId: binding.projectId,
      repoId: binding.repoId,
      authorityId: ctx.authority.identity,
      epoch: store.generation(),
      scopeRevision: store.revision(),
      projectRevision: project.revision,
      bindingRevision: binding.bindingRevision,
      bindingDigest,
      applicability,
      buildVerification: BUILD_VERIFICATION,
      inputDigest,
      memories: Object.freeze(memories),
      excerpts: Object.freeze([]),
      mode: 'memory_only',
      baseHeadRevision,
      route: routeValue,
      configDigest: textOf(configDigest, 'config digest', 128),
      policyRevision: policyRevision(),
      permissionId: textOf(permissionId, 'permission id', 128),
    });
    const manifestDigest = fingerprint(manifest);
    return {
      manifest: Object.freeze({...manifest, manifestDigest}),
      input,
      inputChars,
    };
  }
  function snapshot(args) {
    try {
      return Object.freeze(buildManifest(args));
    } catch (error) {
      if (error?.code) throw error;
      throw failure('MC_SNAPSHOT_FAILED', error?.message || 'consolidation snapshot is unavailable');
    }
  }
  /** User-gesture batch permission; written in the same caller transaction in the future queue. */
  function authorizeBatch({manifest, requestId, actor = 'user'} = {}) {
    if (!manifest || typeof manifest !== 'object' || typeof manifest.manifestDigest !== 'string') throw failure('MC_MANIFEST_REQUIRED');
    if (actor !== 'user') throw failure('USER_ACTION_REQUIRED', 'only a user action may authorize a consolidation batch');
    const request = textOf(requestId, 'request id', 256);
    const expiresAt = new Date(clock().getTime() + batchTtlHours * 3600_000).toISOString();
    return write(ctx, () => {
      const policy = policyRevision();
      const permissionId = manifest.permissionId;
      const previous = ctx.db.prepare('SELECT * FROM ledger.consolidation_permissions WHERE id=? AND scope_ref=?').get(permissionId, store.scopeRef);
      if (previous) {
        if (previous.subject_id !== manifest.manifestDigest || previous.state !== 'active') throw failure('MC_PERMISSION_CONFLICT');
        return Object.freeze({permissionId, state: 'active', policyRevision: previous.policy_revision, expiresAt: previous.expires_at, requestId: request});
      }
      ctx.db.prepare(`INSERT INTO ledger.consolidation_permissions(id,scope_ref,kind,state,subject_id,subject_digest,route_digest,epoch,policy_revision,expires_at,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        permissionId, store.scopeRef, 'batch', 'active', manifest.manifestDigest, manifest.inputDigest,
        fingerprint(manifest.route), manifest.epoch, policy, expiresAt, clock().toISOString(),
      );
      return Object.freeze({permissionId, state: 'active', policyRevision: policy, expiresAt, requestId: request});
    });
  }
  function permissionCurrent(manifest) {
    assertAuthority(ctx);
    const row = ctx.db.prepare('SELECT * FROM ledger.consolidation_permissions WHERE id=? AND scope_ref=?').get(manifest.permissionId, store.scopeRef);
    if (!row || row.kind !== 'batch' || row.state !== 'active') return false;
    if (row.subject_id !== manifest.manifestDigest || row.subject_digest !== manifest.inputDigest) return false;
    if (Date.parse(row.expires_at) <= clock().getTime()) return false;
    return true;
  }
  /** Read-time recheck for enqueue/claim/dispatch/candidate/publish/read. */
  function assertCurrent(manifest, {phase = 'read'} = {}) {
    if (!manifest || manifest.manifestDigest !== fingerprint(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestDigest')))) {
      throw failure('MC_MANIFEST_TAMPERED', 'manifest digest does not match its content');
    }
    if (!permissionCurrent(manifest)) throw failure('MC_PERMISSION_EXPIRED', 'batch permission is not active');
    if (manifest.configDigest !== configDigest) throw failure('MC_CONFIG_CHANGED', 'configuration digest changed');
    const policy = ctx.db.prepare('SELECT revision FROM ledger.consolidation_policy WHERE scope_ref=?').get(store.scopeRef);
    if (!policy || policy.revision !== manifest.policyRevision) throw failure('MC_POLICY_CHANGED', 'consolidation policy revision changed');
    const {binding, project} = bindingNow();
    if (binding.projectId !== manifest.projectId || binding.repoId !== manifest.repoId || binding.scopeRef !== manifest.scopeRef || binding.bindingRevision !== manifest.bindingRevision) {
      throw failure('MC_BINDING_CHANGED', 'project binding changed');
    }
    if (project.revision !== manifest.projectRevision) throw failure('MC_BINDING_CHANGED', 'project revision changed');
    if (store.generation() !== manifest.epoch) throw failure('MC_EPOCH_CHANGED', 'store epoch changed');
    if (store.revision() !== manifest.scopeRevision) throw failure('MC_REVISION_CHANGED', 'store revision changed');
    for (const memory of manifest.memories) {
      const record = store.get(memory.id);
      if (!record || record.generation !== memory.recordGeneration) throw failure('MC_MEMORY_CHANGED', `memory ${memory.id} changed`);
      const entry = entryState(ctx, 'memories', memory.id);
      if (!entry || entry.state !== 'active' || entry.generation !== memory.recordGeneration || entry.body_digest !== memory.bodyDigest) {
        throw failure('MC_MEMORY_CHANGED', `memory ${memory.id} authority changed`);
      }
      const roots = rootsOf(memory.id);
      if (canonical(roots) !== canonical(memory.rootSources)) throw failure('MC_SOURCE_CHANGED', `memory ${memory.id} roots changed`);
    }
    return Object.freeze({ok: true, phase});
  }
  function revokePermission({permissionId, reason = 'revoked'} = {}) {
    const id = textOf(permissionId, 'permission id', 128);
    return write(ctx, () => {
      const row = ctx.db.prepare('SELECT state FROM ledger.consolidation_permissions WHERE id=? AND scope_ref=?').get(id, store.scopeRef);
      if (!row) throw failure('MC_PERMISSION_NOT_FOUND');
      if (row.state === 'revoked') return Object.freeze({permissionId: id, state: 'revoked', reason: 'already_revoked'});
      ctx.db.prepare("UPDATE ledger.consolidation_permissions SET state='revoked' WHERE id=? AND scope_ref=?").run(id, store.scopeRef);
      return Object.freeze({permissionId: id, state: 'revoked', reason: textOf(reason, 'reason', 256)});
    });
  }
  return Object.freeze({snapshot, authorizeBatch, assertCurrent, revokePermission});
}
