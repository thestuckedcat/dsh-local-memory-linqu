import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
async function backend() {
  try { return await import('../src/backend.mjs'); }
  catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Scoped backend is not implemented'); throw e; }
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-store-'));
  const stores = [];
  t.after(() => { for (const store of stores) store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, track(store) { stores.push(store); return store; } };
}
const entry = (extra = {}) => ({ id: 'memory-1', sourceRef: 'fixture/session-A/turn-1', sourceVersion: 'commit-A/clean/debug', kind: 'lesson', text: 'DMA描述符提交后需要同步缓存，并保留设备所有权。', ...extra });
// Omitting scope from storage/FTS/export must leak fixture-A and fail this test.
test('CJK recall and management export stay inside explicit project/worktree/version scopes', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A/worktree-A/revision-A/debug' }));
  a.put(entry());
  assert.equal(a.search('同步缓存')[0].text, entry().text);
  for (const scopeRef of ['project-B/worktree-A/revision-A/debug', 'project-A/worktree-B/revision-A/debug', 'project-A/worktree-A/revision-B/debug', 'project-A/worktree-A/revision-A/release']) {
    const other = f.track(openStore(f.root, { scopeRef }));
    assert.deepEqual(other.search('同步缓存'), []);
    assert.deepEqual(other.list(), []);
    assert.deepEqual(other.exportSnapshot().records, []);
  }
  assert.equal(a.exportSnapshot().records[0].sourceVersion, 'commit-A/clean/debug');
});
test('records survive reopen without a model or network dependency', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  a.put(entry()); a.close();
  const reopened = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  assert.equal(reopened.get('memory-1').sourceRef, 'fixture/session-A/turn-1');
  assert.equal(reopened.search('DMA')[0].id, 'memory-1');
});
test('missing scope, caller scope override, and source identity overwrite fail closed', async t => {
  const { openStore } = await backend(), f = fixture(t);
  assert.throws(() => openStore(f.root, { scopeRef: '' }), /scope/i);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  assert.throws(() => a.put(entry({ scopeRef: 'project-B' })), /scope/i);
  a.put(entry());
  assert.throws(() => a.put(entry({ sourceVersion: 'commit-B' })), /identity|immutable/i);
  assert.throws(() => a.put(entry({ text: 'Contradictory replacement' })), /identity|immutable/i);
});
test('same source/version/content yields one evidence record across reopen', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  a.put(entry()); a.close();
  const b = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  const duplicate = b.put(entry({ id: 'memory-2' }));
  assert.equal(duplicate.id, 'memory-1');
  assert.equal(b.list().length, 1);
});
test('FTS operators do not widen recall and empty query never lists all records', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  a.put(entry({ text: 'Descriptor ownership follows completion.' }));
  a.put(entry({ id: 'memory-2', sourceRef: 'other', text: 'Unrelated allocator rule.' }));
  assert.deepEqual(a.search('" OR * NOT'), []);
  assert.throws(() => a.search(''), /query/i);
  assert.deepEqual(a.search('unmatchable'), []);
});
test('secret-like material and model-assigned path fields cannot enter local records', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  assert.throws(() => a.put(entry({ text: 'api_key=CANARY_SECRET_123456789' })), /secret/i);
  assert.throws(() => a.put(entry({ path: 'C:/outside' })), /field/i);
  assert.deepEqual(a.list(), []);
});
test('unknown future schema and damaged FTS do not silently fall back to raw LIKE', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  a.put(entry()); const file = a.databasePath; a.close();
  let raw = new DatabaseSync(file); raw.exec('PRAGMA user_version=999'); raw.close();
  assert.throws(() => openStore(f.root, { scopeRef: 'project-A' }), /schema/i);
  raw = new DatabaseSync(file); raw.exec('PRAGMA user_version=1; DROP TABLE memory_fts'); raw.close();
  assert.throws(() => openStore(f.root, { scopeRef: 'project-A' }), /index|FTS/i);
});
test('scope identity is deterministic and keeps worktree/revision/build distinctions', async t => {
  const { createScope } = await backend(), f = fixture(t);
  const projectRoot = join(f.root, 'repo'); mkdirSync(projectRoot);
  const args = { projectRoot, worktreeRoot: projectRoot, revision: 'commit-A+dirty-123', buildVariant: 'arm64/debug/compdb-1' };
  const first = createScope(args);
  assert.equal(createScope(args), first);
  assert.notEqual(createScope({ ...args, revision: 'commit-B' }), first);
  assert.notEqual(createScope({ ...args, buildVariant: 'arm64/release/compdb-1' }), first);
  assert.throws(() => createScope({ ...args, revision: '' }), /revision/i);
});
test('quoted credential labels in JSON snippets are rejected before persistence', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  assert.throws(() => a.put(entry({ text: '{"api_key":"CANARY_PRIVATE_987654321"}' })), /secret/i);
  assert.deepEqual(a.list(), []);
});
test('a bounded snapshot rejects overflow rather than silently dropping saved records', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const a = f.track(openStore(f.root, { scopeRef: 'project-A' }));
  for (let i = 0; i < 501; i++) a.put(entry({ id: `record-${i}`, sourceRef: `source-${i}`, text: `Descriptor fact ${i}` }));
  assert.throws(() => a.exportSnapshot(), /snapshot.*limit/i);
  assert.equal(a.get('record-500').text, 'Descriptor fact 500');
});
test('missing or rewritten index triggers and changed FTS definition are refused before writing', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const corruptions = [
    'DROP TRIGGER memory_ai',
    'DROP TRIGGER memory_ai; CREATE TRIGGER memory_ai AFTER INSERT ON records BEGIN SELECT 1; END;',
    'DROP TABLE memory_fts; CREATE VIRTUAL TABLE memory_fts USING fts5(text)',
    'CREATE TRIGGER sqlitex_extra AFTER INSERT ON records BEGIN SELECT 1; END;'
  ];
  for (let i = 0; i < corruptions.length; i++) {
    const scopeRef = `schema-case-${i}`, store = f.track(openStore(f.root, { scopeRef }));
    store.put(entry()); const path = store.databasePath; store.close();
    const raw = new DatabaseSync(path); raw.exec(corruptions[i]); raw.close();
    assert.throws(() => openStore(f.root, { scopeRef }), /schema|index|FTS/i);
  }
});
test('common prefixed and camelCase credential labels never reach storage or export', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const store = f.track(openStore(f.root, { scopeRef: 'credential-fixture' }));
  for (const label of ['client_secret','refresh_token','DATABASE_PASSWORD','AWS_SECRET_ACCESS_KEY','OPENAI_API_KEY','clientSecret','openAIAPIKey']) {
    assert.throws(() => store.put(entry({ id: label, text: JSON.stringify({ [label]: 'CANARY_PRIVATE_987654321' }) })), /secret/i, label);
  }
  assert.deepEqual(store.exportSnapshot().records, []);
});
test('ordinary assignments cannot hide a later credential assignment', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const store = f.track(openStore(f.root, { scopeRef: 'assignment-fixture' }));
  for (const text of ['foo=bar;password=CANARY_PRIVATE_987654321','https://example.invalid/path?mode=local&api_key=CANARY_PRIVATE_987654321']) {
    assert.throws(() => store.put(entry({ text })), /secret/i);
  }
  assert.deepEqual(store.exportSnapshot().records, []);
});
test('a quoted value cannot hide its own credential assignment from input filtering',async t=>{
  const {openStore}=await backend(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));
  assert.throws(()=>s.put(entry({text:'{"description":"password=CANARY_PRIVATE_987654321"}'})),/secret/i);
  assert.deepEqual(s.list(),[]);
});
test('single CJK character recall is preserved', async t => {
  const { openStore } = await backend(), f = fixture(t);
  const store = f.track(openStore(f.root, { scopeRef: 'cjk-single' }));
  store.put(entry({ text: '云' }));
  assert.equal(store.search('云')[0]?.text, '云');
});
test('UNC, device, relative and unapproved drives fail before filesystem access', async () => {
  const { checkedPath } = await import('../src/scope.mjs');
  const originalExists = fs.existsSync, originalLstat = fs.lstatSync;
  try {
    fs.existsSync = fs.lstatSync = () => { throw new Error('Filesystem should not be touched'); };
    syncBuiltinESMExports();
    for (const path of ['\\\\untrusted.invalid\\share\\memory','\\\\?\\UNC\\untrusted.invalid\\share','\\\\.\\C:\\memory','C:relative','relative/path','Z:\\unapproved-memory']) {
      assert.throws(() => checkedPath(path), /local|absolute|approved|network/i);
    }
  } finally { fs.existsSync = originalExists; fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
});
test('ancestor reparse metadata is rejected before any access below it', async t => {
  const { checkedPath } = await import('../src/scope.mjs'), f = fixture(t);
  const target = join(f.root,'target'), link = join(f.root,'junction'), child = join(link,'child');
  mkdirSync(target); mkdirSync(link);
  // Sandbox refused real junction creation with EPERM. Double only the OS metadata boundary.
  const originalExists = fs.existsSync, originalLstat = fs.lstatSync, accessed = [];
  try {
    fs.existsSync = path => { if (String(path) === child) throw new Error('Unexpected descendant I/O'); accessed.push(String(path)); return originalExists(path); };
    fs.lstatSync = (...args) => {
      const path = String(args[0]); if (path === child) throw new Error('Unexpected descendant I/O');
      accessed.push(path);
      if (path === link) return { isSymbolicLink: () => true };
      return originalLstat(...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => checkedPath(child), /link/i);
    assert.equal(accessed.includes(child), false, 'must reject the parent before touching its child');
  } finally { fs.existsSync = originalExists; fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
});
