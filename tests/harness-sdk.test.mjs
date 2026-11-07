import assert from 'node:assert/strict';
import test from 'node:test';
import {BlockAssembler, createSystemMessage, createUserMessage, deepFreeze} from '../plugin/harness-sdk.mjs';

test('created messages are identified, frozen and shaped like the Host helpers', () => {
  const message = createUserMessage({content: [{type: 'text', text: 'hello'}], source: {kind: 'user'}});
  assert.equal(message.role, 'user');
  assert.equal(typeof message.id, 'string');
  assert.ok(message.id.length > 10);
  assert.ok(Object.isFrozen(message));
  assert.ok(Object.isFrozen(message.content[0]));
  assert.throws(() => { message.content.push({type: 'text', text: 'x'}); });
  const system = createSystemMessage('prompt');
  assert.deepEqual(system, {role: 'system', content: [{type: 'text', text: 'prompt'}], source: {kind: 'system-prompt'}, id: system.id});
  assert.deepEqual(createSystemMessage('').content, []);
  assert.throws(() => createUserMessage(null));
});

test('deepFreeze detaches the value from its source and locks nested objects', () => {
  const source = {a: {b: [1, 2]}};
  const frozen = deepFreeze(source);
  assert.notEqual(frozen, source);
  assert.ok(Object.isFrozen(frozen.a) && Object.isFrozen(frozen.a.b));
  assert.throws(() => { frozen.a.b.push(3); });
});

test('BlockAssembler joins deltas, honors block-end text and exposes usage/finish', () => {
  const assembler = new BlockAssembler();
  assembler.push({type: 'block-start', index: 0, blockType: 'text'});
  assembler.push({type: 'text-delta', index: 0, text: 'hel'});
  assembler.push({type: 'text-delta', index: 0, text: 'lo'});
  assembler.push({type: 'block-end', index: 0, block: {type: 'text', text: 'hello'}});
  assembler.push({type: 'usage', usage: {inputTokens: 3, outputTokens: 2}});
  assembler.push({type: 'finish', reason: {kind: 'stop'}});
  assert.deepEqual(assembler.blocks(), [{type: 'text', text: 'hello'}]);
  assert.deepEqual(assembler.usage, {inputTokens: 3, outputTokens: 2});
  assert.deepEqual(assembler.finish, {kind: 'stop'});
});

test('BlockAssembler assembles open text blocks and rejects unknown chunk types', () => {
  const assembler = new BlockAssembler();
  assembler.push({type: 'text-delta', index: 1, text: 'partial'});
  assert.deepEqual(assembler.blocks(), [{type: 'text', text: 'partial'}]);
  assert.deepEqual(assembler.finish, {kind: 'stop'});
  assert.throws(() => assembler.push({type: 'mystery'}));
});
