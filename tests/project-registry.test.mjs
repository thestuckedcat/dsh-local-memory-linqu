import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {normalizeConfig} from '../plugin/configuration.mjs';
import {createProjectRegistry} from '../plugin/project-registry.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-registry-'));
  const repo = join(root, 'repo');
  const worktree = join(repo, 'worktree');
  const nested = join(worktree, 'nested');
  mkdirSync(join(nested, 'src'), {recursive: true});
  mkdirSync(join(worktree, 'src'), {recursive: true});
  const other = join(root, 'other');
  mkdirSync(join(other, 'src'), {recursive: true});
  const closers = [];
  t.after(() => {
    for (const close of closers.reverse()) { try { close(); } catch { /* teardown continues */ } }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, repo, worktree, nested, other, track(close) { closers.push(close); return close; }};
}
function baseConfig(root, extra = {}) {
  return normalizeConfig({dataRoot: join(root, 'data'), ...extra}, {env: {}});
}
function projectConfig(root, extra = {}) {
  return {
    dataRoot: join(root, 'data'),
    projects: [{
      name: 'demo',
      repositories: [{repoId: 'main', canonicalRoot: join(root, 'repo'), worktreeRoot: join(root, 'repo', 'worktree'), revision: 'workspace', buildVariant: 'win-node24'}],
    }],
    ...extra,
  };
}
function session(cwd) {
  return {id: 'session-1', header: {version: 4, id: 'session-1', createdAt: 1, cwd}};
}

test('registry seeds declared projects and resolves trusted session bindings', async (t) => {
  const f = fixture(t);
  const {root, worktree} = f;
  const registry = createProjectRegistry({config: baseConfig(root, projectConfig(root))});
  f.track(() => registry.close());
  await registry.initialize();
  assert.equal(registry.state, 'ready');
  const projects = registry.list();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'demo');
  assert.equal(projects[0].origin, 'config');
  assert.ok(existsSync(join(root, 'data', 'default', 'catalog.sqlite')));
  const binding = registry.bindingForSession(session(worktree));
  assert.equal(binding.projectId, projects[0].projectId);
  assert.equal(binding.repoId, 'main');
  assert.match(binding.scopeRef, /^workspace-v1:[a-f0-9]{64}$/);
  assert.equal(registry.bindingForSession(session(join(worktree, 'src'))).scopeRef, binding.scopeRef);
  assert.equal(registry.bindingForSession(session(join(root, 'unregistered'))), undefined);
  assert.equal(registry.bindingForSession(session(undefined)), undefined);
  assert.equal(registry.bindingForSession({id: 'x', header: {}}), undefined);
  assert.equal(registry.projectForScope(binding.scopeRef).projectId, projects[0].projectId);
  assert.deepEqual(registry.preferencesForScope(binding.scopeRef).preferences, {extract: true, recall: true});
  assert.equal(registry.status().projectCount, 1);
  assert.equal(registry.status().scopeCount, 1);
});

test('the most specific registered worktree wins and unregistered paths stay unbound', async (t) => {
  const f = fixture(t);
  const {root, worktree, nested, other} = f;
  const config = baseConfig(root, {
    projects: [
      {name: 'outer', repositories: [{repoId: 'main', canonicalRoot: join(root, 'repo'), worktreeRoot: worktree, revision: 'workspace', buildVariant: 'v1'}]},
      {name: 'inner', repositories: [{repoId: 'main', canonicalRoot: join(root, 'repo'), worktreeRoot: nested, revision: 'workspace', buildVariant: 'v1'}]},
      {name: 'other', repositories: [{repoId: 'main', canonicalRoot: other, worktreeRoot: other, revision: 'workspace', buildVariant: 'v1'}]},
    ],
  });
  const registry = createProjectRegistry({config});
  f.track(() => registry.close());
  await registry.initialize();
  assert.equal(registry.bindingForSession(session(join(nested, 'src'))).projectId, registry.list().find((project) => project.name === 'inner').projectId);
  assert.equal(registry.bindingForSession(session(join(worktree, 'src'))).projectId, registry.list().find((project) => project.name === 'outer').projectId);
  assert.equal(registry.bindingForSession(session(join(other, 'src'))).projectId, registry.list().find((project) => project.name === 'other').projectId);
  assert.equal(registry.bindingForSession(session(join(root, 'elsewhere'))), undefined);
});

test('user registration adds a binding and duplicate names with another binding are refused', async (t) => {
  const f = fixture(t);
  const {root, other} = f;
  const registry = createProjectRegistry({config: baseConfig(root, projectConfig(root))});
  f.track(() => registry.close());
  await registry.initialize();
  const project = registry.registerProject({
    name: 'second',
    repositories: [{repoId: 'main', canonicalRoot: other, worktreeRoot: other, revision: 'release-1', buildVariant: 'gcc'}],
    origin: 'user',
  });
  assert.equal(project.state, 'active');
  assert.equal(registry.bindingForSession(session(other)).projectId, project.projectId);
  assert.throws(
    () => registry.registerProject({name: 'second', repositories: [{repoId: 'main', canonicalRoot: other, worktreeRoot: other, revision: 'release-2', buildVariant: 'gcc'}], origin: 'user'}),
    (error) => error.code === 'PROJECT_EXISTS',
  );
  assert.equal(registry.list().length, 2);
});

test('stores persist across registry reopen and preferences follow project revisions', async (t) => {
  const f = fixture(t);
  const {root, worktree} = f;
  const config = baseConfig(root, projectConfig(root));
  const first = createProjectRegistry({config});
  await first.initialize();
  const binding = first.bindingForSession(session(worktree));
  const store = first.storeFor(binding.scopeRef);
  store.put({id: 'memory-1', sourceRef: 'session-1/message-1', sourceVersion: 'v1', kind: 'lesson', text: 'Completion precedes reclamation.', origin: 'user'});
  const project = first.list()[0];
  const changed = first.setPreference({projectId: project.projectId, expectedRevision: project.revision, key: 'recall', value: false});
  assert.equal(changed.preferences.recall, false);
  // The cached binding must follow the preference revision bump, otherwise the final gate
  // would see a stale projectRevision and block unrelated requests.
  assert.equal(first.bindingForSession(session(worktree)).projectRevision, changed.revision);
  first.close();
  const second = createProjectRegistry({config});
  f.track(() => second.close());
  await second.initialize();
  const reopened = second.storeFor(binding.scopeRef);
  assert.equal(reopened.get('memory-1').text, 'Completion precedes reclamation.');
  assert.equal(second.getPreference(project.projectId, 'recall'), false);
  assert.equal(second.bindingForSession(session(worktree)).scopeRef, binding.scopeRef);
});

test('retirement stops session binding while keeping the memory store readable', async (t) => {
  const f = fixture(t);
  const {root, worktree} = f;
  const registry = createProjectRegistry({config: baseConfig(root, projectConfig(root))});
  f.track(() => registry.close());
  await registry.initialize();
  const binding = registry.bindingForSession(session(worktree));
  registry.storeFor(binding.scopeRef).put({id: 'memory-1', sourceRef: 'session-1/message-1', sourceVersion: 'v1', kind: 'lesson', text: 'Keep me.', origin: 'user'});
  const project = registry.list()[0];
  const retired = registry.retireProject({projectId: project.projectId, expectedRevision: project.revision, reason: 'project finished'});
  assert.equal(retired.state, 'retired');
  assert.equal(registry.bindingForSession(session(worktree)), undefined);
  assert.equal(registry.storeFor(binding.scopeRef).get('memory-1').text, 'Keep me.');
  assert.equal(registry.projectForScope(binding.scopeRef).state, 'retired');
  assert.equal(registry.activeScopes().length, 0);
  assert.equal(registry.allScopes().length, 1);
});

test('a changed static configuration is reported as degraded instead of silently rebinding', async (t) => {
  const f = fixture(t);
  const {root, worktree} = f;
  const first = createProjectRegistry({config: baseConfig(root, projectConfig(root))});
  await first.initialize();
  const binding = first.bindingForSession(session(worktree));
  first.close();
  const changedConfig = baseConfig(root, {
    projects: [{
      name: 'demo',
      repositories: [{repoId: 'main', canonicalRoot: join(root, 'repo'), worktreeRoot: join(root, 'repo', 'worktree'), revision: 'workspace', buildVariant: 'different-build'}],
    }],
  });
  const second = createProjectRegistry({config: changedConfig});
  f.track(() => second.close());
  await second.initialize();
  assert.equal(second.state, 'ready');
  assert.ok(second.status().degraded.some((entry) => entry.code === 'CONFIG_CONFLICT'));
  assert.equal(second.list()[0].repositories[0].buildVariant, 'win-node24');
  assert.equal(second.bindingForSession(session(worktree)).scopeRef, binding.scopeRef);
});

test('closing the registry closes its stores and refuses later access', async (t) => {
  const f = fixture(t);
  const {root, worktree} = f;
  const registry = createProjectRegistry({config: baseConfig(root, projectConfig(root))});
  await registry.initialize();
  const binding = registry.bindingForSession(session(worktree));
  const store = registry.storeFor(binding.scopeRef);
  registry.close();
  assert.throws(() => store.get('memory-1'));
  assert.throws(() => registry.list(), (error) => error.code === 'REGISTRY_UNAVAILABLE');
});
