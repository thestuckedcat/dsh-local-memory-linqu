import assert from 'node:assert/strict';
import test from 'node:test';
import {createExperienceOperations} from '../plugin/experience-operations.mjs';

function fixture() {
  const session = {id: 's1'};
  const calls = [];
  const attribution = {
    read(args) {
      calls.push(args);
      return {state: 'available', turn: args.turn, mapping: '记忆影响：①参考记1“示例”。', items: [{ref: '记1'}]};
    },
  };
  const operations = createExperienceOperations({attribution, sessions: {get: (id) => (id === 's1' ? session : undefined)}});
  return {operations, calls, session};
}

test('memory.attribution resolves only within the caller session', () => {
  const {operations, calls} = fixture();
  const user = operations['memory.attribution']({sessionId: 's1', turn: 2}, {actor: 'user'});
  assert.equal(user.ok, true);
  assert.equal(user.value.mapping, '记忆影响：①参考记1“示例”。');
  assert.equal(calls[0].turn, 2);

  const modelOwn = operations['memory.attribution']({sessionId: 's1', turn: 2}, {actor: 'model', sessionId: 's1'});
  assert.equal(modelOwn.ok, true);

  const modelOther = operations['memory.attribution']({sessionId: 's2', turn: 2}, {actor: 'model', sessionId: 's1'});
  assert.equal(modelOther.ok, false);
  assert.equal(modelOther.error.code, 'USER_ACTION_REQUIRED');
});

test('memory.attribution fails closed for missing sessions and invalid turns', () => {
  const {operations} = fixture();
  const missing = operations['memory.attribution']({sessionId: 'gone', turn: 1}, {actor: 'user'});
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'SESSION_NOT_FOUND');

  const noSession = operations['memory.attribution']({turn: 1}, {actor: 'user'});
  assert.equal(noSession.ok, false);
  assert.equal(noSession.error.code, 'SESSION_REQUIRED');

  const badTurn = operations['memory.attribution']({sessionId: 's1', turn: -1}, {actor: 'user'});
  assert.equal(badTurn.ok, false);
  assert.equal(badTurn.error.code, 'INVALID_INPUT');
});
