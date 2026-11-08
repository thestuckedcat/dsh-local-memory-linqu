import {join} from 'node:path';
import {checkedPath, checkedText, digest} from '../src/scope.mjs';
import {fingerprint} from '../src/validation.mjs';

const CONFIG_VERSION = 1;
const DEFAULT_DATA_ROOT = 'E:/dsh-data/05-local-memory';
const ROUTE_LIMIT = 16;
const PROJECT_LIMIT = 64;
const REPOSITORY_LIMIT = 16;
const EVIDENCE_ROOT_LIMIT = 8;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCAL_PATH_PATTERN = /^[A-Za-z]:[\\/][^:*?"<>|\r\n]+$/;

export const LIMIT_CAPS = Object.freeze({
  dailyRequests: 100, sessionRequests: 20, dailyInputChars: 320000, dailyOutputTokens: 20000, maxOutputTokens: 2048,
});
export const DEFAULTS = Object.freeze({
  schemaVersion: CONFIG_VERSION,
  dataRoot: DEFAULT_DATA_ROOT,
  profile: '',
  routes: Object.freeze([Object.freeze({routeRef: 'memory-default', provider: 'deepseek-official', model: 'deepseek-flash'})]),
  extraction: Object.freeze({routeRef: 'memory-default', enabled: true, maxMemories: 5, minInputChars: 1}),
  recall: Object.freeze({enabled: true, maxRecords: 5, maxChars: 4000, maxTokens: 4096}),
  projects: Object.freeze([]),
  scheduler: Object.freeze({pollMs: 1000, concurrency: 1, jobTimeoutMs: 10000, recoverOnStart: true}),
  limits: Object.freeze({dailyRequests: 20, sessionRequests: 5, dailyInputChars: 80000, dailyOutputTokens: 4096, maxOutputTokens: 512}),
  workSummary: Object.freeze({enabled: true, routeRef: '', evidenceRoots: Object.freeze([])}),
  reminders: Object.freeze({enabled: true, cooldownHours: 24, maxItems: 3}),
  reports: Object.freeze({exportRootRef: null, maxItems: 200}),
  abstracts: Object.freeze({pollMs: 600000, dirtyCountThreshold: 10, ageHours: 24}),
  consolidation: Object.freeze({enabled: false, routeRef: '', dirtyCountThreshold: 10, maxWaitHours: 1, maxMemories: 8}),
  security: Object.freeze({rejectNonLocalPaths: true}),
});

class ConfigError extends Error {
  constructor(reason) {
    super(`Invalid local-memory configuration: ${reason}`);
    this.name = 'MemoryConfigError';
    this.code = 'INVALID_CONFIG';
    this.reason = reason;
  }
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ConfigError(`${label} must be a plain object`);
  return value;
}
function keys(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ConfigError(`${label} has unsupported field ${unknown[0]}`);
  return value;
}
function bool(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ConfigError(`${label} must be a boolean`);
  return value;
}
function integer(value, min, max, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ConfigError(`${label} must be an integer ${min}..${max}`);
  return value;
}
function text(value, label, max = 512) {
  return checkedText(value, label, max);
}
function localPath(value, label) {
  if (typeof value !== 'string' || !LOCAL_PATH_PATTERN.test(value) || /^[\\/]{2}/.test(value)) throw new ConfigError(`${label} must be an absolute local drive path`);
  return checkedPath(value.replace(/\//g, '\\'));
}
function freezeJSON(value) {
  const copy = structuredClone(value);
  function lock(current) {
    if (current && typeof current === 'object') { for (const child of Object.values(current)) lock(child); Object.freeze(current); }
    return current;
  }
  return lock(copy);
}

function projectEntries(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > PROJECT_LIMIT) throw new ConfigError(`projects must be an array of at most ${PROJECT_LIMIT} entries`);
  const names = new Set();
  return value.map((entry, projectIndex) => {
    plain(entry, `projects[${projectIndex}]`);
    keys(entry, ['name', 'repositories'], `projects[${projectIndex}]`);
    const name = text(entry.name, 'project name', 128);
    if (names.has(name)) throw new ConfigError('project names must be unique');
    names.add(name);
    if (!Array.isArray(entry.repositories) || entry.repositories.length < 1 || entry.repositories.length > REPOSITORY_LIMIT) throw new ConfigError(`projects[${projectIndex}].repositories must contain 1..${REPOSITORY_LIMIT} entries`);
    const repoIds = new Set();
    const repositories = entry.repositories.map((repo, repoIndex) => {
      const label = `projects[${projectIndex}].repositories[${repoIndex}]`;
      plain(repo, label);
      keys(repo, ['repoId', 'canonicalRoot', 'worktreeRoot', 'revision', 'buildVariant'], label);
      const repoId = text(repo.repoId, 'repository id', 128);
      if (repoIds.has(repoId)) throw new ConfigError(`duplicate repository id ${repoId}`);
      repoIds.add(repoId);
      return {
        repoId,
        canonicalRoot: localPath(repo.canonicalRoot, `${label}.canonicalRoot`),
        worktreeRoot: localPath(repo.worktreeRoot ?? repo.canonicalRoot, `${label}.worktreeRoot`),
        revision: text(repo.revision ?? 'workspace', 'repository revision', 512),
        buildVariant: text(repo.buildVariant ?? 'unknown', 'build variant', 2048),
      };
    });
    return {name, repositories};
  });
}

function routeEntries(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > ROUTE_LIMIT) throw new ConfigError(`routes must contain 1..${ROUTE_LIMIT} entries`);
  const seen = new Set();
  return value.map((entry, index) => {
    plain(entry, `routes[${index}]`);
    keys(entry, ['routeRef', 'provider', 'model'], `routes[${index}]`);
    const routeRef = text(entry.routeRef, 'route reference', 128);
    if (!ROUTE_PATTERN.test(routeRef)) throw new ConfigError('route reference must use letters, digits, dot, underscore or dash');
    if (seen.has(routeRef)) throw new ConfigError('route references must be unique');
    seen.add(routeRef);
    return {routeRef, provider: text(entry.provider, 'route provider', 128), model: text(entry.model, 'route model', 256)};
  });
}

function resolveProfile(raw, env) {
  const candidate = raw.profile === undefined || raw.profile === '' ? (env.DSH_PROFILE ?? 'default') : raw.profile;
  if (typeof candidate !== 'string' || !PROFILE_PATTERN.test(candidate)) throw new ConfigError('profile must be a safe directory name');
  return candidate;
}

/** Validate the plugin row config. Throws a ConfigError (code INVALID_CONFIG) without any filesystem side effect. */
export function normalizeConfig(raw, {env = process.env} = {}) {
  const input = raw === undefined || raw === null ? {} : plain(raw, 'config');
  keys(input, Object.keys(DEFAULTS), 'config');
  if (input.schemaVersion !== undefined && input.schemaVersion !== CONFIG_VERSION) throw new ConfigError('unsupported schemaVersion');
  const routes = routeEntries(input.routes ?? DEFAULTS.routes);
  const routeRefs = new Set(routes.map((route) => route.routeRef));
  const dataRootBase = input.dataRoot === undefined ? DEFAULTS.dataRoot : localPath(input.dataRoot, 'dataRoot');
  const profile = resolveProfile(input, env);
  const dataRoot = join(dataRootBase, profile);
  const extractionRaw = input.extraction === undefined ? DEFAULTS.extraction : plain(input.extraction, 'extraction');
  keys(extractionRaw, Object.keys(DEFAULTS.extraction), 'extraction');
  const routeRef = text(extractionRaw.routeRef ?? DEFAULTS.extraction.routeRef, 'extraction route', 128);
  if (!routeRefs.has(routeRef)) throw new ConfigError('extraction route is not configured');
  const workRaw = input.workSummary === undefined ? DEFAULTS.workSummary : plain(input.workSummary, 'workSummary');
  keys(workRaw, Object.keys(DEFAULTS.workSummary), 'workSummary');
  const workRouteRef = workRaw.routeRef === undefined || workRaw.routeRef === '' ? routeRef : text(workRaw.routeRef, 'work summary route', 128);
  if (!routeRefs.has(workRouteRef)) throw new ConfigError('work summary route is not configured');
  if (workRaw.evidenceRoots !== undefined && (!Array.isArray(workRaw.evidenceRoots) || workRaw.evidenceRoots.length > EVIDENCE_ROOT_LIMIT)) throw new ConfigError(`workSummary.evidenceRoots must contain at most ${EVIDENCE_ROOT_LIMIT} paths`);
  const evidenceRoots = (workRaw.evidenceRoots ?? []).map((path, index) => localPath(path, `workSummary.evidenceRoots[${index}]`));
  const consolidationRaw = input.consolidation === undefined ? DEFAULTS.consolidation : plain(input.consolidation, 'consolidation');
  keys(consolidationRaw, Object.keys(DEFAULTS.consolidation), 'consolidation');
  const consolidationRouteRef = consolidationRaw.routeRef === undefined || consolidationRaw.routeRef === '' ? routeRef : text(consolidationRaw.routeRef, 'consolidation route', 128);
  if (!routeRefs.has(consolidationRouteRef)) throw new ConfigError('consolidation route is not configured');
  const consolidation = {
    enabled: bool(consolidationRaw.enabled, 'consolidation.enabled', DEFAULTS.consolidation.enabled),
    routeRef: consolidationRouteRef,
    dirtyCountThreshold: integer(consolidationRaw.dirtyCountThreshold, 1, 100, 'consolidation.dirtyCountThreshold', DEFAULTS.consolidation.dirtyCountThreshold),
    maxWaitHours: integer(consolidationRaw.maxWaitHours, 1, 24, 'consolidation.maxWaitHours', DEFAULTS.consolidation.maxWaitHours),
    maxMemories: integer(consolidationRaw.maxMemories, 2, 16, 'consolidation.maxMemories', DEFAULTS.consolidation.maxMemories),
  };
  const recallRaw = input.recall === undefined ? DEFAULTS.recall : plain(input.recall, 'recall');
  keys(recallRaw, Object.keys(DEFAULTS.recall), 'recall');
  const schedulerRaw = input.scheduler === undefined ? DEFAULTS.scheduler : plain(input.scheduler, 'scheduler');
  keys(schedulerRaw, Object.keys(DEFAULTS.scheduler), 'scheduler');
  const limitsRaw = input.limits === undefined ? DEFAULTS.limits : plain(input.limits, 'limits');
  keys(limitsRaw, Object.keys(DEFAULTS.limits), 'limits');
  const limits = Object.fromEntries(Object.keys(DEFAULTS.limits).map((key) => [key, integer(limitsRaw[key], 1, LIMIT_CAPS[key], `limits.${key}`, DEFAULTS.limits[key])]));
  const remindersRaw = input.reminders === undefined ? DEFAULTS.reminders : plain(input.reminders, 'reminders');
  keys(remindersRaw, Object.keys(DEFAULTS.reminders), 'reminders');
  const reportsRaw = input.reports === undefined ? DEFAULTS.reports : plain(input.reports, 'reports');
  keys(reportsRaw, Object.keys(DEFAULTS.reports), 'reports');
  const abstractsRaw = input.abstracts === undefined ? DEFAULTS.abstracts : plain(input.abstracts, 'abstracts');
  keys(abstractsRaw, Object.keys(DEFAULTS.abstracts), 'abstracts');
  const securityRaw = input.security === undefined ? DEFAULTS.security : plain(input.security, 'security');
  keys(securityRaw, Object.keys(DEFAULTS.security), 'security');
  if (securityRaw.rejectNonLocalPaths !== undefined && securityRaw.rejectNonLocalPaths !== true) throw new ConfigError('security.rejectNonLocalPaths cannot be disabled');
  if (reportsRaw.exportRootRef !== undefined && reportsRaw.exportRootRef !== null) localPath(reportsRaw.exportRootRef, 'reports.exportRootRef');
  const config = {
    schemaVersion: CONFIG_VERSION,
    dataRoot,
    profile,
    routes,
    extraction: {
      routeRef,
      enabled: bool(extractionRaw.enabled, 'extraction.enabled', DEFAULTS.extraction.enabled),
      maxMemories: integer(extractionRaw.maxMemories, 1, 5, 'extraction.maxMemories', DEFAULTS.extraction.maxMemories),
      minInputChars: integer(extractionRaw.minInputChars, 1, 8000, 'extraction.minInputChars', DEFAULTS.extraction.minInputChars),
    },
    recall: {
      enabled: bool(recallRaw.enabled, 'recall.enabled', DEFAULTS.recall.enabled),
      maxRecords: integer(recallRaw.maxRecords, 1, 5, 'recall.maxRecords', DEFAULTS.recall.maxRecords),
      maxChars: integer(recallRaw.maxChars, 100, 4000, 'recall.maxChars', DEFAULTS.recall.maxChars),
      maxTokens: integer(recallRaw.maxTokens, 512, 4096, 'recall.maxTokens', DEFAULTS.recall.maxTokens),
    },
    projects: projectEntries(input.projects),
    scheduler: {
      pollMs: integer(schedulerRaw.pollMs, 100, 60000, 'scheduler.pollMs', DEFAULTS.scheduler.pollMs),
      concurrency: integer(schedulerRaw.concurrency, 1, 4, 'scheduler.concurrency', DEFAULTS.scheduler.concurrency),
      jobTimeoutMs: integer(schedulerRaw.jobTimeoutMs, 100, 30000, 'scheduler.jobTimeoutMs', DEFAULTS.scheduler.jobTimeoutMs),
      recoverOnStart: bool(schedulerRaw.recoverOnStart, 'scheduler.recoverOnStart', DEFAULTS.scheduler.recoverOnStart),
    },
    limits,
    workSummary: {enabled: bool(workRaw.enabled, 'workSummary.enabled', DEFAULTS.workSummary.enabled), routeRef: workRouteRef, evidenceRoots},
    reminders: {
      enabled: bool(remindersRaw.enabled, 'reminders.enabled', DEFAULTS.reminders.enabled),
      cooldownHours: integer(remindersRaw.cooldownHours, 1, 168, 'reminders.cooldownHours', DEFAULTS.reminders.cooldownHours),
      maxItems: integer(remindersRaw.maxItems, 1, 3, 'reminders.maxItems', DEFAULTS.reminders.maxItems),
    },
    reports: {
      exportRootRef: reportsRaw.exportRootRef === undefined || reportsRaw.exportRootRef === null ? null : localPath(reportsRaw.exportRootRef, 'reports.exportRootRef'),
      maxItems: integer(reportsRaw.maxItems, 1, 500, 'reports.maxItems', DEFAULTS.reports.maxItems),
    },
    abstracts: {
      pollMs: integer(abstractsRaw.pollMs, 60000, 3600000, 'abstracts.pollMs', DEFAULTS.abstracts.pollMs),
      dirtyCountThreshold: integer(abstractsRaw.dirtyCountThreshold, 1, 100, 'abstracts.dirtyCountThreshold', DEFAULTS.abstracts.dirtyCountThreshold),
      ageHours: integer(abstractsRaw.ageHours, 1, 168, 'abstracts.ageHours', DEFAULTS.abstracts.ageHours),
    },
    consolidation,
    security: {rejectNonLocalPaths: true},
  };
  config.configDigest = digest(JSON.stringify(config, (key, value) => (key === 'configDigest' ? undefined : value)));
  return freezeJSON(config);
}

/** Build the synchronous approved-route reader consumed by the existing Harness provider bridge. */
export function routeApproval(config) {
  const configDigest = config.configDigest;
  const routes = new Map(config.routes.map((route) => [route.routeRef, Object.freeze({
    routeRef: route.routeRef,
    provider: route.provider,
    model: route.model,
    routeVersion: fingerprint({routeRef: route.routeRef, provider: route.provider, model: route.model, configDigest}),
  })]));
  return function readApprovedRoute(routeRef) {
    const route = routes.get(routeRef);
    return route === undefined ? undefined : Object.freeze({...route});
  };
}

/** Map a job purpose to the configured extraction/work-summary route reference. */
export function routeRefFor(config, purpose) {
  if (purpose === 'work_summary_extract' || purpose === 'work_summary_merge') return config.workSummary.routeRef;
  if (purpose === 'memory_consolidate') return config.consolidation.routeRef || config.extraction.routeRef;
  return config.extraction.routeRef;
}

export function configErrorReason(error) {
  return error && error.code === 'INVALID_CONFIG' ? 'invalid_config' : 'config_unavailable';
}
