import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {createConsolidationInputs} from '../src/consolidation-inputs.mjs';
import {canonical, fingerprint} from '../src/validation.mjs';

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-consolidation-inputs-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  let milliseconds = Date.parse('2026-11-09T00:00:00.000Z');
  const project = {projectId: 'project-1', state: 'active', revision: 3};
  let binding = {
    projectId: 'project-1', projectRevision: 3, projectState: 'active', repoId: 'main',
    canonicalRoot: 'E:/synthetic/project', worktreeRoot: 'E:/synthetic/project', revision: 'workspace',
    buildVariant: 'win-node24', scopeRef: 'A', bindingRevision: 2,
  };
  let applicability = 'current';
  const registry = {
    bindingForScope(scopeRef) { return scopeRef === 'A' ? binding : undefined; },
    projectForScope(scopeRef) { return scopeRef === 'A' ? project : undefined; },
    applicabilityForProject() { return {applicability}; },
  };
  const inputs = createConsolidationInputs(store, {
    registry,
    now: () => new Date(milliseconds),
    maxMemories: options.maxMemories ?? 16,
    maxInputChars: options.maxInputChars ?? 8000,
    batchTtlHours: options.batchTtlHours ?? 24,
    configDigest: 'config-v1',
  });
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {
    store, inputs, project,
    advance(delta) { milliseconds += delta; },
    mutateBinding(change) { binding = {...binding, ...change}; },
    setApplicability(value) { applicability = value; },
  };
}
function memory(store, id, text = 'Descriptor reclamation waits for completion.') {
  return store.put({id, sourceRef: `session-A/${id}`, sourceVersion: 'v1', kind: 'lesson', text, origin: 'user'});
}
function route() {
  return {routeRef: 'memory-default', provider: 'deepseek-official', model: 'deepseek-flash', routeVersion: 'route-v1'};
}
function snapshotArgs(ids, extra = {}) {
  return {jobId: 'job-1', permissionId: 'permission-1', memoryIds: ids, mode: 'memory_only', route: route(), baseHeadRevision: 0, ...extra};
}

test('memory-only snapshot pins 2..16 active memories and builds a bounded canonical input', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const {manifest, input, inputChars} = f.inputs.snapshot(snapshotArgs([first.id, second.id]));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.scopeRef, 'A');
  assert.equal(manifest.projectId, 'project-1');
  assert.equal(manifest.repoId, 'main');
  assert.equal(manifest.mode, 'memory_only');
  assert.equal(manifest.memories.length, 2);
  assert.equal(manifest.memories[0].ref, 'm0');
  assert.equal(manifest.memories[0].recordGeneration, first.generation);
  assert.match(manifest.memories[0].bodyDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.memories[0].rootSources.map((entry) => entry.sourceRef), ['session-A/memory-1']);
  assert.equal(manifest.inputDigest, fingerprint(input));
  assert.equal(input.schema_version, 1);
  assert.equal(input.context.buildVerification, 'unknown');
  assert.equal(inputChars, canonical(input).length);
  assert.equal(manifest.manifestDigest, fingerprint(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'manifestDigest'))));
  assert.equal(manifest.buildVerification, 'unknown');
});

test('selection, applicability and input-size failures happen before any permission exists', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  assert.throws(() => f.inputs.snapshot(snapshotArgs([first.id])), (error) => error.code === 'MC_SELECTION_INVALID');
  assert.throws(() => f.inputs.snapshot(snapshotArgs([first.id, second.id, first.id])), (error) => error.code === 'MC_SELECTION_INVALID');
  assert.throws(() => f.inputs.snapshot({...snapshotArgs([first.id, second.id]), mode: 'with_excerpts'}), (error) => error.code === 'MC_EXCERPTS_NOT_READY');
  f.setApplicability('historical_unknown');
  assert.throws(() => f.inputs.snapshot(snapshotArgs([first.id, second.id])), (error) => error.code === 'MC_APPLICABILITY_UNAVAILABLE');
  f.setApplicability('current');
  f.store.archive({id: second.id, expectedGeneration: f.store.generation()});
  assert.throws(() => f.inputs.snapshot(snapshotArgs([first.id, second.id])), (error) => error.code === 'MC_MEMORY_NOT_ACTIVE');

  const large = fixture(t, {maxInputChars: 2000});
  const longA = memory(large.store, 'long-a', 'A'.repeat(1500));
  const longB = memory(large.store, 'long-b', 'B'.repeat(1500));
  assert.throws(() => large.inputs.snapshot(snapshotArgs([longA.id, longB.id])), (error) => error.code === 'MC_INPUT_TOO_LARGE');
});

test('batch permission is user-only, expires, and read-time recheck fails closed on change', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const {manifest} = f.inputs.snapshot(snapshotArgs([first.id, second.id]));
  assert.throws(() => f.inputs.authorizeBatch({manifest, requestId: 'request-1', actor: 'model'}), (error) => error.code === 'USER_ACTION_REQUIRED');
  const permission = f.inputs.authorizeBatch({manifest, requestId: 'request-1'});
  assert.equal(permission.state, 'active');
  assert.equal(permission.permissionId, 'permission-1');
  assert.equal(f.inputs.assertCurrent(manifest, {phase: 'dispatch'}).ok, true);

  f.advance(24 * 3600_000 + 1);
  assert.throws(() => f.inputs.assertCurrent(manifest), (error) => error.code === 'MC_PERMISSION_EXPIRED');
  f.advance(-(24 * 3600_000 + 1));
  f.inputs.revokePermission({permissionId: permission.permissionId});
  assert.throws(() => f.inputs.assertCurrent(manifest), (error) => error.code === 'MC_PERMISSION_EXPIRED');
});

test('memory mutation, binding drift and a tampered manifest fail the read-time recheck', (t) => {
  const f = fixture(t);
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2');
  const {manifest} = f.inputs.snapshot(snapshotArgs([first.id, second.id]));
  f.inputs.authorizeBatch({manifest, requestId: 'request-1'});
  const corrected = f.store.correct({id: first.id, text: 'Descriptor reclamation requires completion.', sourceVersion: 'v2', expectedGeneration: f.store.generation()});
  assert.notEqual(corrected.id, first.id);
  assert.throws(() => f.inputs.assertCurrent(manifest), (error) => error.code === 'MC_EPOCH_CHANGED' || error.code === 'MC_MEMORY_CHANGED');

  const f2 = fixture(t);
  const a = memory(f2.store, 'memory-a');
  const b = memory(f2.store, 'memory-b');
  const secondManifest = f2.inputs.snapshot(snapshotArgs([a.id, b.id], {jobId: 'job-2', permissionId: 'permission-2'})).manifest;
  f2.inputs.authorizeBatch({manifest: secondManifest, requestId: 'request-2'});
  f2.mutateBinding({bindingRevision: 3});
  assert.throws(() => f2.inputs.assertCurrent(secondManifest), (error) => error.code === 'MC_BINDING_CHANGED');

  const tampered = {...secondManifest, scopeRevision: secondManifest.scopeRevision + 1};
  assert.throws(() => f2.inputs.assertCurrent(tampered), (error) => error.code === 'MC_MANIFEST_TAMPERED');
});
