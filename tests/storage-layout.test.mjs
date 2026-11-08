import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {planLayout, validateLocalRoot} from '../src/storage-layout.mjs';
import {createColdJournal} from '../src/cold-archive.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-layout-'));
  t.after(() => rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}));
  return root;
}

test('layout plans the same-volume hot/cold/authority/staging/reports tree', () => {
  const layout = planLayout('E:/dsh-data/05-local-memory/default');
  assert.equal(layout.root, 'E:\\dsh-data\\05-local-memory\\default');
  assert.equal(layout.hot, join(layout.root, 'hot'));
  assert.equal(layout.cold, join(layout.root, 'cold'));
  assert.equal(layout.authority, join(layout.root, 'authority'));
  assert.equal(layout.staging, join(layout.root, 'staging'));
  assert.equal(layout.reports, join(layout.root, 'reports'));
  assert.equal(layout.coldJournal, join(layout.root, 'cold', 'journal'));
  assert.throws(() => planLayout(' '), /root required/i);
});

test('production root rejects C, relative, UNC, source-tree and missing paths; the test allowC exception is explicit', (t) => {
  const root = fixture(t);
  const platform = 'win32';
  assert.equal(validateLocalRoot(root, {platform, allowC: true, volumeProbe: () => ({type: 'fixed'})}).volumeType, 'fixed');
  assert.throws(() => validateLocalRoot(root, {platform, allowC: false}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot('relative/path', {platform}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot('\\\\server\\share\\memory', {platform}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot(root, {platform, allowC: true, sourceRoot: root}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot(join(root, 'missing'), {platform, allowC: true}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot(root, {platform, allowC: true, volumeProbe: () => ({type: 'network'})}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot(root, {platform, allowC: true, volumeProbe: () => ({type: 'removable'})}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  assert.throws(() => validateLocalRoot(root, {platform, allowC: true, requireVolumeType: true}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
  // A path whose own lstat reports a symlink is rejected before any data operation.
  assert.throws(() => validateLocalRoot(root, {platform, allowC: true, lstat: () => ({isDirectory: () => true, isSymbolicLink: () => true})}), (error) => error.code === 'MEM_LAYOUT_REJECTED');
});

test('cold journal records only metadata, enforces prepared→copied→index→cleaned, and fails closed on tamper', (t) => {
  const root = fixture(t);
  const journal = createColdJournal({root});
  const sourceDigest = 'a'.repeat(64);
  const prepared = journal.begin({id: 'scope-A-cold-1', scopeRef: 'A', sourceDigest, size: 4096});
  assert.equal(prepared.state, 'prepared');
  assert.equal(prepared.payloadDigest, null);
  assert.throws(() => journal.begin({id: 'scope-A-cold-1', scopeRef: 'A', sourceDigest, size: 4096}), /already exists/i);
  assert.throws(() => journal.advance({id: 'scope-A-cold-1', state: 'index_switched'}), /cannot move/i);
  const copied = journal.advance({id: 'scope-A-cold-1', state: 'copied_verified', payloadDigest: 'b'.repeat(64)});
  assert.equal(copied.state, 'copied_verified');
  assert.equal(copied.payloadDigest, 'b'.repeat(64));
  journal.advance({id: 'scope-A-cold-1', state: 'index_switched'});
  const cleaned = journal.advance({id: 'scope-A-cold-1', state: 'source_cleaned'});
  assert.equal(cleaned.state, 'source_cleaned');
  assert.deepEqual(journal.recover().entries.map((entry) => entry.state), ['source_cleaned']);

  const file = join(planLayout(root).coldJournal, 'scope-A-cold-1.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.size = 999;
  writeFileSync(file, JSON.stringify(raw), 'utf8');
  const recovered = journal.recover();
  assert.equal(recovered.entries.length, 0);
  assert.deepEqual(recovered.corrupt, ['scope-A-cold-1.json']);
  assert.throws(() => journal.read('scope-A-cold-1'), /digest/i);
});

test('cold journal rejects unsafe ids and malformed metadata', (t) => {
  const root = fixture(t);
  const journal = createColdJournal({root});
  for (const id of ['../escape', 'bad/id', '', 'x'.repeat(65)]) {
    assert.throws(() => journal.begin({id, scopeRef: 'A', sourceDigest: 'a'.repeat(64), size: 1}));
  }
  assert.throws(() => journal.begin({id: 'ok', scopeRef: 'A', sourceDigest: 'short', size: 1}), /digest/i);
  assert.throws(() => journal.begin({id: 'ok', scopeRef: 'A', sourceDigest: 'a'.repeat(64), size: -1}), /size/i);
  mkdirSync(planLayout(root).coldJournal, {recursive: true});
  assert.deepEqual(journal.recover().entries, []);
});
