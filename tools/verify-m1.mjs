import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// M1 delivery evidence runner: local full suite (TAP) + real installed-library probe +
// hashes of the reviewed material. No network, no profile boot, no business Provider call.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const node = process.execPath;
const suiteTap = 'evidence/m1-node26.tap';
const startedAtUtc = new Date().toISOString();
const start = performance.now();

// Build the explicit test file list (glob expansion is shell-specific).
const {readdirSync} = await import('node:fs');
const tests = readdirSync(resolve(root, 'tests')).filter((name) => name.endsWith('.test.mjs') && !name.startsWith('fake-')).sort().map((name) => `tests/${name}`);
const suiteRun = spawnSync(node, ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${resolve(root, suiteTap)}`, ...tests], {cwd: root, encoding: 'utf8', timeout: 180000});
const suiteText = readFileSync(resolve(root, suiteTap), 'utf8');
const suiteSummary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [key, Number(suiteText.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN)]));

const probeRun = spawnSync(node, [resolve(root, 'tools/test-m1-host.mjs')], {cwd: root, encoding: 'utf8', timeout: 120000});
const probePath = resolve(root, 'evidence/m1-host-probe.json');
const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) : undefined;

const artifacts = [
  'plugin/index.mjs', 'plugin/configuration.mjs', 'plugin/project-registry.mjs', 'plugin/host-grants.mjs',
  'plugin/scheduler.mjs', 'plugin/final-projection.mjs', 'plugin/management.mjs', 'plugin/work-management.mjs',
  'plugin/proof-reminders.mjs', 'plugin/session-hooks.mjs', 'plugin/harness-provider.mjs', 'plugin/harness-sdk.mjs',
  'src/projects.mjs', 'src/reports.mjs', 'src/jobs.mjs', 'src/backend.mjs', 'src/lifecycle.mjs', 'src/store-internals.mjs',
  'src/work-summary.mjs', 'src/work-summary-evidence.mjs', 'client.js', 'cordis.patch.yml', 'package.json',
  'locale/en.json', 'locale/zh.json', 'tools/test-m1-host.mjs', 'tools/host-api/m1.test.mjs',
  'tests/fake-host.mjs', 'tests/plugin-entry.test.mjs', 'tests/host-grants.test.mjs', 'tests/final-projection.test.mjs',
  'tests/scheduler.test.mjs', 'tests/management.test.mjs', 'tests/reports.test.mjs', 'tests/proof-reminders.test.mjs',
  'tests/configuration.test.mjs', 'tests/projects.test.mjs', 'tests/project-registry.test.mjs', 'tests/harness-sdk.test.mjs',
  'vendor/kovey/cjk.js', 'source-lock.json', 'README.md', 'TODO.md', 'docs/m1-plugin-design.md',
  'docs/mechanisms.md', 'docs/m1-independent-review.md', 'docs/implementation-route.md',
].filter((path) => existsSync(resolve(root, path))).map((path) => ({path, sha256: sha(path)}));

const verified = suiteRun.status === 0 && suiteSummary.fail === 0 && suiteSummary.pass === suiteSummary.tests && probe?.verified === true;
const report = {
  schema_version: 1,
  date: '2026-11-07',
  startedAtUtc,
  durationMs: performance.now() - start,
  purpose: 'M1 delivery evidence: local full suite, real installed-library final-request gate probe, reviewed material hashes',
  runtime: {node: process.versions.node, executable: node},
  commands: {
    suite: [node, '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${suiteTap}`, ...tests].join(' '),
    probe: [node, 'tools/test-m1-host.mjs'].join(' '),
  },
  suite: {summary: suiteSummary, exitCode: suiteRun.status, tapSha256: sha(suiteTap)},
  probe: probe === undefined ? null : {verified: probe.verified, summary: probe.summary, exitCode: probeRun.status, tapSha256: probe.tapSha256},
  artifacts,
  verified,
  boundaries: [
    'The suite uses synthetic adapters, FakeHost (for the plugin-entry closed loop) and temporary real SQLite stores; it does not call a business model API.',
    'The probe mounts the real installed Cordis/LlmRuntime with a synthetic text adapter; it does not boot the Web profile, read credentials or reach a Provider.',
    'Installation evidence in evidence/m1-install-verification.json was observed through plugin_manager, the same-origin status route and client slot inspection; no visual screenshot was taken.',
    'M2 abstract sharing, M3 cold tier, MEM-405 dimension mapping and the async proof-read approval seam are not part of this evidence.',
  ],
};
writeFileSync(resolve(root, 'evidence/m1-verification.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify({verified, suite: suiteSummary, probe: probe?.summary ?? null, artifacts: artifacts.length, exitCode: suiteRun.status}, null, 2) + '\n');
process.exitCode = verified ? 0 : 1;
