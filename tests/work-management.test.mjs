import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/backend.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {openProjectCatalog} from '../src/projects.mjs';
import {digest} from '../src/scope.mjs';
import {createReportManager, REMINDER_DISABLED_AT} from '../src/reports.mjs';
import {createWorkOperations, WORK_MANAGEMENT_OPERATIONS} from '../plugin/work-management.mjs';
import {createManagementOperations} from '../plugin/management.mjs';

const RANGE = {from: '2025', to: '2025', precision: 'year'};
const CLOCK = '2026-01-15T03:00:00.000Z';
const NOW = () => new Date(CLOCK);

function fixture(t, {approval} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-work-ops-'));
  const dataRoot = join(root, 'data');
  const documents = join(root, 'documents');
  mkdirSync(dataRoot, {recursive: true});
  mkdirSync(documents, {recursive: true});
  const catalog = openProjectCatalog(join(dataRoot, 'catalog.sqlite'), {identityPath: join(dataRoot, 'catalog.identity.json')});
  const stores = [];
  const byScope = new Map();
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* already closed */ } }
    try { catalog.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true});
  });
  function register(name, scopeRefs) {
    const repoDir = join(root, 'repos', name);
    mkdirSync(repoDir, {recursive: true});
    const project = catalog.registerProject({
      name,
      repositories: scopeRefs.map((scopeRef, index) => ({repoId: `main-${index}`, canonicalRoot: repoDir, worktreeRoot: repoDir, revision: 'workspace', buildVariant: 'test', scopeRef})),
    });
    for (const scopeRef of scopeRefs) {
      const store = openStore(join(root, 'hot', digest(scopeRef)), {scopeRef});
      stores.push(store);
      byScope.set(scopeRef, store);
    }
    return project;
  }
  const registry = {
    catalog,
    getProject: (projectId) => catalog.getProject(projectId),
    list: () => catalog.listProjects(),
    storeFor(scopeRef) {
      const store = byScope.get(scopeRef);
      if (!store) throw new Error('scope is not registered');
      return store;
    },
    bindingForSession(session) {
      if (session?.id !== 'bound-session') return undefined;
      const first = [...byScope.keys()][0];
      return {projectId: catalog.listProjects()[0].projectId, repoId: 'main-0', scopeRef: first, projectRevision: 1, bindingRevision: 1};
    },
  };
  const config = {
    dataRoot,
    profile: 'default',
    workSummary: {enabled: true, routeRef: 'memory-default', evidenceRoots: [documents]},
    reminders: {enabled: true, cooldownHours: 24, maxItems: 3},
    reports: {exportRootRef: null, maxItems: 200},
  };
  const reports = createReportManager({registry, config, now: NOW});
  const sessions = {get: (id) => (id === 'bound-session' ? {id, header: {cwd: join(root, 'repos')}} : undefined)};
  const operations = createWorkOperations({registry, config, reports, approval, sessions, now: NOW});
  return {root, dataRoot, documents, catalog, registry, config, reports, operations, byScope, register};
}
function seed(store, {requestId, title = 'DMA ownership', time = {start: '2025-03-05', precision: 'day'}, result = 'unknown'}) {
  return createWorkSummaryManager(store).save({
    requestId,
    draft: {
      itemType: 'requirement',
      title,
      goal: 'Find the reclamation boundary',
      myContribution: 'I analysed the descriptor path.',
      processOrConclusion: 'Completion controls ownership.',
      result,
      time,
    },
    sources: [{sourceRef: `session-A/${requestId}`, sourceVersion: 'v1', fragmentRef: 'fragment-1'}],
  });
}
const user = Object.freeze({actor: 'user'});
const model = Object.freeze({actor: 'model'});

test('work operations expose exactly the contracted operation map', async (t) => {
  const f = fixture(t);
  assert.deepEqual(Object.keys(f.operations).sort(), [...WORK_MANAGEMENT_OPERATIONS].sort());
  assert.equal(Object.keys(f.operations).length, 15);
});

test('model actors may list/get/draft reports but cannot confirm, merge, read evidence, approve or export', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  assert.equal((await f.operations['work.list']({projectId: project.projectId}, model)).ok, true);
  assert.equal((await f.operations['work.get']({projectId: project.projectId, id: saved.id}, model)).ok, true);
  const denied = [
    ['work.confirmClaim', {projectId: project.projectId, id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation()}],
    ['work.confirmTime', {projectId: project.projectId, id: saved.id, expectedGeneration: store.generation()}],
    ['work.correct', {projectId: project.projectId, id: saved.id, draft: {itemType: 'requirement', title: 'DMA ownership', goal: 'Find the reclamation boundary', myContribution: 'I analysed the descriptor path.', processOrConclusion: 'Completion controls ownership.', result: 'unknown', time: {start: '2025-03-05', precision: 'day'}}, sources: [{sourceRef: 'session-A/one', sourceVersion: 'v1', fragmentRef: 'fragment-1'}], expectedGeneration: store.generation()}],
    ['work.merge', {projectId: project.projectId, id: saved.id, draft: {itemType: 'requirement', title: 'DMA ownership', goal: 'Find the reclamation boundary', myContribution: 'Another contribution.', processOrConclusion: 'Completion controls ownership.', result: 'unknown', time: {start: '2025-03-05', precision: 'day'}}, sources: [{sourceRef: 'session-B/turn-1', sourceVersion: 'v1', fragmentRef: 'fragment-1'}], expectedGeneration: store.generation()}],
    ['work.evidence.register', {projectId: project.projectId, id: saved.id, reference: {url: 'https://example.invalid/a'}, claimRefs: ['myContribution'], expectedGeneration: store.generation()}],
    ['reminder.defer', {projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution'}],
    ['reminder.disable', {projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution'}],
  ];
  for (const [name, input] of denied) {
    const result = await f.operations[name](input, model);
    assert.equal(result.ok, false, `${name} must be denied for a model actor`);
    assert.equal(result.error.code, 'USER_ACTION_REQUIRED', `${name} must report USER_ACTION_REQUIRED`);
  }
  const forUser = await f.operations['work.confirmClaim']({projectId: project.projectId, id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation()}, user);
  assert.equal(forUser.ok, true);
  assert.equal(forUser.value.recordState !== undefined, true);
  const draft = await f.operations['report.draft']({projectIds: [project.projectId], timeRange: RANGE}, model);
  assert.equal(draft.ok, true);
  assert.equal(draft.value.state, 'draft');
  const deniedApprove = await f.operations['report.approve']({reportId: draft.value.reportId, reportDigest: draft.value.reportDigest, sourceRevisions: draft.value.sourceRevisions}, model);
  assert.equal(deniedApprove.ok, false);
  assert.equal(deniedApprove.error.code, 'USER_ACTION_REQUIRED');
  const deniedExport = await f.operations['report.export']({reportId: draft.value.reportId, revision: 1, format: 'json'}, model);
  assert.equal(deniedExport.ok, false);
  assert.equal(deniedExport.error.code, 'USER_ACTION_REQUIRED');
});

test('user confirmations persist and responses never expose local paths or secrets', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const confirmed = await f.operations['work.confirmClaim']({projectId: project.projectId, id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation()}, user);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.value.recordState, 'draft');
  const row = await f.operations['work.get']({projectId: project.projectId, id: saved.id}, user);
  assert.equal(row.ok, true);
  assert.equal(row.value.myContribution.confirmation, 'user_confirmed');
  assert.equal(row.value.pendingConfirmation.includes('time'), true);
  const serialized = JSON.stringify(row.value);
  assert.ok(!/[A-Za-z]:[\\/]/.test(serialized), 'responses must not contain absolute paths');
  const proof = join(f.documents, 'proof.md');
  writeFileSync(proof, 'I analysed the descriptor path. The test passed.');
  const registered = await f.operations['work.evidence.register']({projectId: project.projectId, id: saved.id, reference: {localPath: proof, displayName: 'Design note'}, claimRefs: ['myContribution'], expectedGeneration: store.generation()}, user);
  assert.equal(registered.ok, true);
  assert.equal(JSON.stringify(registered.value).includes(proof), false, 'registration response hides the local path');
  const userView = await f.operations['work.get']({projectId: project.projectId, id: saved.id}, user);
  assert.equal(userView.value.evidenceRefs[0].localPath, undefined);
  assert.equal(JSON.stringify(userView.value).includes(proof), false);
  const deniedReview = await f.operations['work.evidence.review']({projectId: project.projectId, id: saved.id, evidenceRef: registered.value.evidenceRef, claimRef: 'myContribution', assessment: {support: 'supported', quote: 'I analysed the descriptor path.', note: 'Only the analysis statement.'}, expectedGeneration: store.generation()}, {actor: 'user'});
  assert.equal(deniedReview.ok, false);
  assert.equal(deniedReview.error.code, 'USER_ACTION_REQUIRED');
  const reviewed = await f.operations['work.evidence.review']({
    projectId: project.projectId,
    id: saved.id,
    evidenceRef: registered.value.evidenceRef,
    claimRef: 'myContribution',
    assessment: {support: 'supported', quote: 'I analysed the descriptor path.', note: 'Only the analysis statement.'},
    expectedGeneration: store.generation(),
  }, {actor: 'user', userConfirmed: true});
  assert.equal(reviewed.ok, true);
  const userAfter = await f.operations['work.get']({projectId: project.projectId, id: saved.id}, user);
  assert.equal(userAfter.value.myContribution.support, 'supported');
  const modelAfter = await f.operations['work.get']({projectId: project.projectId, id: saved.id}, model);
  assert.equal(modelAfter.value.myContribution.support, 'unread', 'model reads never revalidate proof content');
  assert.equal(modelAfter.value.myContribution.supportQuote, undefined);
  assert.equal(modelAfter.value.myContribution.supportNote, undefined);
  assert.ok(!JSON.stringify(modelAfter.value).includes('Only the analysis statement.'));
});

test('explicit approval.request gates evidence content reads', async (t) => {
  const f = fixture(t, {approval: {request: () => ({decision: 'allowed-once'})}});
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const proof = join(f.documents, 'proof.md');
  writeFileSync(proof, 'I analysed the descriptor path.');
  const registered = await f.operations['work.evidence.register']({projectId: project.projectId, id: saved.id, reference: {localPath: proof, displayName: 'Design note'}, claimRefs: ['myContribution'], expectedGeneration: store.generation()}, user);
  assert.equal(registered.ok, true);
  const reviewed = await f.operations['work.evidence.review']({
    projectId: project.projectId,
    id: saved.id,
    evidenceRef: registered.value.evidenceRef,
    claimRef: 'myContribution',
    assessment: {support: 'partial', quote: 'I analysed the descriptor path.', note: 'Partial support only.'},
    expectedGeneration: store.generation(),
  }, user);
  assert.equal(reviewed.ok, true);
  const deniedByApproval = fixture(t, {approval: {request: () => 'rejected'}});
  const second = deniedByApproval.register('beta', ['workspace-v1:beta']);
  const secondStore = deniedByApproval.byScope.get('workspace-v1:beta');
  const other = seed(secondStore, {requestId: 'two'});
  const otherProof = join(deniedByApproval.documents, 'proof.md');
  writeFileSync(otherProof, 'I analysed the descriptor path.');
  const otherRegistration = await deniedByApproval.operations['work.evidence.register']({projectId: second.projectId, id: other.id, reference: {localPath: otherProof, displayName: 'Design note'}, claimRefs: ['myContribution'], expectedGeneration: secondStore.generation()}, user);
  const rejectedReview = await deniedByApproval.operations['work.evidence.review']({
    projectId: second.projectId,
    id: other.id,
    evidenceRef: otherRegistration.value.evidenceRef,
    claimRef: 'myContribution',
    assessment: {support: 'supported', quote: 'I analysed the descriptor path.', note: 'Attempted.'},
    expectedGeneration: secondStore.generation(),
  }, user);
  assert.equal(rejectedReview.ok, false);
  assert.equal(rejectedReview.error.code, 'USER_ACTION_REQUIRED');
});

test('extras handlers return synchronous envelopes for the management dispatcher', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const listed = f.operations['work.list']({projectId: project.projectId}, user);
  assert.equal(typeof listed.then, 'undefined', 'management dispatch requires synchronous handlers');
  assert.equal(listed.ok, true);
  const report = f.operations['report.list']({limit: 5}, model);
  assert.equal(typeof report.then, 'undefined');
  assert.equal(report.ok, true);
  const fenced = f.operations['work.confirmClaim']({projectId: project.projectId, id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation()}, model);
  assert.equal(fenced.ok, false);
  assert.equal(fenced.error.code, 'USER_ACTION_REQUIRED');
});

test('an async approval service cannot block the synchronous dispatcher; pre-resolved user confirmation works', async (t) => {
  const f = fixture(t, {approval: {request: () => Promise.resolve('allowed-once')}});
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const proof = join(f.documents, 'proof.md');
  writeFileSync(proof, 'I analysed the descriptor path.');
  const registered = await f.operations['work.evidence.register']({projectId: project.projectId, id: saved.id, reference: {localPath: proof, displayName: 'Design note'}, claimRefs: ['myContribution'], expectedGeneration: store.generation()}, user);
  assert.equal(registered.ok, true);
  const input = {
    projectId: project.projectId,
    id: saved.id,
    evidenceRef: registered.value.evidenceRef,
    claimRef: 'myContribution',
    assessment: {support: 'supported', quote: 'I analysed the descriptor path.', note: 'Only this statement.'},
    expectedGeneration: store.generation(),
  };
  const pending = f.operations['work.evidence.review'](input, user);
  assert.equal(typeof pending.then, 'undefined');
  assert.equal(pending.ok, false);
  assert.equal(pending.error.code, 'USER_ACTION_REQUIRED');
  const preConfirmed = f.operations['work.evidence.review'](input, {actor: 'user', userConfirmed: true});
  assert.equal(typeof preConfirmed.then, 'undefined');
  assert.equal(preConfirmed.ok, true);
});

test('project scope resolution works across repositories and from the trusted session binding', async (t) => {
  const f = fixture(t);
  const dual = f.register('dual', ['workspace-v1:one', 'workspace-v1:two']);
  const first = seed(f.byScope.get('workspace-v1:one'), {requestId: 'one', title: 'First scope work'});
  const second = seed(f.byScope.get('workspace-v1:two'), {requestId: 'two', title: 'Second scope work'});
  const listed = await f.operations['work.list']({projectId: dual.projectId}, user);
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items.length, 2);
  const titles = listed.value.items.map((item) => item.title).sort();
  assert.deepEqual(titles, ['First scope work', 'Second scope work']);
  const scopes = new Set(listed.value.items.map((item) => item.scopeRef));
  assert.equal(scopes.size, 2);
  for (const saved of [first, second]) {
    const got = await f.operations['work.get']({projectId: dual.projectId, id: saved.id}, model);
    assert.equal(got.ok, true);
  }
  const bound = await f.operations['work.list']({}, {actor: 'model', sessionId: 'bound-session'});
  assert.equal(bound.ok, true, JSON.stringify(bound.error));
  assert.equal(bound.value.project.projectId === dual.projectId, true);
  const noProject = await f.operations['work.list']({}, model);
  assert.equal(noProject.ok, false);
  assert.equal(noProject.error.code, 'PROJECT_REQUIRED');
  const smuggled = await f.operations['work.list']({projectId: dual.projectId, scopeRef: 'workspace-v1:two'}, model);
  assert.equal(smuggled.ok, false);
  assert.equal(smuggled.error.code, 'INVALID_INPUT');
});

test('report operations delegate to the catalog-backed report manager', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  seed(store, {requestId: 'one'});
  const drafted = await f.operations['report.draft']({projectIds: [project.projectId], timeRange: RANGE}, model);
  assert.equal(drafted.ok, true);
  assert.equal(drafted.value.state, 'draft');
  assert.equal(drafted.value.dimensionMapping.status, 'pending_reference');
  assert.equal((await f.operations['report.list']({limit: 10}, model)).value.total, 1);
  assert.equal((await f.operations['report.get']({reportId: drafted.value.reportId}, model)).value.reportId, drafted.value.reportId);
  const approved = await f.operations['report.approve']({reportId: drafted.value.reportId, reportDigest: drafted.value.reportDigest, sourceRevisions: drafted.value.sourceRevisions}, user);
  assert.equal(approved.ok, true);
  assert.equal(approved.value.state, 'approved');
  assert.equal(approved.value.revision, 2);
  const exported = await f.operations['report.export']({reportId: drafted.value.reportId, revision: 2, format: 'json'}, user);
  assert.equal(exported.ok, true);
  assert.equal(exported.value.state, 'approved');
  assert.match(exported.value.ref, /^reports\//);
  assert.equal(JSON.stringify(exported.value).includes(f.root), false);
  const tooLarge = await f.operations['report.draft']({projectIds: [project.projectId], timeRange: {from: '2024', to: '2024', precision: 'year'}}, user);
  assert.equal(tooLarge.ok, true);
  assert.equal(tooLarge.value.items.length, 0);
});

test('reminder.defer and reminder.disable write persisted catalog state with the documented cooldown semantics', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const deferred = await f.operations['reminder.defer']({projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution', hours: 48}, user);
  assert.equal(deferred.ok, true);
  assert.equal(deferred.value.deferredUntil, '2026-01-17T03:00:00.000Z');
  const stored = f.catalog.getReminder(deferred.value.scopeRef, saved.id, 'myContribution');
  assert.equal(stored.record_generation, saved.generation);
  assert.equal(stored.last_shown_at, '2026-01-17T03:00:00.000Z');
  assert.equal(f.reports.reminders.reminderDue({scopeRef: deferred.value.scopeRef, recordId: saved.id, claimRef: 'myContribution', recordGeneration: saved.generation, now: () => new Date('2026-01-17T02:59:00Z')}).due, false);
  assert.equal(f.reports.reminders.reminderDue({scopeRef: deferred.value.scopeRef, recordId: saved.id, claimRef: 'myContribution', recordGeneration: saved.generation, now: () => new Date('2026-01-17T03:00:01Z')}).due, true);
  const disabled = await f.operations['reminder.disable']({projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution'}, user);
  assert.equal(disabled.ok, true);
  assert.equal(f.catalog.getReminder(deferred.value.scopeRef, saved.id, 'myContribution').last_shown_at, REMINDER_DISABLED_AT);
  const projectDisabled = await f.operations['reminder.disable']({projectId: project.projectId}, user);
  assert.equal(projectDisabled.ok, true);
  assert.equal(f.reports.reminders.projectRemindersEnabled(project.projectId), false);
  const modelDeferred = await f.operations['reminder.defer']({projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution'}, model);
  assert.equal(modelDeferred.ok, false);
  const badHours = await f.operations['reminder.defer']({projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution', hours: 1000}, user);
  assert.equal(badHours.ok, false);
  assert.equal(badHours.error.code, 'INVALID_INPUT');
});

test('stale generations and unknown records map to safe resource codes without leaking internals', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const stale = await f.operations['work.confirmClaim']({projectId: project.projectId, id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation() + 5}, user);
  assert.equal(stale.ok, false);
  assert.match(stale.error.code, /STALE/);
  const missing = await f.operations['work.get']({projectId: project.projectId, id: 'work-missing'}, user);
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'WORK_NOT_FOUND');
  const unknownProject = await f.operations['work.list']({projectId: 'project-' + '0'.repeat(64)}, user);
  assert.equal(unknownProject.ok, false);
  assert.equal(unknownProject.error.code, 'PROJECT_NOT_FOUND');
  for (const result of [stale, missing, unknownProject]) {
    assert.ok(!/[A-Za-z]:[\\/]/.test(result.error.message));
    assert.ok(!result.error.message.includes(f.root));
  }
});

test('work/report operations dispatch through the real management extras envelope', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one'});
  const management = createManagementOperations({config: f.config, registry: f.registry, extras: f.operations, now: NOW});
  const listed = management.dispatch({operation: 'work.list', input: {projectId: project.projectId}, actor: 'user'});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(typeof listed.value.items.length, 'number');
  const got = management.dispatch({operation: 'work.get', input: {projectId: project.projectId, id: saved.id}, actor: 'user'});
  assert.equal(got.ok, true);
  assert.equal(typeof got.value.localPath, 'undefined');
  const modelConfirm = management.dispatch({operation: 'work.confirmClaim', input: {projectId: project.projectId, id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation()}, actor: 'model'});
  assert.equal(modelConfirm.ok, false);
  assert.equal(modelConfirm.error.code, 'USER_ACTION_REQUIRED');
  const drafted = management.dispatch({operation: 'report.draft', input: {projectIds: [project.projectId], timeRange: RANGE}, actor: 'model'});
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  assert.equal(drafted.value.state, 'draft');
  const approveDenied = management.dispatch({operation: 'report.approve', input: {reportId: drafted.value.reportId, reportDigest: drafted.value.reportDigest, sourceRevisions: drafted.value.sourceRevisions}, actor: 'model'});
  assert.equal(approveDenied.ok, false);
  assert.equal(approveDenied.error.code, 'USER_ACTION_REQUIRED');
  const approved = management.dispatch({operation: 'report.approve', input: {reportId: drafted.value.reportId, reportDigest: drafted.value.reportDigest, sourceRevisions: drafted.value.sourceRevisions}, actor: 'user'});
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.value.state, 'approved');
  const exported = management.dispatch({operation: 'report.export', input: {reportId: drafted.value.reportId, revision: 2, format: 'json'}, actor: 'user'});
  assert.equal(exported.ok, true, JSON.stringify(exported));
  assert.equal(JSON.stringify(exported.value).includes(f.dataRoot), false, 'dispatcher responses contain no absolute paths');
  const deferred = management.dispatch({operation: 'reminder.defer', input: {projectId: project.projectId, recordId: saved.id, claimRef: 'myContribution'}, actor: 'user'});
  assert.equal(deferred.ok, true, JSON.stringify(deferred));
  const unknown = management.dispatch({operation: 'work.deleteEverything', input: {}, actor: 'user'});
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'UNAVAILABLE');
});