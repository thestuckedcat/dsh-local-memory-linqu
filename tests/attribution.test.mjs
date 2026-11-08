import assert from 'node:assert/strict';
import test from 'node:test';
import {createAttributionManager} from '../plugin/attribution.mjs';

function setup({text = '第一结论〔记1〕，第二结论〔记2〕。', records, live = {}} = {}) {
  const store = {
    get(id) { return live[id]; },
  };
  const binding = {scopeRef: 'scope-a', projectId: 'project-a'};
  const session = {
    id: 'session-a',
    ownEvents() {
      return [
        {type: 'turn/start', data: {turn: 1}},
        {type: 'assistant/message', data: {turn: 1, message: {content: [{type: 'text', text}]}}},
        {type: 'turn/end', data: {turn: 1}},
      ];
    },
  };
  const registry = {
    bindingForSession(candidate) { return candidate === session ? binding : undefined; },
    storeFor(scopeRef) { return scopeRef === 'scope-a' ? store : undefined; },
  };
  const attribution = createAttributionManager({registry, now: () => new Date('2026-11-09T00:00:00.000Z')});
  attribution.noteRecall({
    sessionId: 'session-a', turn: 1, scopeRef: 'scope-a',
    records: records ?? [
      {ref: '记1', id: 'mem-1', sourceRef: 'session-a/turn-1', sourceVersion: 'v1', generation: 2},
      {ref: '记2', id: 'mem-2', sourceRef: 'session-a/turn-2', sourceVersion: 'v1', generation: 3},
    ],
  });
  return {attribution, session, store, binding, registry};
}

function record(overrides = {}) {
  return {
    id: 'mem-1', state: 'active', generation: 2, sourceRef: 'session-a/turn-1', sourceVersion: 'v1',
    text: 'Descriptor reclamation waits for completion.', ...overrides,
  };
}

test('declared markers become a bounded, revalidated attribution mapping', () => {
  const live = {
    'mem-1': record(),
    'mem-2': record({id: 'mem-2', generation: 3, sourceRef: 'session-a/turn-2', text: 'Ownership barrier precedes reclamation.'}),
  };
  const {attribution, session} = setup({live});
  const result = attribution.handleTurnStopping({agent: {session}, turn: 1});
  assert.equal(result.state, 'available');
  assert.ok(Array.from(result.mapping).length <= 100, result.mapping);
  assert.match(result.mapping, /^记忆影响：/);
  assert.equal(result.items.length, 2);
  const read = attribution.read({sessionId: 'session-a', turn: 1, session});
  assert.equal(read.state, 'available');
  assert.equal(read.mapping, result.mapping);
  assert.equal(read.items[0].ref, '记1');
  assert.equal(read.items[0].name.length > 0, true);
});

test('no declared marker, unknown ref, or stale live record fails closed', () => {
  const noMarker = setup({text: '普通回答，没有引用。', live: {'mem-1': record(), 'mem-2': record({id: 'mem-2'})}});
  assert.equal(noMarker.attribution.handleTurnStopping({agent: {session: noMarker.session}, turn: 1}).state, 'none');

  const unknown = setup({text: '引用不存在的〔记9〕。', live: {'mem-1': record(), 'mem-2': record({id: 'mem-2'})}});
  assert.equal(unknown.attribution.handleTurnStopping({agent: {session: unknown.session}, turn: 1}).state, 'unavailable');

  const stale = setup({text: '引用〔记1〕。', live: {'mem-1': record({generation: 99})}});
  assert.equal(stale.attribution.handleTurnStopping({agent: {session: stale.session}, turn: 1}).state, 'unavailable');
  assert.equal(stale.attribution.read({sessionId: 'session-a', turn: 1, session: stale.session}).state, 'unavailable');
});

test('duplicate markers collapse and an over-limit mapping is not truncated', () => {
  const long = '超长结论名称用于测试映射长度限制';
  const live = {
    'mem-1': record({text: `${long}一`}),
    'mem-2': record({id: 'mem-2', text: `${long}二`}),
  };
  const dup = setup({text: '先说〔记1〕，又说〔记1〕。', live});
  const deduped = dup.attribution.handleTurnStopping({agent: {session: dup.session}, turn: 1});
  assert.equal(deduped.state, 'available');
  assert.equal(deduped.items.length, 1);

  const many = setup({
    text: Array.from({length: 10}, (_, index) => `〔记${index + 1}〕`).join(''),
    live: Object.fromEntries(Array.from({length: 10}, (_, index) => [
      `mem-${index + 1}`,
      record({id: `mem-${index + 1}`, generation: index + 1, text: `${long}${index + 1}`}),
    ])),
    records: Array.from({length: 10}, (_, index) => ({ref: `记${index + 1}`, id: `mem-${index + 1}`, sourceRef: 'session-a/turn-1', sourceVersion: 'v1', generation: index + 1})),
  });
  const over = many.attribution.handleTurnStopping({agent: {session: many.session}, turn: 1});
  assert.equal(over.state, 'over_limit');
  assert.equal(over.mapping, undefined);
});

test('attribution remains scoped to the current session binding', () => {
  const live = {'mem-1': record(), 'mem-2': record({id: 'mem-2', generation: 3, sourceRef: 'session-a/turn-2'})};
  const {attribution, session, registry} = setup({live});
  const bound = attribution.handleTurnStopping({agent: {session}, turn: 1});
  assert.equal(bound.state, 'available');
  registry.bindingForSession = () => undefined;
  assert.equal(attribution.read({sessionId: 'session-a', turn: 1, session}).state, 'unavailable');
});
