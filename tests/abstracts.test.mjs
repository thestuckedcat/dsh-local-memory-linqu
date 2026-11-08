import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {normalizeConfig} from '../plugin/configuration.mjs';
import {createProjectRegistry} from '../plugin/project-registry.mjs';
import {createAbstractManager} from '../src/abstracts.mjs';
import {digest} from '../src/scope.mjs';
import {fingerprint} from '../src/validation.mjs';

/*
 * Fixture: the real v2 project catalog (node:sqlite), real project registry, real memory
 * stores and the real abstract manager. Only the clock is controlled. Every test closes the
 * registry (stores first, then the catalog) before the temporary tree is removed.
 *
 * alpha has two repositories/worktrees so multi-scope aggregation is exercised; beta and
 * gamma have one each. Memories are ordinary `memories` records, never work summaries.
 */

const BASIS_FIELDS = ['id', 'kind', 'recordGeneration', 'sourceRef', 'sourceVersion', 'summary'];
const SUMMARY_LIMIT = 240;

function repository(root, name, repoId, worktreeDir) {
  return {
    repoId,
    canonicalRoot: join(root, name),
    worktreeRoot: join(root, name, worktreeDir),
    revision: 'workspace',
    buildVariant: 'win-node24',
  };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-abstracts-'));
  for (const name of ['alpha', 'beta', 'gamma']) {
    mkdirSync(join(root, name, 'worktree', 'src'), {recursive: true});
    mkdirSync(join(root, name, 'side-worktree'), {recursive: true});
  }
  const closers = [];
  t.after(() => {
    for (const close of closers.reverse()) { try { close(); } catch { /* teardown continues */ } }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, track(close) { closers.push(close); return close; }};
}
function configuration(root) {
  return normalizeConfig({
    dataRoot: join(root, 'data'),
    projects: [
      {name: 'alpha', repositories: [repository(root, 'alpha', 'main', 'worktree'), repository(root, 'alpha', 'side', 'side-worktree')]},
      {name: 'beta', repositories: [repository(root, 'beta', 'main', 'worktree')]},
      {name: 'gamma', repositories: [repository(root, 'gamma', 'main', 'worktree')]},
    ],
  }, {env: {}});
}
function fakeClock(start = '2026-11-08T00:00:00.000Z') {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    iso: () => current.toISOString(),
    advance(ms) { current = new Date(current.getTime() + ms); },
  };
}
function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code, `expected ${code}, received ${error?.code}: ${error?.message}`);
    return true;
  };
}
function assertBasis(view, stores) {
  for (const entry of view.basis) {
    assert.deepEqual(Object.keys(entry).sort(), BASIS_FIELDS);
    const record = stores.map((store) => store.get(entry.id)).find(Boolean);
    assert.ok(record, `basis entry ${entry.id} resolves to a live record`);
    assert.equal(entry.recordGeneration, record.generation);
    assert.equal(entry.kind, record.kind);
    assert.equal(entry.sourceRef, record.sourceRef);
    assert.equal(entry.sourceVersion, record.sourceVersion);
    assert.equal(entry.summary, record.text.length > SUMMARY_LIMIT ? record.text.slice(0, SUMMARY_LIMIT) : record.text);
  }
}
function assertFrozenView(view) {
  assert.ok(Object.isFrozen(view));
  assert.ok(Object.isFrozen(view.counts));
  assert.ok(Object.isFrozen(view.counts.byKind));
  assert.ok(Object.isFrozen(view.basis));
  for (const entry of view.basis) assert.ok(Object.isFrozen(entry));
}

async function setup(t) {
  const base = fixture(t);
  const clock = fakeClock();
  let registry = createProjectRegistry({config: configuration(base.root)});
  base.track(() => registry.close());
  await registry.initialize();
  let abstracts = createAbstractManager({catalog: registry.catalog, registry, now: clock.now});
  let sequence = 0;
  const projectOf = (name) => {
    const project = registry.list().find((entry) => entry.name === name);
    assert.ok(project, `project ${name} is registered`);
    return project;
  };
  const scopeOf = (name, repoId = 'main') => {
    const repo = projectOf(name).repositories.find((entry) => entry.repoId === repoId);
    assert.ok(repo?.enabled, `repository ${name}/${repoId} is enabled`);
    return repo.scopeRef;
  };
  const storeOf = (name, repoId = 'main') => registry.storeFor(scopeOf(name, repoId));
  return {
    root: base.root,
    clock,
    get registry() { return registry; },
    get abstracts() { return abstracts; },
    projectId: (name) => projectOf(name).projectId,
    scopeRef: scopeOf,
    store: storeOf,
    put(store, text, extra = {}) {
      sequence += 1;
      return store.put({
        id: extra.id ?? `memory-${sequence}`,
        sourceRef: extra.sourceRef ?? `session-${sequence}/turn-1`,
        sourceVersion: extra.sourceVersion ?? 'v1',
        kind: extra.kind ?? 'lesson',
        text,
        origin: 'user',
      });
    },
    refresh(name, reason = 'manual') {
      return abstracts.refresh({projectId: projectOf(name).projectId, reason});
    },
    rows(projectId) {
      return registry.catalog.db.prepare('SELECT revision,digest,payload FROM abstract_revisions WHERE project_id=? ORDER BY revision').all(projectId);
    },
    state(projectId) {
      return registry.catalog.db.prepare('SELECT * FROM abstract_state WHERE project_id=?').get(projectId);
    },
    retire(name) {
      const project = projectOf(name);
      return registry.retireProject({projectId: project.projectId, expectedRevision: project.revision, reason: 'project finished'});
    },
    async reopen() {
      registry.close();
      registry = createProjectRegistry({config: configuration(base.root)});
      base.track(() => registry.close());
      await registry.initialize();
      abstracts = createAbstractManager({catalog: registry.catalog, registry, now: clock.now});
    },
  };
}

test('refresh persists a canonical extractive basis with exact references and no paths', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const main = f.store('alpha');
  const side = f.store('alpha', 'side');
  f.put(main, 'Completion precedes reclamation.', {kind: 'lesson'});
  f.put(side, 'The scheduler coalesces refresh requests.', {kind: 'fact'});
  const third = f.put(side, 'd'.repeat(300), {kind: 'decision'});

  const view = f.refresh('alpha');
  assertFrozenView(view);
  assert.equal(view.schemaVersion, 'memory-abstract-v1');
  assert.equal(view.projectId, alpha);
  assert.equal(view.projectName, 'alpha');
  assert.equal(view.projectState, 'active');
  assert.equal(view.revision, 1);
  assert.equal(view.generationRoute, 'local-extractive-v1');
  assert.equal(view.generatedAt, f.clock.iso());
  assert.equal(view.stale, false);
  assert.equal(view.dirtyCount, 0);
  assert.equal(view.applicability, 'current');
  assert.match(view.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(view.counts, {memories: 3, byKind: {lesson: 1, fact: 1, decision: 1}});
  assert.equal(view.basis.length, 3);
  const generations = view.basis.map((entry) => entry.recordGeneration);
  assert.deepEqual([...generations].sort((a, b) => b - a), generations);
  assertBasis(view, [main, side]);
  assert.equal(view.basis.find((entry) => entry.id === third.id).summary.length, SUMMARY_LIMIT);

  const rows = f.rows(alpha);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].digest, view.digest);
  assert.equal(digest(rows[0].payload), rows[0].digest);
  const payload = JSON.parse(rows[0].payload);
  assert.equal(payload.schemaVersion, 'memory-abstract-v1');
  assert.equal(payload.revision, 1);
  assert.equal(payload.projectId, alpha);
  assert.equal(payload.generationRoute, 'local-extractive-v1');
  assert.equal(payload.revisionSummary, fingerprint([`${main.scopeRef}:${main.revision()}`, `${side.scopeRef}:${side.revision()}`].sort()));
  assert.equal(rows[0].payload.includes(f.root), false, 'the canonical payload must not contain absolute paths');
  assert.equal(/[A-Za-z]:[\\/]/.test(rows[0].payload), false, 'the canonical payload must not contain drive paths');
  assert.equal(JSON.stringify(view).includes(f.root), false, 'the view must not contain absolute paths');

  const state = f.state(alpha);
  assert.equal(state.current_revision, 1);
  assert.equal(state.dirty_count, 0);
  assert.equal(state.first_dirty_at, null);
  assert.equal(state.last_generated_at, view.generatedAt);
  assert.equal(state.generation_route, 'local-extractive-v1');
  assert.equal(state.revision_summary, payload.revisionSummary);

  // Everything was written inside the temporary data root: the repository trees are untouched.
  assert.deepEqual(readdirSync(join(f.root, 'alpha')).sort(), ['side-worktree', 'worktree']);
  assert.ok(f.registry.catalog.catalogPath.startsWith(join(f.root, 'data')));
  assert.ok(main.databasePath.startsWith(join(f.root, 'data')));
});

test('a manual refresh appends a revision and keeps the previous revision', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  f.put(store, 'First experience.');
  const first = f.refresh('alpha');
  const secondRecord = f.put(store, 'Second experience.');
  const second = f.refresh('alpha');
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.notEqual(second.digest, first.digest);
  assert.ok(second.basis.some((entry) => entry.id === secondRecord.id));
  assert.equal(second.dirtyCount, 0);
  const rows = f.rows(alpha);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].digest, first.digest);
  assert.equal(rows[1].digest, second.digest);
  assert.equal(JSON.parse(rows[0].payload).revision, 1);
  assert.equal(JSON.parse(rows[1].payload).revision, 2);
  assert.equal(f.state(alpha).current_revision, 2);
  assert.equal(JSON.parse(rows[0].payload).basis.length, 1);
  assert.equal(JSON.parse(rows[0].payload).basis[0].recordGeneration, 1);
});

test('read follows a correction of a cited memory immediately', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  const record = f.put(store, 'Original wording.');
  const before = f.refresh('alpha');
  assert.equal(before.basis[0].id, record.id);
  const corrected = store.correct({id: record.id, text: 'Corrected wording.', sourceVersion: 'v2', expectedGeneration: store.generation()});
  const view = f.abstracts.read({projectId: alpha});
  assert.equal(view.revision, before.revision + 1);
  assert.equal(view.stale, false);
  assert.equal(view.dirtyCount, 0);
  assert.equal(view.basis.some((entry) => entry.id === record.id), false);
  const entry = view.basis.find((value) => value.id === corrected.id);
  assert.ok(entry);
  assert.equal(entry.sourceVersion, 'v2');
  assert.equal(entry.recordGeneration, corrected.generation);
});

test('read drops a deleted citation immediately and never resurrects it', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  const keep = f.put(store, 'Keep this experience.');
  const drop = f.put(store, 'Delete this experience.');
  const before = f.refresh('alpha');
  assert.equal(before.basis.length, 2);
  store.forget({id: drop.id});
  const view = f.abstracts.read({projectId: alpha});
  assert.equal(view.revision, before.revision + 1);
  assert.deepEqual(view.basis.map((entry) => entry.id), [keep.id]);
  assert.equal(view.stale, false);
  assert.equal(view.counts.memories, 1);
  assert.deepEqual(f.abstracts.read({projectId: alpha}).basis.map((entry) => entry.id), [keep.id]);
  assert.equal(f.rows(alpha).length, 2, 'the second read reuses the refreshed revision');
});

test('read reports stale below the coalescing threshold and refreshes at ten noted changes', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  const firstRecord = f.put(store, 'First experience.');
  const first = f.refresh('alpha');
  assert.equal(first.basis[0].id, firstRecord.id);
  const second = f.put(store, 'Second experience.');
  for (let index = 0; index < 9; index += 1) f.abstracts.noteChange(alpha);
  const stale = f.abstracts.read({projectId: alpha});
  assert.equal(stale.revision, first.revision);
  assert.equal(stale.stale, true);
  assert.equal(stale.dirtyCount, 9);
  assert.equal(f.abstracts.shouldRefresh(alpha), false);
  assert.equal(f.abstracts.shouldRefresh(alpha, {countThreshold: 9}), true);
  assert.equal(f.abstracts.noteChange(alpha).dirtyCount, 10);
  assert.equal(f.abstracts.shouldRefresh(alpha), true);
  const fresh = f.abstracts.read({projectId: alpha});
  assert.equal(fresh.revision, first.revision + 1);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.dirtyCount, 0);
  assert.ok(fresh.basis.some((entry) => entry.id === second.id));
  const state = f.state(alpha);
  assert.equal(state.dirty_count, 0);
  assert.equal(state.first_dirty_at, null);
  assert.equal(f.abstracts.shouldRefresh(alpha), false);
});

test('configured coalescing thresholds are honored by a manager instance', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  f.put(store, 'First tuned experience.');
  const first = f.refresh('alpha');
  const second = f.put(store, 'Second tuned experience.');
  const tuned = createAbstractManager({
    catalog: f.registry.catalog,
    registry: f.registry,
    now: f.clock.now,
    thresholds: {dirtyCountThreshold: 2, ageHours: 2},
  });
  tuned.noteChange(alpha);
  tuned.noteChange(alpha);
  assert.equal(tuned.shouldRefresh(alpha), true);
  // The default manager is untouched by the configured instance.
  assert.equal(f.abstracts.shouldRefresh(alpha), false);
  const fresh = tuned.read({projectId: alpha});
  assert.equal(fresh.revision, first.revision + 1);
  assert.equal(fresh.dirtyCount, 0);
  assert.ok(fresh.basis.some((entry) => entry.id === second.id));
});

test('read honors dirty thresholds even when the revision summary is unchanged', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  f.put(store, 'Only experience.');
  const first = f.refresh('alpha');
  for (let index = 0; index < 10; index += 1) f.abstracts.noteChange(alpha);
  assert.equal(f.abstracts.shouldRefresh(alpha), true);
  const read = f.abstracts.read({projectId: alpha});
  // shouldRefresh and read must agree even for a noteChange-only burst.
  assert.equal(read.revision, first.revision + 1);
  assert.equal(read.dirtyCount, 0);
  assert.equal(read.basis.length, 1);
});

test('read refreshes when the first noted change is twenty-four hours old', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const store = f.store('alpha');
  f.put(store, 'First experience.');
  const first = f.refresh('alpha');
  const second = f.put(store, 'Second experience.');
  f.abstracts.noteChange(alpha);
  f.clock.advance(24 * 60 * 60 * 1000 - 1);
  assert.equal(f.abstracts.shouldRefresh(alpha), false);
  assert.equal(f.abstracts.read({projectId: alpha}).revision, first.revision);
  f.clock.advance(1);
  assert.equal(f.abstracts.shouldRefresh(alpha), true);
  const view = f.abstracts.read({projectId: alpha});
  assert.equal(view.revision, first.revision + 1);
  assert.ok(view.basis.some((entry) => entry.id === second.id));
  assert.equal(view.stale, false);
});

test('noteChange counts changes, keeps the first dirty time and can run before any abstract', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  assert.equal(f.state(alpha), undefined);
  const first = f.abstracts.noteChange(alpha, {at: '2026-11-08T01:00:00.000Z'});
  assert.equal(first.currentRevision, 0);
  assert.equal(first.dirtyCount, 1);
  assert.equal(first.firstDirtyAt, '2026-11-08T01:00:00.000Z');
  assert.equal(first.lastChangeAt, '2026-11-08T01:00:00.000Z');
  const second = f.abstracts.noteChange(alpha, {count: 2, at: '2026-11-08T02:00:00.000Z'});
  assert.equal(second.dirtyCount, 3);
  assert.equal(second.firstDirtyAt, '2026-11-08T01:00:00.000Z', 'the first dirty time is set once');
  assert.equal(second.lastChangeAt, '2026-11-08T02:00:00.000Z');
  const third = f.abstracts.noteChange(alpha);
  assert.equal(third.dirtyCount, 4);
  assert.equal(third.lastChangeAt, f.clock.iso());
  assert.equal(f.abstracts.shouldRefresh(alpha), false);
});

test('a retired project keeps a historical view and refuses automatic refresh', async (t) => {
  const f = await setup(t);
  const beta = f.projectId('beta');
  const store = f.store('beta');
  f.put(store, 'First beta experience.');
  const built = f.refresh('beta');
  f.put(store, 'Second beta experience.');
  f.retire('beta');

  const view = f.abstracts.read({projectId: beta});
  assert.equal(view.revision, built.revision);
  assert.equal(view.stale, true);
  assert.equal(view.projectState, 'retired');
  assert.equal(view.applicability, 'historical_unknown');
  assert.equal(view.basis.length, 1);
  assert.throws(() => f.abstracts.refresh({projectId: beta, reason: 'auto'}), expectCode('PROJECT_RETIRED'));
  assert.throws(() => f.abstracts.refresh({projectId: beta, reason: 'coalesced'}), expectCode('PROJECT_RETIRED'));
  assert.throws(() => f.abstracts.read({projectId: beta, forceRefresh: true}), expectCode('STALE_ABSTRACT'));

  const manual = f.abstracts.refresh({projectId: beta, reason: 'manual'});
  assert.equal(manual.revision, built.revision + 1);
  assert.equal(manual.stale, false);
  assert.equal(manual.projectState, 'retired');
  assert.equal(manual.applicability, 'historical_unknown');
  assert.equal(manual.basis.length, 2);
  assert.equal(JSON.parse(f.rows(beta).at(-1).payload).projectState, 'retired');
  assert.equal(f.abstracts.read({projectId: beta}).revision, manual.revision);
  assert.throws(() => f.abstracts.refresh({projectId: beta, reason: 'auto'}), expectCode('PROJECT_RETIRED'));
});

test('a retired project without an abstract is readable only after a manual refresh', async (t) => {
  const f = await setup(t);
  const gamma = f.projectId('gamma');
  f.retire('gamma');
  assert.equal(f.abstracts.read({projectId: gamma}), undefined);
  assert.throws(() => f.abstracts.read({projectId: gamma, forceRefresh: true}), expectCode('ABSTRACT_UNAVAILABLE'));
  assert.throws(() => f.abstracts.refresh({projectId: gamma, reason: 'auto'}), expectCode('PROJECT_RETIRED'));
  const view = f.abstracts.refresh({projectId: gamma, reason: 'manual'});
  assert.equal(view.revision, 1);
  assert.deepEqual(view.basis, []);
  assert.equal(view.counts.memories, 0);
  assert.equal(view.projectState, 'retired');
  assert.equal(f.abstracts.read({projectId: gamma}).revision, 1);
});

test('list exposes active abstracts by default and retired abstracts on request', async (t) => {
  const f = await setup(t);
  f.put(f.store('alpha'), 'Alpha experience.');
  f.put(f.store('beta'), 'Beta experience.');
  const alphaView = f.refresh('alpha');
  const betaView = f.refresh('beta');
  const gamma = f.projectId('gamma');
  assert.equal(f.rows(gamma).length, 0);

  const active = f.abstracts.list();
  assert.ok(Object.isFrozen(active));
  assert.deepEqual(active.map((view) => view.projectName), ['alpha', 'beta', 'gamma']);
  assert.equal(active.find((view) => view.projectName === 'alpha').revision, alphaView.revision);
  const empty = active.find((view) => view.projectName === 'gamma');
  assert.equal(empty.revision, 0);
  assert.equal(empty.digest, undefined);
  assert.equal(empty.stale, true);
  assert.deepEqual(empty.basis, []);
  assert.deepEqual(empty.counts, {memories: 0, byKind: {}});
  assert.equal(empty.applicability, 'current');
  assert.equal(f.rows(gamma).length, 0, 'listing never generates an abstract');

  f.retire('beta');
  assert.deepEqual(f.abstracts.list().map((view) => view.projectName), ['alpha', 'gamma']);
  const withRetired = f.abstracts.list({includeRetired: true});
  assert.deepEqual(withRetired.map((view) => view.projectName), ['alpha', 'beta', 'gamma']);
  const retired = withRetired.find((view) => view.projectName === 'beta');
  assert.equal(retired.projectState, 'retired');
  assert.equal(retired.applicability, 'historical_unknown');
  assert.equal(retired.revision, betaView.revision);

  f.put(f.store('alpha'), 'Second alpha experience.');
  const listed = f.abstracts.list().find((view) => view.projectName === 'alpha');
  assert.equal(listed.revision, alphaView.revision);
  assert.equal(listed.stale, true, 'a changed project is marked stale by list');
  assert.equal(f.rows(f.projectId('alpha')).length, 1, 'list does not refresh');
});

test('status counts generated projects, retained revisions and dirty projects', async (t) => {
  const f = await setup(t);
  assert.deepEqual(f.abstracts.status(), {projectsWithAbstracts: 0, totalRevisions: 0, dirtyProjects: 0});
  f.put(f.store('alpha'), 'Alpha experience.');
  f.refresh('alpha');
  f.put(f.store('alpha'), 'Second alpha experience.');
  f.refresh('alpha');
  f.put(f.store('beta'), 'Beta experience.');
  f.refresh('beta');
  assert.deepEqual(f.abstracts.status(), {projectsWithAbstracts: 2, totalRevisions: 3, dirtyProjects: 0});
  f.abstracts.noteChange(f.projectId('gamma'));
  assert.deepEqual(f.abstracts.status(), {projectsWithAbstracts: 2, totalRevisions: 3, dirtyProjects: 1});
  f.retire('beta');
  assert.deepEqual(f.abstracts.status(), {projectsWithAbstracts: 2, totalRevisions: 3, dirtyProjects: 1});
  assert.ok(Object.isFrozen(f.abstracts.status()));
});

test('a persisted abstract is read back after a catalog reopen without regeneration', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  f.put(f.store('alpha'), 'Persisted experience.');
  const built = f.refresh('alpha');
  assert.equal(f.registry.catalog.version, 2);
  await f.reopen();
  assert.equal(f.registry.catalog.db.prepare('PRAGMA user_version').get().user_version, 2);
  const view = f.abstracts.read({projectId: alpha});
  assert.equal(view.revision, built.revision);
  assert.equal(view.digest, built.digest);
  assert.equal(view.generatedAt, built.generatedAt);
  assert.equal(view.stale, false);
  assert.equal(view.basis.length, 1);
  assertBasis(view, [f.store('alpha')]);
  assert.equal(f.rows(alpha).length, 1, 'reading a persisted abstract does not regenerate it');
  assert.equal(f.abstracts.status().totalRevisions, 1);
});

test('the basis keeps the sixty newest live records', async (t) => {
  const f = await setup(t);
  const store = f.store('alpha');
  for (let index = 0; index < 65; index += 1) f.put(store, `Experience number ${index}.`);
  const view = f.refresh('alpha');
  assert.equal(view.basis.length, 60);
  assert.equal(view.counts.memories, 60);
  assert.deepEqual(Object.values(view.counts.byKind), [60]);
  const generations = view.basis.map((entry) => entry.recordGeneration);
  assert.deepEqual(generations, [...generations].sort((a, b) => b - a));
  assert.equal(generations[0], 65);
  assert.equal(generations.at(-1), 6);
});

test('applicability prefers the registry probe and fails closed when the probe throws', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  f.put(f.store('alpha'), 'Delegated applicability.');
  const delegating = {...f.registry, applicabilityForProject: () => ({applicability: 'unavailable'})};
  const manager = createAbstractManager({catalog: f.registry.catalog, registry: delegating, now: f.clock.now});
  assert.equal(manager.refresh({projectId: alpha}).applicability, 'unavailable');
  const broken = {...f.registry, applicabilityForProject() { throw new Error('probe unavailable'); }};
  const fallback = createAbstractManager({catalog: f.registry.catalog, registry: broken, now: f.clock.now});
  // A probe that cannot answer must not silently promote an active project to "current".
  assert.equal(fallback.refresh({projectId: alpha}).applicability, 'unavailable');
});

test('unknown projects, invalid reasons and invalid input fail closed', async (t) => {
  const f = await setup(t);
  const alpha = f.projectId('alpha');
  const unknown = `project-${'0'.repeat(64)}`;
  assert.throws(() => f.abstracts.read({projectId: unknown}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => f.abstracts.refresh({projectId: unknown}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => f.abstracts.noteChange(unknown), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => f.abstracts.shouldRefresh(unknown), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => f.abstracts.list({includeRetired: 'yes'}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.refresh({projectId: alpha, reason: 'later'}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.read({projectId: 42}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.read({projectId: alpha, forceRefresh: 'yes'}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.noteChange(alpha, {count: 0}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.noteChange(alpha, {at: 'not-a-timestamp'}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.shouldRefresh(alpha, {countThreshold: 0}), expectCode('INVALID_INPUT'));
  assert.throws(() => f.abstracts.read({projectId: alpha, extra: true}), expectCode('INVALID_INPUT'));
  assert.throws(() => createAbstractManager({catalog: null, registry: f.registry}), expectCode('ABSTRACT_UNAVAILABLE'));
  assert.throws(() => createAbstractManager({catalog: f.registry.catalog}), expectCode('ABSTRACT_UNAVAILABLE'));
  assert.equal(f.abstracts.read({projectId: alpha}).revision, 1, 'an active project without an abstract is built on demand');
});
