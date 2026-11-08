import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {createConsolidationInputs} from '../src/consolidation-inputs.mjs';
import {createConsolidationQueue} from '../src/consolidation-queue.mjs';
import {createConsolidationVersions} from '../src/consolidation-versions.mjs';
import {createExperienceOperations} from '../plugin/experience-operations.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {routeA} from './helpers.mjs';
import {contextOf} from '../src/store-internals.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-consolidation-versions-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  const project = {projectId: 'project-1', state: 'active', revision: 3};
  const binding = {
    projectId: 'project-1', projectRevision: 3, projectState: 'active', repoId: 'main',
    canonicalRoot: 'E:/synthetic/project', worktreeRoot: 'E:/synthetic/project', revision: 'workspace',
    buildVariant: 'win-node24', scopeRef: 'A', bindingRevision: 2,
  };
  const registry = {
    bindingForScope: (scopeRef) => (scopeRef === 'A' ? binding : undefined),
    projectForScope: (scopeRef) => (scopeRef === 'A' ? project : undefined),
    applicabilityForProject: () => ({applicability: 'current'}),
  };
  const provider = createControlledProvider({
    resolveRoute: () => routeA,
    invoke: async () => ({
      text: JSON.stringify({
        schema_version: 1,
        groups: [{
          key: 'g0', type: 'related', memoryRefs: ['m0', 'm1'],
          statement: 'Reclamation and ownership barriers are related constraints.',
          status: 'unverified',
          support: [{memoryRef: 'm0', excerptRefs: []}, {memoryRef: 'm1', excerptRefs: []}],
          applicability: 'same_scope_only',
          freshness: {status: 'unknown', reason: 'no explicit time evidence'},
        }],
        untouched: [],
      }),
      finishReason: 'stop',
      usage: {inputTokens: 10, outputTokens: 5},
    }),
  });
  const inputs = createConsolidationInputs(store, {registry, configDigest: 'config-v1'});
  const queue = createConsolidationQueue(store, {inputs, provider, authorizeExecution: () => ({authorizationVersion: 'grant-v1:test:1'})});
  const versions = createConsolidationVersions(store);
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {store, inputs, queue, versions, registry};
}
function memory(store, id, text = 'Descriptor reclamation waits for completion.') {
  return store.put({id, sourceRef: `session-A/${id}`, sourceVersion: 'v1', kind: 'lesson', text, origin: 'user'});
}
function selection(ids) {
  return {memoryIds: ids, excerptIds: [], mode: 'memory_only'};
}
function expected(store) {
  return {expectedEpoch: store.generation(), expectedScopeRevision: store.revision(), expectedHeadRevision: 0};
}
async function readyCandidate(f) {
  const first = memory(f.store, 'memory-1');
  const second = memory(f.store, 'memory-2', 'Ownership barrier precedes reclamation.');
  const job = f.queue.enqueue({requestId: 'enqueue-1', selection: selection([first.id, second.id]), route: routeA, ...expected(f.store)});
  const run = await f.queue.runJob(job.jobId);
  assert.equal(run.state, 'ready');
  return {job, candidateId: run.candidateId, first, second};
}

test('candidate read and publish create an immutable version with a new head', async (t) => {
  const f = fixture(t);
  const {candidateId} = await readyCandidate(f);
  const candidate = f.versions.getCandidate(candidateId);
  assert.equal(candidate.verification, 'unverified');
  assert.equal(candidate.semanticValidation, 'not_performed');
  assert.equal(candidate.groups.length, 1);
  assert.equal(candidate.basis.length, 2);
  const revision = f.store.revision();
  const published = f.versions.publish({requestId: 'publish-1', candidateId, expectedDigest: candidate.digest, expectedEpoch: f.store.generation(), expectedScopeRevision: f.store.revision(), expectedHeadRevision: 0});
  assert.equal(published.state, 'published');
  assert.equal(published.revision, 1);
  assert.match(published.versionId, /^mc-version:/);
  assert.equal(f.versions.head().revision, 1);
  assert.equal(f.versions.head().versionId, published.versionId);
  assert.equal(f.store.revision(), revision, 'publishing a derived view must not advance memory revision');
  const version = f.versions.getVersion(published.versionId);
  assert.equal(version.historical, false);
  assert.equal(version.verification, 'unverified');
  assert.equal(version.groups.length, 1);
  const entry = contextOf(f.store).db.prepare("SELECT state FROM ledger.entries WHERE scope_ref='A' AND collection='consolidation_versions' AND id=?").get(published.versionId);
  assert.equal(entry.state, 'active');
  const job = contextOf(f.store).db.prepare('SELECT state FROM ledger.consolidation_jobs WHERE candidate_id=?').get(candidateId);
  assert.equal(job.state, 'published');
});

test('publish is idempotent and rejects stale digests, epochs or head revisions', async (t) => {
  const f = fixture(t);
  const {candidateId} = await readyCandidate(f);
  const candidate = f.versions.getCandidate(candidateId);
  const input = {requestId: 'publish-1', candidateId, expectedDigest: candidate.digest, expectedEpoch: f.store.generation(), expectedScopeRevision: f.store.revision(), expectedHeadRevision: 0};
  const published = f.versions.publish(input);
  assert.deepEqual(f.versions.publish(input), published);
  assert.throws(() => f.versions.publish({...input, requestId: 'publish-2'}), (error) => error.code === 'MC_HEAD_CHANGED');
  assert.throws(() => f.versions.publish({...input, requestId: 'publish-3', expectedDigest: '0'.repeat(64)}), (error) => error.code === 'MC_CANDIDATE_CHANGED' || error.code === 'OPERATION_CONFLICT');
  assert.throws(() => f.versions.publish({...input, requestId: 'publish-1', expectedHeadRevision: 1}), (error) => error.code === 'OPERATION_CONFLICT');
});

test('a memory mutation before publish blocks the candidate and version read fails closed', async (t) => {
  const f = fixture(t);
  const {candidateId, first} = await readyCandidate(f);
  const candidate = f.versions.getCandidate(candidateId);
  f.store.correct({id: first.id, text: 'Descriptor reclamation requires the completion barrier.', sourceVersion: 'v2', expectedGeneration: f.store.generation()});
  assert.throws(() => f.versions.publish({requestId: 'publish-1', candidateId, expectedDigest: candidate.digest, expectedEpoch: f.store.generation(), expectedScopeRevision: f.store.revision(), expectedHeadRevision: 0}), (error) => error.code === 'MC_DEPENDENCY_CHANGED' || error.code === 'MC_EPOCH_CHANGED');
});

test('memory.derived exposes the published head with full original texts and unverified markers', async (t) => {
  const f = fixture(t);
  const {candidateId} = await readyCandidate(f);
  const candidate = f.versions.getCandidate(candidateId);
  f.versions.publish({requestId: 'publish-derived', candidateId, expectedDigest: candidate.digest, expectedEpoch: f.store.generation(), expectedScopeRevision: f.store.revision(), expectedHeadRevision: 0});
  const operations = createExperienceOperations({
    attribution: {read: () => ({state: 'none'})},
    sessions: {get: () => undefined},
    registry: {
      getProject: (id) => (id === 'project-1' ? {projectId: id, repositories: [{scopeRef: 'A', enabled: true}]} : undefined),
      storeFor: () => f.store,
    },
  });
  const result = operations['memory.derived']({projectId: 'project-1'}, {actor: 'user'});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.head.revision, 1);
  assert.equal(result.value.verification, 'unverified');
  assert.equal(result.value.semanticValidation, 'not_performed');
  assert.equal(result.value.groups.length, 1);
  assert.equal(result.value.groups[0].materials.length, 2);
  assert.match(result.value.groups[0].materials[0].text, /reclamation/i);
  assert.equal(result.value.groups[0].materials[0].textAvailable, true);
  assert.ok(result.value.warnings.includes('semantic_support_unverified'));
});
