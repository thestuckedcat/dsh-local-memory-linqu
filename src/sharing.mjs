import {randomUUID} from 'node:crypto';
import {checkedText} from './scope.mjs';
import {integer, shape} from './validation.mjs';

/**
 * M2 cross-project sharing (contract `MEM-M2-1` §3.2).
 *
 * Authorization boundary: this module deliberately makes NO authorization decision.
 * `grant` and `revoke` are user-only governance actions; the management/HTTP layer must
 * reject model actors (USER_ACTION_REQUIRED) before calling them. The model may call
 * `discover`, `list`, `status` and `resolve`; `resolve` only reads an existing active
 * relation and never creates, widens or restores one.
 *
 * A relation follows the source project's latest valid abstract revision automatically.
 * `resolve` records that followed revision in `share_relations.abstract_revision` (only
 * that column; `decision_basis`, `permission_ref`, `created_at`, `updated_at` and
 * `revoked_at` remain the user's audit trail) so `list().upToDate` changes from false to
 * true without asking the user to decide again. Shard records are never copied into the
 * target project; every item carries its source project, repo and applicability.
 */
const DECISION_BASIS_LIMIT = 2000;
const PERMISSION_REF_LIMIT = 512;
const QUERY_MAX = 2000;
const SEARCH_LIMIT_MAX = 100;
const SEARCH_LIMIT_DEFAULT = 5;
const RELATION_ID_LIMIT = 128;
const PROJECT_ID_LIMIT = 128;
const APPLICABILITIES = Object.freeze(['current', 'historical_unknown', 'unavailable']);

function sharingError(code, message = code) {
  const error = new Error(message);
  error.name = 'MemorySharingError';
  error.code = code;
  return error;
}
function inputError(error) {
  if (error && typeof error.code === 'string') return error;
  return sharingError('INVALID_SHARE', error?.message || 'Invalid sharing request');
}
function isApplicability(value) {
  return typeof value === 'string' && APPLICABILITIES.includes(value);
}
function countsOf(view) {
  const raw = view?.counts;
  const byKind = {};
  if (raw?.byKind && typeof raw.byKind === 'object' && !Array.isArray(raw.byKind)) {
    for (const [kind, count] of Object.entries(raw.byKind)) {
      if (Number.isSafeInteger(count) && count >= 0) byKind[kind] = count;
    }
  }
  return Object.freeze({memories: Number.isSafeInteger(raw?.memories) && raw.memories >= 0 ? raw.memories : 0, byKind: Object.freeze(byKind)});
}

/**
 * @param {object} options
 * @param {object} options.catalog opened project catalog (catalog v2)
 * @param {object} options.registry project registry (scopes, stores, applicability)
 * @param {object} options.abstracts abstract manager (`read` is the only required method)
 * @param {() => Date} [options.now]
 */
export function createSharingManager({catalog, registry, abstracts, now = () => new Date()} = {}) {
  if (!catalog || typeof catalog.read !== 'function' || typeof catalog.write !== 'function') throw new Error('createSharingManager requires an open project catalog');
  if (!registry || typeof registry.list !== 'function' || typeof registry.getProject !== 'function' || typeof registry.scopesForProject !== 'function' || typeof registry.storeFor !== 'function') throw new Error('createSharingManager requires a ready project registry');
  if (!abstracts || typeof abstracts.read !== 'function') throw new Error('createSharingManager requires an abstract manager');

  function timestamp() {
    const value = now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('Sharing clock returned an invalid date');
    return value.toISOString();
  }
  function projectText(value, label) {
    try {
      return checkedText(value, label, PROJECT_ID_LIMIT);
    } catch (error) {
      throw inputError(error);
    }
  }
  function projectOrFail(projectId, label = 'project id') {
    const id = projectText(projectId, label);
    const project = catalog.getProject(id);
    if (!project) throw sharingError('PROJECT_NOT_FOUND', 'project is not registered');
    return project;
  }
  function requireActive(project) {
    if (project.state !== 'active') throw sharingError('PROJECT_RETIRED', `project ${project.name} is retired`);
    return project;
  }
  function projectMap() {
    const map = new Map();
    for (const project of catalog.listProjects()) map.set(project.projectId, project);
    return map;
  }
  function readAbstract(projectId) {
    const view = abstracts.read({projectId});
    if (!view || !Number.isSafeInteger(view.revision) || view.revision < 1) return undefined;
    return view;
  }
  function applicabilityFallback(project) {
    const probe = registry.applicabilityForProject;
    if (typeof probe !== 'function') return project.state === 'active' ? 'current' : 'historical_unknown';
    try {
      const result = probe.call(registry, project.projectId);
      if (isApplicability(result?.applicability)) return result.applicability;
    } catch {
      // A failing probe cannot confirm the source; never promote it to "current".
      return 'unavailable';
    }
    return 'unavailable';
  }
  function summaryApplicability(project, view) {
    if (project.state !== 'active') return 'historical_unknown';
    if (isApplicability(view?.applicability)) return view.applicability;
    return applicabilityFallback(project);
  }
  function relationView(row, projects = new Map()) {
    const source = projects.get(row.source_project_id) ?? catalog.getProject(row.source_project_id);
    const target = projects.get(row.target_project_id) ?? catalog.getProject(row.target_project_id);
    return Object.freeze({
      relationId: row.relation_id,
      sourceProjectId: row.source_project_id,
      sourceProjectName: source?.name,
      sourceProjectState: source?.state,
      targetProjectId: row.target_project_id,
      targetProjectName: target?.name,
      targetProjectState: target?.state,
      state: row.state,
      decisionBasis: row.decision_basis,
      permissionRef: row.permission_ref,
      abstractRevision: row.abstract_revision,
      sourceProjectRevision: row.source_project_revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at ?? undefined,
    });
  }
  function readRelations() {
    return catalog.read(() => catalog.db.prepare('SELECT * FROM share_relations ORDER BY created_at,relation_id').all());
  }
  function relationViewWithFollow(row, projects, current) {
    const currentRevision = current?.revision ?? 0;
    return Object.freeze({
      ...relationView(row, projects),
      currentAbstractRevision: currentRevision,
      upToDate: row.state === 'active' && currentRevision > 0
        && row.abstract_revision === currentRevision && current?.stale !== true,
    });
  }
  function scopeApplicability(binding, project) {
    try {
      const result = registry.applicabilityForScope?.(binding.scopeRef);
      if (isApplicability(result?.applicability)) return result.applicability;
    } catch {
      // Fall back to the project-level answer below.
    }
    return applicabilityFallback(project);
  }

  /** Discover other projects' abstracts. Summaries only: no paths, no detail records. */
  function discover(input = {}) {
    let targetProjectId;
    try {
      targetProjectId = shape(input, ['targetProjectId'], 'share discovery').targetProjectId;
    } catch (error) {
      throw inputError(error);
    }
    const target = requireActive(projectOrFail(targetProjectId, 'target project id'));
    const related = new Set(readRelations()
      .filter((row) => row.target_project_id === target.projectId && row.state === 'active')
      .map((row) => row.source_project_id));
    const summaries = [];
    for (const project of catalog.listProjects()) {
      if (project.projectId === target.projectId) continue;
      if (project.state !== 'active' && !related.has(project.projectId)) continue;
      const view = readAbstract(project.projectId);
      summaries.push(Object.freeze({
        sourceProjectId: project.projectId,
        sourceProjectName: project.name,
        sourceProjectState: project.state,
        abstractRevision: view?.revision ?? 0,
        abstractDigest: view?.digest,
        generatedAt: view?.generatedAt,
        counts: countsOf(view),
        applicability: summaryApplicability(project, view),
      }));
    }
    return Object.freeze(summaries);
  }

  /** User-only grant/upsert. No authorization decision is made here (see module comment). */
  function grant(input) {
    let value;
    try {
      value = shape(input, ['sourceProjectId', 'targetProjectId', 'abstractRevision', 'decisionBasis', 'permissionRef'], 'share grant');
    } catch (error) {
      throw inputError(error);
    }
    let sourceId;
    let targetId;
    let requestedRevision;
    let decisionBasis;
    let permissionRef;
    try {
      sourceId = checkedText(value.sourceProjectId, 'source project id', PROJECT_ID_LIMIT);
      targetId = checkedText(value.targetProjectId, 'target project id', PROJECT_ID_LIMIT);
      requestedRevision = integer(value.abstractRevision, 0, Number.MAX_SAFE_INTEGER, 'abstract revision');
      decisionBasis = checkedText(value.decisionBasis, 'decision basis', DECISION_BASIS_LIMIT);
      permissionRef = checkedText(value.permissionRef, 'permission reference', PERMISSION_REF_LIMIT);
    } catch (error) {
      throw inputError(error);
    }
    if (sourceId === targetId) throw sharingError('INVALID_SHARE', 'source and target project must differ');
    const source = requireActive(projectOrFail(sourceId, 'source project id'));
    const target = requireActive(projectOrFail(targetId, 'target project id'));
    const abstract = readAbstract(sourceId);
    if (!abstract) throw sharingError('ABSTRACT_UNAVAILABLE', 'source project has no readable abstract');
    if (abstract.revision !== requestedRevision) throw sharingError('STALE_ABSTRACT', 'abstract revision changed; review the current source summary before granting');
    const at = timestamp();
    const row = catalog.write(() => {
      const existing = catalog.db.prepare('SELECT * FROM share_relations WHERE source_project_id=? AND target_project_id=?').get(sourceId, targetId);
      if (existing) {
        catalog.db.prepare('UPDATE share_relations SET state=?,decision_basis=?,permission_ref=?,abstract_revision=?,source_project_revision=?,updated_at=?,revoked_at=NULL WHERE relation_id=?')
          .run('active', decisionBasis, permissionRef, abstract.revision, source.revision, at, existing.relation_id);
        return catalog.db.prepare('SELECT * FROM share_relations WHERE relation_id=?').get(existing.relation_id);
      }
      const relationId = `share-${randomUUID()}`;
      catalog.db.prepare('INSERT INTO share_relations VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(relationId, sourceId, targetId, 'active', decisionBasis, permissionRef, abstract.revision, source.revision, at, at, null);
      return catalog.db.prepare('SELECT * FROM share_relations WHERE relation_id=?').get(relationId);
    });
    return Object.freeze({...relationView(row, new Map([[source.projectId, source], [target.projectId, target]])), currentAbstractRevision: abstract.revision, upToDate: abstract.stale !== true});
  }

  /** User-only revoke. Idempotent; a missing relation is RELATION_NOT_FOUND. */
  function revoke(input) {
    let relationId;
    try {
      relationId = checkedText(shape(input, ['relationId'], 'share revoke').relationId, 'relation id', RELATION_ID_LIMIT);
    } catch (error) {
      throw inputError(error);
    }
    const at = timestamp();
    const row = catalog.write(() => {
      const existing = catalog.db.prepare('SELECT * FROM share_relations WHERE relation_id=?').get(relationId);
      if (!existing) throw sharingError('RELATION_NOT_FOUND', 'share relation is not registered');
      if (existing.state === 'revoked') return existing;
      catalog.db.prepare("UPDATE share_relations SET state='revoked',revoked_at=?,updated_at=? WHERE relation_id=?").run(at, at, relationId);
      return catalog.db.prepare('SELECT * FROM share_relations WHERE relation_id=?').get(relationId);
    });
    return relationView(row);
  }

  /** Relation views with source/target names+states, the current source revision and follow state. */
  function list(input = {}) {
    let targetProjectId;
    let sourceProjectId;
    try {
      const value = shape(input === undefined ? {} : input, ['targetProjectId', 'sourceProjectId'], 'share list');
      targetProjectId = value.targetProjectId === undefined ? undefined : checkedText(value.targetProjectId, 'target project id', PROJECT_ID_LIMIT);
      sourceProjectId = value.sourceProjectId === undefined ? undefined : checkedText(value.sourceProjectId, 'source project id', PROJECT_ID_LIMIT);
    } catch (error) {
      throw inputError(error);
    }
    if (targetProjectId !== undefined) targetProjectId = projectOrFail(targetProjectId, 'target project id').projectId;
    if (sourceProjectId !== undefined) sourceProjectId = projectOrFail(sourceProjectId, 'source project id').projectId;
    const rows = catalog.read(() => {
      const clauses = [];
      const params = [];
      if (targetProjectId !== undefined) { clauses.push('target_project_id=?'); params.push(targetProjectId); }
      if (sourceProjectId !== undefined) { clauses.push('source_project_id=?'); params.push(sourceProjectId); }
      const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
      return catalog.db.prepare(`SELECT * FROM share_relations${where} ORDER BY created_at,relation_id`).all(...params);
    });
    const projects = projectMap();
    const currentRevisions = new Map();
    return Object.freeze(rows.map((row) => {
      if (!currentRevisions.has(row.source_project_id)) {
        let view;
        try {
          view = readAbstract(row.source_project_id);
        } catch {
          view = undefined;
        }
        currentRevisions.set(row.source_project_id, view);
      }
      return relationViewWithFollow(row, projects, currentRevisions.get(row.source_project_id));
    }));
  }

  /** Read live source detail inside an active relation. Records are returned, never copied. */
  function resolve(input) {
    let targetId;
    let sourceId;
    let query;
    let limit;
    try {
      const value = shape(input, ['targetProjectId', 'sourceProjectId', 'query', 'limit'], 'shared search');
      targetId = checkedText(value.targetProjectId, 'target project id', PROJECT_ID_LIMIT);
      sourceId = checkedText(value.sourceProjectId, 'source project id', PROJECT_ID_LIMIT);
      query = checkedText(value.query, 'shared search query', QUERY_MAX);
      limit = value.limit === undefined ? SEARCH_LIMIT_DEFAULT : integer(value.limit, 1, SEARCH_LIMIT_MAX, 'shared search limit');
    } catch (error) {
      throw inputError(error);
    }
    if (targetId === sourceId) throw sharingError('SHARE_DENIED', 'a project cannot share with itself');
    const target = requireActive(projectOrFail(targetId, 'target project id'));
    const source = projectOrFail(sourceId, 'source project id');
    const relation = catalog.read(() => catalog.db.prepare('SELECT * FROM share_relations WHERE source_project_id=? AND target_project_id=?').get(sourceId, targetId));
    if (!relation || relation.state !== 'active') throw sharingError('SHARE_DENIED', 'no active share relation from the source project');
    const abstract = readAbstract(sourceId);
    if (!abstract) throw sharingError('ABSTRACT_UNAVAILABLE', 'source project has no readable abstract');
    let followed = relation;
    if (relation.abstract_revision !== abstract.revision) {
      followed = catalog.write(() => {
        catalog.db.prepare("UPDATE share_relations SET abstract_revision=? WHERE relation_id=? AND state='active'").run(abstract.revision, relation.relation_id);
        const fresh = catalog.db.prepare('SELECT * FROM share_relations WHERE relation_id=?').get(relation.relation_id);
        if (!fresh || fresh.state !== 'active') throw sharingError('SHARE_DENIED', 'share relation is no longer active');
        return fresh;
      });
    }
    const projects = new Map([[source.projectId, source], [target.projectId, target]]);
    const items = [];
    const seen = new Set();
    for (const binding of registry.scopesForProject(sourceId)) {
      if (items.length >= limit) break;
      // A scope or record that cannot be read must not be reported as "no such memory":
      // registry/store errors propagate so the caller fails closed instead of guessing.
      const store = registry.storeFor(binding.scopeRef);
      const hits = store.search(query, {limit});
      const applicability = scopeApplicability(binding, source);
      for (const hit of hits) {
        if (items.length >= limit) break;
        if (!hit || typeof hit.id !== 'string') continue;
        const key = `${binding.scopeRef}\u0000${hit.id}`;
        if (seen.has(key)) continue;
        // Same-query liveness: a record deleted/archived after search is dropped here.
        const record = store.get(hit.id);
        if (!record || record.state !== 'active') continue;
        seen.add(key);
        items.push(Object.freeze({
          id: record.id,
          recordGeneration: record.generation,
          kind: record.kind,
          text: record.text,
          sourceRef: record.sourceRef,
          sourceVersion: record.sourceVersion,
          verification: 'unverified',
          projectId: sourceId,
          repoId: binding.repoId,
          applicability,
        }));
      }
    }
    return Object.freeze({
      relation: Object.freeze({...relationView(followed, projects), currentAbstractRevision: abstract.revision, upToDate: abstract.stale !== true}),
      abstractRevision: abstract.revision,
      items: Object.freeze(items),
    });
  }

  function status() {
    const rows = readRelations();
    const active = rows.filter((row) => row.state === 'active');
    return Object.freeze({
      activeRelations: active.length,
      revokedRelations: rows.length - active.length,
      targets: new Set(active.map((row) => row.target_project_id)).size,
    });
  }

  return Object.freeze({discover, grant, revoke, list, resolve, status});
}
