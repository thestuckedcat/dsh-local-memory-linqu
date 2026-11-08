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

test('memory.excerpts lists metadata for an explicit project without returning bodies', () => {
 const store={listExcerpts(args){return [{fragmentId:'mc-excerpt:1',sourceRef:'session-A/turn-1',sourceVersion:'v1',recordGeneration:2,state:'active',generation:3,__args:args}];}};
 const registry={getProject:(id)=>(id==='project-1'?{projectId:id,repositories:[{scopeRef:'scope-1',enabled:true}]}:undefined),storeFor:()=>store};
 const operations=createExperienceOperations({attribution:{read:()=>({state:'none',turn:0})},sessions:{get:()=>undefined},registry});
 const result=operations['memory.excerpts']({projectId:'project-1',memoryId:'memory-1',limit:5},{actor:'user'});
 assert.equal(result.ok,true);
 assert.equal(result.value.total,1);
 assert.equal(result.value.items[0].fragmentId,'mc-excerpt:1');
 assert.equal('text' in result.value.items[0],false);
 const missing=operations['memory.excerpts']({projectId:'project-1'},{actor:'user'});
 assert.equal(missing.ok,false);
 assert.equal(missing.error.code,'INVALID_INPUT');
});
