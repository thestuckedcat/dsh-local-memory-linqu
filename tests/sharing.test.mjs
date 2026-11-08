import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {normalizeConfig} from '../plugin/configuration.mjs';
import {createProjectRegistry} from '../plugin/project-registry.mjs';
import {createAbstractManager} from '../src/abstracts.mjs';
import {createSharingManager} from '../src/sharing.mjs';

/*
 * Fixture: real project catalog (v2), real node:sqlite memory stores, real abstract
 * manager and real sharing manager. Only the clock is controlled. Every test closes
 * the registry (stores + catalog) before removing the temporary tree.
 */

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-sharing-'));
  const repos = join(root, 'repos');
  mkdirSync(repos, {recursive: true});
  let clock = Date.parse('2026-11-08T12:00:00.000Z');
  const now = () => new Date(clock);
  const tick = (ms = 1000) => { clock += ms; };
  const config = normalizeConfig({dataRoot: join(root, 'data')}, {env: {}});
  const registry = createProjectRegistry({config, now});
  await registry.initialize();
  const addProject = (name) => {
    const repo = join(repos, name);
    const worktree = join(repo, 'worktree');
    mkdirSync(join(worktree, 'src'), {recursive: true});
    return registry.registerProject({
      name,
      repositories: [{repoId: 'main', canonicalRoot: repo, worktreeRoot: worktree, revision: `rev-${name}`, buildVariant: 'test-variant'}],
      origin: 'user',
    });
  };
  const a = addProject('alpha');
  const b = addProject('beta');
  const abstracts = createAbstractManager({catalog: registry.catalog, registry, now});
  const sharing = createSharingManager({catalog: registry.catalog, registry, abstracts, now});
  const state = {registry};
  t.after(() => {
    try { state.registry.close(); } catch { /* teardown continues */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, config, registry, abstracts, sharing, a, b, addProject, now, tick, state};
}

function scopeOf(registry, project) {
  const scopes = registry.scopesForProject(project.projectId);
  assert.equal(scopes.length, 1, 'fixture projects have exactly one repository scope');
  return scopes[0];
}
function storeOf(registry, project) {
  return registry.storeFor(scopeOf(registry, project).scopeRef);
}
function putMemory(store, id, text, extra = {}) {
  return store.put({id, sourceRef: `session-A/${id}`, sourceVersion: `version-${id}`, kind: 'lesson', text, origin: 'user', ...extra});
}
function refreshAbstract(abstracts, project) {
  return abstracts.refresh({projectId: project.projectId, reason: 'manual'});
}
function grantShare(sharing, source, target, abstractRevision, extra = {}) {
  return sharing.grant({
    sourceProjectId: source.projectId,
    targetProjectId: target.projectId,
    abstractRevision,
    decisionBasis: 'User reviewed the source abstract before sharing',
    permissionRef: 'local-user-grant-v1:test',
    ...extra,
  });
}
function retire(registry, project, reason = 'project finished') {
  const fresh = registry.getProject(project.projectId);
  return registry.retireProject({projectId: project.projectId, expectedRevision: fresh.revision, reason});
}
function unknownProjectId() {
  return `project-${'0'.repeat(64)}`;
}
function expectCode(code) {
  return (error) => {
    assert.equal(error?.code, code, `expected ${code}, received ${error?.code}: ${error?.message}`);
    return true;
  };
}
function serializedWithoutEscapes(value) {
  return JSON.stringify(value).replaceAll('\\\\', '\\');
}

test('discover lists active sources, excludes the target and only keeps related retired sources', async (t) => {
  const f = await fixture(t);
  const {root, registry, abstracts, sharing, a, b, addProject} = f;
  putMemory(storeOf(registry, a), 'alpha-1', 'Descriptor reclamation waits for completion.');
  putMemory(storeOf(registry, b), 'beta-1', 'The target project keeps its own facts.');
  const alphaView = refreshAbstract(abstracts, a);

  const c = addProject('gamma');
  putMemory(storeOf(registry, c), 'gamma-1', 'Historical bridge detail is retained.');
  const gammaView = refreshAbstract(abstracts, c);
  grantShare(sharing, c, b, gammaView.revision);
  retire(registry, c);

  const d = addProject('delta');
  retire(registry, d, 'never produced a share');

  const discovered = sharing.discover({targetProjectId: b.projectId});
  const ids = discovered.map((entry) => entry.sourceProjectId);
  assert.ok(!ids.includes(b.projectId), 'the target project is never a source');
  assert.ok(ids.includes(a.projectId), 'active source with an abstract is discoverable');
  assert.ok(ids.includes(c.projectId), 'retired source with an existing active relation stays visible');
  assert.ok(!ids.includes(d.projectId), 'retired source without a relation is not discoverable');

  const alpha = discovered.find((entry) => entry.sourceProjectId === a.projectId);
  assert.equal(alpha.sourceProjectName, 'alpha');
  assert.equal(alpha.sourceProjectState, 'active');
  assert.equal(alpha.abstractRevision, alphaView.revision);
  assert.equal(alpha.abstractDigest, alphaView.digest);
  assert.equal(alpha.generatedAt, alphaView.generatedAt);
  assert.equal(alpha.counts.memories, 1);
  assert.deepEqual(alpha.counts.byKind, {lesson: 1});
  assert.equal(alpha.applicability, 'current');

  const gamma = discovered.find((entry) => entry.sourceProjectId === c.projectId);
  assert.equal(gamma.sourceProjectState, 'retired');
  assert.equal(gamma.abstractRevision, gammaView.revision);
  assert.equal(gamma.applicability, 'historical_unknown');

  const serialized = serializedWithoutEscapes(discovered);
  assert.equal(serialized.includes(root), false, 'discover must not expose absolute project paths');
  assert.equal(serialized.includes('canonicalRoot'), false);
  assert.equal(/[A-Za-z]:[\\/]/.test(serialized), false, 'discover summaries contain no drive paths');

  assert.throws(() => sharing.discover({targetProjectId: unknownProjectId()}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => sharing.discover({}), expectCode('INVALID_SHARE'));
});

test('grant requires the current source abstract revision and upserts an existing relation', async (t) => {
  const f = await fixture(t);
  const {registry, abstracts, sharing, a, b, addProject, tick} = f;
  const store = storeOf(registry, a);
  putMemory(store, 'alpha-1', 'Descriptor reclamation waits for completion.');
  const first = refreshAbstract(abstracts, a);
  putMemory(store, 'alpha-2', 'Second reviewed experience.');
  const second = refreshAbstract(abstracts, a);
  assert.ok(second.revision > first.revision);

  assert.throws(() => grantShare(sharing, a, b, first.revision), expectCode('STALE_ABSTRACT'));
  assert.throws(() => grantShare(sharing, a, b, second.revision + 9), expectCode('STALE_ABSTRACT'));
  assert.throws(() => grantShare(sharing, a, a, second.revision), expectCode('INVALID_SHARE'));
  assert.throws(() => grantShare(sharing, a, b, second.revision, {decisionBasis: ''}), expectCode('INVALID_SHARE'));
  assert.throws(() => grantShare(sharing, a, b, second.revision, {permissionRef: 'x'.repeat(513)}), expectCode('INVALID_SHARE'));
  assert.throws(() => sharing.grant({sourceProjectId: a.projectId, targetProjectId: b.projectId, decisionBasis: 'basis', permissionRef: 'ref'}), expectCode('INVALID_SHARE'));
  assert.throws(() => grantShare(sharing, a, {projectId: unknownProjectId()}, second.revision), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => grantShare(sharing, {projectId: unknownProjectId()}, b, second.revision), expectCode('PROJECT_NOT_FOUND'));

  const granted = grantShare(sharing, a, b, second.revision);
  assert.equal(granted.state, 'active');
  assert.equal(granted.sourceProjectId, a.projectId);
  assert.equal(granted.sourceProjectName, 'alpha');
  assert.equal(granted.targetProjectId, b.projectId);
  assert.equal(granted.targetProjectName, 'beta');
  assert.equal(granted.abstractRevision, second.revision);
  assert.equal(granted.currentAbstractRevision, second.revision);
  assert.equal(granted.upToDate, true);
  assert.equal(granted.decisionBasis, 'User reviewed the source abstract before sharing');
  assert.equal(granted.permissionRef, 'local-user-grant-v1:test');
  assert.equal(granted.revokedAt, undefined);

  tick();
  putMemory(store, 'alpha-3', 'Third reviewed experience.');
  const third = refreshAbstract(abstracts, a);
  const regranted = grantShare(sharing, a, b, third.revision, {
    decisionBasis: 'User re-reviewed the changed abstract',
    permissionRef: 'local-user-grant-v1:regrant',
  });
  assert.equal(regranted.relationId, granted.relationId, 'the unique source/target pair is upserted');
  assert.equal(regranted.state, 'active');
  assert.equal(regranted.decisionBasis, 'User re-reviewed the changed abstract');
  assert.equal(regranted.permissionRef, 'local-user-grant-v1:regrant');
  assert.equal(regranted.abstractRevision, third.revision);
  assert.equal(regranted.createdAt, granted.createdAt, 'the original grant timestamp is preserved');
  assert.ok(regranted.updatedAt > granted.updatedAt, 'a re-grant advances the audit timestamp');
  assert.equal(regranted.revokedAt, undefined);

  const retiredTarget = addProject('epsilon');
  retire(registry, retiredTarget);
  assert.throws(() => grantShare(sharing, a, retiredTarget, third.revision), expectCode('PROJECT_RETIRED'));
  retire(registry, a);
  assert.throws(() => grantShare(sharing, a, b, third.revision), expectCode('PROJECT_RETIRED'));
});

test('resolve is denied before grant and returns live source detail without copying it', async (t) => {
  const f = await fixture(t);
  const {registry, abstracts, sharing, a, b} = f;
  const store = storeOf(registry, a);
  putMemory(store, 'alpha-1', 'Descriptor reclamation waits for completion.');
  putMemory(store, 'alpha-2', 'Descriptor retention follows the archive policy.');
  putMemory(store, 'alpha-3', 'Descriptor ownership passes to the successor.');
  const view = refreshAbstract(abstracts, a);

  assert.throws(() => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'}), expectCode('SHARE_DENIED'));
  assert.throws(() => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: b.projectId, query: 'descriptor'}), expectCode('SHARE_DENIED'));

  grantShare(sharing, a, b, view.revision);
  const result = sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'});
  assert.equal(result.abstractRevision, view.revision);
  assert.equal(result.relation.relationId, sharing.list({targetProjectId: b.projectId})[0].relationId);
  assert.equal(result.relation.state, 'active');
  assert.equal(result.relation.upToDate, true);
  assert.equal(result.items.length, 3);
  for (const item of result.items) {
    assert.equal(item.projectId, a.projectId);
    assert.equal(item.repoId, 'main');
    assert.equal(item.applicability, 'current');
    assert.equal(item.verification, 'unverified');
    assert.match(item.sourceRef, /^session-A\/alpha-[123]$/);
    assert.ok(Number.isSafeInteger(item.recordGeneration) && item.recordGeneration >= 1);
    assert.ok(typeof item.text === 'string' && item.text.length > 0);
  }

  const limited = sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor', limit: 2});
  assert.equal(limited.items.length, 2);

  // Detail stays in the source project: nothing is written into beta's store.
  assert.equal(storeOf(registry, b).list({limit: 100}).length, 0);
  assert.equal(storeOf(registry, b).get('alpha-1'), undefined);

  // Deleting the source record breaks the same query immediately (no stale copy is served).
  store.forget({id: 'alpha-1'});
  const afterDelete = sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'});
  assert.equal(afterDelete.items.some((item) => item.id === 'alpha-1'), false);
  assert.equal(afterDelete.abstractRevision, sharing.list({targetProjectId: b.projectId})[0].currentAbstractRevision);
  assert.equal(afterDelete.items.length, 2);
  assert.throws(() => sharing.resolve({targetProjectId: unknownProjectId(), sourceProjectId: a.projectId, query: 'descriptor'}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: unknownProjectId(), query: 'descriptor'}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: ''}), expectCode('INVALID_SHARE'));
  assert.throws(() => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor', limit: 0}), expectCode('INVALID_SHARE'));
});

test('an active relation follows the latest source abstract without a new decision', async (t) => {
  const f = await fixture(t);
  const {registry, abstracts, sharing, a, b} = f;
  const store = storeOf(registry, a);
  putMemory(store, 'alpha-1', 'Initial retention policy.');
  const first = refreshAbstract(abstracts, a);
  const granted = grantShare(sharing, a, b, first.revision);

  let listed = sharing.list({targetProjectId: b.projectId});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].upToDate, true);
  assert.equal(listed[0].currentAbstractRevision, first.revision);

  putMemory(store, 'alpha-2', 'Revised retention policy with a compaction window.');
  // The source abstract is stale before the next refresh; the relation must not claim "up to date".
  const staleList = sharing.list({targetProjectId: b.projectId});
  assert.equal(staleList[0].currentAbstractRevision, first.revision);
  assert.equal(staleList[0].upToDate, false);
  const staleResolve = sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'retention'});
  assert.equal(staleResolve.relation.upToDate, false, 'resolve must not claim up-to-date against a stale abstract');
  const second = refreshAbstract(abstracts, a);
  assert.ok(second.revision > first.revision);

  listed = sharing.list({targetProjectId: b.projectId});
  assert.equal(listed[0].state, 'active');
  assert.equal(listed[0].abstractRevision, first.revision, 'the recorded decision revision is unchanged');
  assert.equal(listed[0].currentAbstractRevision, second.revision);
  assert.equal(listed[0].upToDate, false);
  assert.equal(listed[0].relationId, granted.relationId);

  const result = sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'compaction'});
  assert.equal(result.abstractRevision, second.revision);
  assert.equal(result.relation.abstractRevision, second.revision, 'resolve follows and records the latest revision');
  assert.equal(result.relation.state, 'active');
  assert.equal(result.relation.decisionBasis, granted.decisionBasis);
  assert.equal(result.relation.permissionRef, granted.permissionRef);
  assert.equal(result.relation.updatedAt, granted.updatedAt, 'following does not rewrite the user decision audit trail');
  assert.ok(result.items.some((item) => item.id === 'alpha-2'));

  listed = sharing.list({targetProjectId: b.projectId, sourceProjectId: a.projectId});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, 'active');
  assert.equal(listed[0].abstractRevision, second.revision);
  assert.equal(listed[0].currentAbstractRevision, second.revision);
  assert.equal(listed[0].upToDate, true);
});

test('revoke takes effect on the same query, is idempotent, and a re-grant restores the relation', async (t) => {
  const f = await fixture(t);
  const {registry, abstracts, sharing, a, b, tick} = f;
  const store = storeOf(registry, a);
  putMemory(store, 'alpha-1', 'Descriptor reclamation waits for completion.');
  const view = refreshAbstract(abstracts, a);
  const granted = grantShare(sharing, a, b, view.revision);
  assert.equal(sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'}).items.length, 1);

  tick();
  const revoked = sharing.revoke({relationId: granted.relationId});
  assert.equal(revoked.state, 'revoked');
  assert.ok(revoked.revokedAt);
  assert.equal(revoked.updatedAt, revoked.revokedAt);
  assert.throws(() => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'}), expectCode('SHARE_DENIED'));
  assert.equal(sharing.list({targetProjectId: b.projectId})[0].state, 'revoked');
  assert.equal(sharing.list({targetProjectId: b.projectId})[0].upToDate, false);

  tick();
  const again = sharing.revoke({relationId: granted.relationId});
  assert.equal(again.state, 'revoked');
  assert.equal(again.revokedAt, revoked.revokedAt, 'a repeated revoke is a no-op');
  assert.equal(again.updatedAt, revoked.updatedAt);
  assert.throws(() => sharing.revoke({relationId: 'share-00000000-0000-0000-0000-000000000000'}), expectCode('RELATION_NOT_FOUND'));

  const restored = grantShare(sharing, a, b, view.revision, {decisionBasis: 'User restored the share', permissionRef: 'local-user-grant-v1:restored'});
  assert.equal(restored.relationId, granted.relationId);
  assert.equal(restored.state, 'active');
  assert.equal(restored.revokedAt, undefined);
  assert.equal(restored.decisionBasis, 'User restored the share');
  assert.equal(sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'}).items.length, 1);

  const status = sharing.status();
  assert.deepEqual(status, {activeRelations: 1, revokedRelations: 0, targets: 1});
});

test('retired sources keep existing shares as historical_unknown and retired targets fail closed', async (t) => {
  const f = await fixture(t);
  const {registry, abstracts, sharing, a, b, addProject} = f;
  const store = storeOf(registry, a);
  putMemory(store, 'alpha-1', 'Descriptor reclamation waits for completion.');
  const view = refreshAbstract(abstracts, a);
  grantShare(sharing, a, b, view.revision);
  retire(registry, a);

  const result = sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'});
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].applicability, 'historical_unknown');
  assert.equal(result.relation.state, 'active');

  const discovered = sharing.discover({targetProjectId: b.projectId});
  const alpha = discovered.find((entry) => entry.sourceProjectId === a.projectId);
  assert.equal(alpha.sourceProjectState, 'retired');
  assert.equal(alpha.applicability, 'historical_unknown');

  const c = addProject('gamma');
  assert.throws(() => grantShare(sharing, a, c, view.revision), expectCode('PROJECT_RETIRED'));

  // An active source cannot share into a retired target.
  const bView = refreshAbstract(abstracts, b);
  retire(registry, c);
  assert.throws(() => grantShare(sharing, b, c, bView.revision), expectCode('PROJECT_RETIRED'));
  assert.throws(() => sharing.discover({targetProjectId: a.projectId}), expectCode('PROJECT_RETIRED'));
  assert.throws(() => sharing.discover({targetProjectId: c.projectId}), expectCode('PROJECT_RETIRED'));
  assert.throws(() => sharing.resolve({targetProjectId: c.projectId, sourceProjectId: a.projectId, query: 'descriptor'}), expectCode('PROJECT_RETIRED'));

  // share.list is an audit view and stays available for a retired target.
  assert.deepEqual(sharing.list({targetProjectId: c.projectId}), []);
  assert.equal(sharing.list({targetProjectId: b.projectId})[0].sourceProjectState, 'retired');
});

test('a relation whose source abstract disappeared fails closed instead of guessing', async (t) => {
  const f = await fixture(t);
  const {registry, abstracts, sharing, a, b} = f;
  putMemory(storeOf(registry, a), 'alpha-1', 'Descriptor reclamation waits for completion.');
  const view = refreshAbstract(abstracts, a);
  grantShare(sharing, a, b, view.revision);
  retire(registry, a);
  // Simulates lost/corrupted abstract state for a retired source: it cannot be rebuilt.
  registry.catalog.write(() => {
    registry.catalog.db.prepare('DELETE FROM abstract_revisions WHERE project_id=?').run(a.projectId);
    registry.catalog.db.prepare('DELETE FROM abstract_state WHERE project_id=?').run(a.projectId);
  });
  assert.throws(
    () => sharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'}),
    expectCode('ABSTRACT_UNAVAILABLE'),
  );
  const listed = sharing.list({targetProjectId: b.projectId});
  assert.equal(listed[0].state, 'active');
  assert.equal(listed[0].currentAbstractRevision, 0);
  assert.equal(listed[0].upToDate, false);
  const alpha = sharing.discover({targetProjectId: b.projectId}).find((entry) => entry.sourceProjectId === a.projectId);
  assert.equal(alpha.abstractRevision, 0);
  assert.equal(alpha.applicability, 'historical_unknown');
});

test('unknown projects fail closed and relations survive a catalog reopen with a new manager', async (t) => {
  const f = await fixture(t);
  const {config, registry, abstracts, sharing, a, b, state} = f;
  putMemory(storeOf(registry, a), 'alpha-1', 'Descriptor reclamation waits for completion.');
  const view = refreshAbstract(abstracts, a);
  const granted = grantShare(sharing, a, b, view.revision);
  assert.deepEqual(sharing.status(), {activeRelations: 1, revokedRelations: 0, targets: 1});

  const unknown = unknownProjectId();
  assert.throws(() => sharing.discover({targetProjectId: unknown}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => grantShare(sharing, {projectId: unknown}, b, view.revision), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => sharing.list({targetProjectId: unknown}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => sharing.list({sourceProjectId: unknown}), expectCode('PROJECT_NOT_FOUND'));
  assert.throws(() => sharing.revoke({relationId: 'share-does-not-exist'}), expectCode('RELATION_NOT_FOUND'));
  assert.throws(() => sharing.list({targetProjectId: 42}), expectCode('INVALID_SHARE'));

  registry.close();
  const reopened = createProjectRegistry({config});
  await reopened.initialize();
  state.registry = reopened;
  const reopenedAbstracts = createAbstractManager({catalog: reopened.catalog, registry: reopened, now: f.now});
  const reopenedSharing = createSharingManager({catalog: reopened.catalog, registry: reopened, abstracts: reopenedAbstracts, now: f.now});

  const listed = reopenedSharing.list({targetProjectId: b.projectId});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].relationId, granted.relationId);
  assert.equal(listed[0].state, 'active');
  assert.equal(listed[0].sourceProjectName, 'alpha');
  assert.equal(listed[0].permissionRef, 'local-user-grant-v1:test');
  assert.equal(listed[0].upToDate, true);
  const resolved = reopenedSharing.resolve({targetProjectId: b.projectId, sourceProjectId: a.projectId, query: 'descriptor'});
  assert.equal(resolved.items.length, 1);
  assert.equal(resolved.items[0].id, 'alpha-1');
  assert.deepEqual(reopenedSharing.status(), {activeRelations: 1, revokedRelations: 0, targets: 1});
});
