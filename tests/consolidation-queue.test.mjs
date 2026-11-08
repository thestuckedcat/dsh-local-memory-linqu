import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {createConsolidationInputs} from '../src/consolidation-inputs.mjs';
import {createConsolidationQueue} from '../src/consolidation-queue.mjs';
import {contextOf} from '../src/store-internals.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {routeA} from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-consolidation-queue-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  let milliseconds = Date.parse('2026-11-09T00:00:00.000Z');
  const project = {projectId: 'project-1', state: 'active', revision: 3};
  const binding = {
    projectId: 'project-1', projectRevision: 3, projectState: 'active', repoId: 'main',
    canonicalRoot: 'E:/synthetic/project', worktreeRoot: 'E:/synthetic/project', revision: 'workspace',
    buildVariant: 'win-node24', scopeRef: 'A', bindingRevision: 2,
  };
  const registry = {
    bindingForScope: (scopeRef) => (scopeRef === 'A' ? binding : undefined),
    projectForScope: (scopeRef) => (scopeRef === 'A' ? project : undefined),
    applicabilityForProject: () => ({applicability: 'current'}),
  };
  const clock = () => new Date(milliseconds);
  const inputs = createConsolidationInputs(store, {registry, now: clock, configDigest: 'config-v1'});
  const provider = createControlledProvider({resolveRoute: () => routeA, invoke: async () => ({text: '{}', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1}})});
  const queue = createConsolidationQueue(store, {inputs, provider, authorizeExecution: () => ({authorizationVersion: 'test'}), now: clock});
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, store, inputs, queue, advance: (delta) => { milliseconds += delta; }};
}
function memory(store, id, text = 'Descriptor reclamation waits for completion.') {
  return store.put({id, sourceRef: `session-A/${id}`, sourceVersion: 'v1', kind: 'lesson', text, origin: 'user'});
}
function route() {
  return {routeRef: 'memory-default', provider: 'deepseek-official', model: 'deepseek-flash', routeVersion: 'route-v1'};
}
function selection(ids) {
  return {memoryIds: ids, excerptIds: [], mode: 'memory_only'};
}
function expected(store) {
  return {expectedEpoch: store.generation(), expectedScopeRevision: store.revision(), expectedHeadRevision: 0};
}

test('enqueue persists a pinned queued job and replays the same request id', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const job = f.queue.enqueue({requestId: 'request-1', selection: selection([first.id, second.id]), route: route(), ...expected(f.store)});
  assert.match(job.jobId, /^mc-job:/);
  assert.equal(job.state, 'queued');
  assert.match(job.manifestDigest, /^[a-f0-9]{64}$/);
  assert.match(job.permissionId, /^mc-permission:/);
  const replay = f.queue.enqueue({requestId: 'request-1', selection: selection([first.id, second.id]), route: route(), ...expected(f.store)});
  assert.equal(replay.jobId, job.jobId);
  assert.equal(f.queue.pending().length, 1);
  assert.equal(f.queue.get(job.jobId).state, 'queued');
  assert.equal(f.queue.list({state: 'queued'}).items.length, 1);
  const input = contextOf(f.store).db.prepare('SELECT * FROM consolidation_inputs WHERE job_id=?').get(job.jobId);
  assert.ok(input);
  assert.match(input.digest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(input.payload).schema_version, 1);
  assert.throws(() => f.queue.enqueue({requestId: 'request-1', selection: selection([first.id]), route: route(), ...expected(f.store)}), (error) => error.code === 'OPERATION_CONFLICT');
});

test('stale expected versions and unsupported selections are refused before any job row', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const base = expected(f.store);
  assert.throws(() => f.queue.enqueue({requestId: 'stale-1', selection: selection([first.id, second.id]), route: route(), ...base, expectedEpoch: base.expectedEpoch + 1}), (error) => error.code === 'MC_EPOCH_CHANGED');
  assert.throws(() => f.queue.enqueue({requestId: 'stale-2', selection: selection([first.id, second.id]), route: route(), ...base, expectedScopeRevision: base.expectedScopeRevision + 1}), (error) => error.code === 'MC_REVISION_CHANGED');
  assert.throws(() => f.queue.enqueue({requestId: 'stale-3', selection: selection([first.id, second.id]), route: route(), ...base, expectedHeadRevision: 1}), (error) => error.code === 'MC_HEAD_CHANGED');
  assert.throws(() => f.queue.enqueue({requestId: 'excerpts', selection: {memoryIds: [first.id, second.id], excerptIds: ['f0'], mode: 'with_excerpts'}, route: route(), ...base}), (error) => error.code === 'MC_EXCERPTS_NOT_READY');
  assert.equal(f.queue.list().items.length, 0);
});

test('runJob validates model output, persists a candidate without advancing the scope revision', async (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const provider = createControlledProvider({
    resolveRoute: () => routeA,
    invoke: async () => ({
      text: JSON.stringify({
        schema_version: 1,
        groups: [{
          key: 'g0', type: 'related', memoryRefs: ['m0', 'm1'],
          statement: 'Reclamation and ownership barriers are related constraints.',
          status: 'unverified',
          support: [{memoryRef: 'm0', excerptRefs: []}, {memoryRef: 'm1', excerptRefs: []}],
          applicability: 'same_scope_only',
          freshness: {status: 'unknown', reason: 'no explicit time evidence'},
        }],
        untouched: [],
      }),
      finishReason: 'stop',
      usage: {inputTokens: 12, outputTokens: 8},
    }),
  });
  const {createConsolidationQueue} = await import('../src/consolidation-queue.mjs');
  const queue = createConsolidationQueue(f.store, {inputs: f.inputs, provider, authorizeExecution: () => ({authorizationVersion: 'grant-v1:test:1'})});
  const job = queue.enqueue({requestId: 'run-1', selection: selection([first.id, second.id]), route: routeA, ...expected(f.store)});
  const revision = f.store.revision();
  const result = await queue.runJob(job.jobId);
  assert.equal(result.state, 'ready');
  assert.match(result.candidateId, /^mc-candidate:/);
  assert.equal(f.store.revision(), revision, 'candidate persistence must not advance the scope revision');
  assert.equal(f.store.list({limit: 10}).length, 2);
  const body = contextOf(f.store).db.prepare('SELECT * FROM consolidation_bodies WHERE id=?').get(result.candidateId);
  assert.ok(body);
  assert.equal(JSON.parse(body.payload).manifestDigest, job.manifestDigest);
  const entry = contextOf(f.store).db.prepare("SELECT * FROM ledger.entries WHERE scope_ref='A' AND collection='consolidation_candidates' AND id=?").get(result.candidateId);
  assert.equal(entry.state, 'active');
  const dependencies = contextOf(f.store).db.prepare("SELECT count(*) AS n FROM ledger.consolidation_dependencies WHERE scope_ref='A' AND owner_kind='candidate' AND owner_id=?").get(result.candidateId).n;
  assert.equal(dependencies, 2);
  assert.equal(contextOf(f.store).db.prepare('SELECT count(*) AS n FROM consolidation_inputs WHERE job_id=?').get(job.jobId).n, 0);
});

test('runJob rejects invalid model output and clears the input without a candidate', async (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const provider = createControlledProvider({resolveRoute: () => routeA, invoke: async () => ({text: '{not json', finishReason: 'stop', usage: {inputTokens: 1, outputTokens: 1}})});
  const {createConsolidationQueue} = await import('../src/consolidation-queue.mjs');
  const queue = createConsolidationQueue(f.store, {inputs: f.inputs, provider, authorizeExecution: () => ({authorizationVersion: 'grant-v1:test:1'})});
  const job = queue.enqueue({requestId: 'invalid-1', selection: selection([first.id, second.id]), route: routeA, ...expected(f.store)});
  const result = await queue.runJob(job.jobId);
  assert.equal(result.state, 'stale');
  assert.equal(result.candidateId, undefined);
  assert.equal(contextOf(f.store).db.prepare('SELECT count(*) AS n FROM ledger.consolidation_jobs WHERE scope_ref=? AND candidate_id IS NOT NULL').get('A').n, 0);
  assert.equal(contextOf(f.store).db.prepare('SELECT count(*) AS n FROM consolidation_inputs WHERE job_id=?').get(job.jobId).n, 0);
});

test('pending capacity, cancel idempotency, and recovery of running jobs', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const one = f.queue.enqueue({requestId: 'request-1', selection: selection([first.id, second.id]), route: route(), ...expected(f.store)});
  const two = f.queue.enqueue({requestId: 'request-2', selection: selection([first.id, second.id]), route: route(), ...expected(f.store)});
  assert.equal(f.queue.pending().length, 2);
  assert.throws(() => f.queue.enqueue({requestId: 'request-3', selection: selection([first.id, second.id]), route: route(), ...expected(f.store)}), (error) => error.code === 'MC_QUEUE_FULL');

  const cancelled = f.queue.cancel({requestId: 'cancel-1', jobId: one.jobId, expectedEpoch: f.store.generation()});
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(f.queue.cancel({requestId: 'cancel-1', jobId: one.jobId, expectedEpoch: f.store.generation()}).state, 'cancelled');
  assert.equal(f.queue.pending().length, 1);
  assert.equal(f.queue.get(two.jobId).state, 'queued');

  contextOf(f.store).db.prepare("UPDATE ledger.consolidation_jobs SET state='running' WHERE id=?").run(two.jobId);
  assert.equal(f.queue.recoverInterrupted(), 1);
  assert.equal(f.queue.get(two.jobId).state, 'outcome_unknown');
  assert.equal(contextOf(f.store).db.prepare('SELECT count(*) AS n FROM consolidation_inputs WHERE job_id=?').get(two.jobId).n, 0);
  assert.equal(f.queue.recoverInterrupted(), 0);
});

test('a queued job whose memory changed is settled stale and its input is cleared', async (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const job = f.queue.enqueue({requestId: 'preflight-1', selection: selection([first.id, second.id]), route: routeA, ...expected(f.store)});
  f.store.correct({id: first.id, text: 'Descriptor reclamation requires the completion barrier.', sourceVersion: 'v2', expectedGeneration: f.store.generation()});
  const result = await f.queue.runJob(job.jobId);
  assert.equal(result.state, 'stale');
  assert.equal(contextOf(f.store).db.prepare('SELECT count(*) AS n FROM consolidation_inputs WHERE job_id=?').get(job.jobId).n, 0);
});

test('a running consolidation job cannot be reported as cancelled without a trusted abort', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const job = f.queue.enqueue({requestId: 'cancel-running', selection: selection([first.id, second.id]), route: routeA, ...expected(f.store)});
  contextOf(f.store).db.prepare("UPDATE ledger.consolidation_jobs SET state='running' WHERE id=?").run(job.jobId);
  assert.throws(() => f.queue.cancel({requestId: 'cancel-running', jobId: job.jobId, expectedEpoch: f.store.generation()}), (error) => error.code === 'MC_CANCEL_RUNNING_UNAVAILABLE');
  assert.equal(f.queue.get(job.jobId).state, 'running');
});

test('deleting a selected memory invalidates the queued job and erases its stored input', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const job = f.queue.enqueue({requestId: 'delete-input', selection: selection([first.id, second.id]), route: routeA, ...expected(f.store)});
  const before = contextOf(f.store).db.prepare('SELECT payload FROM consolidation_inputs WHERE job_id=?').get(job.jobId);
  assert.match(before.payload, /reclamation/i);
  f.store.forget({id: first.id, expectedGeneration: f.store.generation()});
  assert.equal(f.queue.get(job.jobId).state, 'stale');
  assert.equal(contextOf(f.store).db.prepare('SELECT count(*) AS n FROM consolidation_inputs WHERE job_id=?').get(job.jobId).n, 0);
});
