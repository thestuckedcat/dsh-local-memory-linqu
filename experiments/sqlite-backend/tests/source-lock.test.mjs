import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('source validation accepts only the pinned host and detects changed vendor bytes', async t => {
  const { verifySourceLock } = await import('../src/source-lock.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Source lock verifier has not been implemented');
    throw error;
  });
  const root = resolve(import.meta.dirname, '..');
  assert.equal(verifySourceLock(root, { hostVersion: '0.2.1-rc.5' }).valid, true);
  assert.throws(() => verifySourceLock(root, { hostVersion: '0.2.2-alpha.3' }), /host/i);
  const copy = mkdtempSync(join(tmpdir(), 'memory-source-'));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  cpSync(join(root, 'vendor'), join(copy, 'vendor'), { recursive: true });
  cpSync(join(root, 'source-lock.json'), join(copy, 'source-lock.json'));
  writeFileSync(join(copy, 'vendor/kovey/store/sqlite/cjk.js'), 'changed');
  assert.throws(() => verifySourceLock(copy, { hostVersion: '0.2.1-rc.5' }), /integrity|digest/i);
});
