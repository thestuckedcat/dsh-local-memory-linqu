/**
 * Management operations for annual work records, evidence, reports and proof reminders.
 *
 * `createWorkOperations` returns the plain operation map that `plugin/management.mjs` merges into
 * its dispatch table. Every handler is `(input, context) => {ok:true,value} | {ok:false,error}`:
 * it never throws, never returns absolute local paths and never leaks secret-like text.
 *
 * Scope resolution: a caller may pass `projectId`, otherwise the project is resolved from the
 * trusted session binding (`registry.bindingForSession`). Callers never pass raw `scopeRef`
 * strings; a project may own several repositories/scopes and work ids are searched inside the
 * trusted project scope set only.
 */
import {checkedText} from '../src/scope.mjs';
import {shape, integer} from '../src/validation.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {createCatalogReminders} from '../src/reports.mjs';

const ACTORS = Object.freeze(['user', 'model', 'host']);
const CLAIM_NAMES = Object.freeze(['myContribution', 'processOrConclusion', 'result', 'time', 'goal', 'projectRef', 'requirementRef', 'problemRef', 'problemState']);
const DEFAULT_LIMIT = 50;
const OPERATIONS = Object.freeze([
  'work.list', 'work.get', 'work.correct', 'work.merge', 'work.confirmClaim', 'work.confirmTime',
  'work.evidence.register', 'work.evidence.review', 'report.draft', 'report.list', 'report.get',
  'report.approve', 'report.export', 'reminder.defer', 'reminder.disable',
]);

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function requireObject(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw failure('INVALID_INPUT', 'Operation input must be an object');
  return value;
}
function safeMessage(error) {
  let message = typeof error?.message === 'string' ? error.message : 'Operation failed';
  if (/[A-Za-z]:[\\/]|\\\\/.test(message) || /-----BEGIN|Bearer\s|sk-[A-Za-z0-9_-]{16,}/.test(message)) return 'Operation failed';
  message = message.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return message.slice(0, 300) || 'Operation failed';
}
function errorResponse(error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.code) ? error.code : undefined;
  if (code) return {ok: false, error: {code, message: safeMessage(error)}};
  const message = safeMessage(error);
  if (/User authorization required|user confirmation required|user action/i.test(message)) return {ok: false, error: {code: 'USER_ACTION_REQUIRED', message: 'This operation requires an explicit user action'}};
  if (/not active|Unknown record|not found/i.test(message)) return {ok: false, error: {code: 'WORK_NOT_FOUND', message}};
  if (/Stale/i.test(message)) return {ok: false, error: {code: 'STALE_REVISION', message}};
  if (/Invalid|required|denied|immutable|limit|Unsupported|mismatch|outside|Unknown/i.test(message)) return {ok: false, error: {code: 'INVALID_INPUT', message}};
  return {ok: false, error: {code: 'OPERATION_FAILED', message}};
}
function ok(value) {
  return {ok: true, value};
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
function sanitize(value, {includeEvidenceNotes = false} = {}) {
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, {includeEvidenceNotes})).filter((entry) => entry !== undefined);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'localPath') continue;
      if (!includeEvidenceNotes && (key === 'supportQuote' || key === 'supportNote')) continue;
      const clean = sanitize(entry, {includeEvidenceNotes});
      if (clean !== undefined) result[key] = clean;
    }
    return result;
  }
  if (typeof value === 'string') {
    if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) return undefined;
    return value;
  }
  return value;
}

/**
 * @param {{registry: object, config: object, reports: object, approval?: object,
 *          sessions?: {get?: Function}, now?: () => Date}} deps
 */
export function createWorkOperations({registry, config, reports, approval, sessions, now = () => new Date()} = {}) {
  if (!registry || typeof registry.storeFor !== 'function' || typeof registry.getProject !== 'function') throw failure('REGISTRY_UNAVAILABLE', 'Trusted project registry required');
  if (!config || typeof config !== 'object') throw failure('INVALID_CONFIG', 'Normalized configuration required');
  if (!reports || typeof reports.draft !== 'function' || typeof reports.approve !== 'function' || typeof reports.export !== 'function') throw failure('INVALID_CONFIG', 'Report manager required');
  const catalog = registry.catalog;
  if (!catalog?.db) throw failure('CATALOG_UNAVAILABLE', 'Project catalog is unavailable');
  const reminders = createCatalogReminders(catalog);
  const evidenceRoots = Array.isArray(config.workSummary?.evidenceRoots) ? config.workSummary.evidenceRoots : [];
  const cooldownHours = integer(config.reminders?.cooldownHours ?? 24, 1, 720, 'reminder cooldown');
  const exportRootRef = config.reports?.exportRootRef ?? 'reports';

  function sessionOf(context) {
    if (context.session) return context.session;
    if (context.agent?.session) return context.agent.session;
    if (context.sessionId && typeof sessions?.get === 'function') return sessions.get(context.sessionId);
    return undefined;
  }
  function projectIdOf(input, context) {
    if (input.projectId !== undefined) return checkedText(input.projectId, 'project id', 128);
    const session = sessionOf(context);
    if (session && typeof registry.bindingForSession === 'function') {
      let binding;
      try { binding = registry.bindingForSession(session); } catch { binding = undefined; }
      if (binding?.projectId) return checkedText(binding.projectId, 'project id', 128);
    }
    throw failure('PROJECT_REQUIRED', 'A project id or a bound session is required');
  }
  function projectView(projectId) {
    const project = registry.getProject(projectId);
    if (!project) throw failure('PROJECT_NOT_FOUND', 'Project is not registered');
    return project;
  }
  function requireActive(project) {
    if (project.state !== 'active') throw failure('PROJECT_NOT_ACTIVE', 'Project is retired; records are read-only');
    return project;
  }
  function scopeRefsOf(project) {
    const repositories = Array.isArray(project.repositories) ? project.repositories : [];
    return [...new Set(repositories.filter((repository) => repository.enabled !== false).map((repository) => repository.scopeRef))];
  }
  function storeFor(scopeRef) {
    try {
      const store = registry.storeFor(scopeRef);
      if (!store || typeof store.generation !== 'function') throw new Error('invalid store');
      return store;
    } catch (error) {
      if (typeof error?.code === 'string' && error.code === 'SCOPE_NOT_FOUND') throw error;
      throw failure('STORE_UNAVAILABLE', 'Work record store is unavailable');
    }
  }
  function authorizeFor(context, {readEvidence = false} = {}) {
    return (request) => {
      if (context.actor !== 'user') return false;
      if (request?.action === 'readEvidence' || request?.action === 'reviewEvidence') return readEvidence === true || context.userConfirmed === true;
      return true;
    };
  }
  function managerFor(scopeRef, context, options = {}) {
    return createWorkSummaryManager(storeFor(scopeRef), {evidenceRoots, authorize: authorizeFor(context, options)});
  }
  function locate(project, workId, context, options = {}) {
    const id = checkedText(workId, 'work id', 256);
    for (const scopeRef of scopeRefsOf(project)) {
      const manager = managerFor(scopeRef, context, options);
      const row = manager.get(id);
      if (row) return {scopeRef, manager, row};
    }
    throw failure('WORK_NOT_FOUND', 'Work summary is not active in this project');
  }
  function draftReport(projectIds, timeRange, extra, context) {
    const authorizeEvidence = context.actor === 'user' ? () => true : undefined;
    return reports.draft({projectIds, timeRange, ...extra, actor: context.actor, ...(authorizeEvidence ? {authorizeEvidence} : {})});
  }
  /**
   * Evidence content read is a user action. The management dispatcher is synchronous, so this
   * function accepts three synchronous forms of an explicit user decision:
   *  - `context.userConfirmed === true` (the Host/HTTP layer already obtained user approval);
   *  - `approval.decideRead(...)` / `approval.request(...)` returning a non-thenable decision
   *    (`allowed-once` / `allowed` / `true`);
   *  - a synchronous `approval.request` result.
   * If the approval service returns a Promise (the normal Host `ctx.approval.request` contract is
   * async), the read cannot be confirmed inside a synchronous dispatch: the caller must pre-resolve
   * the approval and pass `userConfirmed:true`, otherwise USER_ACTION_REQUIRED is returned.
   */
  function evidenceApproved(context) {
    if (context.actor !== 'user') throw failure('USER_ACTION_REQUIRED', 'Reading proof content requires an explicit user action');
    if (context.userConfirmed === true) return true;
    const request = typeof approval?.decideRead === 'function' ? approval.decideRead : approval?.request;
    if (typeof request === 'function') {
      let decision;
      try {
        decision = request({
          agent: context.agent,
          toolName: 'work.evidence.review',
          operation: 'work.evidence.review',
          signal: context.signal,
        });
      } catch {
        throw failure('USER_ACTION_REQUIRED', 'Proof read approval is unavailable');
      }
      if (decision && typeof decision.then === 'function') {
        Promise.resolve(decision).catch(() => {});
        throw failure('USER_ACTION_REQUIRED', 'Proof read approval must be confirmed before dispatch');
      }
      const normalized = typeof decision === 'string' ? decision : decision?.decision ?? decision?.outcome ?? decision?.status;
      if (normalized === 'allowed-once' || normalized === 'allowed' || normalized === true) return true;
      throw failure('USER_ACTION_REQUIRED', 'Proof read was not approved');
    }
    throw failure('USER_ACTION_REQUIRED', 'Proof read requires an explicit user confirmation');
  }

  const handlers = {
    'work.list': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'limit', 'cursor'], 'work list');
      const context = normalizeContext(rawContext);
      const project = projectView(projectIdOf(input, context));
      const limit = integer(input.limit ?? DEFAULT_LIMIT, 1, 200, 'work limit');
      let offset = 0;
      if (input.cursor !== undefined) {
        shape(input.cursor, ['offset'], 'work cursor');
        offset = integer(input.cursor.offset, 0, 100000, 'work cursor offset');
      }
      const collected = [];
      for (const scopeRef of scopeRefsOf(project)) {
        const manager = managerFor(scopeRef, context);
        const listed = manager.list({limit: 500});
        for (const row of listed.items) collected.push({projectId: project.projectId, scopeRef, ...sanitize(row, {includeEvidenceNotes: context.actor === 'user'})});
      }
      collected.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
      const total = collected.length;
      const items = collected.slice(offset, offset + limit);
      return ok({
        items,
        total,
        nextCursor: offset + limit < total ? {offset: offset + limit} : null,
        project: {projectId: project.projectId, name: project.name, state: project.state},
      });
    },

    'work.get': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id'], 'work get');
      const context = normalizeContext(rawContext);
      const project = projectView(projectIdOf(input, context));
      const found = locate(project, input.id, context);
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(found.row, {includeEvidenceNotes: context.actor === 'user'})});
    },

    'work.correct': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id', 'draft', 'sources', 'expectedGeneration'], 'work correct');
      const context = normalizeContext(rawContext);
      userAction(context, 'Work correction');
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.id, context);
      const result = found.manager.correct({id: found.row.id, draft: input.draft, sources: input.sources, expectedGeneration: input.expectedGeneration});
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(result)});
    },

    'work.merge': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id', 'draft', 'sources', 'expectedGeneration'], 'work merge');
      const context = normalizeContext(rawContext);
      userAction(context, 'Work merge');
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.id, context);
      const result = found.manager.merge({id: found.row.id, draft: input.draft, sources: input.sources, origin: 'user', expectedGeneration: input.expectedGeneration});
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(result)});
    },

    'work.confirmClaim': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id', 'claimRef', 'expectedGeneration'], 'work claim confirmation');
      const context = normalizeContext(rawContext);
      userAction(context, 'Contribution confirmation');
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.id, context);
      const result = found.manager.confirmClaim({id: found.row.id, claimRef: input.claimRef, expectedGeneration: input.expectedGeneration});
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(result)});
    },

    'work.confirmTime': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id', 'expectedGeneration'], 'work time confirmation');
      const context = normalizeContext(rawContext);
      userAction(context, 'Work time confirmation');
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.id, context);
      const result = found.manager.confirmTime({id: found.row.id, expectedGeneration: input.expectedGeneration});
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(result)});
    },

    'work.evidence.register': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id', 'reference', 'claimRefs', 'expectedGeneration'], 'evidence registration');
      const context = normalizeContext(rawContext);
      userAction(context, 'Evidence registration');
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.id, context);
      const result = found.manager.registerEvidence({
        id: found.row.id,
        reference: input.reference,
        claimRefs: input.claimRefs,
        expectedGeneration: input.expectedGeneration,
      });
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(result)});
    },

    'work.evidence.review': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'id', 'evidenceRef', 'claimRef', 'assessment', 'expectedGeneration'], 'evidence review');
      const context = normalizeContext(rawContext);
      userAction(context, 'Evidence review');
      evidenceApproved(context);
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.id, context, {readEvidence: true});
      const result = found.manager.reviewEvidence({
        id: found.row.id,
        evidenceRef: input.evidenceRef,
        claimRef: input.claimRef,
        assessment: input.assessment,
        expectedGeneration: input.expectedGeneration,
      });
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, ...sanitize(result)});
    },

    'report.draft': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectIds', 'timeRange', 'workRefs', 'templateRef'], 'report draft');
      const context = normalizeContext(rawContext);
      const report = draftReport(input.projectIds, input.timeRange, {
        ...(input.workRefs === undefined ? {} : {workRefs: input.workRefs}),
        ...(input.templateRef === undefined ? {} : {templateRef: input.templateRef}),
      }, context);
      return ok(report);
    },

    'report.list': (rawInput) => {
      const input = requireObject(rawInput);
      shape(input, ['limit'], 'report list');
      return ok(reports.list({limit: input.limit ?? 20}));
    },

    'report.get': (rawInput) => {
      const input = requireObject(rawInput);
      shape(input, ['reportId'], 'report get');
      return ok(reports.get(input.reportId));
    },

    'report.approve': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['reportId', 'reportDigest', 'sourceRevisions'], 'report approval');
      const context = normalizeContext(rawContext);
      userAction(context, 'Report approval');
      return ok(reports.approve({reportId: input.reportId, reportDigest: input.reportDigest, sourceRevisions: input.sourceRevisions, actor: 'user'}));
    },

    'report.export': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['reportId', 'revision', 'format', 'outputRootRef', 'includeLocalPaths'], 'report export');
      const context = normalizeContext(rawContext);
      userAction(context, 'Report export');
      return ok(reports.export({
        reportId: input.reportId,
        revision: input.revision,
        format: input.format,
        actor: 'user',
        ...(input.outputRootRef === undefined ? {} : {outputRootRef: input.outputRootRef}),
        ...(input.includeLocalPaths === undefined ? {} : {includeLocalPaths: input.includeLocalPaths}),
      }));
    },

    'reminder.defer': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'recordId', 'claimRef', 'hours'], 'reminder defer');
      const context = normalizeContext(rawContext);
      userAction(context, 'Reminder deferral');
      const project = requireActive(projectView(projectIdOf(input, context)));
      const found = locate(project, input.recordId, context);
      const claimRef = checkedText(input.claimRef, 'claim reference', 128);
      if (!CLAIM_NAMES.includes(claimRef)) throw failure('INVALID_INPUT', 'Unknown claim reference');
      const hours = integer(input.hours ?? cooldownHours, 1, 720, 'reminder defer hours');
      const at = now instanceof Function ? now() : new Date();
      const result = reminders.deferReminder({
        scopeRef: found.scopeRef,
        recordId: found.row.id,
        claimRef,
        recordGeneration: found.row.generation,
        hours,
        now: () => at,
      });
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, recordId: found.row.id, claimRef, hours, deferredUntil: result.lastShownAt});
    },

    'reminder.disable': (rawInput, rawContext) => {
      const input = requireObject(rawInput);
      shape(input, ['projectId', 'recordId', 'claimRef'], 'reminder disable');
      const context = normalizeContext(rawContext);
      userAction(context, 'Reminder disable');
      const project = requireActive(projectView(projectIdOf(input, context)));
      if (input.recordId === undefined) return ok({projectId: project.projectId, ...reminders.setProjectReminders(project.projectId, false)});
      if (input.claimRef === undefined) throw failure('INVALID_INPUT', 'A claim reference is required to disable one reminder');
      const found = locate(project, input.recordId, context);
      const claimRef = checkedText(input.claimRef, 'claim reference', 128);
      if (!CLAIM_NAMES.includes(claimRef)) throw failure('INVALID_INPUT', 'Unknown claim reference');
      reminders.disableReminder({scopeRef: found.scopeRef, recordId: found.row.id, claimRef, recordGeneration: found.row.generation});
      return ok({projectId: project.projectId, scopeRef: found.scopeRef, recordId: found.row.id, claimRef, disabled: true});
    },
  };

  const operations = {};
  for (const name of OPERATIONS) {
    const handler = handlers[name];
    operations[name] = (input, context) => {
      try {
        return handler(input, context);
      } catch (error) {
        return errorResponse(error);
      }
    };
  }
  return Object.freeze(operations);
}

export {OPERATIONS as WORK_MANAGEMENT_OPERATIONS};
