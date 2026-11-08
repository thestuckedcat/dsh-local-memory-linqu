import {checkedText} from '../src/scope.mjs';
import {fingerprint} from '../src/validation.mjs';
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

export function createConsolidationOperations({config, registry, provider, now = () => new Date()} = {}) {
  if (!config || typeof config !== 'object') throw new Error('Normalized configuration required');
  if (!registry || typeof registry.getProject !== 'function' || typeof registry.storeFor !== 'function' || typeof registry.bindingForScope !== 'function') throw new Error('Trusted registry required');
  if (!provider || typeof provider.bind !== 'function' || typeof provider.execute !== 'function') throw new Error('Controlled provider required');
  const pending = new Map();
  const counters = {enqueued: 0, published: 0, failed: 0, lastError: undefined};
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
  function consolidate(input, context) {
    const {projectId, repository} = resolve(input, context);
    const store = registry.storeFor(repository.scopeRef);
    const memoryIds = select(store, input?.memoryIds);
    const routeRef = routeRefFor(config, 'memory_extract');
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
    pending.set(job.jobId, {queue, versions, store, projectId, repoId: repository.repoId, memoryIds});
    counters.enqueued += 1;
    return Object.freeze({projectId, repoId: repository.repoId, jobId: job.jobId, state: job.state, queued: true, selected: memoryIds.length});
  }
  async function tick({canDispatch} = {}) {
    if (running || pending.size === 0) return Object.freeze({state: 'skipped', pending: pending.size});
    if (typeof canDispatch !== 'function' || !canDispatch()) return Object.freeze({state: 'foreground_busy', pending: pending.size});
    running = true;
    const results = [];
    try {
      for (const [jobId, grant] of [...pending]) {
        if (!canDispatch()) break;
        pending.delete(jobId);
        try {
          const job = await grant.queue.runJob(jobId, {timeoutMs: 30_000});
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
              return {permissionId: `local-user-publication:${jobId}`};
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
  function status() {
    const {lastError, ...rest} = counters;
    return Object.freeze({pending: pending.size, running, ...rest, ...(lastError ? {lastError} : {})});
  }
  return Object.freeze({'memory.consolidate': (input, context) => {
    try { return {ok: true, value: consolidate(input, context)}; }
    catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INVALID_INPUT';
      return {ok: false, error: {code, message: error.message || 'Consolidation could not be queued.'}};
    }
  }, tick, status});
}
