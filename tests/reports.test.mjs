import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/backend.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {openProjectCatalog} from '../src/projects.mjs';
import {digest} from '../src/scope.mjs';
import {fingerprint} from '../src/validation.mjs';
import {createReportManager, REPORT_SCHEMA, REMINDER_DISABLED_AT} from '../src/reports.mjs';

const RANGE = {from: '2025', to: '2025', precision: 'year'};
const CLOCK = () => new Date('2026-01-15T03:00:00.000Z');

function fixture(t, {evidenceRoots = []} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-reports-'));
  const stores = [];
  const dataRoot = join(root, 'data');
  mkdirSync(dataRoot, {recursive: true});
  const catalog = openProjectCatalog(join(dataRoot, 'catalog.sqlite'), {identityPath: join(dataRoot, 'catalog.identity.json')});
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* already closed */ } }
    try { catalog.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true});
  });
  const byScope = new Map();
  function register(name, scopeRefs) {
    const repoDir = join(root, 'repos', name);
    mkdirSync(repoDir, {recursive: true});
    const project = catalog.registerProject({
      name,
      repositories: scopeRefs.map((scopeRef, index) => ({repoId: `main-${index}`, canonicalRoot: repoDir, worktreeRoot: repoDir, revision: 'workspace', buildVariant: 'test', scopeRef})),
    });
    for (const scopeRef of scopeRefs) {
      if (!byScope.has(scopeRef)) {
        const store = openStore(join(root, 'hot', digest(scopeRef)), {scopeRef});
        stores.push(store);
        byScope.set(scopeRef, store);
      }
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
  };
  const config = {
    dataRoot,
    profile: 'default',
    workSummary: {enabled: true, routeRef: 'memory-default', evidenceRoots},
    reminders: {enabled: true, cooldownHours: 24, maxItems: 3},
    reports: {exportRootRef: null, maxItems: 200},
  };
  const reports = createReportManager({registry, config, now: CLOCK});
  return {root, dataRoot, catalog, registry, config, reports, stores, byScope, register};
}

function workManager(f, scopeRef, options = {}) {
  return createWorkSummaryManager(f.byScope.get(scopeRef), options);
}
function source(id = 'session-A/turn-1') {
  return {sourceRef: id, sourceVersion: 'v1', fragmentRef: 'fragment-1'};
}
function seed(store, {requestId, title, time, result = 'unknown', contribution = 'I analysed the descriptor path.'}) {
  return createWorkSummaryManager(store).save({
    requestId,
    draft: {
      itemType: 'requirement',
      title,
      goal: 'Find the reclamation boundary',
      myContribution: contribution,
      processOrConclusion: 'Completion controls ownership.',
      result,
      time,
    },
    sources: [source(`session-A/${requestId}`)],
  });
}
function exportPath(f, returned) {
  const filename = returned.ref.split('/').pop();
  const reportId = returned.ref.split('/')[1];
  return join(f.dataRoot, 'reports', reportId, filename);
}

test('report draft fixes the time range, lists pending proofs and never invents dimensions or confirmations', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  seed(store, {requestId: 'in-range', title: 'DMA ownership investigation', time: {start: '2025-03-05', precision: 'day'}});
  seed(store, {requestId: 'unknown-time', title: 'Boundary exploration', time: {precision: 'unknown'}});
  seed(store, {requestId: 'old', title: 'Old work', time: {start: '2024', precision: 'year'}});
  const report = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  assert.equal(report.state, 'draft');
  assert.equal(report.revision, 1);
  assert.match(report.reportId, /^report-[a-f0-9]{40}$/);
  assert.match(report.reportDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.equal(report.timeRange.from, '2025');
  assert.equal(report.items.length, 1, 'only the in-range work item is selected');
  const item = report.items[0];
  assert.equal(item.title, 'DMA ownership investigation');
  assert.equal(item.itemType, 'requirement');
  assert.equal(item.claims.myContribution.confirmation, 'pending');
  assert.equal(item.claims.myContribution.support, 'missing');
  assert.equal(item.time.precision, 'day');
  assert.ok(item.pendingEvidence.includes('myContribution'));
  assert.ok(report.pendingProofs.some((proof) => proof.workId === item.workId && proof.claimRef === 'myContribution'));
  assert.ok(report.pendingConfirmations.some((entry) => entry.claimRef === 'time'));
  assert.equal(report.dimensionMapping.status, 'pending_reference');
  assert.equal(report.unknownTimeItems.length, 1, 'unknown dates are listed separately, not silently dropped');
  assert.equal(report.unknownTimeItems[0].title, 'Boundary exploration');
  assert.equal(report.outOfRangeCount, 1);
  assert.equal(f.catalog.db.prepare('SELECT count(*) AS n FROM reports').get().n, 1);
  assert.equal(f.catalog.db.prepare('SELECT count(*) AS n FROM report_revisions WHERE approved=0').get().n, 1);
  assert.equal(report.draftedBy, 'user');
});

test('draft is deterministic for the same fixed clock and content', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  seed(f.byScope.get('workspace-v1:alpha'), {requestId: 'one', title: 'DMA ownership', time: {start: '2025-03-05', precision: 'day'}});
  const first = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  const second = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  assert.equal(second.reportId, first.reportId);
  assert.equal(second.reportDigest, first.reportDigest);
  assert.equal(f.catalog.db.prepare('SELECT count(*) AS n FROM reports').get().n, 1);
});

test('approve binds the report digest and each source work generation; mismatches are REPORT_STALE', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one', title: 'DMA ownership', time: {start: '2025-03-05', precision: 'day'}});
  const report = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  assert.throws(() => f.reports.approve({reportId: report.reportId, reportDigest: '0'.repeat(64), sourceRevisions: report.sourceRevisions, actor: 'user'}), (error) => error.code === 'REPORT_STALE');
  assert.throws(() => f.reports.approve({reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: [{...report.sourceRevisions[0], workGeneration: 999}], actor: 'user'}), (error) => error.code === 'REPORT_STALE');
  assert.throws(() => f.reports.approve({reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: report.sourceRevisions, actor: 'model'}), (error) => error.code === 'USER_ACTION_REQUIRED');
  const boundSources = report.sourceRevisions.map(({projectId, workId, workGeneration}) => ({projectId, workId, workGeneration}));
  const approved = f.reports.approve({reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: boundSources, actor: 'user'});
  assert.equal(approved.state, 'approved');
  assert.equal(approved.revision, 2);
  assert.match(approved.approvalDigest, /^[a-f0-9]{64}$/);
  const row = f.catalog.db.prepare('SELECT * FROM reports WHERE report_id=?').get(report.reportId);
  assert.equal(row.state, 'approved');
  assert.equal(row.revision, 2);
  const revisions = f.catalog.db.prepare('SELECT * FROM report_revisions WHERE report_id=? ORDER BY revision').all(report.reportId);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[1].approved, 1);
  assert.equal(revisions[1].digest, approved.approvalDigest);
  const again = f.reports.approve({reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: report.sourceRevisions, actor: 'user'});
  assert.equal(again.revision, 2, 'repeated approval is idempotent, not a new revision');
  const w = workManager(f, 'workspace-v1:alpha', {authorize: () => true});
  w.confirmClaim({id: saved.id, claimRef: 'myContribution', expectedGeneration: store.generation()});
  assert.throws(() => f.reports.export({reportId: report.reportId, revision: 2, format: 'json', actor: 'user'}), (error) => error.code === 'REPORT_STALE');
  assert.equal(f.catalog.db.prepare('SELECT state FROM reports WHERE report_id=?').get(report.reportId).state, 'stale');
  assert.throws(() => f.reports.approve({reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: report.sourceRevisions, actor: 'user'}), (error) => error.code === 'REPORT_STALE');
});

test('unapproved export is marked as draft and writes Markdown and JSON without absolute paths', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  seed(f.byScope.get('workspace-v1:alpha'), {requestId: 'one', title: 'DMA ownership', time: {start: '2025-03-05', precision: 'day'}});
  const report = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  const markdown = f.reports.export({reportId: report.reportId, revision: 1, format: 'markdown', actor: 'user'});
  assert.equal(markdown.state, 'draft');
  assert.match(markdown.ref, /draft/);
  assert.match(markdown.digest, /^[a-f0-9]{64}$/);
  assert.match(markdown.manifestDigest, /^[a-f0-9]{64}$/);
  assert.ok(markdown.bytes > 0);
  const markdownFile = exportPath(f, markdown);
  assert.ok(existsSync(markdownFile));
  const markdownText = readFileSync(markdownFile, 'utf8');
  assert.match(markdownText, /draft/);
  assert.match(markdownText, /未经用户审定/);
  assert.match(markdownText, /annual-work-report-v1/);
  assert.match(markdownText, /pending_reference/);
  assert.ok(!/[A-Za-z]:[\\/]/.test(markdownText), 'draft Markdown must not contain absolute Windows paths');
  assert.ok(!markdownText.includes(f.root), 'draft Markdown must not contain the local workspace root');
  const json = f.reports.export({reportId: report.reportId, revision: 1, format: 'json', actor: 'user'});
  const jsonFile = exportPath(f, json);
  assert.ok(existsSync(jsonFile));
  const jsonText = readFileSync(jsonFile, 'utf8');
  assert.ok(!/[A-Za-z]:[\\/]/.test(jsonText), 'draft JSON must not contain absolute Windows paths');
  assert.ok(!jsonText.includes(f.root));
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.manifest.state, 'draft');
  assert.equal(parsed.manifest.completeness, 'complete');
  assert.equal(parsed.manifest.dimensionMapping.status, 'pending_reference');
  const {manifestDigest, ...manifestBody} = parsed.manifest;
  assert.equal(manifestDigest, fingerprint(manifestBody));
  assert.equal(parsed.report.reportId, report.reportId);
  assert.equal(parsed.report.items[0].time.precision, 'day');
  assert.ok(Array.isArray(parsed.report.pendingProofs) && parsed.report.pendingProofs.length > 0);
  assert.equal(parsed.manifest.reportDigest, report.reportDigest);
  assert.equal(json.manifestDigest, parsed.manifest.manifestDigest);
  assert.throws(() => f.reports.export({reportId: report.reportId, revision: 1, format: 'json', actor: 'model'}), (error) => error.code === 'USER_ACTION_REQUIRED');
  assert.throws(() => f.reports.export({reportId: report.reportId, revision: 9, format: 'json', actor: 'user'}), (error) => error.code === 'REPORT_REVISION_MISMATCH');
  assert.throws(() => f.reports.export({reportId: report.reportId, revision: 1, format: 'pdf', actor: 'user'}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => f.reports.export({reportId: report.reportId, revision: 1, format: 'json', outputRootRef: 'E:/elsewhere', actor: 'user'}), (error) => error.code === 'EXPORT_ROOT_NOT_APPROVED');
  assert.throws(() => f.reports.export({reportId: '../evil', revision: 1, format: 'json', actor: 'user'}), (error) => error.code === 'INVALID_INPUT');
});

test('approved export is final, includes references and rejects changed sources', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one', title: 'DMA ownership', time: {start: '2025-03-05', precision: 'day'}});
  const report = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  f.reports.approve({reportId: report.reportId, reportDigest: report.reportDigest, sourceRevisions: report.sourceRevisions, actor: 'user'});
  const exported = f.reports.export({reportId: report.reportId, revision: 2, format: 'markdown', actor: 'user'});
  assert.equal(exported.state, 'approved');
  assert.match(exported.ref, /approved/);
  const text = readFileSync(exportPath(f, exported), 'utf8');
  assert.match(text, /approved/);
  assert.match(text, /已由用户审定/);
  assert.match(text, new RegExp(report.items[0].workId));
  assert.ok(!/[A-Za-z]:[\\/]/.test(text));
  const w = workManager(f, 'workspace-v1:alpha', {authorize: () => true});
  w.confirmTime({id: saved.id, expectedGeneration: store.generation()});
  assert.throws(() => f.reports.export({reportId: report.reportId, revision: 2, format: 'markdown', actor: 'user'}), (error) => error.code === 'REPORT_STALE');
});

test('report draft keeps evidence references stable without local paths and never upgrades support', async (t) => {
  const documents = mkdtempSync(join(tmpdir(), 'memory-report-docs-'));
  t.after(() => rmSync(documents, {recursive: true, force: true}));
  const proofPath = join(documents, 'proof.md');
  writeFileSync(proofPath, 'I analysed the descriptor path. The test passed.');
  const f = fixture(t, {evidenceRoots: [documents]});
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const store = f.byScope.get('workspace-v1:alpha');
  const saved = seed(store, {requestId: 'one', title: 'DMA ownership', time: {start: '2025-03-05', precision: 'day'}});
  const allowed = workManager(f, 'workspace-v1:alpha', {evidenceRoots: [documents], authorize: () => true});
  const reference = allowed.registerEvidence({id: saved.id, reference: {localPath: proofPath, displayName: 'Design note'}, claimRefs: ['myContribution'], expectedGeneration: store.generation()});
  allowed.reviewEvidence({
    id: saved.id,
    evidenceRef: reference.evidenceRef,
    claimRef: 'myContribution',
    assessment: {support: 'supported', quote: 'I analysed the descriptor path.', note: 'Only supports the stated analysis contribution.'},
    expectedGeneration: store.generation(),
  });
  assert.equal(allowed.get(saved.id).myContribution.support, 'supported');
  const report = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  const item = report.items[0];
  assert.equal(item.evidenceRefs.length, 1);
  assert.equal(item.evidenceRefs[0].displayName, 'Design note');
  assert.equal(item.evidenceRefs[0].localPath, undefined, 'draft never embeds local paths');
  assert.equal(item.claims.myContribution.support, 'unread', 'unrevalidated support is reported conservatively');
  assert.ok(report.pendingProofs.some((proof) => proof.claimRef === 'myContribution'));
  const exported = f.reports.export({reportId: report.reportId, revision: 1, format: 'json', actor: 'user'});
  const text = readFileSync(exportPath(f, exported), 'utf8');
  assert.ok(!text.includes(proofPath) && !text.includes(documents), 'default export must not contain local evidence paths');
  assert.match(text, /Design note/);
});

test('explicit work references must be live, inside the range and inside the selected projects', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const other = f.register('beta', ['workspace-v1:beta']);
  const store = f.byScope.get('workspace-v1:alpha');
  const inRange = seed(store, {requestId: 'in-range', title: 'In range', time: {start: '2025-03-05', precision: 'day'}});
  const old = seed(store, {requestId: 'old', title: 'Old', time: {start: '2024', precision: 'year'}});
  const unknown = seed(store, {requestId: 'unknown', title: 'Unknown date', time: {precision: 'unknown'}});
  const selected = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE, workRefs: [{projectId: project.projectId, workId: inRange.id}]});
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].workId, inRange.id);
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: RANGE, workRefs: [{projectId: project.projectId, workId: old.id}]}), (error) => error.code === 'WORK_OUT_OF_RANGE');
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: RANGE, workRefs: [{projectId: project.projectId, workId: unknown.id}]}), (error) => error.code === 'WORK_TIME_UNKNOWN');
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: RANGE, workRefs: [{projectId: other.projectId, workId: inRange.id}]}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: RANGE, workRefs: [{projectId: project.projectId, workId: 'work-missing'}]}), (error) => error.code === 'WORK_NOT_FOUND');
});

test('only active registered projects are selected and retired or unknown projects are refused', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const retired = f.register('retired', ['workspace-v1:retired']);
  f.catalog.retireProject({projectId: retired.projectId, expectedRevision: retired.revision, reason: 'test retirement'});
  assert.throws(() => f.reports.draft({projectIds: ['project-' + '0'.repeat(64)], timeRange: RANGE}), (error) => error.code === 'PROJECT_NOT_FOUND');
  assert.throws(() => f.reports.draft({projectIds: [retired.projectId], timeRange: RANGE}), (error) => error.code === 'PROJECT_NOT_ACTIVE');
  const report = f.reports.draft({projectIds: [project.projectId], timeRange: RANGE});
  assert.equal(report.projects[0].projectId, project.projectId);
  assert.equal(report.items.length, 0);
  const list = f.reports.list({limit: 10});
  assert.equal(list.total, 1);
  assert.equal(list.items[0].reportId, report.reportId);
  assert.equal(f.reports.get(report.reportId).reportId, report.reportId);
  assert.throws(() => f.reports.get('../etc'), (error) => error.code === 'INVALID_INPUT');
});

test('report time ranges reject malformed or reversed bounds', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: {from: '2025-12', to: '2025-01', precision: 'month'}}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: {from: '2025-13', to: '2025-14'}}), (error) => error.code === 'INVALID_INPUT');
  assert.throws(() => f.reports.draft({projectIds: [project.projectId], timeRange: {from: '2025-02-30', to: '2025-03-01'}}), (error) => error.code === 'INVALID_INPUT');
  const inferred = f.reports.draft({projectIds: [project.projectId], timeRange: {from: '2025', to: '2025'}});
  assert.equal(inferred.timeRange.precision, 'year');
});

test('catalog-backed reminder state supports 24h dedupe, defer and disable semantics', async (t) => {
  const f = fixture(t);
  const project = f.register('alpha', ['workspace-v1:alpha']);
  const reminders = f.reports.reminders;
  const scopeRef = 'workspace-v1:alpha';
  const at = (iso) => () => new Date(iso);
  const first = reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 3, cooldownHours: 24, now: at('2026-01-01T00:00:00Z')});
  assert.equal(first.due, true);
  assert.equal(first.reason, 'never_shown');
  reminders.markShown({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 3, now: at('2026-01-01T00:00:00Z')});
  assert.equal(reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 3, cooldownHours: 24, now: at('2026-01-01T23:59:00Z')}).due, false);
  assert.equal(reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 3, cooldownHours: 24, now: at('2026-01-02T00:00:01Z')}).due, true);
  assert.equal(reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 4, cooldownHours: 24, now: at('2026-01-01T01:00:00Z')}).due, true, 'a new record generation re-arms the reminder');
  reminders.deferReminder({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 4, hours: 48, now: at('2026-01-01T01:00:00Z')});
  assert.equal(reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 4, cooldownHours: 24, now: at('2026-01-03T00:59:00Z')}).due, false);
  assert.equal(reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 4, cooldownHours: 24, now: at('2026-01-03T01:00:01Z')}).due, true);
  reminders.disableReminder({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 4});
  assert.equal(reminders.reminderDue({scopeRef, recordId: 'work-a', claimRef: 'result', recordGeneration: 4, cooldownHours: 24, now: at('2030-01-01T00:00:00Z')}).due, false);
  assert.equal(f.catalog.getReminder(scopeRef, 'work-a', 'result').last_shown_at, REMINDER_DISABLED_AT);
  assert.equal(reminders.projectRemindersEnabled(project.projectId), true);
  reminders.setProjectReminders(project.projectId, false);
  assert.equal(reminders.projectRemindersEnabled(project.projectId), false);
});
