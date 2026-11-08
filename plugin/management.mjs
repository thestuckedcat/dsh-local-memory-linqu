/**
 * Local memory management API: Host service operations plus the same-origin HTTP route.
 *
 * The model-facing tools and the user-facing memory center share this one implementation
 * (design doc §9 "一份实现两个调用方"): callers construct a request with a trusted `actor`;
 * the HTTP route always fixes `actor:'user'`. Nothing in this module resolves a scope from
 * caller-supplied scope strings: scopes come from the project registry's trusted state.
 */
import {basename} from 'node:path';
import {checkedText, digest} from '../src/scope.mjs';
import {shape, clean, fingerprint, integer} from '../src/validation.mjs';
import {contextOf, assertAuthority, entryState, memoryDigest} from '../src/store-internals.mjs';

export const API_PATH = '/dsh-local-memory/api';
export const API_SCHEMA_VERSION = 1;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/;
const PROJECT_ID_MAX = 128;
const MEMORY_LIMIT_DEFAULT = 10;
const MEMORY_LIMIT_MAX = 50;
const LIST_LIMIT_DEFAULT = 20;
const LIST_LIMIT_MAX = 50;
const TASK_LIMIT_DEFAULT = 20;
const TASK_LIMIT_MAX = 50;
const CURSOR_OFFSET_MAX = 500;
const OPERATION_TABLE_LIMIT = 256;
const DEFAULT_MAX_BODY_BYTES = 65536;
const MAX_BODY_BYTES = 1048576;
const MAX_MEMORY_TEXT = 12000;
const USER_CONFIRMATION_TTL_MS = 120000;

const MEMORY_ACTIONS = Object.freeze({
  active: Object.freeze(['correct', 'archive', 'delete']),
  archived: Object.freeze(['restore', 'delete']),
  stale: Object.freeze([]),
  superseded: Object.freeze([]),
  deleted: Object.freeze([]),
});
const JOB_STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'stale', 'outcome_unknown']);
const JOB_FILTER_STATES = Object.freeze([...JOB_STATES, 'quarantined']);
const JOB_PURPOSES = Object.freeze(['memory_extract', 'work_summary_extract', 'work_summary_merge']);
const COST_STATUSES = Object.freeze(['reported', 'unknown', 'not_dispatched']);
const USER_ONLY_OPERATIONS = new Set([
  'project.register', 'project.update', 'project.retire', 'project.preference',
  'memory.correct', 'memory.archive', 'memory.restore', 'memory.delete',
  'task.cancel', 'task.confirmRemoteQuiescence', 'recovery.confirm',
  'work.correct', 'work.confirmClaim', 'work.confirmTime', 'work.evidence.register',
  'work.evidence.review', 'work.merge',
  'report.approve', 'report.export',
  'reminder.defer', 'reminder.disable',
  'abstract.refresh', 'share.grant', 'share.revoke',
]);
const USER_ONLY_PREFIXES = Object.freeze(['report.approve', 'reminder.']);
// Memory mutations that can change a project abstract; entry may attach noteChange.
const ABSTRACT_AFFECTING_OPERATIONS = new Set(['memory.correct', 'memory.archive', 'memory.restore', 'memory.delete']);
// Read-only operations never duplicate a mutation, so they are not persisted into the catalog
// idempotency table (the memory center polls them every few seconds).
const READ_ONLY_OPERATIONS = new Set([
  'status', 'project.list', 'memory.search', 'memory.list', 'memory.get', 'task.list', 'task.inspect',
  'work.list', 'work.get', 'report.list', 'report.get',
  'abstract.list', 'share.discover', 'share.list', 'shared.search',
  'memory.attribution', 'memory.excerpts',
]);
const PASSTHROUGH_ERROR_CODES = new Set([
  'PROJECT_NOT_FOUND', 'STALE_REVISION', 'PROJECT_RETIRED', 'PROJECT_EXISTS', 'DUPLICATE_NAME',
  'SCOPE_CONFLICT', 'DUPLICATE_REPOSITORY', 'INVALID_REPOSITORIES', 'INVALID_PREFERENCE',
  'INVALID_ORIGIN', 'INVALID_OPERATION', 'SCOPE_NOT_FOUND', 'SCOPE_LIMIT', 'STORE_UNAVAILABLE',
  'QUEUE_UNAVAILABLE', 'REGISTRY_UNAVAILABLE', 'CATALOG_UNAVAILABLE', 'CATALOG_IDENTITY_MISMATCH',
  'CATALOG_SCHEMA_MISMATCH', 'CATALOG_IDENTITY_UNAVAILABLE', 'OPERATION_CONFLICT',
  'SESSION_NOT_FOUND', 'SESSION_REQUIRED',
]);
const UNSAFE_STATUS_KEY = /(?:dataRoot|databasePath|canonicalRoot|worktreeRoot|localPath|exportRoot|exportRootRef|anchor|^path$|^paths$|^root$|^roots$|^dir$|^directory$|^file$|^files$)/i;
const ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])/;
const SECRET_LIKE = /-----BEGIN (?:\w+ )?PRIVATE KEY-----|\bBearer\s+[^\s]{8,}|\bsk-[A-Za-z0-9_-]{16,}/i;
const SAFE_REASON = /^[a-z0-9_:-]{1,80}$/;

const ERROR_MESSAGES = Object.freeze({
  USER_ACTION_REQUIRED: 'This operation can only be performed by the user',
  UNKNOWN_OPERATION: 'Unknown management operation',
  INVALID_REQUEST: 'Invalid management request',
  UNAVAILABLE: 'This operation is unavailable in the current build',
  INVALID_INPUT: 'An input field is invalid',
  PROJECT_REQUIRED: 'A projectId is required because the caller is not bound to one project',
  PROJECT_NOT_FOUND: 'The project is not registered',
  REPO_NOT_FOUND: 'The repository binding is not registered or enabled',
  SCOPE_NOT_FOUND: 'No memory scope is bound to this project',
  STALE_REVISION: 'The project changed since it was read; refresh and retry',
  STALE_GENERATION: 'The memory scope changed since it was read; refresh and retry',
  STALE_CURSOR: 'The list changed since this page was read; refresh and retry',
  MEMORY_NOT_FOUND: 'The memory record was not found',
  MEMORY_NOT_ACTIVE: 'This action requires an active memory record',
  MEMORY_NOT_ARCHIVED: 'Only archived memory records can be restored',
  SOURCE_INVALIDATED: 'The memory source was deleted or invalidated',
  TASK_NOT_FOUND: 'The job was not found in this project',
  TASK_STATE_CONFLICT: 'The job is not in a state that allows this action',
  CANCEL_UNAVAILABLE: 'Local cancellation is unavailable in this build; no remote stop is claimed',
  UNAUTHORIZED: 'The user confirmation is missing or expired',
  OPERATION_CONFLICT: 'The operationId was already used with a different payload',
  INTERNAL_ERROR: 'The operation could not be completed',
});

class OperationError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL_ERROR) {
    super(message);
    this.name = 'MemoryManagementError';
    this.code = code;
  }
}
function fail(code, message) {
  return new OperationError(code, message);
}
function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;
}
function redactText(value, max = 300) {
  let text = typeof value === 'string' ? value : '';
  text = text.replace(ABSOLUTE_PATH, ' [redacted-path]').replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (SECRET_LIKE.test(text)) text = '[redacted]';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
function mapError(error) {
  if (error instanceof OperationError) return {code: error.code, message: error.message};
  const code = safeCode(error?.code);
  if (code && PASSTHROUGH_ERROR_CODES.has(code)) return {code, message: ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL_ERROR};
  const text = typeof error?.message === 'string' ? error.message : '';
  const mappings = [
    [/stale memory generation/i, 'STALE_GENERATION'],
    [/stale correction/i, 'STALE_GENERATION'],
    [/source was deleted or invalidated/i, 'SOURCE_INVALIDATED'],
    [/only archived entries can be restored/i, 'MEMORY_NOT_ARCHIVED'],
    [/record is not active/i, 'MEMORY_NOT_ACTIVE'],
    [/memory is not active/i, 'MEMORY_NOT_FOUND'],
    [/unknown record/i, 'MEMORY_NOT_FOUND'],
    [/unknown scoped job/i, 'TASK_NOT_FOUND'],
    [/only unknown dispatch can be acknowledged/i, 'TASK_STATE_CONFLICT'],
    [/trusted host authorization required/i, 'UNAUTHORIZED'],
    [/unknown project/i, 'PROJECT_NOT_FOUND'],
    [/memory store is unavailable/i, 'STORE_UNAVAILABLE'],
    [/job queue is unavailable/i, 'QUEUE_UNAVAILABLE'],
    [/registry is not ready|registry is unavailable|normalized configuration required/i, 'REGISTRY_UNAVAILABLE'],
    [/only local absolute|drive has no approved|memory path cannot|must be a directory|secret-like|invalid (?:path|project name|repository|revision|build variant)/i, 'INVALID_INPUT'],
    [/^invalid\b/i, 'INVALID_INPUT'],
  ];
  for (const [pattern, mapped] of mappings) if (pattern.test(text)) return {code: mapped, message: ERROR_MESSAGES[mapped]};
  return {code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR};
}

/** Pick a safe one-segment display name so project views never carry absolute local paths. */
function rootName(path) {
  if (typeof path !== 'string' || !path) return undefined;
  try {
    const name = basename(path.replace(/[\\/]+$/, ''));
    return name && name.length <= 128 ? redactText(name, 128) : undefined;
  } catch {
    return undefined;
  }
}
function sanitizeString(value) {
  if (SECRET_LIKE.test(value) || ABSOLUTE_PATH.test(value)) return '[redacted]';
  return value.length > 200 ? value.slice(0, 200) : value;
}
function sanitizeStatusValue(value, depth = 0) {
  if (depth > 4) return '[truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return sanitizeString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeStatusValue(item, depth + 1));
  if (value && typeof value === 'object') {
    let proto;
    try { proto = Object.getPrototypeOf(value); } catch { return '[unavailable]'; }
    if (proto !== Object.prototype && proto !== null) return '[unavailable]';
    const out = {};
    let count = 0;
    for (const key of Object.keys(value)) {
      if (count >= 30) break;
      if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key) || UNSAFE_STATUS_KEY.test(key)) continue;
      out[key] = sanitizeStatusValue(value[key], depth + 1);
      count++;
    }
    return out;
  }
  return '[unavailable]';
}
function safeStatus(label, fn) {
  try {
    const value = fn();
    if (value && typeof value.then === 'function') {
      value.catch(() => {});
      return {state: 'unavailable'};
    }
    return sanitizeStatusValue(value);
  } catch {
    return {state: 'unavailable', service: label};
  }
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw fail('INVALID_INPUT', `${label} must be a plain object`);
  return value;
}
function checkedInputText(value, label, max) {
  try {
    return checkedText(value, label, max);
  } catch {
    throw fail('INVALID_INPUT', ERROR_MESSAGES.INVALID_INPUT);
  }
}
function optionalText(value, label, max) {
  return value === undefined ? undefined : checkedInputText(value, label, max);
}
function checkedRepoPath(value, label) {
  if (typeof value !== 'string' || value.length < 3 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !/^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value) || value.includes(':', 2)) {
    throw fail('INVALID_INPUT', `${label} must be an absolute local drive path`);
  }
  if (SECRET_LIKE.test(value)) throw fail('INVALID_INPUT', `${label} contains credential-like text`);
  return value;
}
function normalizeRepositories(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw fail('INVALID_INPUT', 'repositories must contain 1..16 entries');
  const seen = new Set();
  return value.map((entry, index) => {
    shape(entry, ['repoId', 'canonicalRoot', 'worktreeRoot', 'revision', 'buildVariant'], `repositories[${index}]`);
    const repoId = checkedInputText(entry.repoId, 'repository id', 128);
    if (seen.has(repoId)) throw fail('INVALID_INPUT', 'repository ids must be unique');
    seen.add(repoId);
    const canonicalRoot = checkedRepoPath(entry.canonicalRoot, `repositories[${index}].canonicalRoot`);
    const worktreeRoot = entry.worktreeRoot === undefined ? canonicalRoot : checkedRepoPath(entry.worktreeRoot, `repositories[${index}].worktreeRoot`);
    return {
      repoId,
      canonicalRoot,
      worktreeRoot,
      revision: optionalText(entry.revision, 'repository revision', 512) ?? 'workspace',
      buildVariant: optionalText(entry.buildVariant, 'build variant', 2048) ?? 'unknown',
    };
  });
}
function normalizeCursor(value, label) {
  if (value === undefined || value === null) return undefined;
  shape(value, ['revision', 'offset'], label);
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw fail('INVALID_INPUT', `${label}.revision is invalid`);
  return {revision: value.revision, offset: integer(value.offset, 0, CURSOR_OFFSET_MAX, `${label}.offset`)};
}
function scopeRevision(scopes) {
  return fingerprint(scopes.map((info) => ({scopeRef: info.scopeRef, revision: info.store.revision()})));
}
function projectView(project) {
  if (!project) return undefined;
  return {
    projectId: project.projectId,
    name: project.name,
    state: project.state,
    revision: project.revision,
    origin: project.origin,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    retiredReason: project.retiredReason,
    preferences: project.preferences,
    localRootsVisible: false,
    repositories: (project.repositories ?? []).map((repository) => ({
      repoId: repository.repoId,
      revision: repository.revision,
      buildVariant: repository.buildVariant,
      bindingRevision: repository.bindingRevision,
      enabled: repository.enabled,
      canonicalRootName: rootName(repository.canonicalRoot),
      worktreeRootName: rootName(repository.worktreeRoot),
    })),
  };
}
function memoryItem(info, row, state) {
  return {
    id: row.id,
    kind: row.kind,
    text: row.text,
    origin: row.origin,
    verification: 'unverified',
    state,
    generation: row.generation,
    recordGeneration: row.generation,
    expectedGeneration: info.store.generation(),
    createdAt: row.created_at,
    supersedes: row.supersedes ?? undefined,
    restorable: state === 'archived',
    actions: MEMORY_ACTIONS[state] ?? [],
    repoId: info.repoId,
    source: {sourceRef: row.source_ref, sourceVersion: row.source_version},
  };
}
function tombstoneItem(info, entry) {
  return {
    id: entry.id,
    kind: undefined,
    text: undefined,
    textUnavailable: true,
    verification: 'unverified',
    state: entry.state,
    generation: entry.generation,
    recordGeneration: entry.generation,
    expectedGeneration: info.store.generation(),
    restorable: false,
    actions: MEMORY_ACTIONS[entry.state] ?? [],
    repoId: info.repoId,
    source: {sourceRef: entry.source_ref, sourceVersion: entry.source_version},
    reasonCode: entry.state === 'deleted' ? 'EXPLICITLY_DELETED' : 'RECORD_INVALIDATED',
  };
}

/* -------------------------------------------------------------------------- */
/* Row readers use the store's own authority ledger, read-only.                */
/* -------------------------------------------------------------------------- */

function memoryRows(store, {stateFilter, limit, offset}) {
  const ctx = contextOf(store);
  assertAuthority(ctx);
  const states = stateFilter === 'active' ? ['active'] : stateFilter === 'archived' ? ['archived'] : ['active', 'archived'];
  const placeholders = states.map(() => '?').join(',');
  return ctx.db.prepare(`SELECT r.*, e.state AS ledger_state, e.generation AS entry_generation
    FROM records r JOIN ledger.entries e
      ON e.scope_ref=r.scope_ref AND e.collection='memories' AND e.id=r.id
    WHERE r.scope_ref=? AND e.state IN (${placeholders})
    ORDER BY CASE e.state WHEN 'active' THEN 0 ELSE 1 END, e.generation DESC, r.id
    LIMIT ? OFFSET ?`).all(store.scopeRef, ...states, limit, offset);
}
function memoryCounts(store) {
  const ctx = contextOf(store);
  assertAuthority(ctx);
  const counts = {active: 0, archived: 0, deleted: 0, superseded: 0, stale: 0};
  for (const row of ctx.db.prepare("SELECT state, count(*) AS n FROM ledger.entries WHERE scope_ref=? AND collection='memories' GROUP BY state").all(store.scopeRef)) {
    if (Object.hasOwn(counts, row.state)) counts[row.state] = row.n;
  }
  return counts;
}
function archivedRow(store, id) {
  const ctx = contextOf(store);
  assertAuthority(ctx);
  const entry = entryState(ctx, 'memories', id);
  if (!entry) return undefined;
  if (entry.state !== 'archived') return {entry};
  const row = ctx.db.prepare('SELECT * FROM records WHERE id=? AND scope_ref=?').get(id, store.scopeRef);
  if (!row) return {entry, corrupt: true};
  if (row.generation !== entry.generation || memoryDigest(row) !== entry.body_digest) return {entry, corrupt: true};
  return {entry, row};
}
function jobRows(store) {
  const ctx = contextOf(store);
  assertAuthority(ctx);
  return ctx.db.prepare(`SELECT j.*, l.phase AS lock_phase
    FROM ledger.jobs j LEFT JOIN ledger.dispatch_lock l ON l.job_id=j.id
    WHERE j.scope_ref=? ORDER BY j.created_at DESC, j.id`).all(store.scopeRef);
}
function jobView(info, row, capabilities) {
  const state = JOB_STATES.includes(row.state) ? row.state : 'outcome_unknown';
  const quarantined = state === 'outcome_unknown' && row.lock_phase === 'unknown';
  const phase = state === 'queued' ? 'queued' : state === 'running' ? 'in_flight' : quarantined ? 'unknown' : 'settled';
  const actions = ['inspect'];
  if ((state === 'queued' || state === 'running') && capabilities.cancel) actions.push('cancel');
  if (state === 'outcome_unknown') {
    if (capabilities.confirmQuiescence) actions.push('confirmRemoteQuiescence');
    if (capabilities.recovery) actions.push('recovery.confirm');
  }
  return {
    jobId: row.id,
    state,
    phase,
    quarantined,
    purpose: JOB_PURPOSES.includes(row.purpose) ? row.purpose : 'unknown',
    costStatus: COST_STATUSES.includes(row.cost_status) ? row.cost_status : 'unknown',
    reason: SAFE_REASON.test(row.reason ?? '') ? row.reason : undefined,
    createdAt: typeof row.created_at === 'string' ? row.created_at.slice(0, 40) : undefined,
    repoId: info.repoId,
    expectedGeneration: info.store.generation(),
    actions,
    retryable: false,
    remoteStop: 'not_claimed',
    requiresUserConfirmation: state === 'outcome_unknown',
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Create the management operation table.
 * @param {object} deps - {config, registry, grants, scheduler, provider, extras, now}
 * @returns {{dispatch(request: object): object}}
 */
export function createManagementOperations({config, registry, grants, scheduler, provider, extras, status: statusProjection, onMemoryChange, now = () => new Date()} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Normalized configuration required');
  if (!registry || typeof registry !== 'object' || typeof registry.getProject !== 'function' || typeof registry.list !== 'function' || typeof registry.storeFor !== 'function') throw new Error('Trusted project registry required');
  if (typeof now !== 'function') throw new Error('A clock function is required');
  const extraOperations = extras && typeof extras === 'object' && !Array.isArray(extras) ? extras : {};
  const canConfirm = Boolean(grants && typeof grants.noteUserConfirmation === 'function');
  const fallbackOperations = new Map();

  function clockIso() {
    try {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(+date)) throw new Error('clock');
      return date.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }
  function getProjectRecord(projectId) {
    const project = registry.getProject(checkedInputText(projectId, 'projectId', PROJECT_ID_MAX));
    if (!project) throw fail('PROJECT_NOT_FOUND');
    return project;
  }
  function enabledRepositories(project) {
    return (project.repositories ?? []).filter((repository) => repository.enabled);
  }
  function boundScopes(project, repoId) {
    let repositories = enabledRepositories(project);
    if (repoId !== undefined) {
      const wanted = checkedInputText(repoId, 'repoId', 128);
      repositories = repositories.filter((repository) => repository.repoId === wanted);
      if (!repositories.length) throw fail('REPO_NOT_FOUND');
    }
    if (!repositories.length) throw fail('SCOPE_NOT_FOUND');
    return repositories.map((repository) => ({
      repoId: repository.repoId,
      scopeRef: repository.scopeRef,
      store: registry.storeFor(repository.scopeRef),
    }));
  }
  /** Resolve the project for a request; never trusts a caller-supplied scope string. */
  function resolveProject(projectId) {
    if (projectId !== undefined) return getProjectRecord(projectId);
    let active = [];
    try { active = registry.activeScopes(); } catch { active = []; }
    if (Array.isArray(active) && active.length === 1) {
      const binding = registry.bindingForScope(active[0]);
      if (binding) return getProjectRecord(binding.projectId);
    }
    let all = [];
    try { all = registry.allScopes(); } catch { all = []; }
    if (Array.isArray(all) && all.length === 1) {
      const binding = registry.bindingForScope(all[0]);
      if (binding) return getProjectRecord(binding.projectId);
    }
    throw fail('PROJECT_REQUIRED');
  }
  function locateMemory(scopes, id) {
    for (const info of scopes) {
      const record = info.store.get(id);
      if (record) return {info, record, state: 'active'};
      const archived = archivedRow(info.store, id);
      if (archived?.row) return {info, record: archived.row, state: 'archived'};
      if (archived?.entry) return {info, entry: archived.entry, state: archived.entry.state};
    }
    return undefined;
  }
  function expectGeneration(info, expectedGeneration) {
    integer(expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 'expectedGeneration');
    if (info.store.generation() !== expectedGeneration) throw fail('STALE_GENERATION');
  }
  function recordView(info, located) {
    return located.record ? memoryItem(info, located.record, located.state) : tombstoneItem(info, located.entry);
  }

  function dispatchStatus() {
    const registryStatus = safeStatus('registry', () => registry.status());
    const defaults = {
      schemaVersion: API_SCHEMA_VERSION,
      plugin: {state: 'active', apiPath: API_PATH},
      registry: registryStatus,
      scheduler: scheduler && typeof scheduler.status === 'function' ? safeStatus('scheduler', () => scheduler.status()) : {state: 'unavailable'},
      grants: grants && typeof grants.status === 'function' ? safeStatus('grants', () => grants.status()) : {state: 'unavailable'},
      provider: provider && typeof provider.status === 'function' ? safeStatus('provider', () => provider.status()) : {state: 'unknown'},
      config: {
        schemaVersion: config.schemaVersion,
        profile: config.profile,
        configDigest: config.configDigest,
        extraction: {enabled: config.extraction?.enabled === true},
        recall: {enabled: config.recall?.enabled === true, maxRecords: config.recall?.maxRecords},
        workSummary: {enabled: config.workSummary?.enabled === true},
        reminders: {enabled: config.reminders?.enabled === true},
        reports: {enabled: true},
      },
      semantics: {
        explicitDelete: 'irreversible',
        archive: 'restorable',
        remoteModelData: 'not_revoked',
        backupCopies: 'not-revoked',
        remoteStop: 'not_claimed',
      },
    };
    if (typeof statusProjection !== 'function') return defaults;
    try {
      const provided = statusProjection();
      if (!provided || typeof provided !== 'object' || Array.isArray(provided) || typeof provided.then === 'function') return defaults;
      const sanitized = sanitizeStatusValue(provided);
      if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return defaults;
      return {...defaults, ...sanitized, schemaVersion: API_SCHEMA_VERSION, semantics: defaults.semantics, config: defaults.config};
    } catch {
      return defaults;
    }
  }

  const handlers = {
    status(input) {
      plainObject(input, 'input');
      shape(input, [], 'status');
      return dispatchStatus();
    },
    'project.list'() {
      const projects = registry.list().map(projectView);
      return {projects, total: projects.length};
    },
    'project.register'(input, request) {
      plainObject(input, 'input');
      shape(input, ['name', 'repositories'], 'project.register');
      const name = checkedInputText(input.name, 'project name', 128);
      const repositories = normalizeRepositories(input.repositories);
      const project = registry.registerProject({name, repositories});
      void request;
      return {project: projectView(project), currentRevision: project.revision, state: project.state};
    },
    'project.update'(input, request) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'expectedRevision', 'name', 'repositories', 'reason'], 'project.update');
      const projectId = checkedInputText(input.projectId, 'projectId', PROJECT_ID_MAX);
      const expectedRevision = resolveExpectedRevision(request, input.expectedRevision);
      const name = optionalText(input.name, 'project name', 128);
      const repositories = input.repositories === undefined ? undefined : normalizeRepositories(input.repositories);
      const reason = optionalText(input.reason, 'reason', 2000);
      const project = registry.updateProject({projectId, expectedRevision, name, repositories, reason});
      return {project: projectView(project), currentRevision: project.revision, state: project.state};
    },
    'project.retire'(input, request) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'expectedRevision', 'reason'], 'project.retire');
      const projectId = checkedInputText(input.projectId, 'projectId', PROJECT_ID_MAX);
      const expectedRevision = resolveExpectedRevision(request, input.expectedRevision);
      const reason = checkedInputText(input.reason, 'reason', 2000);
      const project = registry.retireProject({projectId, expectedRevision, reason});
      return {project: projectView(project), currentRevision: project.revision, state: project.state, memoryRetained: true, memoryDeleted: false};
    },
    'project.preference'(input, request) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'expectedRevision', 'key', 'value'], 'project.preference');
      const projectId = checkedInputText(input.projectId, 'projectId', PROJECT_ID_MAX);
      const expectedRevision = resolveExpectedRevision(request, input.expectedRevision);
      if (input.key !== 'extract' && input.key !== 'recall') throw fail('INVALID_INPUT', 'preference key must be extract or recall');
      if (typeof input.value !== 'boolean') throw fail('INVALID_INPUT', 'preference value must be a boolean');
      const project = registry.setPreference({projectId, expectedRevision, key: input.key, value: input.value});
      return {project: projectView(project), currentRevision: project.revision, state: project.state, preference: {key: input.key, value: input.value}};
    },
    'memory.search'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'query', 'mode', 'limit', 'cursor'], 'memory.search');
      if (input.mode !== undefined && input.mode !== 'manual') throw fail('INVALID_INPUT', 'only manual search is available through this API');
      const query = checkedInputText(input.query, 'query', 2000);
      const limit = integer(input.limit ?? MEMORY_LIMIT_DEFAULT, 1, MEMORY_LIMIT_MAX, 'limit');
      const cursor = normalizeCursor(input.cursor, 'cursor');
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const revision = scopeRevision(scopes);
      if (cursor && cursor.revision !== revision) throw fail('STALE_CURSOR');
      const offset = cursor?.offset ?? 0;
      const items = [];
      let exhausted = true;
      for (const info of scopes) {
        const fetch = Math.min(offset + limit + 1, 100);
        const records = info.store.search(query, {limit: fetch});
        for (const record of records) items.push(memoryItem(info, {
          id: record.id, kind: record.kind, text: record.text, origin: record.origin,
          generation: record.generation, created_at: record.createdAt, supersedes: record.supersedes,
          source_ref: record.sourceRef, source_version: record.sourceVersion,
        }, 'active'));
      }
      const page = items.slice(offset, offset + limit);
      if (items.length > offset + limit) exhausted = false;
      return {
        mode: 'manual', query, items: page, hasMore: !exhausted,
        nextCursor: exhausted ? null : {revision, offset: offset + limit},
        revision, projectId: project.projectId,
      };
    },
    'memory.list'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'limit', 'cursor', 'stateFilter'], 'memory.list');
      const limit = integer(input.limit ?? LIST_LIMIT_DEFAULT, 1, LIST_LIMIT_MAX, 'limit');
      const stateFilter = input.stateFilter ?? 'all';
      if (!['all', 'active', 'archived'].includes(stateFilter)) throw fail('INVALID_INPUT', 'stateFilter must be all, active or archived');
      const cursor = normalizeCursor(input.cursor, 'cursor');
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const revision = scopeRevision(scopes);
      if (cursor && cursor.revision !== revision) throw fail('STALE_CURSOR');
      const offset = cursor?.offset ?? 0;
      const counts = {active: 0, archived: 0, deleted: 0, superseded: 0, stale: 0};
      const rows = [];
      for (const info of scopes) {
        const storeCounts = memoryCounts(info.store);
        for (const key of Object.keys(counts)) counts[key] += storeCounts[key] ?? 0;
        const fetch = Math.min(offset + limit + 1, CURSOR_OFFSET_MAX + LIST_LIMIT_MAX + 1);
        for (const row of memoryRows(info.store, {stateFilter, limit: fetch, offset: 0})) rows.push({info, row});
      }
      const page = rows.slice(offset, offset + limit).map(({info, row}) => memoryItem(info, row, row.ledger_state === 'archived' ? 'archived' : 'active'));
      return {
        items: page, counts, total: counts.active + counts.archived,
        nextCursor: rows.length > offset + limit ? {revision, offset: offset + limit} : null,
        revision, projectId: project.projectId, stateFilter,
      };
    },
    'memory.get'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'id'], 'memory.get');
      const id = checkedInputText(input.id, 'id', 256);
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const located = locateMemory(scopes, id);
      if (!located) throw fail('MEMORY_NOT_FOUND');
      const view = recordView(located.info, located);
      const generation = located.info.store.generation();
      return {
        item: view,
        // Flat compatibility fields for the /memory command and model tools: `generation` is the
        // current scope generation accepted as expectedGeneration by the lifecycle operations.
        id: view.id,
        state: view.state,
        generation,
        currentGeneration: generation,
        currentRevision: located.info.store.revision(),
        projectId: project.projectId,
      };
    },
    'memory.correct'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'id', 'text', 'expectedGeneration', 'sourceVersion'], 'memory.correct');
      const text = checkedInputText(input.text, 'memory text', MAX_MEMORY_TEXT);
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const id = checkedInputText(input.id, 'id', 256);
      const located = locateMemory(scopes, id);
      if (!located) throw fail('MEMORY_NOT_FOUND');
      if (located.state !== 'active') throw fail('MEMORY_NOT_ACTIVE');
      const expectedGeneration = input.expectedGeneration === undefined
        ? located.info.store.generation()
        : integer(input.expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 'expectedGeneration');
      expectGeneration(located.info, expectedGeneration);
      const sourceVersion = input.sourceVersion === undefined
        ? `user-correction:${digest(`${id}:${text}:${expectedGeneration}:${clockIso()}`).slice(0, 32)}`
        : checkedInputText(input.sourceVersion, 'source version', 512);
      const record = located.info.store.correct({id, text, sourceVersion, expectedGeneration});
      return {
        item: memoryItem(located.info, {
          id: record.id, kind: record.kind, text: record.text, origin: record.origin,
          generation: record.generation, created_at: record.createdAt, supersedes: record.supersedes,
          source_ref: record.sourceRef, source_version: record.sourceVersion,
        }, 'active'),
        previousId: id,
        previousGeneration: expectedGeneration,
        currentGeneration: located.info.store.generation(),
        currentRevision: located.info.store.revision(),
        state: 'active',
      };
    },
    'memory.archive'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'id', 'expectedGeneration'], 'memory.archive');
      const expectedGeneration = integer(input.expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 'expectedGeneration');
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const id = checkedInputText(input.id, 'id', 256);
      const located = locateMemory(scopes, id);
      if (!located) throw fail('MEMORY_NOT_FOUND');
      if (located.state !== 'active') throw fail('MEMORY_NOT_ACTIVE');
      expectGeneration(located.info, expectedGeneration);
      const result = located.info.store.archive({id, expectedGeneration});
      return {
        id, state: 'archived', restorable: true, bodyRetained: result.bodyRetained === true,
        currentGeneration: result.generation, currentRevision: located.info.store.revision(),
        expectedGeneration: result.generation,
      };
    },
    'memory.restore'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'id', 'expectedGeneration'], 'memory.restore');
      const expectedGeneration = integer(input.expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 'expectedGeneration');
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const id = checkedInputText(input.id, 'id', 256);
      const located = locateMemory(scopes, id);
      if (!located) throw fail('MEMORY_NOT_FOUND');
      if (located.state !== 'archived') throw fail('MEMORY_NOT_ARCHIVED');
      expectGeneration(located.info, expectedGeneration);
      const result = located.info.store.restoreArchived({id, expectedGeneration});
      return {
        id, state: 'active', restorable: false,
        currentGeneration: result.generation, currentRevision: located.info.store.revision(),
        expectedGeneration: result.generation,
      };
    },
    'memory.delete'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'id', 'expectedGeneration'], 'memory.delete');
      const expectedGeneration = integer(input.expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 'expectedGeneration');
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const id = checkedInputText(input.id, 'id', 256);
      const located = locateMemory(scopes, id);
      if (!located) throw fail('MEMORY_NOT_FOUND');
      expectGeneration(located.info, expectedGeneration);
      const result = located.info.store.forget({id, expectedGeneration});
      return {
        id, state: 'forgotten', irreversible: true, restorable: false,
        currentSqliteBodyAndIndexCleared: result.currentSqliteBodyAndIndexCleared === true,
        backupCopies: 'not-revoked',
        remoteModelData: 'not_revoked',
        currentGeneration: result.generation, currentRevision: located.info.store.revision(),
      };
    },
    'task.list'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'stateFilter', 'limit', 'cursor'], 'task.list');
      const limit = integer(input.limit ?? TASK_LIMIT_DEFAULT, 1, TASK_LIMIT_MAX, 'limit');
      let stateFilter;
      if (input.stateFilter !== undefined) {
        stateFilter = Array.isArray(input.stateFilter) ? input.stateFilter : [input.stateFilter];
        if (stateFilter.length < 1 || stateFilter.length > JOB_FILTER_STATES.length || stateFilter.some((state) => !JOB_FILTER_STATES.includes(state))) throw fail('INVALID_INPUT', 'stateFilter contains an unknown job state');
      }
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const capabilities = queueCapabilities(scopes);
      const revision = scopeRevision(scopes);
      const cursor = normalizeCursor(input.cursor, 'cursor');
      if (cursor && cursor.revision !== revision) throw fail('STALE_CURSOR');
      const offset = cursor?.offset ?? 0;
      const rows = [];
      for (const info of scopes) {
        for (const row of jobRows(info.store)) {
          const view = jobView(info, row, capabilities);
          if (stateFilter && !stateFilter.includes(view.state) && !(stateFilter.includes('quarantined') && view.quarantined)) continue;
          rows.push({info, view});
        }
      }
      const items = rows.slice(offset, offset + limit).map((entry) => entry.view);
      return {
        items, total: rows.length,
        nextCursor: rows.length > offset + limit ? {revision, offset: offset + limit} : null,
        revision, projectId: project.projectId,
        capabilities: {cancel: capabilities.cancel, confirmRemoteQuiescence: capabilities.confirmQuiescence, recoveryConfirmation: capabilities.recovery && canConfirm},
      };
    },
    'task.inspect'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'jobId'], 'task.inspect');
      const jobId = checkedInputText(input.jobId, 'jobId', 256);
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      for (const info of scopes) {
        const row = jobRows(info.store).find((candidate) => candidate.id === jobId);
        if (!row) continue;
        const capabilities = queueCapabilities([info]);
        return {
          job: jobView(info, row, capabilities), projectId: project.projectId,
          capabilities: {cancel: capabilities.cancel, confirmRemoteQuiescence: capabilities.confirmQuiescence, recoveryConfirmation: capabilities.recovery && canConfirm},
        };
      }
      throw fail('TASK_NOT_FOUND');
    },
    'task.cancel'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'jobId', 'expectedGeneration'], 'task.cancel');
      const jobId = checkedInputText(input.jobId, 'jobId', 256);
      const expectedGeneration = integer(input.expectedGeneration, 0, Number.MAX_SAFE_INTEGER, 'expectedGeneration');
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const located = findJob(scopes, jobId);
      if (!located) throw fail('TASK_NOT_FOUND');
      expectGeneration(located.info, expectedGeneration);
      if (located.row.state !== 'queued' && located.row.state !== 'running') throw fail('TASK_STATE_CONFLICT');
      let queue;
      try {
        queue = registry.queueFor(located.info.scopeRef);
      } catch {
        throw fail('CANCEL_UNAVAILABLE');
      }
      if (!queue || typeof queue.cancel !== 'function') throw fail('CANCEL_UNAVAILABLE');
      const result = queue.cancel({jobId, expectedGeneration});
      return {
        jobId, localStopRequested: true,
        localCancellationRequested: true,
        remoteStop: 'not_claimed',
        remoteStopConfirmed: false,
        state: result?.state ?? located.row.state,
        originalJobRetried: false,
        currentGeneration: located.info.store.generation(),
      };
    },
    'task.confirmRemoteQuiescence'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'jobId', 'status'], 'task.confirmRemoteQuiescence');
      if (input.status !== 'remote_finished' && input.status !== 'remote_cancel_confirmed') throw fail('INVALID_INPUT', 'status must be remote_finished or remote_cancel_confirmed');
      const jobId = checkedInputText(input.jobId, 'jobId', 256);
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const located = findJob(scopes, jobId);
      if (!located) throw fail('TASK_NOT_FOUND');
      if (located.row.state !== 'outcome_unknown') throw fail('TASK_STATE_CONFLICT');
      if (!canConfirm) throw fail('UNAVAILABLE');
      let queue;
      try {
        queue = registry.queueFor(located.info.scopeRef);
      } catch {
        throw fail('UNAVAILABLE');
      }
      if (!queue || typeof queue.confirmRemoteQuiescence !== 'function') throw fail('UNAVAILABLE');
      // The trusted grant service owns the confirmation reference and verifies it inside the queue.
      const confirmationRef = noteUserConfirmation(grants, {
        action: 'recovery.confirm',
        scopeRef: located.info.scopeRef,
        jobId, status: input.status,
      });
      const result = queue.confirmRemoteQuiescence({jobId, status: input.status, confirmationRef});
      return {
        jobId, status: input.status, released: result?.released === true,
        originalJobRetried: false, retryAttempted: false,
        remoteStop: input.status === 'remote_finished' ? 'declared_finished_by_user' : 'declared_cancel_confirmed_by_user',
        remoteStopVerified: false,
        confirmationRef,
        expiresInMs: USER_CONFIRMATION_TTL_MS,
      };
    },
    'recovery.confirm'(input) {
      plainObject(input, 'input');
      shape(input, ['projectId', 'repoId', 'jobId', 'status'], 'recovery.confirm');
      if (input.status !== 'remote_finished' && input.status !== 'remote_cancel_confirmed') throw fail('INVALID_INPUT', 'status must be remote_finished or remote_cancel_confirmed');
      const jobId = checkedInputText(input.jobId, 'jobId', 256);
      const project = resolveProject(input.projectId);
      const scopes = boundScopes(project, input.repoId);
      const located = findJob(scopes, jobId);
      if (!located) throw fail('TASK_NOT_FOUND');
      if (located.row.state !== 'outcome_unknown') throw fail('TASK_STATE_CONFLICT');
      if (!canConfirm) throw fail('UNAVAILABLE');
      const confirmationRef = noteUserConfirmation(grants, {
        action: 'recovery.confirm',
        scopeRef: located.info.scopeRef,
        jobId,
        status: input.status,
      });
      return {
        jobId, status: input.status, confirmationRef, expiresInMs: USER_CONFIRMATION_TTL_MS,
        remoteStop: 'not_claimed', remoteStopVerified: false, retryAttempted: false,
        scope: 'local_recovery_only',
      };
    },
  };

  function findJob(scopes, jobId) {
    for (const info of scopes) {
      const row = jobRows(info.store).find((candidate) => candidate.id === jobId);
      if (row) return {info, row};
    }
    return undefined;
  }
  function queueCapabilities(scopes) {
    const capabilities = {cancel: false, confirmQuiescence: false, recovery: canConfirm};
    for (const info of scopes) {
      let queue;
      try { queue = registry.queueFor(info.scopeRef); } catch { continue; }
      if (queue && typeof queue.cancel === 'function') capabilities.cancel = true;
      if (queue && typeof queue.confirmRemoteQuiescence === 'function') capabilities.confirmQuiescence = true;
    }
    return capabilities;
  }
  function noteUserConfirmation(service, payload) {
    let result;
    try {
      result = service.noteUserConfirmation(payload);
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
        throw fail('UNAVAILABLE');
      }
    } catch (error) {
      if (error instanceof OperationError) throw error;
      throw fail('UNAVAILABLE');
    }
    if (!result || typeof result !== 'object' || typeof result.confirmationRef !== 'string' || !result.confirmationRef) throw fail('UNAVAILABLE');
    return result.confirmationRef;
  }
  function resolveExpectedRevision(request, fromInput) {
    const value = request?.expectedRevision ?? fromInput;
    return integer(value, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
  }

  /* ---------------------------- dispatch ---------------------------------- */

  function validateRequest(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.getPrototypeOf(request) !== Object.prototype) throw fail('INVALID_REQUEST');
    shape(request, ['operation', 'operationId', 'input', 'expectedRevision', 'actor', 'agent', 'sessionId'], 'request');
    if (typeof request.operation !== 'string' || request.operation.length > 128 || !OPERATION_PATTERN.test(request.operation)) throw fail('INVALID_REQUEST', 'operation is invalid');
    if (request.actor !== 'user' && request.actor !== 'model' && request.actor !== 'host') throw fail('INVALID_REQUEST', 'actor is invalid');
    if (request.operationId !== undefined && (typeof request.operationId !== 'string' || !OPERATION_ID_PATTERN.test(request.operationId))) throw fail('INVALID_REQUEST', 'operationId is invalid');
    if (request.expectedRevision !== undefined) integer(request.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
    if (request.agent !== undefined && (typeof request.agent !== 'object' || request.agent === null)) throw fail('INVALID_REQUEST', 'agent is invalid');
    if (request.sessionId !== undefined && typeof request.sessionId !== 'string') throw fail('INVALID_REQUEST', 'sessionId is invalid');
    const input = request.input === undefined ? {} : request.input;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw fail('INVALID_INPUT', 'input must be a plain object');
    try { clean(input); } catch { throw fail('INVALID_INPUT', 'input is not a bounded plain payload'); }
    return {operation: request.operation, operationId: request.operationId, expectedRevision: request.expectedRevision, actor: request.actor, agent: request.agent, sessionId: request.sessionId, input};
  }
  function requireUser(operation, actor) {
    if (actor === 'user') return;
    if (USER_ONLY_OPERATIONS.has(operation) || USER_ONLY_PREFIXES.some((prefix) => operation.startsWith(prefix))) throw fail('USER_ACTION_REQUIRED');
  }
  function envelopeFor(operation, input, request) {
    const handler = handlers[operation];
    if (handler) return {ok: true, value: handler(input, request)};
    const extra = extraOperations[operation];
    if (typeof extra === 'function') {
      let result;
      try {
        result = extra(input, Object.freeze({actor: request.actor, agent: request.agent, sessionId: request.sessionId}));
      } catch (error) {
        const mapped = mapError(error);
        return {ok: false, error: mapped};
      }
      if (result && typeof result.then === 'function') {
        result.catch(() => {});
        throw fail('INVALID_OPERATION', 'extras operations must be synchronous');
      }
      return normalizeExtraResult(result);
    }
    if (/^(?:work|report|reminder)\./.test(operation)) throw fail('UNAVAILABLE');
    throw fail('UNKNOWN_OPERATION');
  }
  function normalizeExtraResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw fail('INTERNAL_ERROR', 'extras operation returned an invalid envelope');
    if (result.ok) return {ok: true, value: redactExtraValue(result.value)};
    const code = safeCode(result.error?.code) ?? 'INTERNAL_ERROR';
    const message = redactText(result.error?.message ?? ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL_ERROR);
    return {ok: false, error: {code, message: message || ERROR_MESSAGES.INTERNAL_ERROR}};
  }
  function redactExtraValue(value, depth = 0) {
    if (depth > 8) return '[truncated]';
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') {
      if (SECRET_LIKE.test(value)) return '[redacted]';
      return value.replace(/(?:[A-Za-z]:[\\/][^\s"']+|\\\\[^\s"']+)/g, '[redacted-path]');
    }
    if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactExtraValue(item, depth + 1));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, item] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
        out[key] = redactExtraValue(item, depth + 1);
      }
      return out;
    }
    return undefined;
  }
  function fingerprintPayload(request) {
    return fingerprint({operation: request.operation, input: request.input, expectedRevision: request.expectedRevision ?? null, actor: request.actor});
  }
  function replayOrRecord(operation, operationId, payloadFingerprint, execute) {
    if (!operationId || READ_ONLY_OPERATIONS.has(operation)) return execute();
    const catalog = registry.catalog;
    const persistent = catalog && catalog.db && typeof catalog.db.prepare === 'function' && typeof catalog.write === 'function';
    if (persistent) {
      let prior;
      try {
        prior = catalog.db.prepare('SELECT fingerprint,result FROM operations WHERE request_id=?').get(operationId);
      } catch {
        prior = undefined;
      }
      if (prior) {
        if (prior.fingerprint !== payloadFingerprint) throw fail('OPERATION_CONFLICT');
        try { return JSON.parse(prior.result); } catch { throw fail('INTERNAL_ERROR'); }
      }
      const result = execute();
      try {
        catalog.write(() => {
          catalog.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(operationId, payloadFingerprint, JSON.stringify(result));
        });
      } catch {
        /* Losing the durable replay row must not turn a completed mutation into a failure. */
        rememberFallback(operationId, payloadFingerprint, result);
      }
      return result;
    }
    const prior = fallbackOperations.get(operationId);
    if (prior) {
      if (prior.fingerprint !== payloadFingerprint) throw fail('OPERATION_CONFLICT');
      return prior.result;
    }
    const result = execute();
    rememberFallback(operationId, payloadFingerprint, result);
    return result;
  }
  function rememberFallback(operationId, payloadFingerprint, result) {
    if (fallbackOperations.size >= OPERATION_TABLE_LIMIT) {
      const oldest = fallbackOperations.keys().next().value;
      if (oldest !== undefined) fallbackOperations.delete(oldest);
    }
    fallbackOperations.set(operationId, {fingerprint: payloadFingerprint, result});
  }

  function dispatch(request) {
    try {
      const normalized = validateRequest(request);
      requireUser(normalized.operation, normalized.actor);
      const payloadFingerprint = fingerprintPayload(normalized);
      const envelope = replayOrRecord(normalized.operation, normalized.operationId, payloadFingerprint, () => envelopeFor(normalized.operation, normalized.input, normalized));
      if (envelope.ok && typeof onMemoryChange === 'function' && ABSTRACT_AFFECTING_OPERATIONS.has(normalized.operation)) {
        try {
          onMemoryChange(Object.freeze({operation: normalized.operation, projectId: normalized.input.projectId, actor: normalized.actor, sessionId: normalized.sessionId}));
        } catch {
          /* Abstract dirty bookkeeping is best effort; read-time validation still detects invalid basis. */
        }
      }
      return envelope;
    } catch (error) {
      return {ok: false, error: mapError(error)};
    }
  }

  return Object.freeze({dispatch});
}

/* -------------------------------------------------------------------------- */
/* Same-origin HTTP route                                                      */
/* -------------------------------------------------------------------------- */

function transportError(code, message, status) {
  return {status, envelope: {ok: false, error: {code, message}}};
}
function readBody(req, maxBodyBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (finished) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buffer.length;
      if (total > maxBodyBytes) {
        finish({tooLarge: true});
        try { req.resume(); } catch { /* drain is best effort */ }
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => finish({body: Buffer.concat(chunks).toString('utf8')}));
    req.on('error', () => finish({bodyError: true}));
  });
}

/**
 * Create the management HTTP route registration.
 * @param {object} options - {operations, getOrigin, maxBodyBytes}
 * @returns {{path: string, maxBodyBytes: number, dispatch: Function, handler(req,res): Promise<void>}}
 */
export function createManagementHttp({operations, getOrigin, maxBodyBytes = DEFAULT_MAX_BODY_BYTES} = {}) {
  if (!operations || typeof operations.dispatch !== 'function') throw new Error('Management operations are required');
  if (typeof getOrigin !== 'function') throw new Error('A trusted origin reader is required');
  const bodyLimit = integer(maxBodyBytes, 1024, MAX_BODY_BYTES, 'maxBodyBytes');

  function respond(res, status, envelope, extraHeaders = {}) {
    try {
      if (!res || res.headersSent || res.writableEnded) return;
      const body = JSON.stringify(envelope);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...extraHeaders,
      });
      res.end(body);
    } catch {
      /* A disconnected socket must never turn into an unhandled route failure. */
    }
  }
  function trustedOrigin() {
    try {
      const origin = getOrigin();
      return typeof origin === 'string' && origin ? origin : undefined;
    } catch {
      return undefined;
    }
  }
  async function handler(req, res) {
    try {
      if (!req || typeof req.on !== 'function' || !res || typeof res.writeHead !== 'function') return respond(res ?? {}, 500, {ok: false, error: {code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR}});
      if (req.method !== 'POST') return respond(res, 405, {ok: false, error: {code: 'METHOD_NOT_ALLOWED', message: 'POST required'}}, {allow: 'POST'});
      const contentType = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'application/json') return respond(res, 415, {ok: false, error: {code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json'}});
      const origin = req.headers?.origin;
      if (origin !== undefined) {
        const expected = trustedOrigin();
        if (expected === undefined || origin !== expected) return respond(res, 403, {ok: false, error: {code: 'ORIGIN_DENIED', message: 'Request origin is not the local Harness origin'}});
      }
      const read = await readBody(req, bodyLimit);
      if (read.tooLarge) return respond(res, 413, {ok: false, error: {code: 'BODY_TOO_LARGE', message: `Request body exceeds ${bodyLimit} bytes`}});
      if (read.bodyError) return respond(res, 400, {ok: false, error: {code: 'INVALID_REQUEST', message: 'Request body could not be read'}});
      let parsed;
      try {
        parsed = JSON.parse(read.body || '');
      } catch {
        return respond(res, 400, {ok: false, error: {code: 'INVALID_JSON', message: 'Request body must be valid JSON'}});
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
        return respond(res, 400, {ok: false, error: {code: 'INVALID_REQUEST', message: 'Request body must be a JSON object'}});
      }
      if (parsed.schemaVersion !== API_SCHEMA_VERSION) return respond(res, 400, {ok: false, error: {code: 'INVALID_REQUEST', message: 'Unsupported schemaVersion'}});
      if (typeof parsed.operationId !== 'string' || !OPERATION_ID_PATTERN.test(parsed.operationId)) return respond(res, 400, {ok: false, error: {code: 'INVALID_REQUEST', message: 'operationId is invalid'}});
      if (typeof parsed.operation !== 'string' || parsed.operation.length > 128 || !OPERATION_PATTERN.test(parsed.operation)) return respond(res, 400, {ok: false, error: {code: 'INVALID_REQUEST', message: 'operation is invalid'}});
      const envelope = operations.dispatch({
        operation: parsed.operation,
        operationId: parsed.operationId,
        input: parsed.input,
        expectedRevision: parsed.expectedRevision,
        actor: 'user',
      });
      if (!envelope || typeof envelope !== 'object' || typeof envelope.ok !== 'boolean') {
        return respond(res, 200, {ok: false, error: {code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR}});
      }
      return respond(res, 200, envelope);
    } catch {
      return respond(res, 200, {ok: false, error: {code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR}});
    }
  }
  return Object.freeze({path: API_PATH, maxBodyBytes: bodyLimit, dispatch: operations.dispatch, handler});
}
