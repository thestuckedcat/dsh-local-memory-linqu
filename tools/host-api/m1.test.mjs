import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Isolated audit of the two Host seams the M1 plugin depends on: the llm/stream
// waterfall and (through it) the final recall projection gate. Real installed packages,
// synthetic adapter, isolated temporary stores. No profile, credentials or model call.
const hostRoot = process.env.DSH_AUDIT_APP_ROOT;
assert.equal(hostRoot, 'E:/dsh/resources/app.asar/dsh');
const host = async (name) => import(pathToFileURL(`${hostRoot}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const {Context} = await host('cordis');
const {LlmRuntime, LlmAdapter, createUserMessage, createSystemMessage} = await host('dsh-llm');
const boot = await host('dsh-app-boot');
const {openStore} = await import('../../src/backend.mjs');
const {digest} = await import('../../src/scope.mjs');
const {createFinalProjection} = await import('../../plugin/final-projection.mjs');
const {normalizeConfig} = await import('../../plugin/configuration.mjs');

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'memory-m1-'));
}
async function context(t) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  return ctx;
}
async function llmContext(t) {
  const ctx = await context(t);
  await ctx.plugin(LlmRuntime);
  return ctx;
}
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
class TextAdapter extends LlmAdapter {
  calls = [];
  async *stream(options) {
    this.calls.push(options);
    yield {type: 'text-delta', index: 0, text: 'synthetic-output'};
    yield {type: 'usage', usage: {inputTokens: 1, outputTokens: 2}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }
}

test('the installed Host exposes an llm/stream waterfall around the adapter dispatch', async (t) => {
  const ctx = await llmContext(t);
  const adapter = new TextAdapter();
  ctx.llm.registerAdapter(['audit-provider'], adapter);
  const seen = [];
  const off = ctx.on('llm/stream', (options, next) => {
    seen.push({provider: options.provider, messages: options.messages.length});
    return next();
  });
  t.after(() => off());
  const chunks = await collect(ctx.llm.stream({provider: 'audit-provider', model: 'audit-model', maxTokens: 16, messages: [createUserMessage({content: [{type: 'text', text: 'audit input'}], source: {kind: 'user'}})]}));
  assert.equal(seen.length, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
  assert.equal(boot.getDshRuntimeVersion(), '0.2.1-rc.5');
  assert.equal(process.versions.node, '24.21.0');
});

test('a waterfall listener may short-circuit dispatch by yielding its own chunks', async (t) => {
  const ctx = await llmContext(t);
  const adapter = new TextAdapter();
  ctx.llm.registerAdapter(['audit-provider'], adapter);
  const off = ctx.on('llm/stream', () => ({
    async *[Symbol.asyncIterator]() {
      yield {type: 'finish', reason: {kind: 'error', failure: {code: 'synthetic-gate', message: 'blocked'}}};
    },
  }));
  t.after(() => off());
  const chunks = await collect(ctx.llm.stream({provider: 'audit-provider', model: 'audit-model', maxTokens: 16, messages: [createUserMessage({content: [{type: 'text', text: 'audit input'}], source: {kind: 'user'}})]}));
  assert.equal(adapter.calls.length, 0);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].reason.kind, 'error');
});

test('final recall projection passes a live record and blocks the same request after deletion', async (t) => {
  const root = tempRoot();
  const ctx = await llmContext(t);
  const adapter = new TextAdapter();
  ctx.llm.registerAdapter(['audit-provider'], adapter);
  const config = normalizeConfig({dataRoot: join(root, 'data'), profile: 'probe'}, {env: {}});
  const scopeRef = `workspace-v1:${'a'.repeat(64)}`;
  const store = openStore(join(root, 'store'), {scopeRef});
  t.after(() => {
    // Windows cannot remove the fixture directory while SQLite is still open.
    try { store.close(); }
    finally { rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 50}); }
  });
  const memory = store.put({id: 'memory-1', sourceRef: 'session-A/event/1/message/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', sourceVersion: 'version-1', kind: 'lesson', text: 'Descriptor reclamation waits for completion.', origin: 'model'});
  const registry = {
    bindingForScope: () => ({projectId: 'project-audit', projectRevision: 1, bindingRevision: 1, projectState: 'active'}),
    preferencesForScope: () => ({project: {state: 'active'}, preferences: {recall: true}}),
    storeFor: () => store,
  };
  const grants = {currentAuthorizationVersion: () => 'grant-v1:audit:1'};
  const sessions = {get: (id) => (id === 'session-A' ? {id} : undefined)};
  const projection = createFinalProjection({config, registry, grants, sessions});
  const off = projection.install(ctx);
  t.after(() => off());

  const recallText = 'Unverified local memory, quoted as data.\n[{"id":"memory-1"}]';
  const recallMessage = createUserMessage({
    content: [{type: 'text', text: recallText}],
    source: {kind: 'memory-recall', plugin: '@local/dsh-controlled-memory', activation: 'audit', scopeRef, generation: 0, revision: 0, key: 'audit-key'},
  });
  const userMessage = createUserMessage({content: [{type: 'text', text: 'How does reclamation work?'}], source: {kind: 'user'}});
  projection.record({
    sessionId: 'session-A',
    messageId: recallMessage.id,
    textDigest: digest(recallText),
    scopeRef,
    generation: 0,
    revision: 0,
    authorizationVersion: 'grant-v1:audit:1',
    records: [{id: memory.id, sourceRef: memory.sourceRef, sourceVersion: memory.sourceVersion, generation: memory.generation}],
    createdAt: new Date().toISOString(),
  });
  const request = {provider: 'audit-provider', model: 'audit-model', maxTokens: 16, sessionId: 'session-A', messages: [userMessage, recallMessage]};
  const passed = await collect(ctx.llm.stream(request));
  assert.equal(adapter.calls.length, 1);
  assert.equal(passed.at(-1).reason.kind, 'stop');

  store.forget({id: memory.id, collection: 'memories', expectedGeneration: store.generation()});
  const blocked = await collect(ctx.llm.stream(request));
  assert.equal(adapter.calls.length, 1, 'stale recall must not reach the adapter');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason.kind, 'error');
  assert.equal(blocked[0].reason.failure.code, 'memory_projection_stale');

  // A request without any plugin-owned message is never blocked by the gate.
  const unrelated = createUserMessage({content: [{type: 'text', text: 'plain question'}], source: {kind: 'user'}});
  const passedAgain = await collect(ctx.llm.stream({...request, messages: [userMessage, unrelated]}));
  assert.equal(adapter.calls.length, 2);
  assert.equal(passedAgain.at(-1).reason.kind, 'stop');
});
