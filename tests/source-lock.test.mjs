import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
async function verifier() {
  try { return (await import('../src/source-lock.mjs')).verifySourceLock; }
  catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Source admission gate is not implemented'); throw e; }
}
function clone(t) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-source-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const entry of ['source-lock.json', 'vendor', 'licenses', 'THIRD_PARTY_NOTICES.md']) cpSync(join(root, entry), join(directory, entry), { recursive: true });
  return directory;
}
// Removing source/host checks must admit the corrupt package below and fail these tests.
test('admission accepts fixed source and refuses another host or runtime', async () => {
  const verify = await verifier();
  assert.equal(verify(root, { hostVersion: '0.2.1-rc.5', runtimeVersion: '24.21.0' }).valid, true);
  assert.throws(() => verify(root, { hostVersion: '0.2.2-alpha.2' }), /host/i);
  assert.throws(() => verify(root, { runtimeVersion: '22.19.0' }), /runtime/i);
});
test('changed vendor bytes fail before any vendor code can load', async t => {
  const verify = await verifier(), directory = clone(t);
  writeFileSync(join(directory, 'vendor/kovey/cjk.js'), "globalThis.SOURCE_CANARY = true;\n");
  assert.throws(() => verify(directory), /integrity/i);
  assert.equal(globalThis.SOURCE_CANARY, undefined);
});
test('undeclared executable file and removed license are rejected', async t => {
  const verify = await verifier(), directory = clone(t);
  writeFileSync(join(directory, 'vendor/kovey/sync.mjs'), 'export const x = 1;');
  assert.throws(() => verify(directory), /undeclared/i);
  rmSync(join(directory, 'vendor/kovey/sync.mjs'));
  rmSync(join(directory, 'licenses/Apache-2.0.txt'));
  assert.throws(() => verify(directory), /integrity|license/i);
});
test('a lock cannot introduce an alternative vendor or network module', async t => {
  const verify = await verifier(), directory = clone(t);
  const lock = JSON.parse(readFileSync(join(directory, 'source-lock.json'), 'utf8'));
  lock.files.push({ path: 'vendor/kovey/network.mjs', sha256: '0'.repeat(64) });
  writeFileSync(join(directory, 'source-lock.json'), JSON.stringify(lock));
  assert.throws(() => verify(directory), /closure|approved/i);
});
test('backend import verifies bytes before a modified vendor can cause a side effect', t => {
  const directory = clone(t), marker = join(directory, 'EXECUTED');
  cpSync(join(root, 'src'), join(directory, 'src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(directory, 'package.json'));
  writeFileSync(join(directory, 'vendor/kovey/cjk.js'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'leaked');`);
  const target = pathToFileURL(join(directory, 'src/backend.mjs')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `try{await import(${JSON.stringify(target)})}catch(e){console.error(e.message);process.exitCode=42}`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 42);
  assert.match(child.stderr, /Source integrity/i);
  assert.equal(existsSync(marker), false);
});
