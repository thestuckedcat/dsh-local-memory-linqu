import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {normalizeConfig, routeApproval, routeRefFor, DEFAULTS} from '../plugin/configuration.mjs';

function config(extra = {}) {
  return normalizeConfig(extra, {env: {}});
}
function failure(promise, code) {
  assert.throws(promise, (error) => error?.code === code || error?.code === 'INVALID_CONFIG');
}

test('defaults keep the configured approved provider and non-destructive limits', () => {
  const value = config();
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.profile, 'default');
  assert.equal(value.dataRoot, join('E:/dsh-data/05-local-memory', 'default'));
  assert.deepEqual(value.routes.map((route) => route.routeRef), ['memory-default']);
  assert.equal(value.extraction.routeRef, 'memory-default');
  assert.equal(value.extraction.maxMemories, 5);
  assert.equal(value.recall.maxRecords, 5);
  assert.equal(value.scheduler.pollMs, 1000);
  assert.equal(value.scheduler.concurrency, 1);
  assert.equal(value.reminders.cooldownHours, 24);
  assert.equal(value.workSummary.routeRef, 'memory-default');
  assert.match(value.configDigest, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.recall));
});

test('profile comes from the Host environment and cannot escape the data root', () => {
  const value = normalizeConfig({}, {env: {DSH_PROFILE: 'desktop'}});
  assert.equal(value.profile, 'desktop');
  assert.equal(value.dataRoot, join('E:/dsh-data/05-local-memory', 'desktop'));
  assert.throws(() => normalizeConfig({profile: '../escape'}, {env: {}}), /profile/);
});

test('unknown fields, wrong route references and disabled path security are rejected', () => {
  failure(() => config({unknownKey: true}));
  failure(() => config({extraction: {routeRef: 'missing'}}));
  failure(() => config({routes: []}));
  failure(() => config({security: {rejectNonLocalPaths: false}}));
  failure(() => config({routes: [{routeRef: 'memory-default', provider: 'a', model: 'b'}, {routeRef: 'memory-default', provider: 'c', model: 'd'}]}));
});

test('budget and recall bounds cannot be enlarged beyond the reviewed caps', () => {
  failure(() => config({limits: {dailyRequests: 101}}));
  failure(() => config({limits: {maxOutputTokens: 2049}}));
  failure(() => config({recall: {maxRecords: 6}}));
  failure(() => config({recall: {maxChars: 4001}}));
  failure(() => config({extraction: {maxMemories: 6}}));
  failure(() => config({scheduler: {pollMs: 10}}));
});

test('declared projects require unique names and local absolute repository roots', () => {
  const repository = {repoId: 'main', canonicalRoot: 'C:/work/demo', worktreeRoot: 'C:/work/demo', revision: 'workspace', buildVariant: 'win-node24'};
  const value = config({projects: [{name: 'demo', repositories: [repository]}]});
  assert.equal(value.projects.length, 1);
  assert.equal(value.projects[0].repositories[0].canonicalRoot, 'C:\\work\\demo');
  failure(() => config({projects: [{name: 'demo', repositories: [repository]}, {name: 'demo', repositories: [repository]}]}));
  failure(() => config({projects: [{name: 'demo', repositories: [{...repository, repoId: 'main'}, {...repository, repoId: 'main'}]}]}));
  failure(() => config({projects: [{name: 'demo', repositories: [{...repository, canonicalRoot: 'relative/path'}]}]}));
  failure(() => config({projects: [{name: 'demo', repositories: [{...repository, canonicalRoot: '//server/share/x'}]}]}));
});

test('route approval is synchronous, frozen and changes when routing changes', () => {
  const value = config();
  const read = routeApproval(value);
  const route = read('memory-default');
  assert.deepEqual(Object.keys(route), ['routeRef', 'provider', 'model', 'routeVersion']);
  assert.ok(Object.isFrozen(route));
  assert.equal(read('unknown'), undefined);
  const changed = config({routes: [{routeRef: 'memory-default', provider: 'deepseek-official', model: 'other-model'}]});
  const changedRoute = routeApproval(changed)('memory-default');
  assert.notEqual(changedRoute.routeVersion, route.routeVersion);
  assert.notEqual(changed.configDigest, value.configDigest);
});

test('purpose routes follow the configured work-summary route', () => {
  const value = config({
    routes: [{routeRef: 'memory-default', provider: 'p', model: 'm'}, {routeRef: 'work-route', provider: 'p', model: 'm2'}],
    workSummary: {routeRef: 'work-route'},
  });
  assert.equal(routeRefFor(value, 'memory_extract'), 'memory-default');
  assert.equal(routeRefFor(value, 'work_summary_extract'), 'work-route');
  assert.equal(routeRefFor(value, 'work_summary_merge'), 'work-route');
});

test('config digest is stable across re-reads and independent of profile directory', () => {
  const a = config();
  const b = config();
  assert.equal(a.configDigest, b.configDigest);
  const desktop = normalizeConfig({}, {env: {DSH_PROFILE: 'desktop'}});
  assert.notEqual(desktop.dataRoot, a.dataRoot);
});

test('work-summary evidence roots are bounded local paths', () => {
  const value = config({workSummary: {evidenceRoots: ['C:/work/evidence']}});
  assert.deepEqual(value.workSummary.evidenceRoots, ['C:\\work\\evidence']);
  failure(() => config({workSummary: {evidenceRoots: ['/etc/passwd']}}));
  failure(() => config({workSummary: {evidenceRoots: new Array(9).fill('C:/x')}}));
});

test('reports export root can be configured locally but not as a bare relative path', () => {
  assert.equal(config().reports.exportRootRef, null);
  assert.equal(config({reports: {exportRootRef: 'C:/work/reports'}}).reports.exportRootRef, 'C:\\work\\reports');
  failure(() => config({reports: {exportRootRef: 'reports'}}));
});

test('the defaults object itself is frozen and never mutated by normalization', () => {
  assert.ok(Object.isFrozen(DEFAULTS.routes));
  const before = JSON.stringify(DEFAULTS);
  const value = config({recall: {maxRecords: 3}});
  assert.equal(JSON.stringify(DEFAULTS), before);
  assert.equal(value.recall.maxRecords, 3);
});

test('temporary path helpers in the test directory are usable data roots', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'memory-config-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const value = normalizeConfig({dataRoot: root, profile: 'p1'}, {env: {}});
  assert.equal(value.dataRoot, join(root, 'p1'));
  mkdirSync(value.dataRoot, {recursive: true});
  writeFileSync(join(value.dataRoot, 'probe.txt'), 'ok');
  assert.equal(readFileSync(join(value.dataRoot, 'probe.txt'), 'utf8'), 'ok');
});
