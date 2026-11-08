/**
 * Management operations for project abstracts (M2) and cross-project sharing.
 *
 * `createM2Operations` returns the plain operation map that `plugin/management.mjs` merges in as
 * `extras`. Every handler is `(input, context) => {ok:true,value} | {ok:false,error}`: it never
 * throws, never returns an absolute local path and never upgrades unverified content.
 *
 * Authorization boundary (design §3.5): only a `user` actor may refresh an abstract or grant /
 * revoke a share. Model-facing tools call this table with `actor:'model'`; the three user-only
 * handlers reject that here as well, so the guarantee does not depend on `USER_ONLY_OPERATIONS`
 * in `plugin/management.mjs` being updated (that list is Lead-owned).
 *
 * Scope resolution: `abstract.list`/`abstract.refresh`/`share.discover`/`shared.search` use an
 * explicit project id when the caller supplies one, otherwise the trusted session binding
 * (`registry.bindingForSession(sessions.get(sessionId))`); if neither resolves, `PROJECT_REQUIRED`.
 * Callers never pass raw `scopeRef` strings.
 */
import {randomUUID} from 'node:crypto';
import {checkedText} from '../src/scope.mjs';
import {shape, integer} from '../src/validation.mjs';

const ACTORS = Object.freeze(['user', 'model', 'host']);
const PROJECT_ID_MAX = 128;
const RELATION_ID_MAX = 256;
const QUERY_MAX = 2000;
const DECISION_BASIS_MAX = 2000;
const PERMISSION_REF_MAX = 512;
const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 20;
const MAX_STRING = 12000;
const MAX_ARRAY = 500;
const MAX_OBJECT_KEYS = 200;
const PERMISSION_REF_PREFIX = 'local-user-grant-v1:';

const ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])/;
const SECRET_LIKE = /-----BEGIN (?:\w+ )?PRIVATE KEY-----|\bBearer\s+[^\s]{8,}|\bsk-[A-Za-z0-9_-]{16,}/i;
const UNSAFE_KEY = /(?:dataRoot|databasePath|canonicalRoot|worktreeRoot|localPath|exportRoot|^path$|^paths$|^root$|^roots$|^dir$|^directory$|^file$|^files$)/i;
const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The seven M2 management operations, in contract order (§3.4). */
export const M2_OPERATIONS = Object.freeze([
  'abstract.list', 'abstract.refresh', 'share.discover', 'share.list', 'share.grant', 'share.revoke', 'shared.search',
]);
/** Operations whose caller must be the user, enforced by this table independently of management.mjs. */
const USER_ONLY_OPERATIONS = Object.freeze(['abstract.refresh', 'share.grant', 'share.revoke']);

const MESSAGES = Object.freeze({
  PROJECT_REQUIRED: 'A projectId is required because the caller is not bound to one project',
  USER_ACTION_REQUIRED: 'This operation can only be performed by the user',
  INVALID_INPUT: 'An input field is invalid',
  PROJECT_NOT_FOUND: 'The project is not registered',
  PROJECT_RETIRED: 'The project is retired; this sharing action requires an active project',
  INVALID_SHARE: 'The share relation is invalid: source and target must differ and both be registered',
  ABSTRACT_UNAVAILABLE: 'No abstract is available for this project',
  STALE_ABSTRACT: 'The source abstract changed since it was read; rediscover and grant again',
  SHARE_DENIED: 'No active share relation permits this read',
  RELATION_NOT_FOUND: 'The share relation was not found',
  REGISTRY_UNAVAILABLE: 'The project registry is unavailable',
  CATALOG_UNAVAILABLE: 'The project catalog is unavailable',
  STORE_UNAVAILABLE: 'The memory store is unavailable',
  M2_OPERATION_FAILED: 'The M2 operation could not be completed',
});
/**
 * Error codes the M2 managers are allowed to surface (§3.2) plus this table's own input and
 * availability codes. Anything else is sanitized to M2_OPERATION_FAILED.
 */
const PASSTHROUGH_CODES = new Set([
  'PROJECT_REQUIRED', 'USER_ACTION_REQUIRED', 'INVALID_INPUT',
  'PROJECT_NOT_FOUND', 'PROJECT_RETIRED', 'INVALID_SHARE', 'ABSTRACT_UNAVAILABLE', 'STALE_ABSTRACT',
  'SHARE_DENIED', 'RELATION_NOT_FOUND',
  'REGISTRY_UNAVAILABLE', 'CATALOG_UNAVAILABLE', 'STORE_UNAVAILABLE',
]);
/**
 * Last-resort mapping for managers that throw plain Errors. Only unambiguous phrases are mapped:
 * an unknown failure stays M2_OPERATION_FAILED instead of being guessed into a denial.
 */
const MESSAGE_MAPPINGS = Object.freeze([
  [/relation .*not found|unknown relation/i, 'RELATION_NOT_FOUND'],
  [/stale abstract|abstract revision (?:changed|mismatch)/i, 'STALE_ABSTRACT'],
  [/no abstract|abstract (?:is )?unavailable|abstract .*missing/i, 'ABSTRACT_UNAVAILABLE'],
  [/no active share|share denied|sharing is not permitted/i, 'SHARE_DENIED'],
  [/project is retired|retired project/i, 'PROJECT_RETIRED'],
  [/unknown project|project .*not (?:registered|found)/i, 'PROJECT_NOT_FOUND'],
  [/registry is not ready|registry is unavailable|normalized configuration required/i, 'REGISTRY_UNAVAILABLE'],
  [/catalog is unavailable|catalog unavailable/i, 'CATALOG_UNAVAILABLE'],
]);

class M2OperationError extends Error {
  constructor(code, message = MESSAGES[code] ?? MESSAGES.M2_OPERATION_FAILED) {
    super(message);
    this.name = 'M2ManagementError';
    this.code = code;
  }
}
function failure(code, message) {
  return new M2OperationError(code, message);
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function safeCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;
}
function safeMessage(error, code) {
  const fallback = MESSAGES[code] ?? MESSAGES.M2_OPERATION_FAILED;
  let message = typeof error?.message === 'string' ? error.message : '';
  if (!message) return fallback;
  if (ABSOLUTE_PATH.test(message) || SECRET_LIKE.test(message)) return fallback;
  message = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return message.slice(0, 300) || fallback;
}
function mappedCode(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (!message) return undefined;
  for (const [pattern, code] of MESSAGE_MAPPINGS) if (pattern.test(message)) return code;
  return undefined;
}
/** Convert any thrown value into a bounded, path-free error envelope. */
function errorResponse(error) {
  const declared = safeCode(error?.code);
  const code = declared && PASSTHROUGH_CODES.has(declared) ? declared : mappedCode(error);
  if (code) return {ok: false, error: {code, message: safeMessage(error, code)}};
  return {ok: false, error: {code: 'M2_OPERATION_FAILED', message: MESSAGES.M2_OPERATION_FAILED}};
}
/**
 * Recursively enforce the response contract: no absolute paths, no secret-like text, no path-shaped
 * keys, no exotic prototypes, bounded depth/size. This is the last gate before the dispatcher's own
 * redaction, so a single operation cannot leak a host path by returning a raw manager view.
 */
function sanitizeValue(value, depth = 0) {
  if (depth > 8) return '[truncated]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (SECRET_LIKE.test(value)) return '[redacted]';
    const clean = value.replace(/(?:[A-Za-z]:[\\/][^\s"']+|\\\\[^\s"']+)/g, '[redacted-path]');
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    if (value instanceof Date) {
      const time = +value;
      return Number.isFinite(time) ? value.toISOString() : undefined;
    }
    let proto;
    try { proto = Object.getPrototypeOf(value); } catch { return '[unavailable]'; }
    if (proto !== Object.prototype && proto !== null) return '[unavailable]';
    const out = {};
    let written = 0;
    for (const [key, item] of Object.entries(value)) {
      if (written >= MAX_OBJECT_KEYS) break;
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      if (!SAFE_KEY.test(key) || UNSAFE_KEY.test(key)) continue;
      const clean = sanitizeValue(item, depth + 1);
      if (clean !== undefined) {
        out[key] = clean;
        written++;
      }
    }
    return out;
  }
  return undefined;
}
function ok(value) {
  return {ok: true, value: sanitizeValue(value)};
}

/* ------------------------------- input helpers ---------------------------- */

function requireObject(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw failure('INVALID_INPUT', 'Operation input must be an object');
  return value;
}
function checkedShape(value, fields, label) {
  try {
    shape(value, fields, label);
  } catch {
    throw failure('INVALID_INPUT', `Invalid ${label} input`);
  }
}
function text(value, label, max) {
  try {
    return checkedText(value, label, max);
  } catch {
    throw failure('INVALID_INPUT', `Invalid ${label}`);
  }
}
function optionalText(value, label, max) {
  return value === undefined ? undefined : text(value, label, max);
}
function bounded(value, min, max, label) {
  try {
    return integer(value, min, max, label);
  } catch {
    throw failure('INVALID_INPUT', `Invalid ${label}`);
  }
}
function normalizeContext(context) {
  if (context === undefined || context === null) return Object.freeze({actor: 'model'});
  if (!isPlainObject(context)) throw failure('INVALID_INPUT', 'Operation context must be an object');
  const actor = context.actor === undefined ? 'model' : context.actor;
  if (!ACTORS.includes(actor)) throw failure('INVALID_INPUT', 'Unknown operation actor');
  return context;
}
function userAction(context, label) {
  if (context.actor !== 'user') throw failure('USER_ACTION_REQUIRED', `${label} requires an explicit user action`);
}
/** The management dispatcher is synchronous: a thenable result is a programming error, not a value. */
function assertSync(value, label) {
  if (value && typeof value.then === 'function') {
    try { value.catch(() => {}); } catch { /* detached */ }
    throw failure('M2_OPERATION_FAILED', `${label} must be synchronous`);
  }
  return value;
}
function plainResult(value, label) {
  if (!isPlainObject(value)) throw failure('M2_OPERATION_FAILED', `${label} is unavailable`);
  return value;
}
function abstractResult(value) {
  if (value === undefined || value === null) throw failure('ABSTRACT_UNAVAILABLE');
  return plainResult(value, 'abstract view');
}
function resultList(value, label) {
  if (!Array.isArray(value)) throw failure('M2_OPERATION_FAILED', `${label} is unavailable`);
  return value.filter(isPlainObject);
}

/* -------------------------------------------------------------------------- */

/**
 * Create the M2 management operation table.
 * @param {object} deps - {registry, abstracts, sharing, sessions, now}
 * @returns {Readonly<Record<string, (input: object, context: object) => object>>}
 */
export function createM2Operations({registry, abstracts, sharing, sessions, now = () => new Date()} = {}) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)) throw new Error('Trusted project registry required');
  if (!abstracts || typeof abstracts.read !== 'function' || typeof abstracts.refresh !== 'function') throw new Error('Abstract manager with read/refresh is required');
  if (!sharing || ['discover', 'list', 'grant', 'revoke', 'resolve'].some((name) => typeof sharing[name] !== 'function')) throw new Error('Sharing manager with discover/list/grant/revoke/resolve is required');
  if (typeof now !== 'function') throw new Error('A clock function is required');
  const sessionReader = sessions && typeof sessions.get === 'function' ? sessions : undefined;

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
  function sessionOf(context) {
    if (context?.session) return context.session;
    if (context?.agent?.session) return context.agent.session;
    if (context?.sessionId !== undefined && sessionReader) {
      try { return sessionReader.get(context.sessionId); } catch { return undefined; }
    }
    return undefined;
  }
  /** Resolve a project from the trusted session binding only; never from a call-supplied path. */
  function boundProjectId(context) {
    const session = sessionOf(context);
    if (!session || typeof registry.bindingForSession !== 'function') return undefined;
    let binding;
    try { binding = registry.bindingForSession(session); } catch { return undefined; }
    if (!binding || typeof binding.projectId !== 'string' || !binding.projectId.trim()) return undefined;
    try { return checkedText(binding.projectId, 'bound project id', PROJECT_ID_MAX); } catch { return undefined; }
  }
  function projectIdOf(input, context, field = 'projectId') {
    const bound = boundProjectId(context);
    if (input[field] !== undefined) {
      const value = text(input[field], 'project id', PROJECT_ID_MAX);
      // An explicit target is a user-facing extension (HTTP has no session binding). A model or
      // host caller may only ever name its own bound project, never another project's id.
      if ((context?.actor ?? 'model') !== 'user') {
        if (!bound || value !== bound) throw failure('USER_ACTION_REQUIRED');
      }
      return value;
    }
    if (bound) return bound;
    throw failure('PROJECT_REQUIRED');
  }

  const handlers = {
    'abstract.list': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      checkedShape(input, ['projectId'], 'abstract list');
      const context = normalizeContext(rawContext);
      const projectId = projectIdOf(input, context);
      const view = abstractResult(assertSync(abstracts.read({projectId, forceRefresh: false}), 'abstracts.read'));
      return {projectId: view.projectId ?? projectId, ...view, observedAt: clockIso()};
    },

    'abstract.refresh': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      checkedShape(input, ['projectId'], 'abstract refresh');
      const context = normalizeContext(rawContext);
      userAction(context, 'Abstract refresh');
      const projectId = projectIdOf(input, context);
      const view = abstractResult(assertSync(abstracts.refresh({projectId, reason: 'manual'}), 'abstracts.refresh'));
      return {projectId: view.projectId ?? projectId, ...view};
    },

    'share.discover': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      checkedShape(input, ['targetProjectId'], 'share discover');
      const context = normalizeContext(rawContext);
      const targetProjectId = projectIdOf(input, context, 'targetProjectId');
      const sources = resultList(assertSync(sharing.discover({targetProjectId}), 'sharing.discover'), 'shared source list');
      return {targetProjectId, sources, total: sources.length, observedAt: clockIso()};
    },

    'share.list': (rawInput) => {
      const input = requireObject(rawInput);
      checkedShape(input, ['targetProjectId', 'sourceProjectId'], 'share list');
      const targetProjectId = optionalText(input.targetProjectId, 'target project id', PROJECT_ID_MAX);
      const sourceProjectId = optionalText(input.sourceProjectId, 'source project id', PROJECT_ID_MAX);
      const relations = resultList(assertSync(sharing.list({
        ...(targetProjectId === undefined ? {} : {targetProjectId}),
        ...(sourceProjectId === undefined ? {} : {sourceProjectId}),
      }), 'sharing.list'), 'share relation list');
      return {
        ...(targetProjectId === undefined ? {} : {targetProjectId}),
        ...(sourceProjectId === undefined ? {} : {sourceProjectId}),
        relations, total: relations.length, observedAt: clockIso(),
      };
    },

    'share.grant': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      checkedShape(input, ['sourceProjectId', 'targetProjectId', 'abstractRevision', 'decisionBasis', 'permissionRef'], 'share grant');
      const context = normalizeContext(rawContext);
      userAction(context, 'Share grant');
      const sourceProjectId = text(input.sourceProjectId, 'source project id', PROJECT_ID_MAX);
      const targetProjectId = text(input.targetProjectId, 'target project id', PROJECT_ID_MAX);
      const abstractRevision = bounded(input.abstractRevision, 1, Number.MAX_SAFE_INTEGER, 'abstract revision');
      const decisionBasis = text(input.decisionBasis, 'decision basis', DECISION_BASIS_MAX);
      const suppliedPermissionRef = optionalText(input.permissionRef, 'permission reference', PERMISSION_REF_MAX);
      const permissionRef = suppliedPermissionRef ?? `${PERMISSION_REF_PREFIX}${randomUUID()}`;
      const relation = plainResult(assertSync(sharing.grant({
        sourceProjectId, targetProjectId, abstractRevision, decisionBasis, permissionRef,
      }), 'sharing.grant'), 'share relation');
      const storedPermissionRef = typeof relation.permissionRef === 'string' && relation.permissionRef ? relation.permissionRef : permissionRef;
      return {
        ...relation,
        permissionRef: storedPermissionRef,
        permissionRefGenerated: suppliedPermissionRef === undefined,
        userAction: 'share.grant',
      };
    },

    'share.revoke': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      checkedShape(input, ['relationId'], 'share revoke');
      const context = normalizeContext(rawContext);
      userAction(context, 'Share revoke');
      const relationId = text(input.relationId, 'relation id', RELATION_ID_MAX);
      const relation = plainResult(assertSync(sharing.revoke({relationId}), 'sharing.revoke'), 'share relation');
      return {relationId, ...relation, userAction: 'share.revoke'};
    },

    'shared.search': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      // `targetProjectId` is an optional extension for the user-facing memory center: the HTTP route
      // has no session binding, so the UI must name the target project explicitly. The documented
      // model tool only supplies sourceProjectId/query/limit and resolves the target from the session.
      checkedShape(input, ['targetProjectId', 'sourceProjectId', 'query', 'limit'], 'shared search');
      const context = normalizeContext(rawContext);
      const targetProjectId = projectIdOf(input, context, 'targetProjectId');
      const sourceProjectId = text(input.sourceProjectId, 'source project id', PROJECT_ID_MAX);
      const query = text(input.query, 'query', QUERY_MAX);
      const limit = input.limit === undefined ? SEARCH_LIMIT_DEFAULT : bounded(input.limit, 1, SEARCH_LIMIT_MAX, 'limit');
      const result = plainResult(assertSync(sharing.resolve({targetProjectId, sourceProjectId, query, limit}), 'sharing.resolve'), 'shared search result');
      const items = resultList(result.items ?? [], 'shared search items').map((item) => ({
        ...item,
        verification: 'unverified',
        projectId: item.projectId ?? sourceProjectId,
        sourceProjectId: item.sourceProjectId ?? sourceProjectId,
        // A manager that omits applicability must not be read as "current": fail closed.
        applicability: typeof item.applicability === 'string' ? item.applicability : 'unavailable',
      }));
      return {relation: result.relation ?? null, abstractRevision: result.abstractRevision ?? null, items};
    },
  };

  const operations = {};
  for (const name of M2_OPERATIONS) {
    const handler = handlers[name];
    operations[name] = (input, context) => {
      try {
        return ok(handler(input, context));
      } catch (error) {
        return errorResponse(error);
      }
    };
  }
  return Object.freeze(operations);
}

export {USER_ONLY_OPERATIONS as M2_USER_ONLY_OPERATIONS};
