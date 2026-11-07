/**
 * Annual work records: draft / approve / local export, and catalog-backed proof reminder state.
 *
 * Catalog access decision: reports and reminder state live in the project catalog created by
 * `src/projects.mjs`. This module never opens a second DatabaseSync on `catalog.sqlite`; it uses
 * `registry.catalog.db` for SQL and `catalog.write(fn)` for the single writer transaction, plus
 * `catalog.getReminder/setReminder` when available. It only relies on the catalog schema v1 tables
 * (`reports`, `report_revisions`, `reminders`, `preferences`).
 *
 * Stored report payload (canonical JSON in `reports.payload`):
 *   {schema_version:1, content:{...}, contentDigest, approval:null|{reportDigest,sourceRevisions,
 *    approvedAt,actor,approvalDigest}}
 * `reports.digest` is always the content digest; `report_revisions.digest` is the revision binding
 * digest (draft: content digest + state; approved: approvalDigest).
 */
import {existsSync, lstatSync, mkdirSync, writeFileSync} from 'node:fs';
import {join, relative, isAbsolute} from 'node:path';
import {checkedText, checkedPath, digest} from './scope.mjs';
import {shape, canonical, fingerprint, integer} from './validation.mjs';
import {createWorkSummaryManager} from './work-summary.mjs';
import {contextOf, entryState} from './store-internals.mjs';

export const REPORT_SCHEMA = 'annual-work-report-v1';
export const REPORT_MANIFEST_SCHEMA = 'annual-work-report-manifest-v1';
export const REMINDER_DISABLED_AT = '9999-12-31T00:00:00.000Z';
export const REMINDER_CLAIM_LABELS = Object.freeze({
  myContribution: '本人贡献',
  processOrConclusion: '过程/结论',
  result: '结果',
  time: '时间',
  goal: '目标',
  projectRef: '项目关联',
  requirementRef: '需求关联',
  problemRef: '问题关联',
  problemState: '问题状态',
});
const CLAIMS = Object.freeze(['myContribution', 'processOrConclusion', 'result']);
const PRECISIONS = Object.freeze(['year', 'month', 'day']);
const REPORT_ID_PATTERN = /^report-[a-f0-9]{16,64}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_FIELDS = Object.freeze(['sourceRef', 'sourceVersion', 'fragmentRef']);
const EXPORT_FORMATS = Object.freeze(['markdown', 'json']);

export function reportFailure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
const invalid = (message) => reportFailure('INVALID_INPUT', message);
const coded = (error) => error !== null && typeof error === 'object' && typeof error.code === 'string';
function checked(error, code = 'INVALID_INPUT') {
  if (coded(error)) throw error;
  throw reportFailure(code, typeof error?.message === 'string' ? error.message : code);
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid(`Invalid ${label}`);
  return value;
}

function nowIso(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid('Invalid clock value');
  return date.toISOString();
}
function parseIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
function lastDayOfMonth(value) {
  const [year, month] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
function normalizeSource(source) {
  shape(source, [...SOURCE_FIELDS], 'work source');
  return {
    sourceRef: checkedText(source.sourceRef, 'source reference', 2048),
    sourceVersion: checkedText(source.sourceVersion, 'source version', 512),
    fragmentRef: checkedText(source.fragmentRef ?? 'whole', 'fragment reference', 512),
  };
}
function normalizeSourceRevision(source, {allowMissingScope = false, scopeRef} = {}) {
  shape(source, ['projectId', 'scopeRef', 'workId', 'workGeneration'], 'report source revision');
  const normalized = {
    projectId: checkedText(source.projectId, 'project id', 128),
    workId: checkedText(source.workId, 'work id', 256),
    workGeneration: integer(source.workGeneration, 1, Number.MAX_SAFE_INTEGER, 'work generation'),
  };
  if (source.scopeRef !== undefined) normalized.scopeRef = checkedText(source.scopeRef, 'scope reference', 2048);
  else if (scopeRef !== undefined) normalized.scopeRef = scopeRef;
  else if (!allowMissingScope) throw invalid('Report source revision requires a scope reference');
  return normalized;
}
function sourceKey(value) {
  return `${value.projectId}\u0000${value.workId}`;
}
function sortSources(sources) {
  return [...sources].sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
}

/* ------------------------------------------------------------------------------------------ */
/* Catalog-backed reminder state (shared by proof-reminders and work-management)              */
/* ------------------------------------------------------------------------------------------ */

/**
 * Reminder state is keyed by (scopeRef, recordId, claimRef) with `record_generation` stored as the
 * value so a new record generation re-arms the reminder immediately. The catalog column is named
 * `last_shown_at` but is used as "earliest next eligible timestamp": markShown stores
 * now + cooldownHours, deferReminder stores now + hours, and REMINDER_DISABLED_AT means the user
 * disabled this reminder. A changed record generation is due immediately regardless of time.
 */
export function createCatalogReminders(catalog) {
  if (!catalog || typeof catalog.db?.prepare !== 'function') throw reportFailure('CATALOG_UNAVAILABLE', 'project catalog is unavailable');
  const db = catalog.db;
  function write(fn) {
    if (typeof catalog.write === 'function') return catalog.write(fn);
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* original error stays authoritative */ }
      throw error;
    }
  }
  function read(scopeRef, recordId, claimRef) {
    const scope = checkedText(scopeRef, 'scope reference', 2048);
    const record = checkedText(recordId, 'record id', 256);
    const claim = checkedText(claimRef, 'claim reference', 128);
    if (typeof catalog.getReminder === 'function') return catalog.getReminder(scope, record, claim);
    return db.prepare('SELECT * FROM reminders WHERE scope_ref=? AND record_id=? AND claim_ref=?').get(scope, record, claim);
  }
  function set({scopeRef, recordId, claimRef, recordGeneration, lastShownAt}) {
    const shownAt = checkedText(lastShownAt, 'reminder timestamp', 64);
    if (parseIso(shownAt) === undefined) throw invalid('Invalid reminder timestamp');
    if (typeof catalog.setReminder === 'function') return catalog.setReminder({scopeRef, recordId, claimRef, recordGeneration, shownAt});
    return write(() => {
      db.prepare('INSERT INTO reminders VALUES(?,?,?,?,?) ON CONFLICT(scope_ref,record_id,claim_ref) DO UPDATE SET record_generation=excluded.record_generation,last_shown_at=excluded.last_shown_at')
        .run(checkedText(scopeRef, 'scope reference', 2048), checkedText(recordId, 'record id', 256), checkedText(claimRef, 'claim reference', 128), integer(recordGeneration, 0, Number.MAX_SAFE_INTEGER, 'record generation'), shownAt);
      return Object.freeze({scopeRef, recordId, claimRef, recordGeneration, lastShownAt: shownAt});
    });
  }
  function reminderDue({scopeRef, recordId, claimRef, recordGeneration, now}) {
    const row = read(scopeRef, recordId, claimRef);
    const at = nowIso(now);
    if (!row) return Object.freeze({due: true, reason: 'never_shown', lastShownAt: null});
    if (row.last_shown_at === REMINDER_DISABLED_AT) return Object.freeze({due: false, reason: 'disabled', lastShownAt: row.last_shown_at});
    const eligible = parseIso(row.last_shown_at);
    const current = parseIso(at);
    if (eligible === undefined || current === undefined) return Object.freeze({due: true, reason: 'state_unreadable', lastShownAt: row.last_shown_at ?? null});
    if (Number(row.record_generation) !== Number(recordGeneration)) return Object.freeze({due: true, reason: 'generation_changed', lastShownAt: row.last_shown_at});
    if (current < eligible) return Object.freeze({due: false, reason: 'deferred', lastShownAt: row.last_shown_at});
    return Object.freeze({due: true, reason: 'cooldown_elapsed', lastShownAt: row.last_shown_at});
  }
  function markShown({scopeRef, recordId, claimRef, recordGeneration, cooldownHours = 24, now}) {
    const cooldown = integer(cooldownHours, 1, 720, 'reminder cooldown');
    const lastShownAt = new Date(new Date(nowIso(now)).getTime() + cooldown * 3600000).toISOString();
    return set({scopeRef, recordId, claimRef, recordGeneration, lastShownAt});
  }
  function deferReminder({scopeRef, recordId, claimRef, recordGeneration, hours, now}) {
    const delay = integer(hours, 1, 720, 'reminder defer hours');
    const base = new Date(nowIso(now));
    const lastShownAt = new Date(base.getTime() + delay * 3600000).toISOString();
    return set({scopeRef, recordId, claimRef, recordGeneration, lastShownAt});
  }
  function disableReminder({scopeRef, recordId, claimRef, recordGeneration}) {
    return set({scopeRef, recordId, claimRef, recordGeneration, lastShownAt: REMINDER_DISABLED_AT});
  }
  function list(scopeRef) {
    return db.prepare('SELECT * FROM reminders WHERE scope_ref=? ORDER BY record_id,claim_ref').all(checkedText(scopeRef, 'scope reference', 2048));
  }
  function projectRemindersEnabled(projectId) {
    const id = checkedText(projectId, 'project id', 128);
    try {
      const row = db.prepare("SELECT value FROM preferences WHERE project_id=? AND key='reminders'").get(id);
      return !row || row.value !== 'false';
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
  }
  function setProjectReminders(projectId, enabled) {
    if (typeof enabled !== 'boolean') throw invalid('Reminder preference must be boolean');
    const id = checkedText(projectId, 'project id', 128);
    write(() => {
      db.prepare("INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET value=excluded.value").run(id, 'reminders', enabled ? 'true' : 'false');
    });
    return Object.freeze({projectId: id, remindersEnabled: enabled});
  }
  return Object.freeze({get: read, set, reminderDue, markShown, deferReminder, disableReminder, list, projectRemindersEnabled, setProjectReminders});
}

/* ------------------------------------------------------------------------------------------ */
/* Report manager                                                                             */
/* ------------------------------------------------------------------------------------------ */

function rangePattern(precision) {
  return {year: /^\d{4}$/, month: /^\d{4}-(0[1-9]|1[0-2])$/, day: /^\d{4}-\d{2}-\d{2}$/}[precision];
}
function inferPrecision(text) {
  if (/^\d{4}$/.test(text)) return 'year';
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(text)) return 'month';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'day';
  return undefined;
}
function validDay(text) {
  const parsed = Date.parse(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 10) === text;
}
function validateTimeRange(value) {
  shape(value, ['from', 'to', 'precision'], 'report time range');
  const from = checkedText(value.from, 'time range start', 10);
  const to = checkedText(value.to, 'time range end', 10);
  const precision = value.precision ?? inferPrecision(from) ?? inferPrecision(to);
  if (!PRECISIONS.includes(precision)) throw invalid('Invalid report time range precision');
  const pattern = rangePattern(precision);
  if (!pattern.test(from) || !pattern.test(to)) throw invalid('Report time range does not match its precision');
  if (precision === 'day' && (!validDay(from) || !validDay(to))) throw invalid('Invalid report calendar date');
  if (precision === 'month' && (!validDay(`${from}-01`) || !validDay(`${to}-01`))) throw invalid('Invalid report calendar month');
  if (from > to) throw invalid('Report time range is reversed');
  return Object.freeze({from, to, precision});
}
function rangeInterval(range) {
  if (range.precision === 'year') return {start: `${range.from}-01-01`, end: `${range.to}-12-31`};
  if (range.precision === 'month') return {start: `${range.from}-01`, end: `${range.to}-${String(lastDayOfMonth(range.to)).padStart(2, '0')}`};
  return {start: range.from, end: range.to};
}
function workInterval(time) {
  if (!time || time.precision === 'unknown' || !time.start) return undefined;
  const start = time.start;
  const end = time.end ?? start;
  if (time.precision === 'year') return {start: `${start}-01-01`, end: `${end}-12-31`};
  if (time.precision === 'month') return {start: `${start}-01`, end: `${end}-${String(lastDayOfMonth(end)).padStart(2, '0')}`};
  if (time.precision === 'day') return {start, end};
  return undefined;
}
function classifyTime(time, interval) {
  const work = workInterval(time);
  if (!work) return 'unknown';
  if (work.start >= interval.start && work.end <= interval.end) return 'in_range';
  if (work.start <= interval.end && work.end >= interval.start) return 'partial_overlap';
  return 'outside';
}
function normalizeProjectIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) throw invalid('Report project selection must contain 1..64 projects');
  const seen = new Set();
  return value.map((entry) => {
    const id = checkedText(entry, 'project id', 128);
    if (seen.has(id)) throw invalid('Report project selection contains duplicates');
    seen.add(id);
    return id;
  });
}
function normalizeWorkRefs(value, projectIds) {
  if (!Array.isArray(value) || value.length < 1) throw invalid('Report work selection must not be empty');
  if (value.length > 1000) throw invalid('Report work selection is too large');
  const selected = new Set(projectIds);
  const seen = new Set();
  return value.map((entry) => {
    shape(entry, ['projectId', 'workId'], 'report work reference');
    const projectId = checkedText(entry.projectId, 'project id', 128);
    if (!selected.has(projectId)) throw invalid('Report work selection must stay inside the selected projects');
    const workId = checkedText(entry.workId, 'work id', 256);
    const key = `${projectId}\u0000${workId}`;
    if (seen.has(key)) throw invalid('Report work selection contains duplicates');
    seen.add(key);
    return Object.freeze({projectId, workId});
  });
}
function sourceForStore(binding) {
  return binding && typeof binding === 'object' && binding.store ? binding.store : binding;
}

/**
 * createReportManager({registry, config, now?})
 * - registry: ProjectRegistry (storeFor(scopeRef) -> MemoryStore, catalog -> ProjectCatalog,
 *   getProject(projectId) optional).
 * - config: normalized plugin config; uses dataRoot, reports.exportRootRef/maxItems,
 *   workSummary.evidenceRoots, reminders.cooldownHours.
 */
export function createReportManager({registry, config, now = () => new Date()} = {}) {
  if (!registry || typeof registry.storeFor !== 'function') throw reportFailure('REGISTRY_UNAVAILABLE', 'Trusted project registry required');
  if (!config || typeof config !== 'object' || typeof config.dataRoot !== 'string') throw reportFailure('INVALID_CONFIG', 'Normalized configuration required');
  const catalog = registry.catalog;
  if (!catalog || typeof catalog.db?.prepare !== 'function') throw reportFailure('CATALOG_UNAVAILABLE', 'Project catalog is unavailable');
  const dataRoot = checkedPath(config.dataRoot);
  const configuredExportRoot = config.reports?.exportRootRef ?? null;
  const exportRoot = configuredExportRoot === null ? join(dataRoot, 'reports') : checkedPath(configuredExportRoot);
  const exportRootRef = configuredExportRoot === null ? 'reports' : configuredExportRoot;
  const maxItems = integer(config.reports?.maxItems ?? 200, 1, 500, 'report max items');
  const evidenceRoots = Array.isArray(config.workSummary?.evidenceRoots) ? config.workSummary.evidenceRoots : [];
  const cooldownHours = integer(config.reminders?.cooldownHours ?? 24, 1, 720, 'reminder cooldown');
  const reminders = createCatalogReminders(catalog);
  const managers = new Map();
  let catalogDepth = 0;

  function catalogWrite(fn) {
    if (catalogDepth > 0) return fn();
    catalogDepth++;
    try {
      if (typeof catalog.write === 'function') return catalog.write(fn);
      catalog.db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        catalog.db.exec('COMMIT');
        return value;
      } catch (error) {
        try { catalog.db.exec('ROLLBACK'); } catch { /* original error stays authoritative */ }
        throw error;
      }
    } finally {
      catalogDepth--;
    }
  }
  function projectRow(projectId) {
    if (typeof registry.getProject === 'function') return registry.getProject(projectId);
    return catalog.getProject?.(projectId);
  }
  function enabledScopes(project) {
    if (!Array.isArray(project?.repositories)) return [];
    return [...new Set(project.repositories.filter((repo) => repo.enabled !== false).map((repo) => repo.scopeRef))];
  }
  function storeFor(scopeRef) {
    let binding;
    try {
      binding = registry.storeFor(scopeRef);
    } catch (error) {
      if (coded(error) && error.code === 'SCOPE_NOT_FOUND') throw error;
      throw reportFailure('STORE_UNAVAILABLE', 'Work record store is unavailable');
    }
    const store = sourceForStore(binding);
    if (!store || typeof store.generation !== 'function' || store.scopeRef !== scopeRef) throw reportFailure('STORE_UNAVAILABLE', 'Work record store is unavailable');
    return store;
  }
  function managerFor(scopeRef, authorizeEvidence) {
    if (typeof authorizeEvidence !== 'function') {
      const cached = managers.get(scopeRef);
      if (cached) return cached;
    }
    const manager = createWorkSummaryManager(storeFor(scopeRef), {
      evidenceRoots,
      authorize: (request) => request?.action === 'revalidateEvidence' && typeof authorizeEvidence === 'function' ? authorizeEvidence(request) === true : false,
    });
    if (typeof authorizeEvidence !== 'function') managers.set(scopeRef, manager);
    return manager;
  }
  function currentGeneration(scopeRef, workId) {
    let store;
    try {
      store = storeFor(scopeRef);
    } catch {
      throw reportFailure('STORE_UNAVAILABLE', 'Work record store is unavailable');
    }
    const ctx = contextOf(store);
    const state = entryState(ctx, 'work_summaries', workId);
    if (!state || state.state !== 'active') return undefined;
    const row = ctx.db.prepare('SELECT generation,payload FROM work_summaries WHERE id=? AND scope_ref=?').get(workId, scopeRef);
    if (!row || row.generation !== state.generation) return undefined;
    if (digest(row.payload) !== state.body_digest) return undefined;
    return state.generation;
  }
  function currentSources(sources) {
    return sortSources(sources.map((source) => {
      const generation = currentGeneration(source.scopeRef, source.workId);
      return {
        projectId: source.projectId,
        scopeRef: source.scopeRef,
        workId: source.workId,
        workGeneration: generation === undefined ? 0 : generation,
      };
    }));
  }
  function sourcesMatch(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    return fingerprint(sortSources(expected)) === fingerprint(sortSources(actual));
  }
  function updateState(reportId, state, at) {
    catalogWrite(() => catalog.db.prepare('UPDATE reports SET state=?,updated_at=? WHERE report_id=?').run(state, at, reportId));
  }
  function reportRow(reportId) {
    return catalog.db.prepare('SELECT * FROM reports WHERE report_id=?').get(reportId);
  }
  function payloadOf(row) {
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      throw reportFailure('REPORT_CORRUPT', 'Stored report payload is unreadable');
    }
    const content = payload?.content;
    if (!content || typeof content !== 'object' || payload.contentDigest !== row.digest || fingerprint(content) !== payload.contentDigest) throw reportFailure('REPORT_CORRUPT', 'Stored report integrity check failed');
    return payload;
  }
  function publicReport(row) {
    const payload = payloadOf(row);
    return Object.freeze({
      schema_version: 1,
      schema: REPORT_SCHEMA,
      reportId: row.report_id,
      revision: row.revision,
      state: row.state,
      reportDigest: payload.contentDigest,
      updatedAt: row.updated_at,
      ...payload.content,
      approval: payload.approval ?? null,
    });
  }
  function buildItem(projectId, scopeRef, work, timeStatus) {
    const claims = {};
    for (const claimRef of CLAIMS) {
      const claim = work[claimRef];
      claims[claimRef] = {
        text: claim.text,
        basis: claim.basis,
        support: claim.support,
        confirmation: claim.confirmation,
      };
    }
    return {
      projectId,
      scopeRef,
      workId: work.id,
      workGeneration: work.generation,
      title: work.title,
      itemType: work.itemType,
      goal: work.goal,
      claims,
      time: {start: work.time.start ?? null, end: work.time.end ?? null, precision: work.time.precision, confirmation: work.time.confirmation},
      timeStatus,
      sources: (work.sources ?? []).map(normalizeSource),
      evidenceRefs: (work.evidenceRefs ?? []).map((reference) => ({
        id: reference.id,
        displayName: reference.displayName,
        claimRefs: [...reference.claimRefs],
        accessStatus: reference.accessStatus,
        ...(reference.url ? {url: reference.url} : {}),
      })),
      pendingEvidence: [...work.pendingEvidence],
      pendingConfirmation: [...work.pendingConfirmation],
    };
  }
  function buildUnknownTime(projectId, scopeRef, work) {
    return {
      projectId,
      scopeRef,
      workId: work.id,
      workGeneration: work.generation,
      title: work.title,
      itemType: work.itemType,
      time: {start: work.time.start ?? null, end: work.time.end ?? null, precision: work.time.precision, confirmation: work.time.confirmation},
      pendingEvidence: [...work.pendingEvidence],
      pendingConfirmation: [...work.pendingConfirmation],
    };
  }
  function flattenPending(items, unknownTimeItems) {
    const pendingProofs = new Map();
    const pendingConfirmations = new Map();
    const addProof = (projectId, workId, claimRef) => {
      const item = items.find((entry) => entry.projectId === projectId && entry.workId === workId);
      const support = item?.claims?.[claimRef]?.support ?? 'missing';
      pendingProofs.set(`${projectId}\u0000${workId}\u0000${claimRef}`, {projectId, workId, claimRef, support});
    };
    const addConfirmation = (projectId, workId, claimRef, extra) => {
      pendingConfirmations.set(`${projectId}\u0000${workId}\u0000${claimRef}`, {projectId, workId, claimRef, ...extra});
    };
    for (const item of items) {
      for (const claimRef of item.pendingEvidence) if (CLAIMS.includes(claimRef)) addProof(item.projectId, item.workId, claimRef);
      for (const claimRef of item.pendingConfirmation) addConfirmation(item.projectId, item.workId, claimRef, claimRef === 'time' ? {precision: item.time.precision} : {});
    }
    for (const item of unknownTimeItems) for (const claimRef of item.pendingConfirmation) addConfirmation(item.projectId, item.workId, claimRef, claimRef === 'time' ? {precision: item.time.precision} : {});
    return {
      pendingProofs: [...pendingProofs.values()].sort((a, b) => `${sourceKey(a)}${a.claimRef}`.localeCompare(`${sourceKey(b)}${b.claimRef}`)),
      pendingConfirmations: [...pendingConfirmations.values()].sort((a, b) => `${sourceKey(a)}${a.claimRef}`.localeCompare(`${sourceKey(b)}${b.claimRef}`)),
    };
  }

  function draft(args = {}) {
    shape(args, ['projectIds', 'timeRange', 'workRefs', 'templateRef', 'actor', 'authorizeEvidence'], 'report draft');
    const projectIds = normalizeProjectIds(args.projectIds);
    const timeRange = validateTimeRange(args.timeRange);
    const actor = args.actor ?? 'user';
    if (!['user', 'model', 'host'].includes(actor)) throw invalid('Invalid report actor');
    const templateRef = args.templateRef === undefined ? undefined : checkedText(args.templateRef, 'template reference', 512);
    const explicit = args.workRefs === undefined ? undefined : normalizeWorkRefs(args.workRefs, projectIds);
    if (explicit && explicit.length > maxItems) throw reportFailure('REPORT_TOO_LARGE', 'Selected work records exceed the report limit');
    const authorizeEvidence = typeof args.authorizeEvidence === 'function' ? args.authorizeEvidence : undefined;
    const interval = rangeInterval(timeRange);
    const createdAt = nowIso(now);
    const projects = [];
    const items = [];
    const unknownTimeItems = [];
    let outOfRangeCount = 0;
    const explicitByProject = new Map();
    if (explicit) for (const reference of explicit) {
      const list = explicitByProject.get(reference.projectId) ?? [];
      list.push(reference.workId);
      explicitByProject.set(reference.projectId, list);
    }
    for (const projectId of projectIds) {
      let project;
      try {
        project = projectRow(projectId);
      } catch (error) {
        checked(error, 'CATALOG_UNAVAILABLE');
      }
      if (!project) throw reportFailure('PROJECT_NOT_FOUND', `Project ${projectId} is not registered`);
      if (project.state !== 'active') throw reportFailure('PROJECT_NOT_ACTIVE', `Project ${projectId} is not active`);
      projects.push({projectId, name: project.name});
      const scopes = enabledScopes(project);
      const selected = explicitByProject.get(projectId);
      if (selected) {
        for (const workId of selected) {
          let found;
          let foundScope;
          for (const scopeRef of scopes) {
            const work = managerFor(scopeRef, authorizeEvidence).get(workId);
            if (work) {
              found = work;
              foundScope = scopeRef;
              break;
            }
          }
          if (!found) throw reportFailure('WORK_NOT_FOUND', `Selected work record was not found in project ${projectId}`);
          const timeStatus = classifyTime(found.time, interval);
          if (timeStatus === 'unknown') throw reportFailure('WORK_TIME_UNKNOWN', 'Selected work record has no confirmable date for this time range');
          if (timeStatus === 'outside') throw reportFailure('WORK_OUT_OF_RANGE', 'Selected work record is outside the report time range');
          items.push(buildItem(projectId, foundScope, found, timeStatus));
        }
        continue;
      }
      for (const scopeRef of scopes) {
        let listed;
        try {
          listed = managerFor(scopeRef, authorizeEvidence).list({limit: 500});
        } catch (error) {
          checked(error, 'STORE_UNAVAILABLE');
        }
        if (!listed || !Array.isArray(listed.items)) throw reportFailure('STORE_UNAVAILABLE', 'Work record store is unreadable');
        if (listed.total > 500) throw reportFailure('REPORT_TOO_LARGE', 'Too many work records to enumerate for one report');
        for (const work of listed.items) {
          const timeStatus = classifyTime(work.time, interval);
          if (timeStatus === 'unknown') {
            unknownTimeItems.push(buildUnknownTime(projectId, scopeRef, work));
            continue;
          }
          if (timeStatus === 'outside') {
            outOfRangeCount++;
            continue;
          }
          items.push(buildItem(projectId, scopeRef, work, timeStatus));
          if (items.length > maxItems) throw reportFailure('REPORT_TOO_LARGE', 'Report item limit exceeded');
        }
      }
    }
    items.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)) || a.workGeneration - b.workGeneration);
    unknownTimeItems.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b)));
    const sourceRevisions = sortSources(items.map((item) => ({projectId: item.projectId, scopeRef: item.scopeRef, workId: item.workId, workGeneration: item.workGeneration})));
    const {pendingProofs, pendingConfirmations} = flattenPending(items, unknownTimeItems);
    const content = {
      schema_version: 1,
      schema: REPORT_SCHEMA,
      timeRange,
      projectIds,
      projects,
      ...(templateRef === undefined ? {} : {templateRef}),
      items,
      pendingProofs,
      pendingConfirmations,
      unknownTimeItems,
      outOfRangeCount,
      sourceRevisions,
      dimensionMapping: {status: 'pending_reference', ...(templateRef === undefined ? {} : {templateRef})},
      draftedBy: actor,
      createdAt,
    };
    const contentDigest = fingerprint(content);
    const reportId = `report-${contentDigest.slice(0, 40)}`;
    const payload = {schema_version: 1, content, contentDigest, approval: null};
    const encoded = canonical(payload);
    const revisionDigest = fingerprint({contentDigest, state: 'draft'});
    const existing = reportRow(reportId);
    if (existing) {
      if (payloadOf(existing).contentDigest !== contentDigest) throw reportFailure('REPORT_CONFLICT', 'Draft report identity collided with different content');
      return publicReport(existing);
    }
    try {
      catalogWrite(() => {
        catalog.db.prepare('INSERT INTO reports(report_id,revision,state,payload,digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
          .run(reportId, 1, 'draft', encoded, contentDigest, createdAt, createdAt);
        catalog.db.prepare('INSERT INTO report_revisions(report_id,revision,digest,approved,payload,created_at) VALUES(?,?,?,?,?,?)')
          .run(reportId, 1, revisionDigest, 0, encoded, createdAt);
      });
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
    return publicReport(reportRow(reportId));
  }

  function list({limit = 20} = {}) {
    const size = integer(limit, 1, 100, 'report limit');
    let rows;
    try {
      rows = catalog.db.prepare('SELECT * FROM reports ORDER BY created_at DESC,report_id LIMIT ?').all(size);
      const total = catalog.db.prepare('SELECT count(*) AS n FROM reports').get().n;
      const items = rows.map((row) => {
        const report = publicReport(row);
        return Object.freeze({
          reportId: report.reportId,
          revision: report.revision,
          state: report.state,
          reportDigest: report.reportDigest,
          createdAt: report.createdAt,
          updatedAt: report.updatedAt,
          timeRange: report.timeRange,
          projectIds: report.projectIds,
          itemCount: report.items.length,
          pendingProofCount: report.pendingProofs.length,
          pendingConfirmationCount: report.pendingConfirmations.length,
          unknownTimeCount: report.unknownTimeItems.length,
        });
      });
      return Object.freeze({items: Object.freeze(items), total});
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
  }

  function get(reportId) {
    const id = checkedText(reportId, 'report id', 128);
    if (!REPORT_ID_PATTERN.test(id)) throw invalid('Invalid report id');
    let row;
    try {
      row = reportRow(id);
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
    if (!row) throw reportFailure('REPORT_NOT_FOUND', 'Report is not registered');
    return publicReport(row);
  }

  function normalizeApprovalSources(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) throw invalid('Approval requires the source revisions to bind');
    return sortSources(value.map((entry) => normalizeSourceRevision(plain(entry, 'source revision'), {allowMissingScope: true})));
  }

  function approve(args = {}) {
    shape(args, ['reportId', 'reportDigest', 'sourceRevisions', 'actor'], 'report approval');
    if (args.actor !== 'user') throw reportFailure('USER_ACTION_REQUIRED', 'Report approval is a user action');
    const reportId = checkedText(args.reportId, 'report id', 128);
    if (!REPORT_ID_PATTERN.test(reportId)) throw invalid('Invalid report id');
    const reportDigest = checkedText(args.reportDigest, 'report digest', 64);
    if (!DIGEST_PATTERN.test(reportDigest)) throw invalid('Invalid report digest');
    const requested = normalizeApprovalSources(args.sourceRevisions);
    let row;
    try {
      row = reportRow(reportId);
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
    if (!row) throw reportFailure('REPORT_NOT_FOUND', 'Report is not registered');
    const payload = payloadOf(row);
    const report = publicReport(row);
    const bound = payload.approval?.sourceRevisions ?? report.sourceRevisions;
    const normalizedBound = sortSources(bound.map((source) => normalizeSourceRevision(source, {allowMissingScope: false})));
    // Callers may bind by {projectId,workId,workGeneration}; fill the stable scope reference from
    // the stored draft so an omitted scopeRef never turns a valid approval into REPORT_STALE.
    const requestedBound = sortSources(requested.map((source) => {
      if (source.scopeRef !== undefined) return source;
      const match = normalizedBound.find((candidate) => candidate.projectId === source.projectId && candidate.workId === source.workId);
      return match ? {...source, scopeRef: match.scopeRef} : source;
    }));
    if (row.state === 'stale') throw reportFailure('REPORT_STALE', 'Report approval is stale; create a new draft');
    if (row.state === 'approved') {
      if (payload.contentDigest !== reportDigest) throw reportFailure('REPORT_STALE', 'Approved report digest does not match');
      if (fingerprint(requestedBound) !== fingerprint(normalizedBound)) throw reportFailure('REPORT_STALE', 'Approved source revisions do not match the request');
      const fresh = currentSources(normalizedBound);
      if (!sourcesMatch(fresh, normalizedBound)) {
        updateState(reportId, 'stale', nowIso(now));
        throw reportFailure('REPORT_STALE', 'A bound source work record changed after approval');
      }
      return Object.freeze({
        reportId,
        revision: row.revision,
        state: 'approved',
        reportDigest: payload.contentDigest,
        approvalDigest: payload.approval?.approvalDigest,
        sourceRevisions: Object.freeze(normalizedBound.map((source) => Object.freeze({...source}))),
      });
    }
    if (payload.contentDigest !== reportDigest) throw reportFailure('REPORT_STALE', 'Report content changed since the draft digest');
    if (fingerprint(requestedBound) !== fingerprint(normalizedBound)) throw reportFailure('REPORT_STALE', 'Requested source revisions do not match the draft');
    const fresh = currentSources(normalizedBound);
    if (!sourcesMatch(fresh, normalizedBound)) throw reportFailure('REPORT_STALE', 'A source work record changed since the draft');
    const approvedAt = nowIso(now);
    const approval = {
      reportDigest: payload.contentDigest,
      sourceRevisions: normalizedBound.map((source) => ({...source})),
      approvedAt,
      actor: 'user',
    };
    approval.approvalDigest = fingerprint({
      reportDigest: approval.reportDigest,
      sourceRevisions: approval.sourceRevisions,
      approvedAt: approval.approvedAt,
      actor: approval.actor,
    });
    const approvedPayload = {...payload, approval};
    const encoded = canonical(approvedPayload);
    const revision = row.revision + 1;
    try {
      catalogWrite(() => {
        catalog.db.prepare('UPDATE reports SET revision=?,state=?,payload=?,digest=?,updated_at=? WHERE report_id=?')
          .run(revision, 'approved', encoded, payload.contentDigest, approvedAt, reportId);
        catalog.db.prepare('INSERT INTO report_revisions(report_id,revision,digest,approved,payload,created_at) VALUES(?,?,?,?,?,?)')
          .run(reportId, revision, approval.approvalDigest, 1, encoded, approvedAt);
      });
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
    return Object.freeze({
      reportId,
      revision,
      state: 'approved',
      reportDigest: payload.contentDigest,
      approvalDigest: approval.approvalDigest,
      sourceRevisions: Object.freeze(approval.sourceRevisions.map((source) => Object.freeze({...source}))),
    });
  }

  /* ----- export ---------------------------------------------------------------------------- */

  function proofRef(reference) {
    const stable = {id: reference.id, displayName: reference.displayName, accessStatus: reference.accessStatus, claimRefs: [...reference.claimRefs]};
    if (reference.url) stable.url = reference.url;
    return stable;
  }
  function localPathsFor(sources) {
    const paths = new Map();
    for (const source of sources) {
      let work;
      try {
        work = managerFor(source.scopeRef).get(source.workId);
      } catch {
        continue;
      }
      if (!work) continue;
      for (const reference of work.evidenceRefs ?? []) {
        if (typeof reference.localPath === 'string') paths.set(`${source.scopeRef}\u0000${reference.id}`, reference.localPath);
      }
    }
    return paths;
  }
  function exportReport(report, paths, includeLocalPaths) {
    const items = report.items.map((item) => ({
      ...item,
      evidenceRefs: item.evidenceRefs.map((reference) => {
        const stable = proofRef(reference);
        if (includeLocalPaths && paths.has(`${item.scopeRef}\u0000${reference.id}`)) stable.localPath = paths.get(`${item.scopeRef}\u0000${reference.id}`);
        return stable;
      }),
    }));
    return {...report, items};
  }
  function markdownFor(report, manifest) {
    const draft = report.state === 'draft';
    const lines = [];
    lines.push(`# 年度工作记录${draft ? '草稿' : '报告'}（${report.state}）`);
    lines.push('');
    lines.push(`> 状态：${report.state}${draft ? '（未经用户审定，仅作材料草稿，不是最终年终报告）' : '（已由用户审定并绑定来源版本）'}`);
    lines.push('');
    lines.push(`- schema: ${REPORT_SCHEMA}`);
    lines.push(`- reportId: ${report.reportId}`);
    lines.push(`- revision: ${report.revision}`);
    lines.push(`- reportDigest: ${report.reportDigest}`);
    lines.push(`- manifestDigest: ${manifest.manifestDigest}`);
    lines.push(`- 时间范围: ${report.timeRange.from}..${report.timeRange.to}（精度 ${report.timeRange.precision}）`);
    lines.push(`- 项目: ${report.projects.map((project) => `${project.name}（${project.projectId}）`).join('；')}`);
    lines.push(`- 维度映射: ${report.dimensionMapping.status}（未提供《年终总结维度.md》，不生成评分维度）`);
    lines.push(`- 完整性: ${manifest.completeness}；本地绝对路径: ${manifest.localPathsIncluded ? '已包含（用户显式选择）' : '未包含'}`);
    if (report.approval) lines.push(`- 审定: ${report.approval.approvedAt}；approvalDigest: ${report.approval.approvalDigest}`);
    lines.push('');
    let currentProject;
    for (const item of report.items) {
      if (item.projectId !== currentProject) {
        currentProject = item.projectId;
        lines.push(`## 项目 ${report.projects.find((project) => project.projectId === currentProject)?.name ?? currentProject}`);
        lines.push('');
      }
      lines.push(`### ${item.title}（${item.itemType}）`);
      lines.push(`- workId: ${item.workId}`);
      lines.push(`- workGeneration: ${item.workGeneration}`);
      lines.push(`- 时间: ${item.time.start ?? 'unknown'}..${item.time.end ?? item.time.start ?? 'unknown'}（精度 ${item.time.precision}；确认 ${item.time.confirmation}；${item.timeStatus}）`);
      for (const claimRef of CLAIMS) {
        const claim = item.claims[claimRef];
        lines.push(`- ${claimRef}: ${claim.text}`);
        lines.push(`  - basis: ${claim.basis}; support: ${claim.support}; confirmation: ${claim.confirmation}`);
      }
      for (const source of item.sources) lines.push(`- 来源: ${source.sourceRef}@${source.sourceVersion}#${source.fragmentRef}`);
      for (const reference of item.evidenceRefs) lines.push(`- 证明引用: ${reference.displayName}（${reference.accessStatus}${reference.localPath ? `；${reference.localPath}` : ''}）`);
      if (item.pendingEvidence.length) lines.push(`- 待补证明: ${item.pendingEvidence.join('、')}`);
      if (item.pendingConfirmation.length) lines.push(`- 待确认: ${item.pendingConfirmation.join('、')}`);
      lines.push('');
    }
    lines.push('## 待补证明清单');
    lines.push('');
    if (report.pendingProofs.length === 0) lines.push('- 无');
    for (const proof of report.pendingProofs) lines.push(`- ${proof.projectId}/${proof.workId} ${proof.claimRef}: ${proof.support}`);
    lines.push('');
    lines.push('## 待确认清单');
    lines.push('');
    if (report.pendingConfirmations.length === 0) lines.push('- 无');
    for (const confirmation of report.pendingConfirmations) lines.push(`- ${confirmation.projectId}/${confirmation.workId} ${confirmation.claimRef}${confirmation.precision ? `（精度 ${confirmation.precision}）` : ''}`);
    lines.push('');
    lines.push('## 日期/年度待确认（未按聊天日期强行归年）');
    lines.push('');
    if (report.unknownTimeItems.length === 0) lines.push('- 无');
    for (const item of report.unknownTimeItems) lines.push(`- ${item.projectId}/${item.title}（workId ${item.workId}；时间 ${item.time.precision}）`);
    lines.push('');
    lines.push(`## Manifest`);
    lines.push('');
    lines.push(`- ${REPORT_MANIFEST_SCHEMA}`);
    lines.push(`- manifestDigest: ${manifest.manifestDigest}`);
    lines.push(`- 报告摘要: ${manifest.reportDigest}`);
    lines.push(`- 未核实标记: 所有 support 非 supported 的断言均按待补证明列出；自述不等于已证实。`);
    lines.push('');
    return lines.join('\n');
  }
  function ensureExportRoot(reportId) {
    if (!REPORT_ID_PATTERN.test(reportId)) throw invalid('Invalid report id');
    let root;
    try {
      root = checkedPath(exportRoot);
      mkdirSync(root, {recursive: true, mode: 0o700});
      root = checkedPath(root);
      if (!lstatSync(root).isDirectory()) throw new Error('not a directory');
    } catch {
      throw reportFailure('EXPORT_ROOT_UNAVAILABLE', 'Report export root is unavailable');
    }
    let directory;
    try {
      directory = join(root, reportId);
      const parent = checkedPath(root);
      if (relative(parent, directory) !== reportId || isAbsolute(relative(parent, directory))) throw new Error('escape');
      mkdirSync(directory, {recursive: true, mode: 0o700});
      directory = checkedPath(directory);
      if (!lstatSync(directory).isDirectory()) throw new Error('not a directory');
    } catch {
      throw reportFailure('EXPORT_PATH_UNSAFE', 'Report export directory is not safe');
    }
    return {root, directory};
  }
  function writeExport(reportId, revision, state, format, content) {
    const {directory} = ensureExportRoot(reportId);
    const extension = format === 'json' ? 'json' : 'md';
    const filename = `${reportId}-r${revision}-${state}.${extension}`;
    const file = join(directory, filename);
    if (relative(directory, file) !== filename || isAbsolute(relative(directory, file))) throw reportFailure('EXPORT_PATH_UNSAFE', 'Report export filename is not safe');
    try {
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe existing export');
      }
      writeFileSync(file, Buffer.from(content, 'utf8'), {mode: 0o600});
    } catch (error) {
      if (coded(error) || error?.code === 'EXPORT_PATH_UNSAFE') throw error;
      throw reportFailure('EXPORT_FAILED', 'Report file could not be written');
    }
    return {file, ref: `reports/${reportId}/${filename}`, filename};
  }

  function exportReportFile(args = {}) {
    shape(args, ['reportId', 'revision', 'format', 'outputRootRef', 'includeLocalPaths', 'actor'], 'report export');
    if (args.actor !== 'user') throw reportFailure('USER_ACTION_REQUIRED', 'Report export is a user action');
    const reportId = checkedText(args.reportId, 'report id', 128);
    if (!REPORT_ID_PATTERN.test(reportId)) throw invalid('Invalid report id');
    const revision = integer(args.revision, 1, Number.MAX_SAFE_INTEGER, 'report revision');
    const format = args.format;
    if (!EXPORT_FORMATS.includes(format)) throw invalid('Unsupported report export format');
    const requestedRoot = args.outputRootRef === undefined ? exportRootRef : checkedText(args.outputRootRef, 'export root reference', 128);
    if (requestedRoot !== exportRootRef) throw reportFailure('EXPORT_ROOT_NOT_APPROVED', 'Report export root is not approved');
    const includeLocalPaths = args.includeLocalPaths === true;
    let row;
    try {
      row = reportRow(reportId);
    } catch (error) {
      checked(error, 'CATALOG_UNAVAILABLE');
    }
    if (!row) throw reportFailure('REPORT_NOT_FOUND', 'Report is not registered');
    if (row.state === 'stale') throw reportFailure('REPORT_STALE', 'Report approval is stale; export is refused');
    if (row.revision !== revision) throw reportFailure('REPORT_REVISION_MISMATCH', 'Report revision changed');
    const payload = payloadOf(row);
    const report = publicReport(row);
    let sourceRevisionsCurrent = true;
    let sourceRevisions = report.sourceRevisions;
    if (row.state === 'approved') {
      const approval = payload.approval;
      if (!approval) throw reportFailure('REPORT_CORRUPT', 'Approved report has no approval record');
      const recomputed = fingerprint({
        reportDigest: approval.reportDigest,
        sourceRevisions: approval.sourceRevisions,
        approvedAt: approval.approvedAt,
        actor: approval.actor,
      });
      if (recomputed !== approval.approvalDigest || approval.reportDigest !== payload.contentDigest) {
        updateState(reportId, 'stale', nowIso(now));
        throw reportFailure('REPORT_STALE', 'Report approval integrity check failed');
      }
      sourceRevisions = sortSources(approval.sourceRevisions.map((source) => normalizeSourceRevision(source, {allowMissingScope: false})));
      const fresh = currentSources(sourceRevisions);
      if (!sourcesMatch(fresh, sourceRevisions)) {
        updateState(reportId, 'stale', nowIso(now));
        throw reportFailure('REPORT_STALE', 'A source work record changed after approval');
      }
    } else {
      const fresh = currentSources(report.sourceRevisions);
      sourceRevisionsCurrent = sourcesMatch(fresh, report.sourceRevisions);
    }
    const paths = includeLocalPaths ? localPathsFor(sourceRevisions) : new Map();
    const exported = exportReport(report, paths, includeLocalPaths);
    const exportedAt = nowIso(now);
    const manifest = {
      schema: REPORT_MANIFEST_SCHEMA,
      schema_version: 1,
      reportId,
      revision: row.revision,
      state: row.state,
      reportDigest: report.reportDigest,
      reportContentDigest: payload.contentDigest,
      timeRange: report.timeRange,
      projectIds: report.projectIds,
      sourceRevisions,
      approved: row.state === 'approved' ? {approvedAt: payload.approval.approvedAt, approvalDigest: payload.approval.approvalDigest} : null,
      dimensionMapping: report.dimensionMapping,
      pendingProofCount: report.pendingProofs.length,
      pendingConfirmationCount: report.pendingConfirmations.length,
      unknownTimeCount: report.unknownTimeItems.length,
      outOfRangeCount: report.outOfRangeCount,
      completeness: 'complete',
      sourceRevisionsCurrent,
      format,
      localPathsIncluded: includeLocalPaths,
      exportedAt,
      exportedBy: 'user',
    };
    manifest.manifestDigest = fingerprint(manifest);
    let content;
    if (format === 'json') {
      content = `${JSON.stringify({manifest, report: exported}, null, 2)}\n`;
    } else {
      content = markdownFor(exported, manifest);
    }
    const written = writeExport(reportId, row.revision, row.state, format, content);
    const bytes = Buffer.byteLength(content, 'utf8');
    return Object.freeze({
      state: row.state,
      format,
      ref: written.ref,
      digest: digest(content),
      manifestDigest: manifest.manifestDigest,
      bytes,
      reportId,
      revision: row.revision,
      ...(includeLocalPaths ? {localPath: written.file} : {}),
    });
  }

  function close() {
    managers.clear();
  }

  return Object.freeze({
    catalog,
    reminders,
    draft,
    get,
    list,
    approve,
    export: exportReportFile,
    close,
    exportRoot,
    exportRootRef,
    cooldownHours,
  });
}
