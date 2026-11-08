import assert from 'node:assert/strict';
import test from 'node:test';
import {createBusyGate} from '../plugin/idle-gate.mjs';

function fixture({agentIds = [], quietMs = 30_000} = {}) {
  let ms = Date.parse('2026-11-09T00:00:00.000Z');
  const agents = agentIds.map((id) => ({id}));
  const gate = createBusyGate({agents: {list: () => agents}, now: () => ms, quietMs});
  return {
    gate,
    agents,
    advance(delta) { ms += delta; },
    add(id) { agents.push({id}); },
    remove(id) { const index = agents.findIndex((agent) => agent.id === id); if (index >= 0) agents.splice(index, 1); },
  };
}

test('an empty foreground is idle, while a discovered unknown agent fails closed', () => {
  const empty = fixture();
  assert.equal(empty.gate.status().state, 'quieting');
  empty.advance(30_000);
  assert.equal(empty.gate.status().state, 'idle');
  assert.equal(empty.gate.canDispatch(), true);

  const unknown = fixture({agentIds: ['session-a']});
  const status = unknown.gate.status();
  assert.equal(status.state, 'unknown');
  assert.equal(status.unknown, 1);
  assert.equal(unknown.gate.canDispatch(), false);
});

test('a running agent blocks, and an idle transition waits a full quiet window', () => {
  const f = fixture({agentIds: ['session-a']});
  f.gate.noteAgentStatus('session-a', 'running');
  assert.equal(f.gate.status().state, 'busy');
  assert.equal(f.gate.canDispatch(), false);

  f.gate.noteAgentStatus('session-a', 'idle');
  assert.equal(f.gate.status().state, 'quieting');
  f.advance(29_999);
  assert.equal(f.gate.canDispatch(), false);
  f.advance(1);
  assert.equal(f.gate.status().state, 'idle');
  assert.equal(f.gate.canDispatch(), true);
});

test('new activity resets the quiet window and a new agent is unknown until it reports', () => {
  const f = fixture({agentIds: ['session-a']});
  f.gate.noteAgentStatus('session-a', 'idle');
  f.advance(30_000);
  assert.equal(f.gate.canDispatch(), true);
  f.gate.noteSessionStatus('session-a', true);
  assert.equal(f.gate.status().state, 'busy');
  f.advance(30_000);
  f.gate.noteSessionStatus('session-a', false);
  assert.equal(f.gate.status().state, 'quieting');

  f.add('session-b');
  assert.equal(f.gate.status().state, 'unknown');
  f.gate.noteAgentStatus('session-b', 'idle');
  assert.equal(f.gate.status().state, 'quieting');
});

test('disposal removes an agent and the gate rejects an invalid quiet window', () => {
  const f = fixture({agentIds: ['session-a', 'session-b']});
  f.gate.noteAgentStatus('session-a', 'idle');
  f.gate.noteAgentStatus('session-b', 'running');
  assert.equal(f.gate.status().state, 'busy');
  f.remove('session-b');
  f.gate.noteDisposed('session-b');
  assert.equal(f.gate.status().state, 'quieting');
  assert.throws(() => createBusyGate({quietMs: -1}), /Invalid quiet window/);
});
