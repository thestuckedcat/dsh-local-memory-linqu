import {checkedText} from '../src/scope.mjs';
import {fingerprint} from '../src/validation.mjs';
import {contextOf, write} from '../src/store-internals.mjs';
import {createConsolidationInputs} from '../src/consolidation-inputs.mjs';
import {createConsolidationQueue} from '../src/consolidation-queue.mjs';
import {createConsolidationVersions} from '../src/consolidation-versions.mjs';
import {routeRefFor} from './configuration.mjs';

/**
 * Optional user-gesture consolidation entry + in-process idle worker (I-1 partial).
 *
 * The user explicitly asks for one project; the operation selects 2..8 active memories, takes an
 * approved configured route, enqueues a pinned consolidation job and records a one-shot local
 * user-gesture grant. The worker only runs when the idle gate answers canDispatch()===true, then
 * validates and publishes the candidate. This is NOT automatic dirty-triggered consolidation:
 * no job is created without the user operation; grants are process-local and are not persisted.
 */
const MAX_SELECTION = 8;
const MIN_SELECTION = 2;

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function enabledRepos(project) {
  return Array.isArray(project?.repositories) ? project.repositories.filter((entry) => entry.enabled !== false) : [];
}
function configDigestOf(config) {
  return fingerprint({routes: config.routes, extraction: config.extraction, limits: config.limits, workSummary: config.workSummary});
}
function publicationRow(store, candidateId) {
  const ctx = contextOf(store);
  return ctx.db.prepare("SELECT id,state,subject_id,expires_at FROM ledger.consolidation_permissions WHERE scope_ref=? AND kind='publication' AND state='active' AND subject_id=?").get(store.scopeRef, candidateId);
}
function grantPublication(store, candidateId, manifestDigest, now) {
  const ctx = contextOf(store);
  return write(ctx, () => {
    const policy = ctx.db.prepare('SELECT revision FROM ledger.consolidation_policy WHERE scope_ref=?').get(store.scopeRef)?.revision ?? 1;
    const existing = publicationRow(store, candidateId);
    if (existing) return {permissionId: existing.id};
    const permissionId = `local-publication:${candidateId}`;
    ctx.db.prepare(`INSERT INTO ledger.consolidation_permissions(id,scope_ref,kind,state,subject_id,subject_digest,route_digest,epoch,policy_revision,expires_at,created_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(permissionId, store.scopeRef, 'publication', 'active', candidateId, manifestDigest, null, store.generation(), policy, null, now().toISOString());
    return {permissionId};
  });
}

export function createConsolidationOperations({config, registry, provider, dirty, now = () => new Date()} = {}) {
  if (!config || typeof config !== 'object') throw new Error('Normalized configuration required');
  if (!registry || typeof registry.getProject !== 'function' || typeof registry.storeFor !== 'function' || typeof registry.bindingForScope !== 'function') throw new Error('Trusted registry required');
  if (!provider || typeof provider.bind !== 'function' || typeof provider.execute !== 'function') throw new Error('Controlled provider required');
  const pending = new Map();
  const counters = {enqueued: 0, autoEnqueued: 0, published: 0, failed: 0, lastError: undefined};
  let running = false;
  function resolve(input, context) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    let projectId = raw.projectId;
    if (projectId === undefined && registry.bindingForSession && context?.session) {
      try { projectId = registry.bindingForSession(context.session)?.projectId; } catch { projectId = undefined; }
    }
    if (typeof projectId !== 'string' || !projectId) throw failure('PROJECT_REQUIRED', 'Select a project before consolidating.');
    if (context?.actor !== 'user') throw failure('USER_ACTION_REQUIRED', 'Only the user may start consolidation.');
    const project = registry.getProject(projectId);
    if (!project || project.state !== 'active') throw failure('PROJECT_NOT_FOUND', 'Project is not active.');
    const repositories = enabledRepos(project);
    const requestedRepoId = raw.repoId === undefined ? undefined : checkedText(raw.repoId, 'repository id', 128);
    const repository = requestedRepoId === undefined ? repositories[0] : repositories.find((entry) => entry.repoId === requestedRepoId);
    if (!repository) throw failure('SCOPE_NOT_FOUND', 'Project has no enabled repository.');
    return {projectId, repository};
  }
  function select(store, requested) {
    if (requested !== undefined) {
      if (!Array.isArray(requested) || requested.length < MIN_SELECTION || requested.length > MAX_SELECTION) throw failure('CONSOLIDATE_SELECTION', `Select ${MIN_SELECTION}..${MAX_SELECTION} active memories.`);
      if (new Set(requested).size !== requested.length) throw failure('CONSOLIDATE_SELECTION', 'Selected memories must not repeat.');
      return requested.map((id) => checkedText(id, 'memory reference', 256));
    }
    const listed = store.list({limit: 16, stateFilter: 'active'});
    const ids = listed.map((item) => item.id).slice(0, MAX_SELECTION);
    if (ids.length < MIN_SELECTION) throw failure('CONSOLIDATE_SELECTION', `At least ${MIN_SELECTION} active memories are required.`);
    return ids;
  }
  function autoEnqueue() {
    if (!config.consolidation?.enabled || !dirty) return 0;
    let count = 0;
    let projects;
    try { projects = registry.list(); } catch { return 0; }
    for (const project of projects) {
      if (project.state !== 'active') continue;
      for (const repository of enabledRepos(project)) {
        let store, inputs, versions, queue;
        try {
          store = registry.storeFor(repository.scopeRef);
          if ([...pending.values()].some((entry) => entry.store === store)) continue;
          const due = dirty.due(store, {threshold: config.consolidation.dirtyCountThreshold, maxWaitMs: config.consolidation.maxWaitHours * 3600_000});
          if (!due.due) continue;
          const ids = store.list({limit: 16, stateFilter: 'active'}).map((item) => item.id).slice(0, Math.min(5, config.consolidation.maxMemories));
          if (ids.length < MIN_SELECTION) { dirty.reset(store); continue; }
          const route = provider.bind(config.consolidation.routeRef || config.extraction.routeRef, 'memory_consolidate');
          inputs = createConsolidationInputs(store, {registry, now, configDigest: configDigestOf(config)});
          versions = createConsolidationVersions(store, {inputs});
          queue = createConsolidationQueue(store, {inputs, provider, now, authorizeExecution: ({jobId}) => ({authorizationVersion: `auto-user-consolidation:${jobId}`})});
          const head = versions.head();
          const expected = {expectedEpoch: store.generation(), expectedScopeRevision: store.revision(), expectedHeadRevision: head.revision};
          const requestId = `auto-consolidate:${fingerprint({projectId: project.projectId, repoId: repository.repoId, memoryIds: ids, change: due.firstAt, ...expected})}`;
          const job = queue.enqueue({requestId, selection: {memoryIds: ids, excerptIds: [], mode: 'memory_only'}, route, ...expected});
          const candidateId = `mc-candidate:${job.jobId}`;
          grantPublication(store, candidateId, job.manifestDigest, now);
          dirty.reset(store);
          pending.set(job.jobId, {queue, versions, store, projectId: project.projectId, repoId: repository.repoId, memoryIds: ids, candidateId});
          counters.autoEnqueued += 1;
          count += 1;
        } catch { counters.lastError = 'auto_enqueue_failed'; try { dirty.reset(store); } catch { /* marker cleanup best effort */ } }
      }
    }
    return count;
  }
  function consolidate(input, context) {
    const {projectId, repository} = resolve(input, context);
    const store = registry.storeFor(repository.scopeRef);
    const memoryIds = select(store, input?.memoryIds);
    const routeRef = config.consolidation?.routeRef || routeRefFor(config, 'memory_extract');
    let route;
    try { route = provider.bind(routeRef, 'memory_consolidate'); } catch { throw failure('CONSOLIDATE_ROUTE_UNAVAILABLE', 'The approved consolidation route is unavailable.'); }
    const inputs = createConsolidationInputs(store, {registry, now, configDigest: configDigestOf(config)});
    const versions = createConsolidationVersions(store, {inputs});
    const queue = createConsolidationQueue(store, {
      inputs, provider, now,
      authorizeExecution: ({jobId}) => ({authorizationVersion: `local-user-consolidation:${jobId}`}),
    });
    const head = versions.head();
    const expected = {expectedEpoch: store.generation(), expectedScopeRevision: store.revision(), expectedHeadRevision: head.revision};
    const requestId = `manual-consolidate:${fingerprint({projectId, repoId: repository.repoId, memoryIds, ...expected})}`;
    const job = queue.enqueue({requestId, selection: {memoryIds, excerptIds: [], mode: 'memory_only'}, route, ...expected});
    const candidateId = `mc-candidate:${job.jobId}`;
    try { grantPublication(store, candidateId, job.manifestDigest, now); }
    catch (error) {
      try { queue.cancel({requestId: `cancel-no-publication:${job.jobId}`, jobId: job.jobId, expectedEpoch: store.generation()}); } catch { /* best effort */ }
      throw error;
    }
    pending.set(job.jobId, {queue, versions, store, projectId, repoId: repository.repoId, memoryIds, candidateId});
    counters.enqueued += 1;
    return Object.freeze({projectId, repoId: repository.repoId, jobId: job.jobId, state: job.state, queued: true, selected: memoryIds.length});
  }
  async function tick({canDispatch} = {}) {
    if (running) return Object.freeze({state: 'skipped', pending: pending.size});
    if (typeof canDispatch !== 'function' || !canDispatch()) return Object.freeze({state: 'foreground_busy', pending: pending.size});
    autoEnqueue();
    if (pending.size === 0) return Object.freeze({state: 'skipped', pending: 0});
    running = true;
    const results = [];
    try {
      for (const [jobId, grant] of [...pending]) {
        if (!canDispatch()) break;
        pending.delete(jobId);
        try {
          let job = grant.queue.get(jobId);
          if (!job) continue;
          if (job.state === 'queued') job = await grant.queue.runJob(jobId, {timeoutMs: 30_000});
          if (job.state !== 'ready') {
            counters.failed += 1;
            counters.lastError = job.state;
            results.push(Object.freeze({jobId, state: job.state}));
            continue;
          }
          const candidate = grant.versions.getCandidate(job.candidateId);
          const published = grant.versions.publish({
            requestId: `manual-publish:${jobId}`,
            candidateId: job.candidateId,
            expectedDigest: candidate.digest,
            expectedEpoch: grant.store.generation(),
            expectedScopeRevision: grant.store.revision(),
            expectedHeadRevision: grant.versions.head().revision,
            publication: {authorize: ({candidateId, digest}) => {
              if (candidateId !== job.candidateId || digest !== candidate.digest) throw failure('MC_PUBLICATION_UNAVAILABLE', 'publication does not match this user gesture');
              const row = publicationRow(grant.store, job.candidateId);
              if (!row) throw failure('MC_PUBLICATION_UNAVAILABLE', 'persistent publication permission is missing');
              return {permissionId: row.id};
            }},
          });
          counters.published += 1;
          results.push(Object.freeze({jobId, state: 'published', versionId: published.versionId, revision: published.revision}));
        } catch (error) {
          counters.failed += 1;
          counters.lastError = typeof error?.code === 'string' ? error.code : 'CONSOLIDATE_FAILED';
          results.push(Object.freeze({jobId, state: 'failed', reason: counters.lastError}));
        }
      }
    } finally { running = false; }
    return Object.freeze({state: 'ticked', results: Object.freeze(results)});
  }
  function requestIdOf(store, jobId) {
    try { return contextOf(store).db.prepare('SELECT request_id FROM ledger.consolidation_jobs WHERE scope_ref=? AND id=?').get(store.scopeRef, jobId)?.request_id; } catch { return undefined; }
  }
  function recover() {
    let recovered = 0;
    let projects;
    try { projects = registry.list(); } catch { projects = []; }
    for (const project of projects) {
      for (const repository of enabledRepos(project)) {
        let store, queue, versions;
        try {
          store = registry.storeFor(repository.scopeRef);
          const inputs = createConsolidationInputs(store, {registry, now, configDigest: configDigestOf(config)});
          versions = createConsolidationVersions(store, {inputs});
          queue = createConsolidationQueue(store, {inputs, provider, now, authorizeExecution: ({jobId}) => ({authorizationVersion: `persisted-user-consolidation:${jobId}`})});
        } catch { continue; }
        try { queue.recoverInterrupted(); } catch { continue; }
        let jobs;
        try { jobs = [...queue.list({state: 'queued', limit: 2}).items, ...queue.list({state: 'ready', limit: 2}).items]; } catch { continue; }
        for (const job of jobs) {
          const requestId = requestIdOf(store, job.jobId);
          if (typeof requestId === 'string' && requestId.startsWith('auto-consolidate:') && !config.consolidation?.enabled) continue;
          const candidateId = `mc-candidate:${job.jobId}`;
          if (!publicationRow(store, candidateId)) continue;
          if (pending.has(job.jobId)) continue;
          pending.set(job.jobId, {queue, versions, store, projectId: project.projectId, repoId: repository.repoId, memoryIds: [], candidateId});
          recovered += 1;
        }
      }
    }
    return recovered;
  }
  function status() {
    const {lastError, ...rest} = counters;
    return Object.freeze({pending: pending.size, running, ...rest, ...(lastError ? {lastError} : {})});
  }
  return Object.freeze({recover, 'memory.consolidate': (input, context) => {
    try { return {ok: true, value: consolidate(input, context)}; }
    catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INVALID_INPUT';
      return {ok: false, error: {code, message: error.message || 'Consolidation could not be queued.'}};
    }
  }, tick, status});
}
