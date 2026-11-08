import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// M2 (v0.3.0) delivery evidence runner: local full suite (TAP), the real installed-library
// M1 final-request-gate probe (regression), reviewed material hashes, and the recorded
// desktop-profile install observation. No business Provider call, no profile boot.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const node = process.execPath;
const suiteTap = 'evidence/m2-node26.tap';
const startedAtUtc = new Date().toISOString();
const start = performance.now();
const tests = readdirSync(resolve(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`);

const suiteRun = spawnSync(node, ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${resolve(root, suiteTap)}`, ...tests], {cwd: root, encoding: 'utf8', timeout: 300000});
const suiteText = readFileSync(resolve(root, suiteTap), 'utf8');
const suiteSummary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [key, Number(suiteText.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN)]));

const probeRun = spawnSync(node, [resolve(root, 'tools/test-m1-host.mjs')], {cwd: root, encoding: 'utf8', timeout: 180000});
const probePath = resolve(root, 'evidence/m1-host-probe.json');
const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) : undefined;

const installPath = resolve(root, 'evidence/m2-install-verification.json');
const install = existsSync(installPath) ? JSON.parse(readFileSync(installPath, 'utf8')) : undefined;

const artifacts = [
  'src/projects.mjs', 'src/abstracts.mjs', 'src/sharing.mjs',
  'plugin/index.mjs', 'plugin/project-registry.mjs', 'plugin/management.mjs', 'plugin/m2-management.mjs',
  'plugin/configuration.mjs', 'plugin/final-projection.mjs', 'plugin/session-hooks.mjs', 'plugin/host-grants.mjs',
  'client.js', 'package.json', 'cordis.patch.yml', 'locale/en.json', 'locale/zh.json',
  'tests/projects.test.mjs', 'tests/project-registry.test.mjs', 'tests/abstracts.test.mjs',
  'tests/sharing.test.mjs', 'tests/m2-management.test.mjs', 'tests/management.test.mjs',
  'tests/configuration.test.mjs', 'tests/plugin-entry.test.mjs',
  'README.md', 'TODO.md', 'docs/m1-plugin-design.md', 'docs/m2-design.md', 'docs/mechanisms.md',
  'docs/implementation-route.md', 'docs/m2-independent-review.md', 'docs/m1-independent-review.md',
  'evidence/m2-install-verification.json',
].filter((path) => existsSync(resolve(root, path))).map((path) => ({path, sha256: sha(path)}));

const installOk = Boolean(install && install.checks?.catalogMigration?.userVersion === 2
  && install.checks?.statusRoute?.responseSummary?.state === 'ready'
  && Array.isArray(install.checks?.newModelTools?.tools)
  && install.checks.newModelTools.tools.includes('memory_abstracts')
  && install.checks.newModelTools.tools.includes('memory_shared_search'));
// The evidence must attest the very tree it is written from: re-hash every artifact after the
// suite/probe and fail closed if anything changed while this runner was executing.
const artifactDrift = artifacts.filter((artifact) => sha(artifact.path) !== artifact.sha256).map((artifact) => artifact.path);
const artifactsStable = artifacts.length > 0 && artifactDrift.length === 0;
const verified = suiteRun.status === 0 && suiteSummary.tests === suiteSummary.pass && suiteSummary.fail === 0
  && probe?.verified === true && installOk && artifactsStable;
const report = {
  schema_version: 1,
  date: '2026-11-08',
  startedAtUtc,
  durationMs: performance.now() - start,
  purpose: 'M2 (v0.3.0) delivery evidence: catalog v1->v2, project abstracts, user-granted sharing, applicability, management API and client tab; local full suite plus the real installed-library final-gate regression probe',
  runtime: {node: process.versions.node, executable: node},
  commands: {
    suite: [node, '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${suiteTap}`, ...tests].join(' '),
    probe: [node, 'tools/test-m1-host.mjs'].join(' '),
  },
  suite: {summary: suiteSummary, exitCode: suiteRun.status, tapSha256: sha(suiteTap)},
  probe: probe === undefined ? null : {verified: probe.verified, summary: probe.summary, exitCode: probeRun.status, tapSha256: probe.tapSha256},
  liveInstall: install === undefined ? null : {
    ref: 'evidence/m2-install-verification.json',
    catalogVersion: install.checks?.catalogMigration?.userVersion,
    pluginState: install.checks?.statusRoute?.responseSummary?.state,
    newModelTools: install.checks?.newModelTools?.tools,
    clientSlotOccupant: install.checks?.clientSlot?.occupant,
    verified: installOk,
  },
  artifacts,
  artifactsStable,
  artifactDrift,
  verified,
  boundaries: [
    'The suite uses synthetic adapters/FakeHost and temporary real SQLite stores; it does not call a business model API.',
    'The probe mounts the real installed Cordis/LlmRuntime with a synthetic adapter and exercises the M1 final-request gate as a regression; it is not an M2 load test.',
    'No live M2 write journey was run against the real data root; the install evidence records the real catalog migration and route state only.',
    'Client visual rendering of the fourth Memory Center tab remains unverified; the page must reload the updated client bundle.',
    'MEM-204 capability-event consumption, M3 cold tier and MEM-405 dimension mapping are not part of this increment.',
  ],
};
writeFileSync(resolve(root, 'evidence/m2-verification.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({verified, suite: suiteSummary, probe: probe?.summary ?? null, installOk, artifacts: artifacts.length, exitCode: suiteRun.status}, null, 2) + '\n');
process.exitCode = verified ? 0 : 1;
