import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {apply} from '../plugin/index.mjs';
import {openProjectCatalog} from '../src/projects.mjs';
import {FakeHost, sleep, waitFor} from './fake-host.mjs';

let operationCounter = 0;
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-plugin-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), {recursive: true});
  const host = new FakeHost();
  const config = {
    dataRoot: join(root, 'data'),
    profile: 'test',
    scheduler: {pollMs: 100, jobTimeoutMs: 5000},
    projects: [{name: 'demo', repositories: [{repoId: 'main', canonicalRoot: repo, worktreeRoot: repo, revision: 'workspace', buildVariant: 'test'}]}],
    ...overrides,
  };
  apply(host.ctx, config);
  t.after(async () => {
    try { await host.dispose(); } catch { /* teardown continues */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 50});
  });
  return {root, repo, host, config};
}
async function api(host, operation, input = {}, extra = {}) {
  operationCounter += 1;
  const response = await host.callApi({schemaVersion: 1, operationId: `entry-${process.pid}-${operationCounter}`, operation, input, ...extra});
  return response.json;
}
async function projectId(host) {
  const result = await api(host, 'project.list');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value.projects[0].projectId;
}
function userQuery(id, text, rpcId = `rpc-${id}`) {
  return {id, role: 'user', content: [{type: 'text', text}], source: {kind: 'user', rpcId, clientTimeZone: 'Asia/Shanghai'}};
}

test('activation registers tools, command, HTTP route and a ready status', async (t) => {
  const {host} = fixture(t);
  for (const name of ['memory_status', 'memory_search', 'memory_remember', 'memory_list', 'memory_get', 'memory_correct', 'memory_archive', 'memory_delete', 'memory_tasks', 'work_list', 'work_get']) {
    assert.ok(host.tool(name), `tool ${name} should be registered`);
  }
  assert.ok(host.command('memory'));
  assert.ok(host.routes.has('/dsh-local-memory/api'));
  const result = await api(host, 'status');
  assert.equal(result.ok, true, JSON.stringify(result));
  const value = JSON.stringify(result.value);
  assert.match(value, /dsh-local-memory-linqu/);
  assert.match(value, /"registry"/);
  assert.match(value, /"state":"ready"/);
  assert.doesNotMatch(value, /[A-Z]:\\\\/);
  assert.ok(result.value.experience, 'status exposes the read-only experience phase');
  assert.ok(['idle', 'queued', 'remembering', 'paused'].includes(result.value.experience.phase));
  assert.equal(typeof result.value.experience.pendingScopes, 'number');
  assert.equal(typeof result.value.experience.running, 'number');
  assert.ok(result.value.capability, 'status exposes the capability consumer state');
  assert.equal(typeof result.value.capability.holds, 'number');
  assert.equal(typeof result.value.capability.cursors, 'number');
});

test('closed loop: extraction persists, recall injects, stale projection blocks dispatch', async (t) => {
  const {host, repo} = fixture(t);
  const {session} = host.addSession({id: 'session-1', cwd: repo});
  host.userMessage(session, 'We confirmed that descriptor completion precedes reclamation.');
  const project = await waitFor(async () => {
    const listed = await api(host, 'project.list');
    const id = listed.ok ? listed.value.projects[0]?.projectId : undefined;
    if (!id) return undefined;
    const found = await api(host, 'memory.search', {projectId: id, query: 'reclamation', limit: 10});
    return found.ok && found.value.items.length >= 1 ? {id, item: found.value.items[0]} : undefined;
  }, {timeoutMs: 10000, label: 'extracted memory'});
  assert.equal(project.item.origin, 'model');
  assert.equal(project.item.verification, 'unverified');
  assert.match(project.item.text, /Completion|reclamation/i);

  const {session: second} = host.addSession({id: 'session-2', cwd: repo});
  const query = userQuery('q-1', 'How does descriptor reclamation work?');
  const decision = await host.preStep(second, [query]);
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 2, 'recall should append exactly one message');
  const injected = decision.messages[1];
  assert.equal(injected.source.kind, 'memory-recall');
  assert.match(injected.content[0].text, /reclamation/i);

  const passed = await host.llmStream({sessionId: second.id, provider: 'deepseek-official', model: 'deepseek-flash', messages: decision.messages});
  assert.equal(passed.adapterCalled, true);
  const passedChunks = [];
  for await (const chunk of passed.iterable) passedChunks.push(chunk);
  assert.equal(passedChunks.at(-1).type, 'finish');
  assert.equal(passedChunks.at(-1).reason.kind, 'stop');

  // The exact same committed recall message must not be forwarded once the record is deleted.
  const removed = await api(host, 'memory.delete', {projectId: project.id, id: project.item.id, expectedGeneration: project.item.expectedGeneration});
  assert.equal(removed.ok, true, JSON.stringify(removed));
  const blocked = await host.llmStream({sessionId: second.id, provider: 'deepseek-official', model: 'deepseek-flash', messages: decision.messages});
  assert.equal(blocked.adapterCalled, false, 'stale recall must not reach the adapter');
  const blockedChunks = [];
  for await (const chunk of blocked.iterable) blockedChunks.push(chunk);
  assert.equal(blockedChunks.length, 1);
  assert.equal(blockedChunks[0].type, 'finish');
  assert.equal(blockedChunks[0].reason.kind, 'error');
  assert.equal(blockedChunks[0].reason.failure.code, 'memory_projection_stale');
});

test('an unbound session keeps chatting, enqueues nothing and recalls nothing', async (t) => {
  const {host, root} = fixture(t);
  mkdirSync(join(root, 'elsewhere'), {recursive: true});
  const {session} = host.addSession({id: 'session-unbound', cwd: join(root, 'elsewhere')});
  host.userMessage(session, 'This should not be extracted.');
  const project = await projectId(host);
  await sleep(400);
  const tasks = await api(host, 'task.list', {projectId: project});
  assert.equal(tasks.ok, true, JSON.stringify(tasks));
  assert.equal(tasks.value.items.length, 0);
  const decision = await host.preStep(session, [userQuery('q-unbound', 'hello')]);
  assert.equal(decision.messages.length, 1);
  assert.notEqual(decision.messages[0].source?.kind, 'memory-recall');
});

test('user-only memory actions are refused for model callers', async (t) => {
  const {host, repo} = fixture(t);
  const {agent} = host.addSession({id: 'session-actor', cwd: repo});
  const tool = host.tool('memory_delete');
  const result = await tool.execute({id: 'memory-x', expectedGeneration: 0}, {agent, signal: new AbortController().signal});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'USER_ACTION_REQUIRED');
});

test('/memory register binds the current working directory as a new project', async (t) => {
  const {host, root} = fixture(t);
  const secondRepo = join(root, 'second-repo');
  mkdirSync(join(secondRepo, 'src'), {recursive: true});
  const {session, agent} = host.addSession({id: 'session-register', cwd: secondRepo});
  const command = host.command('memory');
  const registered = await command.handler({commandId: 'c1', agent, rawInput: 'register second', attachments: [], signal: new AbortController().signal});
  assert.equal(registered.kind, 'success', JSON.stringify(registered));
  assert.match(registered.text, /second/);
  host.userMessage(session, 'The second project remembers transaction boundaries.');
  const project = await waitFor(async () => {
    const listed = await api(host, 'project.list');
    const candidate = listed.ok ? listed.value.projects.find((entry) => entry.name === 'second') : undefined;
    if (!candidate) return undefined;
    const found = await api(host, 'memory.search', {projectId: candidate.projectId, query: 'reclamation', limit: 10});
    return found.ok && found.value.items.length >= 1 ? candidate : undefined;
  }, {timeoutMs: 10000, label: 'second project memory'});
  assert.equal(project.state, 'active');
  // The /memory remember command is also a product write path and must mark the abstract dirty.
  const before = await api(host, 'abstract.list', {projectId: project.projectId});
  assert.ok(before.ok && before.value.revision >= 1, JSON.stringify(before));
  const remembered = await command.handler({commandId: 'c2', agent, rawInput: 'remember CLI dirty lesson', attachments: [], signal: new AbortController().signal});
  assert.equal(remembered.kind, 'success', JSON.stringify(remembered));
  const after = await api(host, 'abstract.list', {projectId: project.projectId});
  assert.ok(after.ok, JSON.stringify(after));
  assert.ok(after.value.dirtyCount >= before.value.dirtyCount + 1, JSON.stringify(after.value));
});

test('activation-owned listeners, routes and tools are released on dispose and can be reinstalled', async (t) => {
  const {host, config} = fixture(t);
  assert.ok(host.routes.size > 0);
  await host.dispose();
  assert.equal(host.routes.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(host.commands.size, 0);
  assert.equal(host.listeners.size, 0);
  apply(host.ctx, config);
  assert.ok(host.tools.has('memory_status'));
  assert.ok(host.routes.has('/dsh-local-memory/api'));
});

test('annual draft and proof reminder are wired through the same admission', async (t) => {
  const {host, repo} = fixture(t);
  const {session} = host.addSession({id: 'session-annual', cwd: repo});
  host.userMessage(session, 'I completed the reclamation investigation and aligned the ownership boundary.');
  const project = await waitFor(async () => {
    const listed = await api(host, 'project.list');
    const id = listed.ok ? listed.value.projects[0]?.projectId : undefined;
    if (!id) return undefined;
    const work = await api(host, 'work.list', {projectId: id, limit: 20});
    return work.ok && work.value.items.length >= 1 ? {id, items: work.value.items} : undefined;
  }, {timeoutMs: 15000, label: 'annual draft'});
  assert.ok(project.items.length >= 1);
  const draft = project.items[0];
  assert.equal(draft.verification ?? draft.recordState ?? 'draft', draft.recordState ?? 'draft');
  const decision = await host.preStep(session, [userQuery('q-reminder', 'continue the work record')]);
  assert.equal(decision.kind, 'enter');
  const reminder = decision.messages.find((message) => message.source?.kind === 'memory-proof-reminder');
  assert.ok(reminder, `expected a proof reminder in ${JSON.stringify(decision.messages.map((message) => message.source))}`);
});

test('an unusable data root degrades the plugin instead of throwing out of apply', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-plugin-degraded-'));
  const blocked = join(root, 'blocked-data-root');
  writeFileSync(blocked, 'not a directory');
  const host = new FakeHost();
  t.after(async () => { try { await host.dispose(); } catch { /* teardown */ } rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 50}); });
  // apply must never leak a rejected promise; an async initialize() here would crash the Host.
  const returned = apply(host.ctx, {dataRoot: blocked});
  assert.equal(returned, undefined);
  const status = host.tool('memory_status');
  const result = await status.execute({}, {signal: new AbortController().signal});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'activation_failed');
});

test('memory_status never returns an absolute local path to the model', async (t) => {
  const {host, repo} = fixture(t);
  const {agent} = host.addSession({id: 'session-status', cwd: repo});
  const result = await host.tool('memory_status').execute({}, {agent, signal: new AbortController().signal});
  assert.equal(result.ok, true);
  const text = JSON.stringify(result.value);
  assert.doesNotMatch(text, /dataRoot/);
  assert.doesNotMatch(text, /[A-Za-z]:\\\\/);
  assert.doesNotMatch(text, /[A-Za-z]:[\\/]/);
});

test('a static config conflict disables automatic memory instead of silently using the old binding', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-plugin-conflict-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), {recursive: true});
  const dataRoot = join(root, 'data', 'default');
  mkdirSync(dataRoot, {recursive: true});
  const catalog = openProjectCatalog(join(dataRoot, 'catalog.sqlite'), {identityPath: join(dataRoot, 'catalog.identity.json')});
  const {createScope} = await import('../src/scope.mjs');
  const oldScope = createScope({projectRoot: repo, worktreeRoot: repo, revision: 'workspace', buildVariant: 'old'});
  catalog.registerProject({name: 'demo', repositories: [{repoId: 'main', canonicalRoot: repo, worktreeRoot: repo, revision: 'workspace', buildVariant: 'old', scopeRef: oldScope}], origin: 'config'});
  catalog.close();
  const host = new FakeHost();
  t.after(async () => { try { await host.dispose(); } catch { /* teardown */ } rmSync(root, {recursive: true, force: true, maxRetries: 20, retryDelay: 50}); });
  apply(host.ctx, {
    dataRoot: join(root, 'data'),
    profile: 'default',
    scheduler: {pollMs: 100},
    projects: [{name: 'demo', repositories: [{repoId: 'main', canonicalRoot: repo, worktreeRoot: repo, revision: 'workspace', buildVariant: 'new'}]}],
  });
  const status = await api(host, 'status');
  assert.equal(status.ok, true);
  assert.equal(status.value.automaticDisabled, 'config_conflict');
  const {session} = host.addSession({id: 'session-conflict', cwd: repo});
  host.userMessage(session, 'This message must not start automatic extraction.');
  const project = await projectId(host);
  await sleep(400);
  const tasks = await api(host, 'task.list', {projectId: project});
  assert.equal(tasks.ok, true);
  assert.equal(tasks.value.items.length, 0);
});

test('M2: abstracts are discoverable, user-granted sharing follows latest, revoke/delete cut off', async (t) => {
  const {host, repo, root} = fixture(t);
  const secondRepo = join(root, 'second-repo');
  mkdirSync(join(secondRepo, 'src'), {recursive: true});
  const registered = await api(host, 'project.register', {
    name: 'second',
    repositories: [{repoId: 'main', canonicalRoot: secondRepo, worktreeRoot: secondRepo, revision: 'workspace', buildVariant: 'test'}],
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const secondId = registered.value.project.projectId;
  const listed = await api(host, 'project.list');
  const demoId = listed.value.projects.find((entry) => entry.name === 'demo').projectId;

  const {agent: agentA} = host.addSession({id: 'session-m2-a', cwd: repo});
  const {agent: agentB} = host.addSession({id: 'session-m2-b', cwd: secondRepo});
  const signal = new AbortController().signal;
  assert.equal((await host.tool('memory_remember').execute({text: 'Project A lesson: descriptor reclamation waits for completion.', kind: 'lesson'}, {agent: agentA, signal})).ok, true);
  assert.equal((await host.tool('memory_remember').execute({text: 'Project B unrelated note.', kind: 'lesson'}, {agent: agentB, signal})).ok, true);

  const refreshed = await api(host, 'abstract.refresh', {projectId: demoId});
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.ok(refreshed.value.revision >= 1);
  assert.ok(refreshed.value.basis.some((entry) => /reclamation/i.test(entry.summary)), JSON.stringify(refreshed.value.basis));

  // A normal memory write (not a management mutation) must mark the abstract dirty so the
  // coalescing thresholds/maintenance actually apply to the primary path.
  assert.equal((await host.tool('memory_remember').execute({text: 'Project A follow-up lesson: owner handoff needs a barrier.', kind: 'lesson'}, {agent: agentA, signal})).ok, true);
  const staleAbstract = await api(host, 'abstract.list', {projectId: demoId});
  assert.equal(staleAbstract.ok, true, JSON.stringify(staleAbstract));
  assert.ok(staleAbstract.value.dirtyCount >= 1, JSON.stringify(staleAbstract.value));
  assert.equal(staleAbstract.value.stale, true);

  // B discovers A's abstract summary but cannot read A's memory details before the user grants.
  const abstracts = await host.tool('memory_abstracts').execute({}, {agent: agentB, signal});
  assert.equal(abstracts.ok, true, JSON.stringify(abstracts));
  const source = abstracts.value.discoverable.find((entry) => entry.sourceProjectId === demoId);
  assert.ok(source, JSON.stringify(abstracts.value.discoverable));
  const denied = await host.tool('memory_shared_search').execute({sourceProjectId: demoId, query: 'reclamation'}, {agent: agentB, signal});
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'SHARE_DENIED');

  const grant = await api(host, 'share.grant', {
    sourceProjectId: demoId,
    targetProjectId: secondId,
    abstractRevision: source.abstractRevision,
    decisionBasis: 'm2 integration test: B needs A reclamation lesson',
  });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal(grant.value.state, 'active');
  assert.match(grant.value.permissionRef, /^local-user-grant-v1:/);
  const relationId = grant.value.relationId;

  const shared = await host.tool('memory_shared_search').execute({sourceProjectId: demoId, query: 'reclamation'}, {agent: agentB, signal});
  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.ok(shared.value.items.length >= 1);
  const item = shared.value.items[0];
  assert.match(item.text, /reclamation/i);
  assert.equal(item.verification, 'unverified');
  assert.ok(item.sourceRef);
  assert.equal(item.projectId, demoId);

  // Deleting the shared record must immediately remove it from cross-project reads.
  const memory = await api(host, 'memory.search', {projectId: demoId, query: 'reclamation'});
  const target = memory.value.items.find((entry) => entry.id === item.id) ?? memory.value.items[0];
  const deleted = await api(host, 'memory.delete', {projectId: demoId, id: target.id, expectedGeneration: target.expectedGeneration});
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  const afterDelete = await host.tool('memory_shared_search').execute({sourceProjectId: demoId, query: 'reclamation'}, {agent: agentB, signal});
  assert.equal(afterDelete.ok, true, JSON.stringify(afterDelete));
  assert.equal(afterDelete.value.items.length, 0);

  const revoked = await api(host, 'share.revoke', {relationId});
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  const afterRevoke = await host.tool('memory_shared_search').execute({sourceProjectId: demoId, query: 'reclamation'}, {agent: agentB, signal});
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.error.code, 'SHARE_DENIED');
});
