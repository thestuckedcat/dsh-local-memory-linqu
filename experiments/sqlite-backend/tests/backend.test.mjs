import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function backend() {
  const module = await import('../src/backend.mjs').catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Memory backend has not been implemented');
    throw error;
  });
  return module.openStore;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'controlled-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const record = (id, text, extra = {}) => ({ id, sourceRef: 'session-A/turn-1', sourceVersion: 'commit-A', text, kind: 'lesson', ...extra });

test('SQLite and CJK recall persist across close/reopen and do not cross scope', async t => {
  const openStore = await backend(), root = fixture(t);
  let a = openStore(root, { scopeRef: 'repo-A/worktree-1/config-debug' });
  const b = openStore(root, { scopeRef: 'repo-B/worktree-1/config-debug' });
  a.put(record('one', 'DMA描述符提交后需要同步缓存，并保留设备所有权。'));
  assert.equal(a.search('同步缓存')[0].id, 'one');
  assert.deepEqual(b.search('同步缓存'), []);
  assert.deepEqual(b.list(), []);
  a.close();
  a = openStore(root, { scopeRef: 'repo-A/worktree-1/config-debug' });
  assert.equal(a.get('one').sourceVersion, 'commit-A');
  assert.equal(a.search('同步缓存')[0].scopeRef, 'repo-A/worktree-1/config-debug');
  a.close(); b.close();
});

test('empty scope and an ordinary secret cannot create globally visible memory', async t => {
  const openStore = await backend(), root = fixture(t);
  assert.throws(() => openStore(root, { scopeRef: '' }), /scope/i);
  const a = openStore(root, { scopeRef: 'repo-A' });
  assert.throws(() => a.put(record('secret', 'api_key=CANARY_PRIVATE_VALUE_918273')), /secret/i);
  assert.deepEqual(a.list(), []);
  a.close();
});

test('same source/version/content is idempotent without creating independent evidence', async t => {
  const openStore = await backend(), a = openStore(fixture(t), { scopeRef: 'repo-A' });
  const first = a.put(record('one', 'Doorbell writes follow descriptor preparation.'));
  const generation = a.generation();
  const again = a.put(record('two', 'Doorbell writes follow descriptor preparation.'));
  assert.equal(again.id, first.id);
  assert.equal(a.generation(), generation);
  assert.equal(a.list().length, 1);
  a.close();
});

test('correction supersedes old text and warm recall cannot expose old body', async t => {
  const openStore = await backend(), a = openStore(fixture(t), { scopeRef: 'repo-A' });
  a.put(record('one', 'Queue ownership belongs to old allocator.'));
  assert.equal(a.search('allocator').length, 1);
  const corrected = a.correct({ id: 'one', text: 'Queue ownership belongs to device allocator.', sourceVersion: 'commit-B' });
  assert.notEqual(corrected.id, 'one');
  assert.equal(corrected.supersedes, 'one');
  assert.equal(a.search('allocator').length, 1);
  assert.match(a.search('allocator')[0].text, /device allocator/);
  assert.equal(a.get('one'), undefined);
  a.close();
});

test('forget blocks stale writers, old backup restore, and index rebuild resurrection', async t => {
  const openStore = await backend(), a = openStore(fixture(t), { scopeRef: 'repo-A' });
  a.put(record('one', 'Reclamation requires waiting for completion.'));
  const snapshot = a.exportSnapshot(), oldGeneration = a.generation();
  a.search('Reclamation');
  a.forget({ id: 'one', expectedGeneration: oldGeneration });
  assert.throws(() => a.put(record('late', 'Reclamation requires waiting for completion.'), { expectedGeneration: oldGeneration }), /stale/i);
  assert.throws(() => a.put(record('one', 'Reclamation requires waiting for completion.')), /deleted|tombstone/i);
  a.restoreSnapshot(snapshot);
  a.rebuildIndex();
  assert.deepEqual(a.search('Reclamation'), []);
  assert.deepEqual(a.list(), []);
  a.close();
});

test('existing data fails closed when independent deletion authority is missing', async t => {
  const openStore = await backend(), root = fixture(t);
  const a = openStore(root, { scopeRef: 'repo-A' });
  a.put(record('one', 'The active generation is authoritative.'));
  a.close();
  const authority = join(root, 'authority.sqlite');
  assert.ok(existsSync(authority));
  unlinkSync(authority);
  assert.throws(() => openStore(root, { scopeRef: 'repo-A' }), /authority/i);
});

test('two open handles observe a deletion and reject a stale generation', async t => {
  const openStore = await backend(), root = fixture(t);
  const a = openStore(root, { scopeRef: 'repo-A' }), b = openStore(root, { scopeRef: 'repo-A' });
  a.put(record('one', 'Retired buffers must not be recalled.'));
  const generation = b.generation();
  a.forget({ id: 'one', expectedGeneration: generation });
  assert.deepEqual(b.search('buffers'), []);
  assert.throws(() => b.put(record('late', 'Retired buffers must not be recalled.'), { expectedGeneration: generation }), /stale/i);
  a.close(); b.close();
});
