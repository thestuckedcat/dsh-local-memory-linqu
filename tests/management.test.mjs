import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createManagementHttp, createManagementOperations} from '../plugin/management.mjs';
import {normalizeConfig} from '../plugin/configuration.mjs';
import {createProjectRegistry} from '../plugin/project-registry.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {contextOf} from '../src/store-internals.mjs';
import {authorizeTestExecution, job, routeA} from './helpers.mjs';

/* ------------------------------------------------------------------ */
/* Fixture: real project catalog + real node:sqlite stores, fake       */
/* grants/scheduler/provider. Nothing here trusts a caller scope.      */
/* ------------------------------------------------------------------ */

function createFakeGrants() {
  // Mirrors the trusted host-grants contract: the service owns confirmation references,
  // accepts only action/scopeRef/jobId/status/itemRef, and authorizes each one once.
  const confirmations = new Map();
  const grants = {
    noteUserConfirmation(payload) {
      if (!payload || typeof payload !== 'object') throw new Error('confirmation payload required');
      for (const key of Object.keys(payload)) if (!['action', 'scopeRef', 'jobId', 'status', 'itemRef'].includes(key)) throw new Error('invalid confirmation field');
      if (payload.action !== 'recovery.confirm') throw new Error('unknown confirmation action');
      if (!['remote_finished', 'remote_cancel_confirmed'].includes(payload.status)) throw new Error('remote status required');
      const confirmationRef = `confirmation-v1:${randomUUID()}`;
      confirmations.set(confirmationRef, {action: 'recovery.confirm', confirmationRef, scopeRef: payload.scopeRef, jobId: payload.jobId, status: payload.status, consumed: false});
      return {confirmationRef, action: 'recovery.confirm', expiresAt: new Date(Date.now() + 120000).toISOString()};
    },
    authorizeRecovery(args) {
      const entry = confirmations.get(args?.confirmationRef);
      if (!entry || entry.consumed || entry.action !== 'recovery.confirm') return false;
      if (entry.jobId !== args.jobId || entry.status !== args.status || entry.scopeRef !== args.scopeRef) return false;
      entry.consumed = true;
      return true;
    },
    status() {
      return {confirmations: confirmations.size, revoked: false, authorizationVersion: 'test-authorization-1', dataRoot: 'E:/should-not-leak'};
    },
    currentAuthorizationVersion() {
      return 'test-authorization-1';
    },
  };
  return {grants, confirmations};
}

async function fixture(t, {cancel = true} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-management-'));
  const repoRoot = join(root, 'repo-root');
  const worktree = join(repoRoot, 'worktree');
  const secondRoot = join(root, 'repo-two');
  mkdirSync(join(worktree, 'src'), {recursive: true});
  mkdirSync(join(secondRoot, 'src'), {recursive: true});
  const config = normalizeConfig({dataRoot: join(root, 'data')}, {env: {}});
  const provider = {
    bind: () => routeA,
    approved: () => true,
    execute: async () => { throw new Error('management tests never execute model calls'); },
    measureInput: ({input}) => input.length,
  };
  const {grants, confirmations} = createFakeGrants();
  const scheduler = {
    status: () => ({state: 'running', running: 0, pendingScopes: 0, lastTickAt: null, lastError: `tick failed at ${root}`}),
    tick: () => 0,
    stop: () => {},
  };
  const queues = new Map();
  function createQueue(store) {
    const base = createJobQueue(store, {
      provider,
      limits: {},
      authorizeExecution: authorizeTestExecution,
      authorizeRecovery: (args) => grants.authorizeRecovery(args),
    });
    const calls = [];
    const queue = Object.freeze({
      ...base,
      ...(cancel ? {cancel(args) { calls.push(Object.freeze({kind: 'cancel', ...args})); return {state: 'local_cancel_requested'}; }} : {}),
      __calls: calls,
    });
    queues.set(store.scopeRef, queue);
    return queue;
  }
  const registry = createProjectRegistry({config, createQueue});
  await registry.initialize();
  t.after(() => {
    try { registry.close(); } catch { /* teardown continues */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, repoRoot, worktree, secondRoot, config, registry, grants, confirmations, scheduler, provider, queues};
}

function createOperations(ctx, {extras, scheduler} = {}) {
  return createManagementOperations({
    config: ctx.config,
    registry: ctx.registry,
    grants: ctx.grants,
    scheduler: scheduler ?? ctx.scheduler,
    provider: ctx.provider,
    extras,
    now: () => new Date('2026-11-07T00:00:00.000Z'),
  });
}

function call(operations, operation, input = {}, extra = {}) {
  const request = {operation, input, actor: extra.actor ?? 'user'};
  if (extra.operationId !== undefined) request.operationId = extra.operationId;
  if (extra.expectedRevision !== undefined) request.expectedRevision = extra.expectedRevision;
  if (extra.sessionId !== undefined) request.sessionId = extra.sessionId;
  return operations.dispatch(request);
}
function expectOk(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
function expectError(result, code) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, JSON.stringify(result));
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
  return result.error;
}
function repositoryInput(dir, extra = {}) {
  return {repoId: 'main', canonicalRoot: dir, worktreeRoot: dir, revision: 'workspace', buildVariant: 'win-node24', ...extra};
}
function rawProject(ctx, projectId) {
  return ctx.registry.getProject(projectId);
}
function registered(operations, name, repositories) {
  const value = expectOk(call(operations, 'project.register', {name, repositories}));
  assert.equal(value.state, 'active');
  return value;
}
function seedMemory(ctx, project, record, repoId = 'main') {
  const repository = project.repositories.find((candidate) => candidate.repoId === repoId);
  assert.ok(repository, `repository ${repoId} must be registered`);
  const store = ctx.registry.storeFor(repository.scopeRef);
  return store.put({
    id: record.id,
    sourceRef: record.sourceRef ?? `session-A/turn-${record.id}`,
    sourceVersion: record.sourceVersion ?? 'version-1',
    kind: record.kind ?? 'lesson',
    text: record.text,
    origin: record.origin ?? 'user',
  });
}
function currentGeneration(ctx, project, repoId = 'main') {
  const repository = project.repositories.find((candidate) => candidate.repoId === repoId);
  return ctx.registry.storeFor(repository.scopeRef).generation();
}
function noAbsolutePath(text) {
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), `response leaked an absolute path: ${text.slice(0, 400)}`);
  assert.ok(!text.includes('\\\\'), 'response leaked a UNC path');
}

/* ------------------------------------------------------------------ */
/* dispatch: actor enforcement, unknown operations, extras routing     */
/* ------------------------------------------------------------------ */

test('user-only operations reject model and host actors', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const project = rawProject(ctx, ctx.registry.list()[0].projectId);
  seedMemory(ctx, project, {id: 'one', text: 'Completion precedes reclamation.'});

  expectError(call(operations, 'memory.delete', {projectId: project.projectId, id: 'one', expectedGeneration: 0}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  expectError(call(operations, 'project.register', {name: 'beta', repositories: [repositoryInput(ctx.secondRoot)]}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  expectError(call(operations, 'task.cancel', {projectId: project.projectId, jobId: 'x', expectedGeneration: 0}, {actor: 'host'}), 'USER_ACTION_REQUIRED');
  expectError(call(operations, 'recovery.confirm', {projectId: project.projectId, jobId: 'x'}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  expectError(call(operations, 'report.approve', {reportId: 'r', reportDigest: 'd', sourceRevisions: []}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  // A read is not user-only.
  const search = expectOk(call(operations, 'memory.search', {query: 'reclamation'}, {actor: 'model'}));
  assert.equal(search.items.length, 1);
  assert.equal(search.items[0].verification, 'unverified');
});

test('unknown operations and unavailable extras return stable reason codes', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  expectError(call(operations, 'memory.explode', {}), 'UNKNOWN_OPERATION');
  expectError(call(operations, 'status.unknown', {}), 'UNKNOWN_OPERATION');
  // Managed-but-not-composed families are unavailable, not unknown.
  expectError(call(operations, 'work.list', {}), 'UNAVAILABLE');
  expectError(call(operations, 'report.draft', {}), 'UNAVAILABLE');
  expectError(call(operations, 'reminder.defer', {}), 'UNAVAILABLE');
});

test('extras receive trusted actor context and their envelopes are validated', async (t) => {
  const ctx = await fixture(t);
  const seen = [];
  const operations = createOperations(ctx, {
    extras: {
      'work.list': (input, context) => {
        seen.push({actual: input, context});
        return {ok: true, value: {items: [], marker: 'work-list'}};
      },
      'report.approve': () => ({ok: true, value: {approved: true}}),
      'report.draft': () => ({ok: false, error: {code: 'REPORT_STALE', message: 'source changed'}}),
      'reminder.defer': () => ({ok: true, value: {deferred: true}}),
      'work.broken': () => ({ok: 'yes'}),
      'work.async': async () => ({ok: true, value: {}}),
      'work.throws': () => { throw Object.assign(new Error(`boom at E:\\secret\\dir`), {code: 'PROOF_UNREADABLE'}); },
      'work.leaks': () => ({ok: true, value: {exportPath: 'E:\\dsh-data\\reports\\r1', nested: {file: 'E:\\x\\y.md', token: 'sk-abcdefghijklmnopqrstuvwx'}}}),
    },
  });
  assert.deepEqual(expectOk(call(operations, 'work.list', {limit: 3}, {actor: 'model'})), {items: [], marker: 'work-list'});
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].context, {actor: 'model', agent: undefined, sessionId: undefined});
  expectError(call(operations, 'report.approve', {}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  assert.equal(expectOk(call(operations, 'report.approve', {}, {actor: 'user'})).approved, true);
  expectError(call(operations, 'report.draft', {}), 'REPORT_STALE');
  expectError(call(operations, 'work.broken', {}), 'INTERNAL_ERROR');
  expectError(call(operations, 'work.async', {}), 'INVALID_OPERATION');
  expectError(call(operations, 'work.throws', {}), 'INTERNAL_ERROR');
  const leaky = expectOk(call(operations, 'work.leaks', {}));
  assert.equal(leaky.exportPath, '[redacted-path]');
  assert.equal(leaky.nested.file, '[redacted-path]');
  assert.equal(leaky.nested.token, '[redacted]');
});

test('request validation rejects malformed envelopes without throwing', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  expectError(operations.dispatch(undefined), 'INVALID_REQUEST');
  expectError(operations.dispatch({operation: 'status', actor: 'robot', input: {}}), 'INVALID_REQUEST');
  expectError(operations.dispatch({operation: 'bad name!', actor: 'user', input: {}}), 'INVALID_REQUEST');
  expectError(operations.dispatch({operation: 'status', operationId: '../etc', actor: 'user', input: {}}), 'INVALID_REQUEST');
  expectError(operations.dispatch({operation: 'status', operationId: 'a'.repeat(129), actor: 'user', input: {}}), 'INVALID_REQUEST');
  expectError(operations.dispatch({operation: 'status', actor: 'user', input: {unexpected: true}}), 'INVALID_INPUT');
  expectError(call(operations, 'memory.search', {query: 'x'.repeat(2001)}), 'INVALID_INPUT');
  expectError(call(operations, 'memory.search', {query: 'x', limit: 51}), 'INVALID_INPUT');
  expectError(call(operations, 'memory.search', {query: 'x', mode: 'automatic'}), 'INVALID_INPUT');
  expectError(call(operations, 'memory.list', {limit: 0}), 'INVALID_INPUT');
  expectError(call(operations, 'memory.get', {projectId: 'project-missing', id: 'one'}), 'PROJECT_NOT_FOUND');
  // Direct dispatch accepts an unbound caller only when exactly one project is discoverable.
  assert.equal(expectOk(call(operations, 'status')).schemaVersion, 1);
});

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

test('project lifecycle: register, list, update, preference, retire', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  let list = expectOk(call(operations, 'project.list'));
  assert.equal(list.total, 0);

  const main = ctx.repoRoot;
  const created = registered(operations, 'alpha', [repositoryInput(main)]);
  assert.equal(created.currentRevision, 1);
  assert.equal(created.project.name, 'alpha');
  assert.equal(created.project.origin, 'user');
  assert.equal(created.project.localRootsVisible, false);
  assert.equal(created.project.repositories[0].canonicalRootName, 'repo-root');
  assert.equal(created.project.repositories[0].scopeRef, undefined, 'scope identity must not be exposed');
  assert.equal(created.project.preferences.extract, true);
  noAbsolutePath(JSON.stringify(created));

  list = expectOk(call(operations, 'project.list'));
  assert.equal(list.total, 1);
  assert.equal(list.projects[0].projectId, created.project.projectId);
  noAbsolutePath(JSON.stringify(list));

  // Duplicate name with a different binding is refused with the catalogue reason code.
  expectError(call(operations, 'project.register', {name: 'alpha', repositories: [repositoryInput(ctx.secondRoot)]}), 'PROJECT_EXISTS');
  expectError(call(operations, 'project.register', {name: '', repositories: [repositoryInput(ctx.secondRoot)]}), 'INVALID_INPUT');
  expectError(call(operations, 'project.register', {name: 'gamma', repositories: []}), 'INVALID_INPUT');
  expectError(call(operations, 'project.register', {name: 'gamma', repositories: [repositoryInput('relative/path')]}), 'INVALID_INPUT');
  expectError(call(operations, 'project.register', {name: 'api_key=supersecretvalue', repositories: [repositoryInput(ctx.secondRoot)]}), 'INVALID_INPUT');

  const updated = expectOk(call(operations, 'project.update', {projectId: created.project.projectId, name: 'alpha-renamed'}, {expectedRevision: created.currentRevision}));
  assert.equal(updated.project.name, 'alpha-renamed');
  assert.equal(updated.currentRevision, 2);
  expectError(call(operations, 'project.update', {projectId: created.project.projectId, name: 'again'}, {expectedRevision: created.currentRevision}), 'STALE_REVISION');

  const preferred = expectOk(call(operations, 'project.preference', {projectId: created.project.projectId, key: 'extract', value: false}, {expectedRevision: 2}));
  assert.equal(preferred.project.preferences.extract, false);
  assert.equal(preferred.preference.value, false);
  assert.equal(preferred.currentRevision, 3);
  expectError(call(operations, 'project.preference', {projectId: created.project.projectId, key: 'remember', value: true}, {expectedRevision: 3}), 'INVALID_INPUT');
  expectError(call(operations, 'project.preference', {projectId: created.project.projectId, key: 'recall', value: 'yes'}, {expectedRevision: 3}), 'INVALID_INPUT');

  const retired = expectOk(call(operations, 'project.retire', {projectId: created.project.projectId, reason: 'project finished'}, {expectedRevision: 3}));
  assert.equal(retired.state, 'retired');
  assert.equal(retired.memoryRetained, true);
  assert.equal(retired.memoryDeleted, false);
  noAbsolutePath(JSON.stringify(retired));
  expectError(call(operations, 'project.retire', {projectId: created.project.projectId, reason: 'again'}, {expectedRevision: 3}), 'STALE_REVISION');
});

test('one project aggregates multiple repository scopes without exposing their roots', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  const first = ctx.repoRoot;
  const second = ctx.secondRoot;
  const created = registered(operations, 'multi', [
    repositoryInput(first, {repoId: 'one'}),
    repositoryInput(second, {repoId: 'two', canonicalRoot: second, worktreeRoot: second}),
  ]);
  const project = rawProject(ctx, created.project.projectId);
  assert.equal(project.repositories.length, 2);
  seedMemory(ctx, project, {id: 'memory-one', text: 'Reclamation waits for completion.'}, 'one');
  seedMemory(ctx, project, {id: 'memory-two', text: 'Ownership follows the descriptor path.'}, 'two');

  const search = expectOk(call(operations, 'memory.search', {projectId: project.projectId, query: 'completion descriptor'}));
  assert.equal(search.items.length, 2);
  assert.deepEqual(search.items.map((item) => item.repoId).sort(), ['one', 'two']);

  const listed = expectOk(call(operations, 'memory.list', {projectId: project.projectId}));
  assert.equal(listed.counts.active, 2);
  const detail = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: 'memory-two'}));
  assert.equal(detail.item.repoId, 'two');
  assert.equal(detail.item.text, 'Ownership follows the descriptor path.');
  noAbsolutePath(JSON.stringify(search));
  noAbsolutePath(JSON.stringify(detail));
});

/* ------------------------------------------------------------------ */
/* Memory lifecycle                                                    */
/* ------------------------------------------------------------------ */

test('memory search, paging, detail, correction, archive, restore and explicit delete use the real store', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  const created = registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const project = rawProject(ctx, created.project.projectId);
  seedMemory(ctx, project, {id: 'mem-1', text: 'Descriptor reclamation waits for completion.', sourceRef: 'session-A/turn-1'});
  seedMemory(ctx, project, {id: 'mem-2', text: 'Ownership follows the descriptor path.', sourceRef: 'session-A/turn-2'});
  seedMemory(ctx, project, {id: 'mem-3', text: 'Build variants select applicable lessons.', sourceRef: 'session-A/turn-3'});

  const first = expectOk(call(operations, 'memory.search', {query: 'descriptor', limit: 1}));
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  assert.equal(first.items[0].verification, 'unverified');
  assert.equal(first.items[0].state, 'active');
  assert.equal(typeof first.items[0].expectedGeneration, 'number');
  assert.equal(first.items[0].source.sourceRef, 'session-A/turn-1');
  const second = expectOk(call(operations, 'memory.search', {query: 'descriptor', limit: 1, cursor: first.nextCursor}));
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, first.items[0].id);

  const listed = expectOk(call(operations, 'memory.list'));
  assert.equal(listed.counts.active, 3);
  assert.equal(listed.counts.deleted, 0);
  const paged = expectOk(call(operations, 'memory.list', {limit: 2}));
  assert.equal(paged.items.length, 2);
  assert.ok(paged.nextCursor);
  assert.equal(expectOk(call(operations, 'memory.list', {limit: 2, cursor: paged.nextCursor})).items.length, 1);

  const detail = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: 'mem-1'}));
  assert.equal(detail.item.text, 'Descriptor reclamation waits for completion.');
  assert.deepEqual(detail.item.actions, ['correct', 'archive', 'delete']);
  const generation = detail.currentGeneration;
  assert.equal(detail.item.expectedGeneration, generation);

  // Cursors are bound to the scope revision.
  seedMemory(ctx, project, {id: 'mem-4', text: 'Another descriptor lesson.'});
  expectError(call(operations, 'memory.list', {limit: 2, cursor: paged.nextCursor}), 'STALE_CURSOR');

  // Correction creates a new record and invalidates the old one.
  const corrected = expectOk(call(operations, 'memory.correct', {projectId: project.projectId, id: 'mem-1', text: 'Descriptor reclamation requires completion evidence.', expectedGeneration: generation}));
  assert.notEqual(corrected.item.id, 'mem-1');
  assert.equal(corrected.item.text, 'Descriptor reclamation requires completion evidence.');
  assert.equal(corrected.state, 'active');
  assert.equal(corrected.previousId, 'mem-1');
  const old = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: 'mem-1'}));
  assert.equal(old.item.state, 'superseded');
  assert.equal(old.item.textUnavailable, true);
  assert.equal(old.item.restorable, false);

  // Archive -> listed as restorable -> restore back to active.
  const archiveGeneration = corrected.currentGeneration;
  const archived = expectOk(call(operations, 'memory.archive', {projectId: project.projectId, id: corrected.item.id, expectedGeneration: archiveGeneration}));
  assert.equal(archived.state, 'archived');
  assert.equal(archived.restorable, true);
  assert.equal(archived.bodyRetained, true);
  const archivedList = expectOk(call(operations, 'memory.list', {stateFilter: 'archived'}));
  assert.equal(archivedList.items.length, 1);
  const archivedDetail = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: corrected.item.id}));
  assert.equal(archivedDetail.item.state, 'archived');
  assert.equal(archivedDetail.item.actions.includes('restore'), true);
  expectError(call(operations, 'memory.archive', {projectId: project.projectId, id: corrected.item.id, expectedGeneration: archiveGeneration}), 'MEMORY_NOT_ACTIVE');
  const restored = expectOk(call(operations, 'memory.restore', {projectId: project.projectId, id: corrected.item.id, expectedGeneration: archived.currentGeneration}));
  assert.equal(restored.state, 'active');

  // Stale generation and wrong-state actions fail without mutating.
  expectError(call(operations, 'memory.archive', {projectId: project.projectId, id: corrected.item.id, expectedGeneration: restored.currentGeneration - 1}), 'STALE_GENERATION');
  expectError(call(operations, 'memory.restore', {projectId: project.projectId, id: corrected.item.id, expectedGeneration: restored.currentGeneration}), 'MEMORY_NOT_ARCHIVED');
  expectError(call(operations, 'memory.get', {projectId: project.projectId, id: 'missing'}), 'MEMORY_NOT_FOUND');

  // Explicit delete is irreversible and never claims remote model data was revoked.
  const deleteGeneration = restored.currentGeneration;
  const deleted = expectOk(call(operations, 'memory.delete', {projectId: project.projectId, id: corrected.item.id, expectedGeneration: deleteGeneration}));
  assert.equal(deleted.state, 'forgotten');
  assert.equal(deleted.irreversible, true);
  assert.equal(deleted.restorable, false);
  assert.equal(deleted.currentSqliteBodyAndIndexCleared, true);
  assert.equal(deleted.remoteModelData, 'not_revoked');
  assert.equal(deleted.backupCopies, 'not-revoked');
  const tombstone = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: corrected.item.id}));
  assert.equal(tombstone.item.state, 'deleted');
  assert.equal(tombstone.item.restorable, false);
  assert.equal(tombstone.item.reasonCode, 'EXPLICITLY_DELETED');
  const afterDelete = expectOk(call(operations, 'memory.list'));
  assert.equal(afterDelete.counts.deleted, 1);
  assert.ok(!afterDelete.items.some((item) => item.id === corrected.item.id));
  const searchAfterDelete = expectOk(call(operations, 'memory.search', {projectId: project.projectId, query: 'completion evidence'}));
  assert.equal(searchAfterDelete.items.length, 0);
  const store = ctx.registry.storeFor(project.repositories[0].scopeRef);
  assert.equal(store.get(corrected.item.id), undefined);

  // Flat `generation` in memory.get feeds the /memory command and the model tool contract; an
  // explicit sourceVersion is accepted for callers that already carry it.
  const flatDetail = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: 'mem-2'}));
  assert.equal(flatDetail.generation, flatDetail.currentGeneration);
  assert.equal(flatDetail.id, 'mem-2');
  const explicitCorrection = expectOk(call(operations, 'memory.correct', {
    projectId: project.projectId,
    id: 'mem-2',
    text: 'Ownership follows the descriptor path, corrected.',
    sourceVersion: 'manual-correct-v2',
  }));
  assert.equal(explicitCorrection.state, 'active');
  assert.equal(explicitCorrection.item.source.sourceVersion, 'manual-correct-v2');
});

/* ------------------------------------------------------------------ */
/* Jobs and user confirmations                                         */
/* ------------------------------------------------------------------ */

function enqueueJob(ctx, project, extra = {}) {
  const repository = project.repositories.find((candidate) => candidate.repoId === 'main');
  const store = ctx.registry.storeFor(repository.scopeRef);
  const queue = ctx.registry.queueFor(repository.scopeRef);
  return queue.enqueue(job(store, extra));
}
function quarantine(ctx, project, jobId) {
  const repository = project.repositories.find((candidate) => candidate.repoId === 'main');
  const store = ctx.registry.storeFor(repository.scopeRef);
  store.transaction(() => {
    const db = contextOf(store).db;
    db.prepare("UPDATE ledger.jobs SET state='outcome_unknown',reason='provider_outcome_unknown',cost_status='unknown',run_token=NULL WHERE id=?").run(jobId);
    db.prepare("INSERT OR REPLACE INTO ledger.dispatch_lock VALUES(1,?,?,'unknown')").run(jobId, 'run-token-unknown');
  });
}

test('task listing and inspection expose safe states without blind retry', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  const created = registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const project = rawProject(ctx, created.project.projectId);
  const queued = enqueueJob(ctx, project, {requestId: 'request-1'});
  enqueueJob(ctx, project, {requestId: 'request-2', sourceRef: 'session-A/turn-2', sourceVersion: 'version-2', inputRef: 'session-A/turn-2#fragment-1'});
  quarantine(ctx, project, queued.jobId);

  const list = expectOk(call(operations, 'task.list', {projectId: project.projectId}));
  assert.equal(list.items.length, 2);
  for (const item of list.items) {
    assert.equal(item.actions.includes('retry'), false);
    assert.equal(item.retryable, false);
    assert.equal(item.remoteStop, 'not_claimed');
  }
  const unknown = list.items.find((item) => item.jobId === queued.jobId);
  assert.equal(unknown.state, 'outcome_unknown');
  assert.equal(unknown.quarantined, true);
  assert.equal(unknown.requiresUserConfirmation, true);
  assert.equal(unknown.phase, 'unknown');
  assert.ok(unknown.actions.includes('confirmRemoteQuiescence'));
  assert.ok(unknown.actions.includes('recovery.confirm'));

  const filtered = expectOk(call(operations, 'task.list', {projectId: project.projectId, stateFilter: ['outcome_unknown']}));
  assert.equal(filtered.items.length, 1);
  expectError(call(operations, 'task.list', {projectId: project.projectId, stateFilter: ['done']}), 'INVALID_INPUT');

  const inspect = expectOk(call(operations, 'task.inspect', {projectId: project.projectId, jobId: queued.jobId}));
  assert.equal(inspect.job.quarantined, true);
  assert.equal(inspect.job.retryable, false);
  assert.equal(inspect.capabilities.cancel, true);
  expectError(call(operations, 'task.inspect', {projectId: project.projectId, jobId: 'missing'}), 'TASK_NOT_FOUND');
  expectError(call(operations, 'task.confirmRemoteQuiescence', {projectId: project.projectId, jobId: queued.jobId, status: 'maybe'}), 'INVALID_INPUT');
});

test('task cancel requests only a local stop and confirmation releases the unknown lock', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  const created = registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const project = rawProject(ctx, created.project.projectId);
  const first = enqueueJob(ctx, project, {requestId: 'request-1'});
  const second = enqueueJob(ctx, project, {requestId: 'request-2', sourceRef: 'session-A/turn-2', sourceVersion: 'version-2', inputRef: 'session-A/turn-2#fragment-1'});
  quarantine(ctx, project, second.jobId);
  const generation = currentGeneration(ctx, project);
  const repository = project.repositories.find((candidate) => candidate.repoId === 'main');
  const queue = ctx.registry.queueFor(repository.scopeRef);

  const cancelled = expectOk(call(operations, 'task.cancel', {projectId: project.projectId, jobId: first.jobId, expectedGeneration: generation}));
  assert.equal(cancelled.localStopRequested, true);
  assert.equal(cancelled.localCancellationRequested, true);
  assert.equal(cancelled.remoteStop, 'not_claimed');
  assert.equal(cancelled.remoteStopConfirmed, false);
  assert.equal(cancelled.originalJobRetried, false);
  assert.equal(queue.__calls.length, 1);
  assert.equal(queue.__calls[0].kind, 'cancel');
  assert.equal(queue.__calls[0].jobId, first.jobId);
  expectError(call(operations, 'task.cancel', {projectId: project.projectId, jobId: first.jobId, expectedGeneration: generation + 1}), 'STALE_GENERATION');
  expectError(call(operations, 'task.cancel', {projectId: project.projectId, jobId: second.jobId, expectedGeneration: generation}), 'TASK_STATE_CONFLICT');

  expectError(call(operations, 'task.confirmRemoteQuiescence', {projectId: project.projectId, jobId: second.jobId, status: 'remote_finished'}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  const confirmed = expectOk(call(operations, 'task.confirmRemoteQuiescence', {projectId: project.projectId, jobId: second.jobId, status: 'remote_finished'}));
  assert.equal(confirmed.released, true);
  assert.equal(confirmed.originalJobRetried, false);
  assert.equal(confirmed.retryAttempted, false);
  assert.equal(confirmed.remoteStopVerified, false);
  assert.equal(ctx.confirmations.size, 1);
  assert.equal([...ctx.confirmations.values()][0].action, 'recovery.confirm');
  assert.equal([...ctx.confirmations.values()][0].status, 'remote_finished');
  assert.equal([...ctx.confirmations.values()][0].consumed, true, 'the queue consumes the confirmation once');

  // An unknown task needs an explicit user recovery confirmation as well.
  expectError(call(operations, 'recovery.confirm', {projectId: project.projectId, jobId: second.jobId, status: 'remote_finished'}, {actor: 'model'}), 'USER_ACTION_REQUIRED');
  expectError(call(operations, 'recovery.confirm', {projectId: project.projectId, jobId: second.jobId}), 'INVALID_INPUT');
  const recovered = expectOk(call(operations, 'recovery.confirm', {projectId: project.projectId, jobId: second.jobId, status: 'remote_finished'}));
  assert.equal(typeof recovered.confirmationRef, 'string');
  assert.equal(recovered.status, 'remote_finished');
  assert.equal(recovered.retryAttempted, false);
  assert.equal(recovered.remoteStop, 'not_claimed');
  assert.equal(recovered.remoteStopVerified, false);
});

test('cancel is honestly unavailable when the queue cannot stop a job', async (t) => {
  const ctx = await fixture(t, {cancel: false});
  const operations = createOperations(ctx);
  const created = registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const project = rawProject(ctx, created.project.projectId);
  const queued = enqueueJob(ctx, project, {requestId: 'request-1'});
  const generation = currentGeneration(ctx, project);
  expectError(call(operations, 'task.cancel', {projectId: project.projectId, jobId: queued.jobId, expectedGeneration: generation}), 'CANCEL_UNAVAILABLE');
  const list = expectOk(call(operations, 'task.list', {projectId: project.projectId}));
  assert.equal(list.items[0].actions.includes('cancel'), false);
});

/* ------------------------------------------------------------------ */
/* HTTP route                                                          */
/* ------------------------------------------------------------------ */

const ORIGIN = 'http://127.0.0.1:14255';

function invoke(http, {method = 'POST', headers = {}, body = '', origin} = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = {'content-type': 'application/json', ...(origin === undefined ? {} : {origin}), ...headers};
  const res = {status: 0, headers: {}, body: '', headersSent: false, writableEnded: false};
  res.writeHead = (status, responseHeaders) => {
    res.status = status;
    res.headers = responseHeaders ?? {};
    res.headersSent = true;
  };
  res.end = (chunk) => {
    res.body += chunk === undefined ? '' : String(chunk);
    res.writableEnded = true;
  };
  const done = Promise.resolve(http.handler(req, res));
  process.nextTick(() => {
    if (body !== '') req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return done.then(() => res);
}
function requestBody(operation, input = {}, extra = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    operationId: extra.operationId ?? `op-${Math.random().toString(36).slice(2)}`,
    operation,
    input,
    ...(extra.expectedRevision === undefined ? {} : {expectedRevision: extra.expectedRevision}),
  });
}
function parseEnvelope(response) {
  return JSON.parse(response.body);
}

test('HTTP route enforces transport rules and same-origin, then returns business envelopes', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  const http = createManagementHttp({operations, getOrigin: () => ORIGIN});
  assert.equal(http.path, '/dsh-local-memory/api');
  assert.equal(typeof http.dispatch, 'function');
  assert.ok(http.maxBodyBytes > 0);

  let response = await invoke(http, {body: requestBody('project.list')});
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(parseEnvelope(response).ok, true);

  response = await invoke(http, {method: 'GET'});
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'POST');
  assert.equal(parseEnvelope(response).error.code, 'METHOD_NOT_ALLOWED');

  response = await invoke(http, {headers: {'content-type': 'text/plain'}, body: '{}'});
  assert.equal(response.status, 415);
  assert.equal(parseEnvelope(response).error.code, 'UNSUPPORTED_MEDIA_TYPE');

  response = await invoke(http, {origin: 'http://evil.example', body: requestBody('status')});
  assert.equal(response.status, 403);
  assert.equal(parseEnvelope(response).error.code, 'ORIGIN_DENIED');

  response = await invoke(http, {origin: ORIGIN, body: requestBody('status')});
  assert.equal(response.status, 200);
  assert.equal(parseEnvelope(response).ok, true);

  response = await invoke(http, {body: '{not json'});
  assert.equal(response.status, 400);
  assert.equal(parseEnvelope(response).error.code, 'INVALID_JSON');

  response = await invoke(http, {body: JSON.stringify({schemaVersion: 2, operationId: 'op-1', operation: 'status', input: {}})});
  assert.equal(response.status, 400);
  assert.equal(parseEnvelope(response).error.code, 'INVALID_REQUEST');

  response = await invoke(http, {body: JSON.stringify({schemaVersion: 1, operation: 'status', input: {}})});
  assert.equal(response.status, 400);
  assert.equal(parseEnvelope(response).error.code, 'INVALID_REQUEST');

  response = await invoke(http, {body: requestBody('memory.explode')});
  assert.equal(response.status, 200);
  assert.equal(parseEnvelope(response).error.code, 'UNKNOWN_OPERATION');

  const small = createManagementHttp({operations, getOrigin: () => ORIGIN, maxBodyBytes: 1024});
  response = await invoke(small, {body: requestBody('status', {padding: 'x'.repeat(2048)})});
  assert.equal(response.status, 413);
  assert.equal(parseEnvelope(response).error.code, 'BODY_TOO_LARGE');
});

test('HTTP operationId is idempotent for mutations and rejects conflicting payloads', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  const http = createManagementHttp({operations, getOrigin: () => ORIGIN});
  const created = registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const project = rawProject(ctx, created.project.projectId);
  seedMemory(ctx, project, {id: 'mem-1', text: 'Keep this lesson.'});
  const detail = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: 'mem-1'}));
  const archiveBody = requestBody('memory.archive', {projectId: project.projectId, id: 'mem-1', expectedGeneration: detail.currentGeneration}, {operationId: 'archive-op-1'});

  const first = await invoke(http, {body: archiveBody});
  assert.equal(first.status, 200);
  const firstEnvelope = parseEnvelope(first);
  assert.equal(firstEnvelope.ok, true);
  assert.equal(firstEnvelope.value.state, 'archived');

  // Replaying the same operationId+payload returns the cached result instead of failing on the now-archived record.
  const second = await invoke(http, {body: archiveBody});
  assert.equal(second.status, 200);
  assert.deepEqual(parseEnvelope(second), firstEnvelope);
  const store = ctx.registry.storeFor(project.repositories[0].scopeRef);
  const archivedDetail = expectOk(call(operations, 'memory.get', {projectId: project.projectId, id: 'mem-1'}));
  assert.equal(archivedDetail.item.state, 'archived');
  assert.equal(store.get('mem-1'), undefined);

  // Same operationId with a different payload is a conflict.
  const conflicting = await invoke(http, {body: requestBody('memory.delete', {projectId: project.projectId, id: 'mem-1', expectedGeneration: detail.currentGeneration}, {operationId: 'archive-op-1'})});
  assert.equal(conflicting.status, 200);
  assert.equal(parseEnvelope(conflicting).error.code, 'OPERATION_CONFLICT');

  // The durable operations table holds the replay row.
  const row = ctx.registry.catalog.db.prepare('SELECT fingerprint,result FROM operations WHERE request_id=?').get('archive-op-1');
  assert.ok(row);
  assert.equal(JSON.parse(row.result).ok, true);

  // Read-only operations are not persisted: the memory center polls them, and they cannot
  // duplicate a mutation, so the idempotency table stays bounded.
  const readResponse = await invoke(http, {body: requestBody('project.list', {}, {operationId: 'read-op-1'})});
  assert.equal(readResponse.status, 200);
  assert.equal(ctx.registry.catalog.db.prepare('SELECT count(*) AS n FROM operations WHERE request_id=?').get('read-op-1').n, 0);

  // HTTP error envelopes never carry stacks or absolute paths.
  const missing = await invoke(http, {body: requestBody('memory.get', {projectId: project.projectId, id: 'missing'})});
  const raw = missing.body;
  assert.equal(parseEnvelope(missing).error.code, 'MEMORY_NOT_FOUND');
  noAbsolutePath(raw);
  assert.ok(!raw.includes('stack'));
  assert.ok(!raw.includes('at /'));
});

test('status and project responses never leak local absolute paths or credentials', async (t) => {
  const ctx = await fixture(t);
  const operations = createOperations(ctx);
  registered(operations, 'alpha', [repositoryInput(ctx.repoRoot)]);
  const status = expectOk(call(operations, 'status'));
  assert.equal(status.semantics.explicitDelete, 'irreversible');
  assert.equal(status.semantics.remoteModelData, 'not_revoked');
  assert.equal(status.semantics.remoteStop, 'not_claimed');
  assert.equal(status.scheduler.state, 'running');
  const serialized = JSON.stringify(status);
  assert.ok(!serialized.includes(ctx.root), 'status must not contain the data root');
  noAbsolutePath(serialized);
  assert.equal(JSON.stringify(status).includes('should-not-leak'), false);
});

/* ------------------------------------------------------------------ */
/* Client half: classic loader shape, locale completeness, registration */
/* ------------------------------------------------------------------ */

test('client half is a dependency-free classic plugin with locale-complete UI strings', async () => {
  const clientUrl = new URL('../client.js', import.meta.url);
  const source = readFileSync(fileURLToPath(clientUrl), 'utf8');
  assert.match(source, /^\/\*\*[\s\S]*?\*\/\s*window\.__ModuleLoader__\.load\(/);
  assert.ok(source.includes('factory(require)'));
  assert.ok(!/^\s*import\s/m.test(source), 'client half must not use ESM imports');
  assert.ok(!/^\s*export\s/m.test(source), 'client half must not use ESM exports');
  assert.ok(!/require\('@deepseek-ai/.test(source), 'client half must not import Harness Client packages');
  assert.ok(!source.includes('document.body'), 'client half must not write outside its component');
  // Polling is visibility-aware and every timer is cleared in the owning effect.
  assert.ok(source.includes('visibilitychange'));
  assert.ok(source.includes('setInterval'));
  assert.ok(source.includes('clearInterval'));

  const en = JSON.parse(readFileSync(fileURLToPath(new URL('../locale/en.json', import.meta.url)), 'utf8'));
  const zh = JSON.parse(readFileSync(fileURLToPath(new URL('../locale/zh.json', import.meta.url)), 'utf8'));
  for (const document of [en, zh]) {
    assert.equal(typeof document.meta?.title, 'string');
    assert.ok(document.meta.title.length > 0);
    assert.equal(typeof document.meta?.description, 'string');
    assert.ok(document.meta.description.length > 0);
    assert.equal(typeof document.memoryCenter, 'object');
  }
  const staticKeys = new Set();
  const dynamicPrefixes = new Set();
  for (const match of source.matchAll(/\bt\('([^']+)'/g)) staticKeys.add(match[1]);
  for (const match of source.matchAll(/\bt\(`([^`]+)`/g)) {
    const prefix = match[1].split('${')[0];
    if (prefix) dynamicPrefixes.add(prefix);
  }
  const enKeys = Object.keys(en.memoryCenter);
  const zhKeys = Object.keys(zh.memoryCenter);
  for (const key of staticKeys) {
    assert.ok(enKeys.includes(key), `English locale is missing static key ${key}`);
    assert.ok(zhKeys.includes(key), `Chinese locale is missing static key ${key}`);
  }
  for (const prefix of dynamicPrefixes) {
    assert.ok(enKeys.some(key => key.startsWith(prefix)), `English locale has no keys under dynamic prefix ${prefix}`);
    assert.ok(zhKeys.some(key => key.startsWith(prefix)), `Chinese locale has no keys under dynamic prefix ${prefix}`);
  }
  for (const key of enKeys) assert.ok(zhKeys.includes(key), `Chinese locale is missing ${key}`);
  for (const key of zhKeys) assert.ok(enKeys.includes(key), `English locale is missing ${key}`);

  const registrations = [];
  const previousWindow = globalThis.window;
  globalThis.window = {__ModuleLoader__: {load(spec) { registrations.push(spec); }}};
  try {
    await import(`${clientUrl.href}?test=${Date.now()}`);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  assert.equal(registrations.length, 1);
  const spec = registrations[0];
  assert.equal(spec.id, 'dsh-local-memory-linqu');
  assert.equal(typeof spec.factory, 'function');
  // Minimal single-pass hook runtime: state overrides let one render exercise the loading and
  // populated branches; effects are intentionally not executed (separate tests cover the API).
  let stateIndex = 0;
  let stateOverrides = [];
  const fakeReact = {
    createElement(type, props, ...children) { return {type, props: props || {}, children}; },
    useRef(initial) { return {current: initial}; },
    useState(initial) {
      const overrideIndex = stateIndex++;
      const override = stateOverrides.length > overrideIndex ? stateOverrides[overrideIndex] : undefined;
      return [override === undefined ? (typeof initial === 'function' ? initial() : initial) : override, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useCallback(callback) { return callback; },
    useMemo(factory) { return factory(); },
  };
  const plugin = spec.factory(name => {
    if (name === 'react') return fakeReact;
    throw new Error(`unexpected module ${name}`);
  });
  assert.deepEqual(plugin.inject, ['slots', 'locale']);

  let active = 'zh';
  const dictionaries = new Map();
  const effects = [];
  const injections = [];
  const slotRegistrations = [];
  const ctx = {
    effect(callback, label) {
      const disposer = callback();
      effects.push({label, disposer});
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.set(namespace, dicts);
        return () => dictionaries.delete(namespace);
      },
      bind(namespace) {
        return (key, params) => {
          const dictionary = dictionaries.get(namespace)?.[active];
          if (!dictionary || typeof dictionary[key] !== 'string') return key;
          const template = dictionary[key];
          if (!params) return template;
          return template.replace(/\{(\w+)\}/g, (match, name) => Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
        };
      },
    },
    slots: {
      inject(ownerKey, callback) { injections.push({ownerKey, disposer: callback()}); },
      register(options, Component) { slotRegistrations.push({options, Component}); return () => {}; },
    },
  };
  plugin.apply(ctx);
  assert.equal(effects.length, 1);
  assert.match(effects[0].label, /^local-memory/);
  assert.ok(dictionaries.has('memoryCenter'));
  assert.equal(injections.length, 1);
  assert.equal(injections[0].ownerKey, 'settings.section');
  assert.equal(slotRegistrations.length, 1);
  const registration = slotRegistrations[0];
  assert.equal(registration.options.name, 'settings.section');
  assert.equal(registration.options.id, 'local-memory');
  assert.equal(registration.options.order, 10);
  assert.equal(registration.options.locale, 'memoryCenter');
  assert.equal(typeof registration.options.label, 'function');
  assert.equal(registration.options.label(), '记忆中心');
  active = 'en';
  assert.equal(registration.options.label(), 'Memory Center');
  assert.equal(typeof registration.Component, 'function');
  assert.equal(typeof registration.options.inject, 'function');
  const provided = registration.options.inject();
  assert.equal(typeof provided.translate, 'function');
  assert.equal(typeof provided.call, 'function');
  assert.equal(provided.translate('page.title'), 'Memory Center');

  // Render every tab and the destructive/unknown confirmation branches once. This catches runtime
  // typing mistakes that syntax checks cannot (visual verification still requires the real page).
  const componentOverrides = {};
  const renderedByComponent = new Map();
  function walkElement(node, tally) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walkElement(child, tally); return; }
    if (typeof node.type === 'function') {
      tally.count += 1;
      const name = node.type.name || 'Anonymous';
      renderedByComponent.set(name, (renderedByComponent.get(name) || 0) + 1);
      const savedIndex = stateIndex;
      const savedOverrides = stateOverrides;
      stateIndex = 0;
      stateOverrides = componentOverrides[name] || [];
      try {
        walkElement(node.type(node.props), tally);
      } finally {
        stateIndex = savedIndex;
        stateOverrides = savedOverrides;
      }
      return;
    }
    for (const child of node.children || []) walkElement(child, tally);
  }
  function renderComponent(Component, props, overrides) {
    const savedIndex = stateIndex;
    const savedOverrides = stateOverrides;
    stateIndex = 0;
    stateOverrides = overrides || [];
    const tally = {count: 0};
    try {
      walkElement(Component(props), tally);
    } finally {
      stateIndex = savedIndex;
      stateOverrides = savedOverrides;
    }
    return tally;
  }
  const rootProps = {translate: provided.translate, call: provided.call};
  for (const tab of ['memory', 'work', 'tasks']) {
    const tally = renderComponent(registration.Component, rootProps, [undefined, undefined, undefined, tab]);
    assert.ok(tally.count >= 5, `tab ${tab} must render its component tree (rendered ${tally.count})`);
  }
  const memoryItem = {
    id: 'mem-1', kind: 'lesson', text: 'Descriptor reclamation waits.', origin: 'user', state: 'active',
    generation: 4, expectedGeneration: 5, repoId: 'main',
    source: {sourceRef: 'session-A/turn-1', sourceVersion: 'v1'}, actions: ['correct', 'archive', 'delete'],
  };
  componentOverrides.MemoryTab = [[memoryItem], {active: 1, archived: 0, deleted: 0}, null, 'all', '', false, false, 'mem-1', {item: memoryItem, currentGeneration: 5}, 'Descriptor reclamation waits.', true, null];
  componentOverrides.ProjectPanel = [true, 'probe', [{repoId: 'main', canonicalRoot: '', worktreeRoot: '', revision: 'workspace', buildVariant: ''}], false, null, ''];
  let tally = renderComponent(registration.Component, rootProps, [undefined, undefined, 'project-abc', 'memory']);
  assert.ok(tally.count >= 10);
  assert.ok(renderedByComponent.has('ProjectPanel'));
  delete componentOverrides.MemoryTab;
  delete componentOverrides.ProjectPanel;

  const workRecord = {
    id: 'work-1', generation: 3, itemType: 'requirement', title: 'DMA ownership investigation', goal: 'Find the boundary',
    time: {start: '2026', end: '2026', precision: 'year', confirmation: 'pending'},
    sources: [{sourceRef: 'session-A/turn-1', sourceVersion: 'v1'}], evidenceRefs: [], conflicts: [],
    myContribution: {text: 'I analysed the descriptor path.', basis: 'inferred', support: 'missing', confirmation: 'pending'},
    processOrConclusion: {text: 'Completion controls ownership.', basis: 'inferred', support: 'missing', confirmation: 'pending'},
    result: {text: 'unknown', basis: 'inferred', support: 'missing', confirmation: 'pending'},
    pendingEvidence: [{claimRef: 'myContribution', support: 'missing'}],
    pendingConfirmation: ['myContribution', 'time'],
  };
  const reportValue = {reportId: `report-${'a'.repeat(40)}`, revision: 1, state: 'draft', reportDigest: 'a'.repeat(64), sourceRevisions: [{projectId: 'p', scopeRef: 's', workId: 'work-1', workGeneration: 3}], pendingProofs: [{claimRef: 'myContribution'}], pendingConfirmations: [], timeRange: {from: '2026', to: '2026', precision: 'year'}};
  componentOverrides.WorkTab = [[workRecord], null, false, 'work-1', workRecord, null, true, 'Proof note', 'E:/docs/proof.md', 'myContribution', reportValue, '', '2026', '2026'];
  tally = renderComponent(registration.Component, rootProps, [undefined, undefined, 'project-abc', 'work']);
  assert.ok(tally.count >= 10);
  delete componentOverrides.WorkTab;

  const unknownJob = {
    jobId: 'job-1', state: 'outcome_unknown', phase: 'unknown', quarantined: true, purpose: 'memory_extract',
    costStatus: 'unknown', reason: 'provider_outcome_unknown', createdAt: '2026-11-07T00:00:00.000Z', repoId: 'main',
    expectedGeneration: 2, actions: ['inspect', 'confirmRemoteQuiescence', 'recovery.confirm'],
    retryable: false, remoteStop: 'not_claimed', requiresUserConfirmation: true,
  };
  componentOverrides.TasksTab = [[unknownJob], null, false, 'job-1', {job: unknownJob, capabilities: {cancel: true, confirmRemoteQuiescence: true, recoveryConfirmation: true}}, null, true];
  tally = renderComponent(registration.Component, rootProps, [undefined, undefined, 'project-abc', 'tasks']);
  assert.ok(tally.count >= 10);
  delete componentOverrides.TasksTab;

  for (const effect of effects) effect.disposer();
  assert.equal(dictionaries.size, 0);
});



