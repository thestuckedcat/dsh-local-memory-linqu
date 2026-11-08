import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {createConsolidationInputs} from '../src/consolidation-inputs.mjs';
import {createConsolidationQueue} from '../src/consolidation-queue.mjs';
import {contextOf} from '../src/store-internals.mjs';

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
  const queue = createConsolidationQueue(store, {inputs, now: clock});
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
