import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Isolated audit of the real installed Host seams used by the M1 plugin (llm/stream
// waterfall + final recall projection). Pinned installation only; no profile, no
// credentials and no registered Provider is used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const executable = 'E:/dsh/DeepSeek Harness.exe', archive = 'E:/dsh/resources/app.asar';
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const hashes = {executable: sha(executable), archive: sha(archive)};
if (hashes.executable !== '7ae939b5a82b220fbd8ad04dfbafaaedb5a49ab43dc884a5db6381f678dd0cc4' || hashes.archive !== 'e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915') throw new Error('Host differs from reviewed baseline');
// A fresh DSH_HOME per run avoids Electron single-instance locks/hand-off when the
// runner is executed repeatedly; the directory is owned by this run and removed after.
const isolatedHome = mkdtempSync(join(tmpdir(), 'm1-host-probe-'));
mkdirSync(isolatedHome, {recursive: true});
process.on('exit', () => { try { rmSync(isolatedHome, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}); } catch { /* best effort */ } });
const tap = resolve(root, 'evidence/m1-host-probe.tap');
const args = ['--expose-internals', '--require', resolve(root, 'tools/host-api/deny-network.cjs'), '--test', '--test-concurrency=1', '--test-reporter=tap', `--test-reporter-destination=${tap}`, resolve(root, 'tools/host-api/m1.test.mjs')];
const artifacts = ['tools/test-m1-host.mjs', 'tools/host-api/m1.test.mjs', 'tools/host-api/deny-network.cjs', 'plugin/final-projection.mjs', 'plugin/configuration.mjs', 'plugin/project-registry.mjs', 'src/projects.mjs', 'src/backend.mjs', 'src/scope.mjs', 'src/schema.mjs', 'src/store-internals.mjs', 'src/validation.mjs', 'src/lifecycle.mjs'].map((path) => ({path, sha256: sha(resolve(root, path))}));
const startedAtUtc = new Date().toISOString(), started = performance.now();
const result = spawnSync(executable, args, {cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000, env: {SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: isolatedHome, DSH_TELEMETRY_DISABLED: '1', DSH_AUDIT_APP_ROOT: 'E:/dsh/resources/app.asar/dsh'}});
const durationMs = performance.now() - started;
const text = readFileSync(tap, 'utf8');
const summary = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [key, Number(text.match(new RegExp(`^# ${key} (\\d+)\\r?$`, 'm'))?.[1] ?? NaN)]));
const verified = result.status === 0 && summary.tests === 3 && summary.pass === 3 && ['fail', 'cancelled', 'skipped', 'todo'].every((key) => summary[key] === 0);
const report = {
  schema_version: 1,
  date: '2026-11-07',
  startedAtUtc,
  durationMs,
  purpose: 'isolated real installed-library audit of the M1 final recall projection gate (llm/stream waterfall); not a full Host activation',
  executable,
  archive,
  hashes,
  artifacts,
  args,
  exitCode: result.status,
  signal: result.signal,
  errorCode: result.error?.code ?? null,
  summary,
  verified,
  profileLoaded: false,
  realProviderCalled: false,
  declarationBasis: 'The probe mounts the installed Cordis/LlmRuntime and a synthetic TextAdapter; the false flags follow the inspected call path, not OS-level monitoring.',
  networkGuard: 'tools/host-api/deny-network.cjs; covered Node API sinks only; not an OS policy',
  scope: 'Proves the llm/stream waterfall exists in the pinned Host, that a listener can pass or short-circuit dispatch, and that the final projection blocks a recalled message after the record is deleted. Does not certify the full Web profile, the real Provider, or the client bundle.',
  tapSha256: sha(tap),
};
writeFileSync(resolve(root, 'evidence/m1-host-probe.json'), JSON.stringify(report, null, 2) + '\n');
if (result.stderr) process.stderr.write(result.stderr);
if (result.stdout) process.stdout.write(result.stdout);
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
process.exitCode = verified ? 0 : 1;
