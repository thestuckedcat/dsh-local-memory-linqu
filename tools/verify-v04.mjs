import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

// v0.4.0 delivery evidence runner: local full suite (TAP), the real installed-library M1
// final-request-gate regression probe, the current live plugin status, the installed-profile
// content/authority schema observation, and reviewed material hashes. No business Provider call
// and no profile boot are performed by this script.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => spawnSync('git', args, {cwd: root, encoding: 'utf8'}).stdout;
const gitHead = git(['rev-parse', 'HEAD']).trim();
const generated = new Set(['evidence/v0.4.0-node26.tap', 'evidence/v0.4.0-verification.json', 'evidence/m1-host-probe.json', 'evidence/m1-host-probe.tap']);
const statusClean = () => { const lines = git(['status', '--porcelain']).replace(/\r/g, '').split('\n').filter(Boolean); return lines.every((line) => generated.has(line.slice(3).trim())); };
const cleanAtStart = statusClean();
const sha = (path) => createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex');
const node = process.execPath;
const suiteTap = 'evidence/v0.4.0-node26.tap';
const startedAtUtc = new Date().toISOString();
const start = performance.now();
const tests = readdirSync(resolve(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `tests/${name}`);

const suiteRun = spawnSync(node, ['--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${resolve(root, suiteTap)}`, ...tests], {cwd: root, encoding: 'utf8', timeout: 300000});
const suiteText = readFileSync(resolve(root, suiteTap), 'utf8');
const suiteSummary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [key, Number(suiteText.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN)]));

const probeRun = spawnSync(node, [resolve(root, 'tools/test-m1-host.mjs')], {cwd: root, encoding: 'utf8', timeout: 180000});
const probePath = resolve(root, 'evidence/m1-host-probe.json');
const probe = existsSync(probePath) ? JSON.parse(readFileSync(probePath, 'utf8')) : undefined;

async function liveStatus() {
  try {
    const response = await fetch('http://127.0.0.1:8656/dsh-local-memory/api', {
      method: 'POST', headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(8000),
      body: JSON.stringify({schemaVersion: 1, operationId: 'v04-evidence-status', operation: 'status', input: {}}),
    });
    const value = await response.json();
    return {ok: response.ok && value?.ok === true, value: value?.value ?? undefined, error: value?.error ?? undefined};
  } catch (error) { return {ok: false, error: {code: 'STATUS_UNAVAILABLE', message: String(error?.message ?? error)}}; }
}
function installedSchemas() {
  const dir = 'E:/dsh-data/05-local-memory/default/hot/scopes/7ed3cd11ec24112bfba80d33631e84101fa93056fb34c59f07baf11920e2cd59';
  const contentFile = resolve(dir, 'scope-7ed3cd11ec24112bfba80d33631e84101fa93056fb34c59f07baf11920e2cd59.sqlite');
  const authorityFile = resolve(dir, 'authority.sqlite');
  if (!existsSync(contentFile) || !existsSync(authorityFile)) return {available: false};
  const content = new DatabaseSync(contentFile, {readOnly: true});
  const authority = new DatabaseSync(authorityFile, {readOnly: true});
  try {
    return {
      available: true,
      contentUserVersion: content.prepare('PRAGMA user_version').get().user_version,
      authorityUserVersion: authority.prepare('PRAGMA user_version').get().user_version,
      contentTables: content.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'consolidation_%' ORDER BY name").all().map((row) => row.name),
      authorityTables: authority.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'consolidation_%' ORDER BY name").all().map((row) => row.name),
    };
  } finally { content.close(); authority.close(); }
}

const artifacts = [
  'src/schema.mjs', 'src/consolidation-schema.mjs', 'src/store-internals.mjs', 'src/backend.mjs', 'src/jobs.mjs',
  'src/consolidation-inputs.mjs', 'src/consolidation-output.mjs', 'src/consolidation-queue.mjs',
  'src/consolidation-versions.mjs', 'src/storage-layout.mjs', 'src/cold-archive.mjs', 'src/provider.mjs',
  'plugin/index.mjs', 'plugin/attribution.mjs', 'plugin/experience-operations.mjs', 'plugin/correction.mjs',
  'plugin/idle-gate.mjs', 'plugin/harness-provider.mjs', 'plugin/session-hooks.mjs', 'plugin/management.mjs',
  'client.js', 'package.json', 'locale/en.json', 'locale/zh.json',
  'tests/consolidation-inputs.test.mjs', 'tests/consolidation-output.test.mjs', 'tests/consolidation-queue.test.mjs',
  'tests/consolidation-versions.test.mjs', 'tests/consolidation-storage.test.mjs', 'tests/correction.test.mjs',
  'tests/excerpt-lifecycle.test.mjs', 'tests/storage-layout.test.mjs', 'tests/attribution.test.mjs',
  'tests/idle-gate.test.mjs', 'tests/plugin-entry.test.mjs', 'tests/harness-provider.test.mjs',
  'README.md', 'TODO.md', 'docs/mechanisms.md', 'docs/implementation-route.md', 'docs/experience-implementation-plan.md',
].filter((path) => existsSync(resolve(root, path))).map((path) => ({path, sha256: sha(path)}));

const installStatus = await liveStatus();
const schemas = installedSchemas();
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const cleanAtEnd = statusClean();
const installOk = installStatus.ok && installStatus.value?.state === 'ready'
  && schemas.available && schemas.contentUserVersion === 3 && schemas.authorityUserVersion === 2;
const verified = suiteRun.status === 0 && summaryComplete() && probe?.verified === true && installOk && cleanAtStart && cleanAtEnd;
function summaryComplete() {
  return Number.isFinite(suiteSummary.tests) && suiteSummary.tests === suiteSummary.pass && suiteSummary.fail === 0;
}
const report = {
  schema_version: 1,
  date: '2026-11-09',
  startedAtUtc,
  durationMs: performance.now() - start,
  purpose: 'v0.4.0 experience/background delivery evidence: reading-first UI, attribution, excerpts, consolidation manifest/validator/queue/runJob/candidate/publish/derived views, correction suspension, M3 layout/journal skeleton; local full suite plus the real installed-library final-gate regression probe and live install observation',
  runtime: {node: process.versions.node, executable: node},
  packageVersion: pkg.version,
  commands: {
    suite: `${node} --test --test-concurrency=1 --test-reporter=tap ${tests.join(' ')}`,
    hostProbe: `${node} tools/test-m1-host.mjs`,
  },
  suite: {tap: suiteTap, exitCode: suiteRun.status, ...suiteSummary},
  hostProbe: {json: 'evidence/m1-host-probe.json', exitCode: probeRun.status, verified: probe?.verified === true, profileLoaded: probe?.profileLoaded ?? null, realProviderCalled: probe?.realProviderCalled ?? null},
  liveInstall: {status: installStatus, schemas},
  artifacts,
  artifactsHashBasis: 'SHA256 computed from the clean HEAD tree before this evidence file was written; compare with git show <git.head>:<path>',
  tapSha256: sha(suiteTap),
  git: {head: gitHead, cleanAtStart, cleanAtEnd},
  independentReview: {path: 'docs/v0.4.0-independent-review.md', status: 'reviewed at HEAD a35b550; Critical/Important fixes landed after that review and require a fresh evidence run', findings: {critical: 1, important: 9, minor: 9}},
  verified,
  limitations: [
    'Host probe uses a synthetic TextAdapter and installed Cordis/LlmRuntime; it does not boot the full Web profile or call a real Provider.',
    'No real business Provider call, real consolidation on the installed profile, browser visual walkthrough, OS-level egress test, or independent review is included in this evidence.',
    'Consolidation is storage/queue/runJob/publish-tested but not wired to automatic idle dispatch or a profile budget broker.',
    'M3 layout/journal is validated only; no actual body transfer, cold recall, GC or crash-during-copy test was run.',
    'Correction reflection/root-cause and cross-restart attribution were not implemented; derived/candidate UI actions remain read-only.',
  ],
};
writeFileSync(resolve(root, 'evidence/v0.4.0-verification.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
if (!verified) {
  console.error(JSON.stringify({verified, suite: suiteSummary, probe: probe?.verified, installOk, git: {head: gitHead, cleanAtStart, cleanAtEnd}}, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({verified, suite: suiteSummary, probe: probe?.verified, content: schemas.contentUserVersion, authority: schemas.authorityUserVersion, artifacts: artifacts.length}, null, 2));
}
