import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createM2Operations, M2_OPERATIONS, M2_USER_ONLY_OPERATIONS} from '../plugin/m2-management.mjs';
import {createManagementOperations} from '../plugin/management.mjs';
import {digest} from '../src/scope.mjs';

const CLOCK = '2026-11-08T07:00:00.000Z';
const NOW = () => new Date(CLOCK);
const USER = Object.freeze({actor: 'user'});
const MODEL = Object.freeze({actor: 'model', sessionId: 's1'});
const WINDOWS_PATH = /(?:^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])/;
const GENERATED_PERMISSION_REF = /^local-user-grant-v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertNoAbsolutePaths(value, label = 'envelope') {
  const json = JSON.stringify(value);
  assert.ok(json !== undefined, `${label} must be JSON-serializable`);
  assert.doesNotMatch(json, WINDOWS_PATH, `${label} leaked an absolute path: ${json.slice(0, 400)}`);
}

function abstractView(projectId, overrides = {}) {
  return {
    schemaVersion: 'memory-abstract-v1',
    projectId,
    projectName: projectId === 'p1' ? 'Alpha' : 'Beta',
    projectState: 'active',
    revision: 3,
    digest: 'a'.repeat(64),
    generatedAt: '2026-11-08T06:00:00.000Z',
    generationRoute: 'local-extractive-v1',
    stale: false,
    dirtyCount: 0,
    applicability: 'current',
    counts: {memories: 2, byKind: {lesson: 2}},
    basis: [{
      id: 'mem-1',
      recordGeneration: 2,
      kind: 'lesson',
      sourceRef: 'session-a/fragment-1',
      sourceVersion: 'v1',
      summary: 'DMA completion controls ownership.',
    }],
    ...overrides,
  };
}

function relationView(overrides = {}) {
  return {
    relationId: 'rel-1',
    sourceProjectId: 'p1',
    targetProjectId: 'p2',
    state: 'active',
    decisionBasis: 'The user shared Alpha lessons with Beta.',
    permissionRef: 'local-user-grant-v1:00000000-0000-4000-8000-000000000000',
    abstractRevision: 3,
    currentAbstractRevision: 3,
    upToDate: true,
    createdAt: '2026-11-08T06:30:00.000Z',
    updatedAt: '2026-11-08T06:30:00.000Z',
    ...overrides,
  };
}

function sourceEntry(overrides = {}) {
  return {
    sourceProjectId: 'p1',
    sourceProjectName: 'Alpha',
    sourceProjectState: 'active',
    abstractRevision: 3,
    abstractDigest: 'a'.repeat(64),
    generatedAt: '2026-11-08T06:00:00.000Z',
    counts: {memories: 2, byKind: {lesson: 2}},
    applicability: 'current',
    ...overrides,
  };
}

function sharedResult(overrides = {}) {
  return {
    relation: relationView(),
    abstractRevision: 3,
    items: [{
      id: 'mem-1',
      recordGeneration: 2,
      kind: 'lesson',
      text: 'DMA completion controls ownership.',
      sourceRef: 'session-a/fragment-1',
      sourceVersion: 'v1',
      verification: 'unverified',
      projectId: 'p1',
      repoId: 'main',
      applicability: 'current',
    }],
    ...overrides,
  };
}

const PROJECTS = Object.freeze({
  p1: Object.freeze({projectId: 'p1', name: 'Alpha', state: 'active'}),
  p2: Object.freeze({projectId: 'p2', name: 'Beta', state: 'active'}),
});

/**
 * Build the operation table over recording fakes. Every fake manager method records its arguments
 * and can be overridden per test to return a specific view or throw a specific error.
 */
function harness({abstracts: abstractOverrides = {}, sharing: sharingOverrides = {}, projects = PROJECTS, bindings = {s1: {projectId: 'p1'}}} = {}) {
  const calls = {read: [], refresh: [], discover: [], list: [], grant: [], revoke: [], resolve: []};
  const abstracts = {
    read(args) {
      calls.read.push(args);
      return abstractOverrides.read ? abstractOverrides.read(args) : abstractView(args.projectId);
    },
    refresh(args) {
      calls.refresh.push(args);
      return abstractOverrides.refresh ? abstractOverrides.refresh(args) : abstractView(args.projectId, {revision: 4});
    },
  };
  const sharing = {
    discover(args) {
      calls.discover.push(args);
      return sharingOverrides.discover ? sharingOverrides.discover(args) : [sourceEntry()];
    },
    list(args) {
      calls.list.push(args);
      return sharingOverrides.list ? sharingOverrides.list(args) : [relationView()];
    },
    grant(args) {
      calls.grant.push(args);
      if (sharingOverrides.grant) return sharingOverrides.grant(args);
      return relationView({
        relationId: 'rel-9',
        sourceProjectId: args.sourceProjectId,
        targetProjectId: args.targetProjectId,
        abstractRevision: args.abstractRevision,
        currentAbstractRevision: args.abstractRevision,
        decisionBasis: args.decisionBasis,
        permissionRef: args.permissionRef,
      });
    },
    revoke(args) {
      calls.revoke.push(args);
      if (sharingOverrides.revoke) return sharingOverrides.revoke(args);
      return relationView({relationId: args.relationId, state: 'revoked', upToDate: false, revokedAt: '2026-11-08T06:45:00.000Z'});
    },
    resolve(args) {
      calls.resolve.push(args);
      return sharingOverrides.resolve ? sharingOverrides.resolve(args) : sharedResult();
    },
  };
  const registry = {
    getProject: (projectId) => projects[projectId],
    list: () => Object.values(projects),
    storeFor() { throw new Error('scope access is not part of the M2 operations'); },
    bindingForSession: (session) => (session && typeof session === 'object' && session.id !== undefined ? bindings[session.id] : undefined),
  };
  const sessions = {get: (id) => (id === 's1' ? {id, header: {cwd: 'E:\\dsh\\plugin'}} : undefined)};
  const operations = createM2Operations({registry, abstracts, sharing, sessions, now: NOW});
  return {operations, calls, abstracts, sharing, registry, sessions};
}

function grantInput(overrides = {}) {
  return {
    sourceProjectId: 'p1',
    targetProjectId: 'p2',
    abstractRevision: 3,
    decisionBasis: 'The user shared Alpha lessons with Beta.',
    ...overrides,
  };
}

function codedError(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

/* ------------------------------- construction ----------------------------- */

test('M2_OPERATIONS exports exactly the seven contract operations, frozen', () => {
  assert.deepEqual([...M2_OPERATIONS], [
    'abstract.list', 'abstract.refresh', 'share.discover', 'share.list', 'share.grant', 'share.revoke', 'shared.search',
  ]);
  assert.ok(Object.isFrozen(M2_OPERATIONS));
  assert.deepEqual([...M2_USER_ONLY_OPERATIONS], ['abstract.refresh', 'share.grant', 'share.revoke']);
  const {operations} = harness();
  assert.ok(Object.isFrozen(operations));
  assert.deepEqual(Object.keys(operations), [...M2_OPERATIONS]);
  for (const name of M2_OPERATIONS) assert.equal(typeof operations[name], 'function', name);
});

test('construction rejects missing managers or clock', () => {
  const {abstracts, sharing, registry} = harness();
  assert.throws(() => createM2Operations({abstracts, sharing}), /registry/i);
  assert.throws(() => createM2Operations({registry, sharing}), /abstract/i);
  assert.throws(() => createM2Operations({registry, abstracts}), /sharing/i);
  assert.throws(() => createM2Operations({registry, abstracts, sharing, now: 5}), /clock/i);
});

/* --------------------------- project resolution --------------------------- */

test('abstract.list honours an explicit projectId and returns a path-free view', () => {
  const {operations, calls} = harness();
  const result = operations['abstract.list']({projectId: 'p2'}, USER);
  assert.equal(result.ok, true);
  assert.equal(result.value.projectId, 'p2');
  assert.equal(result.value.revision, 3);
  assert.equal(result.value.applicability, 'current');
  assert.equal(result.value.basis.length, 1);
  assert.equal(result.value.observedAt, CLOCK);
  assert.deepEqual(calls.read, [{projectId: 'p2', forceRefresh: false}]);
  assertNoAbsolutePaths(result);
});

test('abstract.list resolves the project from the trusted session binding', () => {
  const {operations, calls} = harness();
  const viaSessionId = operations['abstract.list']({}, {actor: 'model', sessionId: 's1'});
  assert.equal(viaSessionId.ok, true);
  assert.equal(viaSessionId.value.projectId, 'p1');
  const viaSession = operations['abstract.list']({}, {actor: 'host', session: {id: 's1'}});
  assert.equal(viaSession.ok, true);
  assert.equal(viaSession.value.projectId, 'p1');
  assert.deepEqual(calls.read.map((call) => call.projectId), ['p1', 'p1']);
});

test('a model caller cannot name another project; the user HTTP path may name its target', () => {
  const {operations, calls} = harness();
  const model = operations['abstract.list']({projectId: 'p2'}, MODEL);
  assert.equal(model.ok, false);
  assert.equal(model.error.code, 'USER_ACTION_REQUIRED');
  assert.equal(calls.read.length, 0);
  const user = operations['abstract.list']({projectId: 'p2'}, USER);
  assert.equal(user.ok, true);
  assert.equal(user.value.projectId, 'p2');
});

test('PROJECT_REQUIRED when neither an explicit project nor a binding resolves', () => {
  const {operations, calls} = harness({bindings: {}});
  const result = operations['abstract.list']({}, MODEL);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PROJECT_REQUIRED');
  assert.equal(calls.read.length, 0);

  const discover = operations['share.discover']({}, MODEL);
  assert.equal(discover.ok, false);
  assert.equal(discover.error.code, 'PROJECT_REQUIRED');

  const search = operations['shared.search']({sourceProjectId: 'p1', query: 'dma'}, MODEL);
  assert.equal(search.ok, false);
  assert.equal(search.error.code, 'PROJECT_REQUIRED');
  assert.equal(calls.resolve.length, 0);
});

/* ------------------------------ user boundary ----------------------------- */

test('user-only operations reject model and host callers without touching the managers', () => {
  const inputs = {
    'abstract.refresh': {projectId: 'p1'},
    'share.grant': grantInput(),
    'share.revoke': {relationId: 'rel-1'},
  };
  for (const [operation, input] of Object.entries(inputs)) {
    for (const context of [{actor: 'model'}, {actor: 'host'}, undefined]) {
      const {operations, calls} = harness();
      const result = operations[operation](input, context);
      assert.equal(result.ok, false, `${operation} must reject a non-user actor`);
      assert.equal(result.error.code, 'USER_ACTION_REQUIRED', operation);
      for (const recorded of Object.values(calls)) assert.equal(recorded.length, 0, `${operation} must not call a manager`);
    }
  }
});

test('abstract.refresh is a user action that records reason=manual', () => {
  const {operations, calls} = harness();
  const result = operations['abstract.refresh']({projectId: 'p1'}, USER);
  assert.equal(result.ok, true);
  assert.equal(result.value.revision, 4);
  assert.deepEqual(calls.refresh, [{projectId: 'p1', reason: 'manual'}]);
  assertNoAbsolutePaths(result);
});

test('abstract.refresh falls back to the session binding when projectId is omitted', () => {
  const {operations, calls} = harness();
  const result = operations['abstract.refresh']({}, {actor: 'user', sessionId: 's1'});
  assert.equal(result.ok, true);
  assert.deepEqual(calls.refresh, [{projectId: 'p1', reason: 'manual'}]);
});

test('share.grant requires the user and forwards every contract field', () => {
  const {operations, calls} = harness();
  const permissionRef = 'local-user-grant-v1:11111111-2222-4333-8444-555555555555';
  const result = operations['share.grant'](grantInput({permissionRef}), USER);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.grant, [{
    sourceProjectId: 'p1',
    targetProjectId: 'p2',
    abstractRevision: 3,
    decisionBasis: 'The user shared Alpha lessons with Beta.',
    permissionRef,
  }]);
  assert.equal(result.value.relationId, 'rel-9');
  assert.equal(result.value.state, 'active');
  assert.equal(result.value.permissionRef, permissionRef);
  assert.equal(result.value.permissionRefGenerated, false);
  assert.equal(result.value.userAction, 'share.grant');
  assertNoAbsolutePaths(result);
});

test('share.grant generates a local-user-grant-v1 permissionRef when absent', () => {
  const {operations, calls} = harness();
  const result = operations['share.grant'](grantInput(), USER);
  assert.equal(result.ok, true);
  assert.match(result.value.permissionRef, GENERATED_PERMISSION_REF);
  assert.equal(calls.grant[0].permissionRef, result.value.permissionRef);
  assert.equal(result.value.permissionRefGenerated, true);
});

test('share.revoke requires the user and returns the revoked relation', () => {
  const {operations, calls} = harness();
  const result = operations['share.revoke']({relationId: 'rel-1'}, USER);
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'revoked');
  assert.equal(result.value.relationId, 'rel-1');
  assert.equal(result.value.upToDate, false);
  assert.equal(result.value.userAction, 'share.revoke');
  assert.deepEqual(calls.revoke, [{relationId: 'rel-1'}]);
  assertNoAbsolutePaths(result);
});

/* ------------------------------ discovery/list ---------------------------- */

test('share.discover resolves its target and reports applicability', () => {
  const explicit = harness();
  const result = explicit.operations['share.discover']({targetProjectId: 'p2'}, USER);
  assert.equal(result.ok, true);
  assert.equal(result.value.targetProjectId, 'p2');
  assert.equal(result.value.total, 1);
  assert.equal(result.value.sources[0].applicability, 'current');
  assert.equal(result.value.sources[0].sourceProjectId, 'p1');
  assert.deepEqual(explicit.calls.discover, [{targetProjectId: 'p2'}]);

  const bound = harness();
  const fromBinding = bound.operations['share.discover']({}, MODEL);
  assert.equal(fromBinding.ok, true);
  assert.equal(fromBinding.value.targetProjectId, 'p1');
  assertNoAbsolutePaths(result);
});

test('share.list forwards only the supplied filters and returns relations', () => {
  const {operations, calls} = harness();
  const both = operations['share.list']({targetProjectId: 'p2', sourceProjectId: 'p1'}, USER);
  assert.equal(both.ok, true);
  assert.equal(both.value.total, 1);
  assert.equal(both.value.relations[0].upToDate, true);
  const onlyTarget = operations['share.list']({targetProjectId: 'p2'}, USER);
  assert.equal(onlyTarget.ok, true);
  const all = operations['share.list']({}, USER);
  assert.equal(all.ok, true);
  assert.deepEqual(calls.list, [{targetProjectId: 'p2', sourceProjectId: 'p1'}, {targetProjectId: 'p2'}, {}]);
  assertNoAbsolutePaths(all);
});

/* ------------------------------ shared search ----------------------------- */

test('shared.search returns the exact envelope with source refs and applicability', () => {
  const {operations, calls} = harness();
  const result = operations['shared.search']({sourceProjectId: 'p2', query: 'dma'}, MODEL);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value).sort(), ['abstractRevision', 'items', 'relation']);
  assert.equal(result.value.abstractRevision, 3);
  assert.equal(result.value.relation.state, 'active');
  assert.equal(result.value.items.length, 1);
  assert.equal(result.value.items[0].sourceRef, 'session-a/fragment-1');
  assert.equal(result.value.items[0].sourceVersion, 'v1');
  assert.equal(result.value.items[0].verification, 'unverified');
  assert.equal(result.value.items[0].applicability, 'current');
  assert.deepEqual(calls.resolve, [{targetProjectId: 'p1', sourceProjectId: 'p2', query: 'dma', limit: 5}]);
  assertNoAbsolutePaths(result);
});

test('shared.search accepts an explicit target and a bounded limit', () => {
  const {operations, calls} = harness();
  const result = operations['shared.search']({targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma', limit: 3}, USER);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.resolve, [{targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma', limit: 3}]);
});

test('shared.search fails closed when a manager omits applicability or claims verification', () => {
  const {operations} = harness({
    sharing: {
      resolve: () => sharedResult({
        items: [{id: 'mem-1', recordGeneration: 2, kind: 'lesson', text: 'x', sourceRef: 'session-a/f1', sourceVersion: 'v1', verification: 'verified'}],
      }),
    },
  });
  const result = operations['shared.search']({sourceProjectId: 'p2', query: 'dma'}, MODEL);
  assert.equal(result.ok, true);
  assert.equal(result.value.items[0].verification, 'unverified');
  assert.equal(result.value.items[0].applicability, 'unavailable');
  assert.equal(result.value.items[0].projectId, 'p2');
});

/* --------------------------- errors and sanitizing ------------------------ */

test('documented manager error codes pass through with a safe message', () => {
  const codes = ['PROJECT_NOT_FOUND', 'PROJECT_RETIRED', 'INVALID_SHARE', 'ABSTRACT_UNAVAILABLE', 'STALE_ABSTRACT', 'SHARE_DENIED', 'RELATION_NOT_FOUND'];
  for (const code of codes) {
    const {operations} = harness({sharing: {resolve: () => { throw codedError(code, `manager failed: ${code}`); }}});
    const result = operations['shared.search']({targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma'}, USER);
    assert.equal(result.ok, false, code);
    assert.equal(result.error.code, code);
    assertNoAbsolutePaths(result, `error ${code}`);
  }
});

test('unknown manager failures are sanitized to M2_OPERATION_FAILED', () => {
  const unknown = harness({abstracts: {read: () => { throw codedError('SOME_INTERNAL_CODE', 'boom'); }}});
  const unknownResult = unknown.operations['abstract.list']({projectId: 'p1'}, MODEL);
  assert.equal(unknownResult.ok, false);
  assert.equal(unknownResult.error.code, 'M2_OPERATION_FAILED');

  const pathError = harness({sharing: {discover: () => { throw new Error('failed at E:\\dsh\\data\\catalog.sqlite'); }}});
  const pathResult = pathError.operations['share.discover']({targetProjectId: 'p2'}, USER);
  assert.equal(pathResult.ok, false);
  assert.equal(pathResult.error.code, 'M2_OPERATION_FAILED');
  assertNoAbsolutePaths(pathResult, 'path error');

  const plainDenial = harness({sharing: {resolve: () => { throw new Error('No active share relation permits this read'); }}});
  const denialResult = plainDenial.operations['shared.search']({targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma'}, USER);
  assert.equal(denialResult.ok, false);
  assert.equal(denialResult.error.code, 'SHARE_DENIED');
});

test('a manager result that is not an object fails closed', () => {
  const {operations} = harness({abstracts: {read: () => undefined}});
  const result = operations['abstract.list']({projectId: 'p1'}, MODEL);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'ABSTRACT_UNAVAILABLE');
});

/* -------------------------------- validation ----------------------------- */

test('validation rejects empty query/basis, bad limits and unknown fields before calling managers', () => {
  const cases = [
    ['shared.search', {sourceProjectId: 'p2', query: ''}, MODEL],
    ['shared.search', {sourceProjectId: 'p2', query: '   '}, MODEL],
    ['shared.search', {sourceProjectId: 'p2'}, MODEL],
    ['shared.search', {targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma', limit: 0}, USER],
    ['shared.search', {targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma', limit: 21}, USER],
    ['shared.search', {targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma', limit: '5'}, USER],
    ['shared.search', {targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma', path: 'E:\\dsh'}, USER],
    ['share.grant', grantInput({decisionBasis: ''}), USER],
    ['share.grant', grantInput({decisionBasis: '   '}), USER],
    ['share.grant', {sourceProjectId: 'p1', targetProjectId: 'p2', decisionBasis: 'x'}, USER],
    ['share.grant', grantInput({abstractRevision: 0}), USER],
    ['share.grant', grantInput({abstractRevision: '3'}), USER],
    ['share.grant', grantInput({permissionRef: 'p'.repeat(513)}), USER],
    ['share.revoke', {relationId: '   '}, USER],
    ['share.revoke', {}, USER],
    ['abstract.list', {projectId: 'p1', bogus: true}, MODEL],
    ['abstract.refresh', {projectId: 'p1', reason: 'auto'}, USER],
    ['share.discover', {targetProjectId: 'p2', bogus: 1}, USER],
    ['share.list', {bogus: 1}, USER],
  ];
  for (const [operation, input, context] of cases) {
    const {operations, calls} = harness();
    const result = operations[operation](input, context);
    assert.equal(result.ok, false, `${operation} ${JSON.stringify(input)}`);
    assert.equal(result.error.code, 'INVALID_INPUT', `${operation} ${JSON.stringify(input)}`);
    assertNoAbsolutePaths(result, `${operation} validation error`);
    for (const recorded of Object.values(calls)) assert.equal(recorded.length, 0, `${operation} must validate before calling a manager`);
  }
});

test('handlers never throw, even for hostile input or context values', () => {
  const inputs = [null, [], 'text', 42, {projectId: {}}, {sourceProjectId: ['p1']}];
  const contexts = [undefined, null, 'model', {actor: 'robot'}, {actor: 'user'}, {actor: 'model', sessionId: 5}];
  for (const name of M2_OPERATIONS) {
    for (const input of inputs) {
      for (const context of contexts) {
        const {operations} = harness();
        let result;
        assert.doesNotThrow(() => { result = operations[name](input, context); }, `${name} threw`);
        assert.equal(typeof result, 'object', name);
        assert.equal(typeof result.ok, 'boolean', name);
        if (!result.ok) assert.equal(typeof result.error.code, 'string', name);
      }
    }
  }
});

test('no operation returns absolute paths or path-shaped keys', () => {
  const windowsPath = 'E:\\dsh\\plugin\\05-local-memory\\data';
  const {operations} = harness({
    abstracts: {
      read: () => abstractView('p1', {
        text: `stored at ${windowsPath}`,
        canonicalRoot: windowsPath,
        worktreeRoot: windowsPath,
        basis: [{
          id: 'mem-1', recordGeneration: 2, kind: 'lesson',
          sourceRef: `${windowsPath}\\session-a`, sourceVersion: 'v1',
          summary: `source lives in ${windowsPath}`,
        }],
      }),
      refresh: () => abstractView('p1', {text: `stored at ${windowsPath}`}),
    },
    sharing: {
      discover: () => [sourceEntry({sourceProjectName: windowsPath})],
      list: () => [relationView({sourceProjectName: `C:\\repos\\Alpha`, localPath: windowsPath})],
      grant: () => relationView({permissionRef: 'local-user-grant-v1:11111111-2222-4333-8444-555555555555', sourceProjectName: `C:\\repos\\Alpha`}),
      revoke: () => relationView({state: 'revoked', revokedAt: '2026-11-08T06:45:00.000Z', sourceProjectName: windowsPath, localPath: windowsPath}),
      resolve: () => sharedResult({
        relation: relationView({sourceProjectName: `C:\\repos\\Alpha`}),
        items: [{
          id: 'mem-1', recordGeneration: 2, kind: 'lesson',
          text: `read from ${windowsPath}`,
          sourceRef: `${windowsPath}\\session-a\\f1`,
          sourceVersion: 'v1', verification: 'unverified', projectId: 'p1', repoId: 'main',
          applicability: 'current', canonicalRoot: windowsPath,
        }],
      }),
    },
  });
  const invocations = [
    ['abstract.list', {projectId: 'p1'}, USER],
    ['abstract.refresh', {projectId: 'p1'}, USER],
    ['share.discover', {targetProjectId: 'p2'}, USER],
    ['share.list', {targetProjectId: 'p2'}, USER],
    ['share.grant', grantInput(), USER],
    ['share.revoke', {relationId: 'rel-1'}, USER],
    ['shared.search', {targetProjectId: 'p2', sourceProjectId: 'p1', query: 'dma'}, USER],
  ];
  for (const [operation, input, context] of invocations) {
    const result = operations[operation](input, context);
    assert.equal(result.ok, true, operation);
    assertNoAbsolutePaths(result, operation);
    const json = JSON.stringify(result);
    for (const key of ['canonicalRoot', 'worktreeRoot', 'localPath']) assert.equal(json.includes(`"${key}"`), false, `${operation} leaked ${key}`);
    assert.equal(json.includes('[redacted-path]'), true, `${operation} should mark the redacted path`);
  }
});

/* ------------------------- dispatcher integration ------------------------ */

test('management dispatcher: model grant/refresh denied, model shared.search allowed', () => {
  const {operations, registry} = harness();
  const dispatcher = createManagementOperations({
    config: {schemaVersion: 1, profile: 'default'},
    registry,
    extras: operations,
    now: NOW,
  });

  const grant = dispatcher.dispatch({operation: 'share.grant', actor: 'model', input: grantInput()});
  assert.equal(grant.ok, false);
  assert.equal(grant.error.code, 'USER_ACTION_REQUIRED');

  const refresh = dispatcher.dispatch({operation: 'abstract.refresh', actor: 'model', input: {projectId: 'p1'}});
  assert.equal(refresh.ok, false);
  assert.equal(refresh.error.code, 'USER_ACTION_REQUIRED');

  const revoke = dispatcher.dispatch({operation: 'share.revoke', actor: 'model', input: {relationId: 'rel-1'}});
  assert.equal(revoke.ok, false);
  assert.equal(revoke.error.code, 'USER_ACTION_REQUIRED');

  const search = dispatcher.dispatch({
    operation: 'shared.search',
    actor: 'model',
    sessionId: 's1',
    input: {sourceProjectId: 'p2', query: 'dma'},
  });
  assert.equal(search.ok, true);
  assert.equal(search.value.items[0].verification, 'unverified');
  assert.equal(search.value.items[0].applicability, 'current');
  assertNoAbsolutePaths(search, 'dispatched shared.search');

  const listed = dispatcher.dispatch({operation: 'abstract.list', actor: 'model', sessionId: 's1', input: {projectId: 'p1'}});
  assert.equal(listed.ok, true);
  assert.equal(listed.value.projectId, 'p1');

  const granted = dispatcher.dispatch({operation: 'share.grant', actor: 'user', input: grantInput()});
  assert.equal(granted.ok, true);
  assert.match(granted.value.permissionRef, GENERATED_PERMISSION_REF);
  assertNoAbsolutePaths(granted, 'dispatched share.grant');
});

/* --------------------------- real module wiring -------------------------- */

const HAS_REAL_MODULES = existsSync(new URL('../src/abstracts.mjs', import.meta.url))
  && existsSync(new URL('../src/sharing.mjs', import.meta.url));

test('real abstracts/sharing managers work through the operation table', {
  skip: HAS_REAL_MODULES ? false : 'src/abstracts.mjs and/or src/sharing.mjs are not present yet',
}, async (t) => {
  let fixture;
  try {
    const [{openProjectCatalog}, {openStore}, abstractModule, sharingModule] = await Promise.all([
      import('../src/projects.mjs'),
      import('../src/backend.mjs'),
      import('../src/abstracts.mjs'),
      import('../src/sharing.mjs'),
    ]);
    fixture = realFixture({
      openProjectCatalog,
      openStore,
      createAbstractManager: abstractModule.createAbstractManager,
      createSharingManager: sharingModule.createSharingManager,
    });
  } catch (error) {
    t.diagnostic(`real M2 modules are present but not yet usable: ${error?.message ?? error}`);
    t.skip('real M2 modules are present but not yet usable');
    return;
  }
  const {operations, close, projectIds} = fixture;
  t.after(() => close());

  const model = {actor: 'model', sessionId: 's-target'};
  const refreshed = operations['abstract.refresh']({projectId: projectIds.source}, USER);
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.ok(refreshed.value.revision >= 1);
  assertNoAbsolutePaths(refreshed, 'real abstract.refresh');

  const discovered = operations['share.discover']({targetProjectId: projectIds.target}, USER);
  assert.equal(discovered.ok, true, JSON.stringify(discovered));
  const source = discovered.value.sources.find((entry) => entry.sourceProjectId === projectIds.source);
  assert.ok(source, 'the source abstract must be discoverable');
  assert.equal(source.applicability, 'current');

  const denied = operations['shared.search']({sourceProjectId: projectIds.source, query: 'DMA'}, model);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, 'SHARE_DENIED');

  const granted = operations['share.grant']({
    sourceProjectId: projectIds.source,
    targetProjectId: projectIds.target,
    abstractRevision: source.abstractRevision,
    decisionBasis: 'Integration case: the user shared the source abstract.',
  }, USER);
  assert.equal(granted.ok, true, JSON.stringify(granted));
  assert.match(granted.value.permissionRef, GENERATED_PERMISSION_REF);
  assert.equal(granted.value.state, 'active');
  assertNoAbsolutePaths(granted, 'real share.grant');

  const shared = operations['shared.search']({sourceProjectId: projectIds.source, query: 'DMA'}, model);
  assert.equal(shared.ok, true, JSON.stringify(shared));
  assert.equal(shared.value.items.length, 1);
  assert.equal(shared.value.items[0].verification, 'unverified');
  assert.equal(shared.value.items[0].applicability, 'current');
  assert.equal(shared.value.items[0].sourceRef, 'integration/fragment-1');
  assertNoAbsolutePaths(shared, 'real shared.search');

  const revoked = operations['share.revoke']({relationId: granted.value.relationId}, USER);
  assert.equal(revoked.ok, true, JSON.stringify(revoked));
  assert.equal(revoked.value.state, 'revoked');

  const afterRevoke = operations['shared.search']({sourceProjectId: projectIds.source, query: 'DMA'}, model);
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.error.code, 'SHARE_DENIED');
});

/**
 * Minimal real catalog/registry fixture for the conditional integration case. Returns undefined
 * state on construction failure so the test can skip while the concurrent modules are in progress.
 */
function realFixture({openProjectCatalog, openStore, createAbstractManager, createSharingManager}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-m2-real-'));
  const dataRoot = join(root, 'data');
  mkdirSync(dataRoot, {recursive: true});
  const catalog = openProjectCatalog(join(dataRoot, 'catalog.sqlite'), {identityPath: join(dataRoot, 'catalog.identity.json')});
  const stores = new Map();
  const projects = [];
  function register(name, scopeRef) {
    const repoDir = join(root, 'repos', name);
    mkdirSync(repoDir, {recursive: true});
    const project = catalog.registerProject({
      name,
      repositories: [{repoId: 'main', canonicalRoot: repoDir, worktreeRoot: repoDir, revision: 'workspace', buildVariant: 'test', scopeRef}],
    });
    const store = openStore(join(root, 'hot', digest(scopeRef)), {scopeRef});
    stores.set(scopeRef, store);
    projects.push(project);
    return project;
  }
  const source = register('Alpha', 'scope-alpha');
  const target = register('Beta', 'scope-beta');
  stores.get('scope-alpha').put({
    id: 'mem-1',
    sourceRef: 'integration/fragment-1',
    sourceVersion: 'v1',
    kind: 'lesson',
    text: 'DMA completion controls ownership.',
    origin: 'user',
  });
  const registry = {
    catalog,
    getProject: (projectId) => catalog.getProject(projectId),
    list: () => catalog.listProjects(),
    scopesForProject(projectId) {
      const project = catalog.getProject(projectId);
      if (!project) return [];
      return (project.repositories ?? []).map((repository) => ({
        projectId: project.projectId,
        repoId: repository.repoId,
        scopeRef: repository.scopeRef,
        projectState: project.state,
      }));
    },
    bindingForScope(scopeRef) {
      for (const project of catalog.listProjects()) {
        for (const repository of project.repositories ?? []) {
          if (repository.scopeRef === scopeRef) return {projectId: project.projectId, repoId: repository.repoId, scopeRef};
        }
      }
      return undefined;
    },
    storeFor(scopeRef) {
      const store = stores.get(scopeRef);
      if (!store) throw codedError('SCOPE_NOT_FOUND', 'scope is not registered');
      return store;
    },
    bindingForSession(session) {
      if (session?.id === 's-target') {
        const repository = target.repositories[0];
        return {projectId: target.projectId, repoId: repository.repoId, scopeRef: repository.scopeRef, projectRevision: target.revision, bindingRevision: repository.bindingRevision};
      }
      return undefined;
    },
    applicabilityForProject(projectId) {
      return {applicability: projectId === source.projectId || projectId === target.projectId ? 'current' : 'unavailable', projectState: 'active', sourceAvailable: true, checkedAt: CLOCK};
    },
    applicabilityForScope() {
      return {applicability: 'current', projectState: 'active', sourceAvailable: true, checkedAt: CLOCK};
    },
  };
  const abstracts = createAbstractManager({catalog, registry, now: NOW});
  const sharing = createSharingManager({catalog, registry, abstracts, now: NOW});
  const operations = createM2Operations({registry, abstracts, sharing, sessions: {get: (id) => (id === 's-target' ? {id} : undefined)}, now: NOW});
  function close() {
    for (const store of stores.values()) { try { store.close(); } catch { /* already closed */ } }
    try { catalog.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true});
  }
  return {operations, close, projectIds: {source: source.projectId, target: target.projectId}};
}

test('model/host callers may only name their bound project; explicit targets remain user-only', () => {
  const {operations} = harness();
  for (const [operation, input] of [
    ['shared.search', {sourceProjectId: 'p2', query: 'reclamation', targetProjectId: 'p2'}],
    ['share.discover', {targetProjectId: 'p2'}],
    ['abstract.list', {projectId: 'p2'}],
  ]) {
    const result = operations[operation](input, {actor: 'model', sessionId: 's1'});
    assert.equal(result.ok, false, operation);
    assert.equal(result.error.code, 'USER_ACTION_REQUIRED', operation);
  }
  // Naming the caller's own bound project stays valid for the model tools.
  assert.equal(operations['share.discover']({targetProjectId: 'p1'}, {actor: 'model', sessionId: 's1'}).ok, true);
  assert.equal(operations['abstract.list']({projectId: 'p1'}, {actor: 'model', sessionId: 's1'}).ok, true);
  assert.equal(operations['shared.search']({sourceProjectId: 'p2', query: 'x'}, {actor: 'model', sessionId: 's1'}).ok, true);
  // The same-origin HTTP route has no session binding, so the user UI must name the target.
  assert.equal(operations['share.discover']({targetProjectId: 'p2'}, {actor: 'user'}).ok, true);
  assert.equal(operations['shared.search']({targetProjectId: 'p2', sourceProjectId: 'p2', query: 'x'}, {actor: 'user'}).ok, true);
});
