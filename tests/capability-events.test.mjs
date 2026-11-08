import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {openProjectCatalog} from '../src/projects.mjs';
import {createCapabilityEventConsumer} from '../plugin/capability-events.mjs';

const SCOPE = 'workspace-v1:' + 'a'.repeat(64);

function event(overrides = {}) {
  return {
    schema_version: 1,
    event_id: 'event-1',
    kind: 'workspace_files_restored',
    source_capability: '03-session-management',
    scope_ref: SCOPE,
    session_ref: 'session-a',
    operation_id: 'operation-1',
    generation: 2,
    affected_refs: ['session-a/turn-1'],
    before_snapshot: null,
    after_snapshot: null,
    outcome: 'completed',
    occurred_at: '2026-11-09T00:00:00.000Z',
    ...overrides,
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-capability-'));
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'));
  const store = openStore(join(root, 'scopes', 'a'), {scopeRef: SCOPE});
  const registry = {
    bindingForScope(scopeRef) { return scopeRef === SCOPE ? {scopeRef: SCOPE} : undefined; },
    storeFor(scopeRef) { if (scopeRef !== SCOPE) throw new Error('unknown scope'); return store; },
  };
  const consumer = createCapabilityEventConsumer({catalog, registry, now: () => new Date('2026-11-09T00:00:00.000Z')});
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { catalog.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, catalog, store, consumer};
}

test('capability events require a trusted baseline before applying sequentially', (t) => {
  const {consumer, store} = fixture(t);
  const held = consumer.consume(event());
  assert.equal(held.state, 'held');
  assert.equal(held.reason, 'baseline_unknown');
  assert.equal(consumer.isHeld(SCOPE), true);

  const baseline = consumer.establishBaseline({scopeRef: SCOPE, generation: 1, eventId: 'baseline-1'});
  assert.equal(baseline.generation, 1);
  assert.equal(consumer.isHeld(SCOPE), false);

  const memory = store.put({id: 'memory-1', sourceRef: 'session-a/turn-1', sourceVersion: 'v1', kind: 'lesson', text: 'Restored file boundary.', origin: 'user'});
  const applied = consumer.consume(event());
  assert.equal(applied.state, 'applied');
  assert.equal(applied.generation, 2);
  assert.deepEqual(store.list({limit: 10}), [], 'affected source entries are no longer active');
  assert.deepEqual(consumer.consume(event()), {state: 'duplicate', applied: true, eventId: 'event-1'});
  assert.equal(consumer.status().applied, 1);
});

test('a generation gap, late event or non-completed outcome is held and never applied', (t) => {
  const {consumer} = fixture(t);
  consumer.establishBaseline({scopeRef: SCOPE, generation: 1});
  const gap = consumer.consume(event({event_id: 'gap', generation: 3}));
  assert.equal(gap.state, 'held');
  assert.equal(gap.reason, 'generation_gap');
  assert.equal(consumer.isHeld(SCOPE), true);

  consumer.establishBaseline({scopeRef: SCOPE, generation: 3});
  const late = consumer.consume(event({event_id: 'late-1', generation: 2}));
  assert.equal(late.reason, 'late_generation_requires_recheck');

  const partial = consumer.consume(event({event_id: 'partial', generation: 4, outcome: 'partial'}));
  assert.equal(partial.reason, 'outcome_partial');
  const unknown = consumer.consume(event({event_id: 'unknown', generation: 4, outcome: 'outcome_unknown'}));
  assert.equal(unknown.reason, 'outcome_unknown');
});

test('a held unregistered scope and invalid events fail closed visibly', (t) => {
  const {consumer} = fixture(t);
  const other = 'workspace-v1:' + 'b'.repeat(64);
  consumer.establishBaseline({scopeRef: other, generation: 1});
  const unregistered = consumer.consume(event({scope_ref: other, event_id: 'unregistered', generation: 2}));
  assert.equal(unregistered.state, 'held');
  assert.equal(unregistered.reason, 'scope_not_registered');

  assert.throws(() => consumer.consume({...event(), extra: true}), /Invalid capability event/);
  assert.throws(() => consumer.consume(event({schema_version: 2})), /unsupported capability event schema/);
  assert.throws(() => consumer.consume(event({source_capability: 'other'})), /unknown capability event source/);
  assert.throws(() => consumer.consume(event({outcome: 'done'})), /unknown capability event outcome/);
  assert.throws(() => consumer.consume(event({affected_refs: []})), /invalid affected refs/);
});

test('an optional trusted getScopeState can refuse a producer-state mismatch', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-capability-state-'));
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'));
  const store = openStore(join(root, 'scopes', 'a'), {scopeRef: SCOPE});
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { catalog.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  const registry = {
    bindingForScope: () => ({scopeRef: SCOPE}),
    storeFor: () => store,
  };
  const consumer = createCapabilityEventConsumer({
    catalog, registry, getScopeState: () => ({generation: 9}),
  });
  consumer.establishBaseline({scopeRef: SCOPE, generation: 1});
  const result = consumer.consume(event({event_id: 'mismatch', generation: 2}));
  assert.equal(result.state, 'held');
  assert.equal(result.reason, 'producer_state_mismatch');
});
