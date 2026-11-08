import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openProjectCatalog, CATALOG_SCHEMA_VERSION, CATALOG_V1_SCHEMA} from '../src/projects.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-catalog-'));
  const closers = [];
  t.after(() => {
    for (const close of closers.reverse()) { try { close(); } catch { /* teardown continues */ } }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, track(close) { closers.push(close); return close; }};
}
function repository(root, extra = {}) {
  return {
    repoId: 'main',
    canonicalRoot: join(root, 'repo'),
    worktreeRoot: join(root, 'repo'),
    revision: 'workspace',
    buildVariant: 'win-node24',
    scopeRef: 'workspace-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...extra,
  };
}
function failure(fn, code) {
  assert.throws(fn, (error) => error?.code === code);
}

test('catalog creates an identity anchor and refuses a replaced identity', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalogPath = join(root, 'catalog.sqlite');
  const anchor = join(root, 'catalog.identity.json');
  const catalog = openProjectCatalog(catalogPath, {identityPath: anchor});
  const identity = catalog.identity;
  assert.match(identity, /^[a-f0-9-]{36}$/);
  assert.ok(existsSync(catalogPath) && existsSync(anchor));
  assert.equal(JSON.parse(readFileSync(anchor, 'utf8')).identity, identity);
  catalog.close();
  const reopened = openProjectCatalog(catalogPath, {identityPath: anchor});
  assert.equal(reopened.identity, identity);
  reopened.close();
  writeFileSync(anchor, JSON.stringify({schema_version: 1, identity: '00000000-0000-4000-8000-000000000000'}));
  failure(() => openProjectCatalog(catalogPath, {identityPath: anchor}), 'CATALOG_IDENTITY_MISMATCH');
});

test('project registration is idempotent and rejects a conflicting binding', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  const repositories = [repository(root)];
  const first = catalog.registerProject({name: 'demo', repositories, origin: 'user'});
  assert.equal(first.revision, 1);
  assert.equal(first.state, 'active');
  assert.equal(first.preferences.extract, true);
  assert.equal(first.repositories[0].bindingRevision, 1);
  const again = catalog.registerProject({name: 'demo', repositories, origin: 'user'});
  assert.equal(again.projectId, first.projectId);
  assert.equal(again.revision, 1);
  failure(() => catalog.registerProject({name: 'demo', repositories: [{...repository(root), revision: 'other'}]}), 'PROJECT_EXISTS');
  assert.equal(catalog.listProjects().length, 1);
});

test('a concrete scope cannot be registered by two projects', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  catalog.registerProject({name: 'alpha', repositories: [repository(root)], origin: 'user'});
  failure(() => catalog.registerProject({name: 'beta', repositories: [repository(root)]}), 'SCOPE_CONFLICT');
});

test('updates advance binding revisions and retire removed repositories without deleting them', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  const first = catalog.registerProject({name: 'demo', repositories: [repository(root)], origin: 'user'});
  const second = catalog.updateProject({
    projectId: first.projectId,
    expectedRevision: first.revision,
    repositories: [repository(root, {repoId: 'main', revision: 'release-1'}), repository(root, {repoId: 'side', scopeRef: 'workspace-v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'})],
  });
  assert.equal(second.revision, 2);
  const main = second.repositories.find((repo) => repo.repoId === 'main');
  const side = second.repositories.find((repo) => repo.repoId === 'side');
  assert.equal(main.bindingRevision, 2);
  assert.equal(side.bindingRevision, 1);
  const third = catalog.updateProject({projectId: first.projectId, expectedRevision: second.revision, repositories: [repository(root, {repoId: 'main', revision: 'release-1'})]});
  assert.equal(third.revision, 3);
  const removed = third.repositories.find((repo) => repo.repoId === 'side');
  assert.equal(removed.enabled, false);
  assert.equal(removed.bindingRevision, 2);
  failure(() => catalog.updateProject({projectId: first.projectId, expectedRevision: 1, repositories: []}), 'STALE_REVISION');
});

test('retirement is terminal for edits but keeps repositories and memory identity', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  const project = catalog.registerProject({name: 'demo', repositories: [repository(root)], origin: 'user'});
  const retired = catalog.retireProject({projectId: project.projectId, expectedRevision: project.revision, reason: 'finished'});
  assert.equal(retired.state, 'retired');
  assert.equal(retired.repositories.length, 1);
  assert.equal(retired.retiredReason, 'finished');
  failure(() => catalog.updateProject({projectId: project.projectId, expectedRevision: retired.revision, name: 'renamed'}), 'PROJECT_RETIRED');
  assert.equal(catalog.retireProject({projectId: project.projectId, expectedRevision: retired.revision, reason: 'finished'}).revision, retired.revision);
});

test('preferences persist and are revision-checked', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  const project = catalog.registerProject({name: 'demo', repositories: [repository(root)], origin: 'user'});
  assert.equal(catalog.getPreference(project.projectId, 'recall'), true);
  const changed = catalog.setPreference({projectId: project.projectId, expectedRevision: project.revision, key: 'recall', value: false});
  assert.equal(catalog.getPreference(project.projectId, 'recall'), false);
  assert.equal(changed.revision, project.revision + 1);
  failure(() => catalog.setPreference({projectId: project.projectId, expectedRevision: project.revision, key: 'recall', value: true}), 'STALE_REVISION');
  failure(() => catalog.getPreference(project.projectId, 'unknown'), 'INVALID_PREFERENCE');
});

test('operation idempotency caches results and rejects a changed payload', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  let calls = 0;
  const first = catalog.operate('op-1', {value: 1}, () => { calls++; return {done: true}; });
  const second = catalog.operate('op-1', {value: 1}, () => { calls++; return {done: false}; });
  assert.deepEqual(first, {done: true});
  assert.deepEqual(second, {done: true});
  assert.equal(calls, 1);
  failure(() => catalog.operate('op-1', {value: 2}, () => ({done: true})), 'OPERATION_CONFLICT');
});

test('reopened catalog preserves projects, bindings and preferences', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalogPath = join(root, 'catalog.sqlite');
  const anchor = join(root, 'catalog.identity.json');
  const catalog = openProjectCatalog(catalogPath, {identityPath: anchor});
  const project = catalog.registerProject({name: 'demo', repositories: [repository(root)], origin: 'config'});
  catalog.setPreference({projectId: project.projectId, expectedRevision: project.revision, key: 'extract', value: false});
  catalog.close();
  const reopened = openProjectCatalog(catalogPath, {identityPath: anchor});
  f.track(() => reopened.close());
  const projects = reopened.listProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'demo');
  assert.equal(projects[0].origin, 'config');
  assert.equal(reopened.getPreference(project.projectId, 'extract'), false);
});

test('reminders record the last shown timestamp per claim and version', (t) => {
  const f = fixture(t);
  const root = f.root;
  const catalog = openProjectCatalog(join(root, 'catalog.sqlite'), {identityPath: join(root, 'catalog.identity.json')});
  f.track(() => catalog.close());
  assert.equal(catalog.getReminder('scope-a', 'work-1', 'myContribution'), undefined);
  const shown = catalog.setReminder({scopeRef: 'scope-a', recordId: 'work-1', claimRef: 'myContribution', recordGeneration: 4, shownAt: '2026-11-07T00:00:00.000Z'});
  assert.equal(shown.recordGeneration, 4);
  assert.equal(catalog.getReminder('scope-a', 'work-1', 'myContribution').last_shown_at, '2026-11-07T00:00:00.000Z');
  failure(() => catalog.setReminder({scopeRef: 'scope-a', recordId: 'work-1', claimRef: 'myContribution', recordGeneration: 5, shownAt: 'not-a-date'}), 'INVALID_TIMESTAMP');
});

test('catalog reports a stable schema version and rejects a foreign schema file', (t) => {
  const f = fixture(t);
  const root = f.root;
  const path = join(root, 'catalog.sqlite');
  writeFileSync(path, 'not sqlite');
  assert.throws(() => openProjectCatalog(path, {identityPath: join(root, 'catalog.identity.json')}));
  assert.equal(existsSync(join(root, 'catalog.identity.json')), false);
});

const V1_IDENTITY = '11111111-1111-4111-8111-111111111111';
function createV1Catalog(root) {
  const path = join(root, 'catalog.sqlite'), anchor = join(root, 'catalog.identity.json');
  const db = new DatabaseSync(path);
  try {
    db.exec(CATALOG_V1_SCHEMA);
    db.prepare('INSERT INTO meta VALUES(?,?)').run('identity', V1_IDENTITY);
    db.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version', '1');
    db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)').run('project-' + 'a'.repeat(64), 'legacy', 'active', 1, 'user', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null);
  } finally { db.close(); }
  writeFileSync(anchor, JSON.stringify({schema_version: 1, identity: V1_IDENTITY}));
  return {path, anchor};
}

test('a reviewed v1 catalog migrates additively to v2 exactly once and keeps identity/data', (t) => {
  const f = fixture(t);
  const {path, anchor} = createV1Catalog(f.root);
  const catalog = openProjectCatalog(path, {identityPath: anchor});
  assert.equal(CATALOG_SCHEMA_VERSION, 2);
  assert.equal(catalog.version, 2);
  assert.equal(catalog.identity, V1_IDENTITY);
  assert.deepEqual(catalog.listProjects().map((project) => project.name), ['legacy']);
  assert.equal(catalog.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, '2');
  assert.ok(catalog.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='abstract_revisions'").get());
  assert.ok(catalog.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='share_relations'").get());
  catalog.close();
  const reopened = openProjectCatalog(path, {identityPath: anchor});
  f.track(() => reopened.close());
  assert.equal(reopened.version, 2);
  assert.equal(reopened.listProjects().length, 1);
});

test('a v1-shaped catalog with drift is refused before migration and stays at v1', (t) => {
  const f = fixture(t);
  const {path, anchor} = createV1Catalog(f.root);
  const db = new DatabaseSync(path);
  try { db.exec('ALTER TABLE projects ADD COLUMN unexpected TEXT;'); } finally { db.close(); }
  assert.throws(() => openProjectCatalog(path, {identityPath: anchor}), (error) => error?.code === 'CATALOG_SCHEMA_MISMATCH');
  const probe = new DatabaseSync(path);
  try {
    assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(probe.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='abstract_revisions'").get(), undefined);
  } finally { probe.close(); }
});

test('identity mismatch is refused before a v1 catalog is migrated', (t) => {
  const f = fixture(t);
  const {path, anchor} = createV1Catalog(f.root);
  writeFileSync(anchor, JSON.stringify({schema_version: 1, identity: '22222222-2222-4222-8222-222222222222'}));
  assert.throws(() => openProjectCatalog(path, {identityPath: anchor}), (error) => error?.code === 'CATALOG_IDENTITY_MISMATCH');
  const probe = new DatabaseSync(path);
  try {
    assert.equal(probe.prepare('PRAGMA user_version').get().user_version, 1, 'identity failure must not advance the schema');
    assert.equal(probe.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='abstract_revisions'").get(), undefined);
  } finally { probe.close(); }
});
