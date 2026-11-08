import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {contextOf} from '../src/store-internals.mjs';
import {createConsolidationInputs} from '../src/consolidation-inputs.mjs';
import {createConsolidationVersions} from '../src/consolidation-versions.mjs';
import {createConsolidationOperations} from '../plugin/consolidation-operations.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {routeA} from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-consolidation-ops-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  const project = {projectId: 'project-1', state: 'active', revision: 3, repositories: [{repoId: 'main', scopeRef: 'A', enabled: true}]};
  const binding = {
    projectId: 'project-1', projectRevision: 3, projectState: 'active', repoId: 'main',
    canonicalRoot: 'E:/synthetic/project', worktreeRoot: 'E:/synthetic/project', revision: 'workspace',
    buildVariant: 'win-node24', scopeRef: 'A', bindingRevision: 2,
  };
  const registry = {
    list: () => [project],
    getProject: (id) => (id === 'project-1' ? project : undefined),
    bindingForScope: (scopeRef) => (scopeRef === 'A' ? binding : undefined),
    projectForScope: (scopeRef) => (scopeRef === 'A' ? project : undefined),
    applicabilityForProject: () => ({applicability: 'current'}),
    storeFor: (scopeRef) => { if (scopeRef !== 'A') throw new Error('unknown scope'); return store; },
  };
  const provider = createControlledProvider({
    resolveRoute: () => routeA,
    invoke: async (request) => {
      const input = JSON.parse(request.input);
      const refs = input.memories.map((memory) => memory.ref);
      return {
        text: JSON.stringify({
          schema_version: 1,
          groups: refs.length ? [{key: 'g0', type: 'related', memoryRefs: refs, statement: 'Synthetic consolidation statement.', status: 'unverified', support: refs.map((ref) => ({memoryRef: ref, excerptRefs: []})), applicability: 'same_scope_only', freshness: {status: 'unknown', reason: 'synthetic'}}] : [],
          untouched: [],
        }),
        finishReason: 'stop',
        usage: {inputTokens: 10, outputTokens: 5},
      };
    },
  });
  const config = {routes: [{routeRef: 'registered-A', provider: 'provider-A', model: 'model-A'}], extraction: {routeRef: 'registered-A'}, workSummary: {routeRef: 'registered-A'}, limits: {maxOutputTokens: 512}};
  const operations = createConsolidationOperations({config, registry, provider, now: () => new Date('2026-11-09T00:00:00.000Z')});
  t.after(() => {
    try { store.close(); } catch { /* closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {store, registry, provider, operations, config, inputs: createConsolidationInputs(store, {registry})};
}
function memory(store, id, text) {
  return store.put({id, sourceRef: `session-A/${id}`, sourceVersion: 'v1', kind: 'lesson', text, origin: 'user'});
}

test('user-gesture consolidation queues, runs only when idle, publishes a derived head and keeps memory revision', async (t) => {
  const f = fixture(t);
  memory(f.store, 'memory-1', 'Descriptor reclamation waits for completion.');
  memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const queued = f.operations['memory.consolidate']({projectId: 'project-1'}, {actor: 'user'});
  assert.equal(queued.ok, true, JSON.stringify(queued));
  assert.equal(queued.value.queued, true);
  assert.equal(queued.value.selected, 2);
  assert.equal(f.operations.status().pending, 1);
  const busy = await f.operations.tick({canDispatch: () => false});
  assert.equal(busy.state, 'foreground_busy');
  const revision = f.store.revision();
  const ticked = await f.operations.tick({canDispatch: () => true});
  assert.equal(ticked.state, 'ticked');
  assert.equal(ticked.results[0].state, 'published', JSON.stringify(ticked.results[0]));
  assert.equal(f.store.revision(), revision);
  const versions = createConsolidationVersions(f.store);
  const head = versions.head();
  assert.ok(head.versionId);
  assert.equal(head.revision, 1);
  assert.equal(f.operations.status().published, 1);
  assert.equal(f.operations.status().pending, 0);
});

test('only a user can start consolidation and at least two active memories are required', (t) => {
  const f = fixture(t);
  memory(f.store, 'memory-1', 'Only one memory.');
  const model = f.operations['memory.consolidate']({projectId: 'project-1'}, {actor: 'model'});
  assert.equal(model.ok, false);
  assert.equal(model.error.code, 'USER_ACTION_REQUIRED');
  const single = f.operations['memory.consolidate']({projectId: 'project-1'}, {actor: 'user'});
  assert.equal(single.ok, false);
  assert.equal(single.error.code, 'CONSOLIDATE_SELECTION');
});

test('persisted publication permission lets a new worker instance recover and publish a queued user-gesture job', async (t) => {
  const f = fixture(t);
  memory(f.store, 'memory-1', 'Descriptor reclamation waits for completion.');
  memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const queued = f.operations['memory.consolidate']({projectId: 'project-1'}, {actor: 'user'});
  assert.equal(queued.ok, true, JSON.stringify(queued));
  const restarted = createConsolidationOperations({config: {routes: [{routeRef: 'registered-A', provider: 'provider-A', model: 'model-A'}], extraction: {routeRef: 'registered-A'}, workSummary: {routeRef: 'registered-A'}, limits: {maxOutputTokens: 512}}, registry: f.registry, provider: f.provider, now: () => new Date('2026-11-09T00:00:00.000Z')});
  assert.equal(restarted.recover(), 1);
  const ticked = await restarted.tick({canDispatch: () => true});
  assert.equal(ticked.results[0].state, 'published');
  assert.equal(restarted.status().published, 1);
});

test('an opt-in dirty marker auto-enqueues and publishes when the foreground is idle', async (t) => {
  const f = fixture(t);
  memory(f.store, 'memory-1', 'Descriptor reclamation waits for completion.');
  memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  let resets = 0;
  const autoConfig = {...f.config, consolidation: {enabled: true, routeRef: 'registered-A', dirtyCountThreshold: 2, maxWaitHours: 1, maxMemories: 8}};
  const auto = createConsolidationOperations({
    config: autoConfig,
    registry: f.registry,
    provider: f.provider,
    now: () => new Date('2026-11-09T00:00:00.000Z'),
    dirty: {due: () => ({due: true, firstAt: '2026-11-09T00:00:00.000Z'}), reset: () => { resets += 1; }},
  });
  const ticked = await auto.tick({canDispatch: () => true});
  assert.equal(ticked.state, 'ticked');
  assert.equal(ticked.results[0].state, 'published');
  assert.equal(auto.status().autoEnqueued, 1);
  assert.equal(resets, 1);
});

test('recovery moves an interrupted running job to outcome_unknown instead of leaving it stuck', (t) => {
  const f = fixture(t);
  memory(f.store, 'memory-1', 'Descriptor reclamation waits for completion.');
  memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const queued = f.operations['memory.consolidate']({projectId: 'project-1'}, {actor: 'user'});
  assert.equal(queued.ok, true, JSON.stringify(queued));
  const ctx = contextOf(f.store);
  ctx.db.prepare("UPDATE ledger.consolidation_jobs SET state='running',run_token='interrupted' WHERE id=?").run(queued.value.jobId);
  const restarted = createConsolidationOperations({config: f.config, registry: f.registry, provider: f.provider, now: () => new Date('2026-11-09T00:00:00.000Z')});
  assert.equal(restarted.recover(), 0);
  const row = ctx.db.prepare('SELECT state,reason FROM ledger.consolidation_jobs WHERE id=?').get(queued.value.jobId);
  assert.equal(row.state, 'outcome_unknown');
  assert.equal(row.reason, 'recovered_unknown');
});
