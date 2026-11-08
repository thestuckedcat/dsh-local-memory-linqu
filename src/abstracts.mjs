/**
 * Project abstracts (M2, design `MEM-M2-1` §3.1): one deterministic, local extractive
 * compression of a project's live memories, persisted in the project catalog.
 *
 * Why this shape:
 * - The abstract references storage, it never copies it. Every `basis` entry pins
 *   (id, record generation, kind, source ref/version); `read` re-checks each citation with
 *   the owning memory store and rebuilds immediately when one was deleted, corrected or
 *   archived. A late writer therefore cannot keep a dead citation alive, and a retired
 *   project's abstract can only ever describe what was live when it was generated.
 * - Freshness is tracked twice. `revisionSummary` is a digest of the sorted
 *   `scopeRef:store.revision()` pairs and is recomputed on every read ("did anything
 *   change?"); `dirty_count`/`first_dirty_at` feed the coalescing thresholds from
 *   `noteChange`. A changed summary only marks the view `stale`: below the thresholds the
 *   stored revision is returned untouched, so one new memory does not rewrite the abstract
 *   on every model turn.
 * - Auto-refresh is active-project only. Retired projects keep a readable
 *   `historical_unknown` abstract, but only an explicit `refresh({reason:'manual'})` (a
 *   user action through the management API) may regenerate it.
 *
 * Catalog access: only through `catalog.read(fn)`/`catalog.write(fn)` on the catalog's own
 * single `DatabaseSync` (the `src/reports.mjs` convention). This module never opens a
 * second database and never writes to a memory store; memory I/O is read-only.
 */
import {checkedText, digest} from './scope.mjs';
import {canonical, fingerprint, integer, shape} from './validation.mjs';

export const ABSTRACT_SCHEMA_VERSION = 'memory-abstract-v1';
export const ABSTRACT_GENERATION_ROUTE = 'local-extractive-v1';
const BASIS_LIMIT = 60;
const READ_LIMIT = 200;
const SUMMARY_LIMIT = 240;
const DEFAULT_COUNT_THRESHOLD = 10;
const DEFAULT_AGE_MS = 86400000;
const CHANGE_COUNT_MAX = 100000;
const REFRESH_REASONS = Object.freeze(['manual', 'auto', 'coalesced']);
const APPLICABILITY = Object.freeze(['current', 'historical_unknown', 'unavailable']);
const MEMORY_KINDS = Object.freeze(['fact', 'lesson', 'preference', 'decision']);
const STATE_QUERY = `SELECT s.current_revision,s.dirty_count,s.first_dirty_at,s.last_change_at,
 s.last_generated_at,s.generation_route,s.revision_summary,
 r.digest AS revision_digest,r.payload AS revision_payload,r.created_at AS revision_created_at
 FROM abstract_state s
 LEFT JOIN abstract_revisions r ON r.project_id=s.project_id AND r.revision=s.current_revision
 WHERE s.project_id=?`;

export function abstractFailure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (message) => abstractFailure('INVALID_INPUT', message);
function checked(value, label, max) {
  try { return checkedText(value, label, max); } catch (error) { throw invalid(error.message); }
}
function options(value, fields, label) {
  try { return value === undefined ? {} : shape(value, fields, label); } catch (error) { throw invalid(error.message); }
}
function counted(value, min, max, label) {
  try { return integer(value, min, max, label); } catch (error) { throw invalid(error.message); }
}
function clockValue(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw abstractFailure('INVALID_TIMESTAMP', 'the abstract clock returned an invalid timestamp');
  return date;
}
function summaryOf(record) {
  return record.text.length > SUMMARY_LIMIT ? record.text.slice(0, SUMMARY_LIMIT) : record.text;
}
function validBasisEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 256
    && Number.isSafeInteger(entry.recordGeneration) && entry.recordGeneration >= 1
    && typeof entry.kind === 'string' && MEMORY_KINDS.includes(entry.kind)
    && typeof entry.sourceRef === 'string' && entry.sourceRef.length > 0 && entry.sourceRef.length <= 2048
    && typeof entry.sourceVersion === 'string' && entry.sourceVersion.length > 0 && entry.sourceVersion.length <= 512
    && typeof entry.summary === 'string' && entry.summary.length <= SUMMARY_LIMIT;
}

/**
 * `createAbstractManager({catalog, registry, now})` -> frozen `{read, refresh, list, noteChange, shouldRefresh, status}`.
 * The registry `applicabilityForProject` probe is used when the surrounding build provides it
 * (§3.3); otherwise applicability falls back to the catalog project state. A throwing probe
 * must not make a stored abstract unreadable, so it degrades to the same fallback.
 */
export function createAbstractManager({catalog, registry, now = () => new Date(), thresholds} = {}) {
  if (!catalog || typeof catalog.read !== 'function' || typeof catalog.write !== 'function' || typeof catalog.db?.prepare !== 'function') throw abstractFailure('ABSTRACT_UNAVAILABLE', 'the project catalog is unavailable');
  if (!registry || typeof registry.getProject !== 'function' || typeof registry.list !== 'function' || typeof registry.storeFor !== 'function') throw abstractFailure('ABSTRACT_UNAVAILABLE', 'the project registry is unavailable');
  if (typeof now !== 'function') throw abstractFailure('ABSTRACT_UNAVAILABLE', 'an abstract clock is required');
  const thresholdOptions = options(thresholds ?? {}, ['dirtyCountThreshold', 'ageHours'], 'abstract thresholds');
  const countThreshold = counted(thresholdOptions.dirtyCountThreshold ?? DEFAULT_COUNT_THRESHOLD, 1, Number.MAX_SAFE_INTEGER, 'dirty count threshold');
  const ageMs = counted((thresholdOptions.ageHours ?? 24) * 3600000, 0, Number.MAX_SAFE_INTEGER, 'abstract refresh age');
  const db = catalog.db;

  function resolveProject(projectId) {
    const id = checked(projectId, 'project id', 128);
    const project = registry.getProject(id);
    if (!project) throw abstractFailure('PROJECT_NOT_FOUND', 'project is not registered');
    return project;
  }
  function applicabilityOf(project) {
    if (typeof registry.applicabilityForProject === 'function') {
      try {
        const value = registry.applicabilityForProject(project.projectId);
        if (value && APPLICABILITY.includes(value.applicability)) return value.applicability;
      } catch {
        // A probe that fails cannot confirm the source: fail closed to "unavailable" rather than
        // promoting an active project to "current".
        return 'unavailable';
      }
      return 'unavailable';
    }
    return project.state === 'active' ? 'current' : 'historical_unknown';
  }
  function scopeRefsOf(project) {
    if (Array.isArray(project.repositories)) return project.repositories.filter((repo) => repo.enabled !== false).map((repo) => repo.scopeRef);
    if (typeof registry.scopesForProject === 'function') return registry.scopesForProject(project.projectId).map((binding) => binding.scopeRef);
    return [];
  }
  function scopeStores(project) {
    return scopeRefsOf(project).map((scopeRef) => ({scopeRef, store: registry.storeFor(scopeRef)}));
  }
  function revisionSummaryOf(scopes) {
    return fingerprint(scopes.map(({scopeRef, store}) => `${scopeRef}:${store.revision()}`).sort());
  }
  function basisLive(scopes, basis) {
    if (!basis.length) return true;
    return basis.every((entry) => scopes.some(({store}) => {
      const record = store.get(entry.id);
      return record !== undefined
        && record.generation === entry.recordGeneration
        && record.kind === entry.kind
        && record.sourceRef === entry.sourceRef
        && record.sourceVersion === entry.sourceVersion;
    }));
  }
  function needsRefresh(state, countThreshold, ageMs, nowMs) {
    if (state.dirtyCount >= countThreshold) return true;
    if (state.firstDirtyAt === undefined) return false;
    const first = Date.parse(state.firstDirtyAt);
    return Number.isFinite(first) && nowMs - first >= ageMs;
  }

  /** Read every enabled scope, keep only records that are live *now*, then take the 60 newest. */
  function gather(project) {
    const scopes = scopeStores(project);
    const records = [];
    for (const {store} of scopes) {
      for (const listed of store.list({limit: READ_LIMIT})) {
        const record = store.get(listed.id);
        if (record) records.push(record);
      }
    }
    records.sort((a, b) => b.generation - a.generation || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const basis = Object.freeze(records.slice(0, BASIS_LIMIT).map((record) => Object.freeze({
      id: record.id,
      recordGeneration: record.generation,
      kind: record.kind,
      sourceRef: record.sourceRef,
      sourceVersion: record.sourceVersion,
      summary: summaryOf(record),
    })));
    const byKind = {};
    for (const entry of basis) byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    return Object.freeze({
      basis,
      counts: Object.freeze({memories: basis.length, byKind: Object.freeze(byKind)}),
      revisionSummary: revisionSummaryOf(scopes),
    });
  }

  /** Insert the new immutable revision and reset the coalescing state in one catalog transaction. */
  function persist(project, gathered, generatedAt) {
    return catalog.write(() => {
      const previous = db.prepare('SELECT current_revision FROM abstract_state WHERE project_id=?').get(project.projectId);
      const revision = (previous?.current_revision ?? 0) + 1;
      const payload = Object.freeze({
        schemaVersion: ABSTRACT_SCHEMA_VERSION,
        projectId: project.projectId,
        projectName: project.name,
        projectState: project.state,
        revision,
        generatedAt,
        generationRoute: ABSTRACT_GENERATION_ROUTE,
        basis: gathered.basis,
        counts: gathered.counts,
        revisionSummary: gathered.revisionSummary,
      });
      const payloadText = canonical(payload);
      const payloadDigest = fingerprint(payload);
      db.prepare('INSERT INTO abstract_revisions(project_id,revision,digest,payload,created_at) VALUES(?,?,?,?,?)')
        .run(project.projectId, revision, payloadDigest, payloadText, generatedAt);
      db.prepare(`INSERT INTO abstract_state(project_id,current_revision,dirty_count,first_dirty_at,last_change_at,last_generated_at,generation_route,revision_summary)
 VALUES(?,?,0,NULL,NULL,?,?,?)
 ON CONFLICT(project_id) DO UPDATE SET
  current_revision=excluded.current_revision,
  dirty_count=0,
  first_dirty_at=NULL,
  last_generated_at=excluded.last_generated_at,
  generation_route=excluded.generation_route,
  revision_summary=excluded.revision_summary`)
        .run(project.projectId, revision, generatedAt, ABSTRACT_GENERATION_ROUTE, gathered.revisionSummary);
      return Object.freeze({payload, digest: payloadDigest, revision});
    });
  }

  /** The view reflects the *current* registry state; the payload keeps the generation-time state. */
  function viewOf(project, payload, dirtyCount, payloadDigest, stale) {
    return Object.freeze({
      schemaVersion: ABSTRACT_SCHEMA_VERSION,
      projectId: project.projectId,
      projectName: project.name,
      projectState: project.state,
      revision: payload.revision,
      digest: payloadDigest,
      generatedAt: payload.generatedAt,
      generationRoute: payload.generationRoute,
      stale,
      dirtyCount,
      applicability: applicabilityOf(project),
      counts: Object.freeze({memories: payload.counts.memories, byKind: Object.freeze({...payload.counts.byKind})}),
      basis: Object.freeze(payload.basis.map((entry) => Object.freeze({
        id: entry.id,
        recordGeneration: entry.recordGeneration,
        kind: entry.kind,
        sourceRef: entry.sourceRef,
        sourceVersion: entry.sourceVersion,
        summary: entry.summary,
      }))),
    });
  }
  function emptyView(project, dirtyCount) {
    return Object.freeze({
      schemaVersion: ABSTRACT_SCHEMA_VERSION,
      projectId: project.projectId,
      projectName: project.name,
      projectState: project.state,
      revision: 0,
      digest: undefined,
      generatedAt: undefined,
      generationRoute: undefined,
      stale: true,
      dirtyCount,
      applicability: applicabilityOf(project),
      counts: Object.freeze({memories: 0, byKind: Object.freeze({})}),
      basis: Object.freeze([]),
    });
  }
  function parseStored(projectId, row) {
    if (typeof row.revision_payload !== 'string' || typeof row.revision_digest !== 'string') return undefined;
    // The stored text is canonical JSON, so its sha256 must equal the recorded digest.
    if (digest(row.revision_payload) !== row.revision_digest) return undefined;
    let payload;
    try { payload = JSON.parse(row.revision_payload); } catch { return undefined; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    if (payload.schemaVersion !== ABSTRACT_SCHEMA_VERSION || payload.projectId !== projectId || payload.revision !== row.current_revision) return undefined;
    if (typeof payload.projectName !== 'string' || !['active', 'retired'].includes(payload.projectState)) return undefined;
    if (typeof payload.generatedAt !== 'string' || typeof payload.generationRoute !== 'string' || typeof payload.revisionSummary !== 'string') return undefined;
    if (!Array.isArray(payload.basis) || !payload.basis.every(validBasisEntry)) return undefined;
    if (!payload.counts || typeof payload.counts !== 'object' || Array.isArray(payload.counts)) return undefined;
    if (!Number.isSafeInteger(payload.counts.memories) || payload.counts.memories !== payload.basis.length) return undefined;
    const byKind = payload.counts.byKind;
    if (!byKind || typeof byKind !== 'object' || Array.isArray(byKind)) return undefined;
    const kinds = Object.keys(byKind);
    if (kinds.some((kind) => !MEMORY_KINDS.includes(kind))) return undefined;
    if (kinds.some((kind) => !Number.isSafeInteger(byKind[kind]) || byKind[kind] < 1)) return undefined;
    if (kinds.reduce((total, kind) => total + byKind[kind], 0) !== payload.counts.memories) return undefined;
    return Object.freeze({payload: Object.freeze(payload), digest: row.revision_digest, createdAt: row.revision_created_at});
  }
  function loadAbstract(projectId) {
    const row = catalog.read(() => db.prepare(STATE_QUERY).get(projectId));
    if (!row) return undefined;
    const state = Object.freeze({
      currentRevision: row.current_revision,
      dirtyCount: row.dirty_count,
      firstDirtyAt: row.first_dirty_at ?? undefined,
      lastChangeAt: row.last_change_at ?? undefined,
      lastGeneratedAt: row.last_generated_at ?? undefined,
      generationRoute: row.generation_route ?? undefined,
      revisionSummary: row.revision_summary ?? undefined,
    });
    const current = state.currentRevision >= 1 ? parseStored(projectId, row) : undefined;
    return Object.freeze({state, current});
  }
  function refreshProject(project, reason) {
    if (reason !== 'manual' && project.state !== 'active') throw abstractFailure('PROJECT_RETIRED', 'a retired project cannot refresh its abstract automatically');
    const generatedAt = clockValue(now).toISOString();
    const stored = persist(project, gather(project), generatedAt);
    return viewOf(project, stored.payload, 0, stored.digest, false);
  }

  /**
   * Load the current abstract, or rebuild it. A retired project is readable but never rebuilt
   * implicitly: it either returns the stored (possibly `stale`) view, `undefined` when no
   * abstract was ever generated, or the specific refusal code for a forced refresh.
   */
  function read(request) {
    const input = options(request, ['projectId', 'forceRefresh'], 'abstract read');
    const project = resolveProject(input.projectId);
    const forceRefresh = input.forceRefresh ?? false;
    if (typeof forceRefresh !== 'boolean') throw invalid('forceRefresh must be a boolean');
    const active = project.state === 'active';
    if (forceRefresh) {
      if (active) return refreshProject(project, 'auto');
      // `refresh()` stays the only way to regenerate a retired abstract; a *read* that demands
      // certainty cannot silently return an older revision.
      const retired = loadAbstract(project.projectId);
      if (!retired || !retired.current) throw abstractFailure('ABSTRACT_UNAVAILABLE', 'no abstract can be rebuilt for this retired project');
      throw abstractFailure('STALE_ABSTRACT', 'a retired project cannot refresh its abstract automatically');
    }
    const loaded = loadAbstract(project.projectId);
    if (!loaded || loaded.state.currentRevision < 1) {
      if (!active) return undefined;
      return refreshProject(project, 'auto');
    }
    if (!loaded.current) {
      if (!active) throw abstractFailure('ABSTRACT_UNAVAILABLE', 'the stored abstract is unreadable and cannot be rebuilt automatically');
      return refreshProject(project, 'auto');
    }
    const scopes = scopeStores(project);
    const live = basisLive(scopes, loaded.current.payload.basis);
    const changed = revisionSummaryOf(scopes) !== loaded.current.payload.revisionSummary;
    if (live && !changed) {
      // Thresholds are a real contract even when the revision summary is unchanged (for example a
      // caller that only calls noteChange): read must agree with shouldRefresh.
      if (active && needsRefresh(loaded.state, countThreshold, ageMs, clockValue(now).getTime())) return refreshProject(project, 'auto');
      return viewOf(project, loaded.current.payload, loaded.state.dirtyCount, loaded.current.digest, false);
    }
    if (!active) return viewOf(project, loaded.current.payload, loaded.state.dirtyCount, loaded.current.digest, true);
    // A dead reference disconnects immediately; a merely changed project only refreshes once
    // the caller forced it or `noteChange` crossed the coalescing thresholds.
    if (!live || needsRefresh(loaded.state, countThreshold, ageMs, clockValue(now).getTime())) return refreshProject(project, 'auto');
    return viewOf(project, loaded.current.payload, loaded.state.dirtyCount, loaded.current.digest, true);
  }

  function refresh(request) {
    const input = options(request, ['projectId', 'reason'], 'abstract refresh');
    const project = resolveProject(input.projectId);
    const reason = input.reason ?? 'manual';
    if (typeof reason !== 'string' || !REFRESH_REASONS.includes(reason)) throw invalid('unknown abstract refresh reason');
    return refreshProject(project, reason);
  }

  function list(request) {
    const input = options(request, ['includeRetired'], 'abstract list');
    const includeRetired = input.includeRetired ?? false;
    if (typeof includeRetired !== 'boolean') throw invalid('includeRetired must be a boolean');
    const projects = registry.list().filter((project) => includeRetired || project.state === 'active');
    return Object.freeze(projects.map((project) => {
      const loaded = loadAbstract(project.projectId);
      if (!loaded || loaded.state.currentRevision < 1 || !loaded.current) return emptyView(project, loaded?.state.dirtyCount ?? 0);
      let stale = true;
      // Listing is discovery: one unreadable store must not hide every other project.
      try { stale = revisionSummaryOf(scopeStores(project)) !== loaded.current.payload.revisionSummary; } catch { stale = true; }
      return viewOf(project, loaded.current.payload, loaded.state.dirtyCount, loaded.current.digest, stale);
    }));
  }

  function timestamp(value) {
    const text = checked(value, 'change timestamp', 64);
    if (!Number.isFinite(Date.parse(text))) throw invalid('invalid change timestamp');
    return text;
  }
  function noteChange(projectId, request) {
    const input = options(request, ['count', 'at'], 'abstract change note');
    const count = counted(input.count ?? 1, 1, CHANGE_COUNT_MAX, 'change count');
    const project = resolveProject(projectId);
    const at = input.at === undefined ? clockValue(now).toISOString() : timestamp(input.at);
    const row = catalog.write(() => {
      db.prepare(`INSERT INTO abstract_state(project_id,current_revision,dirty_count,first_dirty_at,last_change_at)
 VALUES(?,0,?,?,?)
 ON CONFLICT(project_id) DO UPDATE SET
  dirty_count=abstract_state.dirty_count+excluded.dirty_count,
  first_dirty_at=COALESCE(abstract_state.first_dirty_at,excluded.first_dirty_at),
  last_change_at=excluded.last_change_at`).run(project.projectId, count, at, at);
      return db.prepare('SELECT * FROM abstract_state WHERE project_id=?').get(project.projectId);
    });
    return Object.freeze({
      projectId: project.projectId,
      currentRevision: row.current_revision,
      dirtyCount: row.dirty_count,
      firstDirtyAt: row.first_dirty_at ?? undefined,
      lastChangeAt: row.last_change_at ?? undefined,
    });
  }

  function shouldRefresh(projectId, request) {
    const input = options(request, ['countThreshold', 'ageMs'], 'abstract refresh thresholds');
    const requestedCount = counted(input.countThreshold ?? countThreshold, 1, Number.MAX_SAFE_INTEGER, 'count threshold');
    const requestedAge = counted(input.ageMs ?? ageMs, 0, Number.MAX_SAFE_INTEGER, 'refresh age');
    const project = resolveProject(projectId);
    if (project.state !== 'active') return false;
    const loaded = loadAbstract(project.projectId);
    // A pristine project is not "due" by threshold; `read` still builds its first abstract.
    if (!loaded) return false;
    return needsRefresh(loaded.state, requestedCount, requestedAge, clockValue(now).getTime());
  }

  function status() {
    return catalog.read(() => Object.freeze({
      projectsWithAbstracts: db.prepare('SELECT count(*) AS n FROM abstract_state WHERE current_revision>=1').get().n,
      totalRevisions: db.prepare('SELECT count(*) AS n FROM abstract_revisions').get().n,
      dirtyProjects: db.prepare('SELECT count(*) AS n FROM abstract_state WHERE dirty_count>0').get().n,
    }));
  }

  return Object.freeze({read, refresh, list, noteChange, shouldRefresh, status});
}
