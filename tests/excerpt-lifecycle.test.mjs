import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-excerpt-life-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, store};
}
function memory(id, text = 'Descriptor reclamation waits for completion.') {
  return {id, sourceRef: `session-A/${id}`, sourceVersion: 'v1', kind: 'lesson', text, origin: 'user'};
}
function excerptBodyCount(store, fragmentId) {
  const db = new DatabaseSync(store.databasePath, {readOnly: true});
  try { return db.prepare('SELECT count(*) AS n FROM consolidation_excerpts WHERE id=?').get(fragmentId).n; } finally { db.close(); }
}

test('explicit memory deletion purges its excerpt body and leaves unrelated excerpts readable', (t) => {
  const {store} = fixture(t);
  const first = store.put(memory('memory-1'));
  const second = store.put(memory('memory-2', 'Ownership barrier precedes reclamation.'));
  const one = store.registerExcerpt({requestId: 'excerpt-1', memoryId: first.id, expectedRecordGeneration: first.generation, sourceVersion: first.sourceVersion, fragmentRef: 'whole', text: '原始支持片段一'});
  const two = store.registerExcerpt({requestId: 'excerpt-2', memoryId: second.id, expectedRecordGeneration: second.generation, sourceVersion: second.sourceVersion, fragmentRef: 'whole', text: '原始支持片段二'});
  assert.equal(store.readExcerpt(one.fragmentId).text, '原始支持片段一');

  store.forget({id: first.id, expectedGeneration: store.generation()});
  assert.equal(store.readExcerpt(one.fragmentId), undefined);
  assert.equal(excerptBodyCount(store, one.fragmentId), 0, 'forgotten excerpt body must be cleared');
  assert.equal(store.readExcerpt(two.fragmentId).text, '原始支持片段二');
  assert.equal(excerptBodyCount(store, two.fragmentId), 1);

  assert.throws(() => store.registerExcerpt({requestId: 'excerpt-1', memoryId: first.id, expectedRecordGeneration: first.generation, sourceVersion: first.sourceVersion, fragmentRef: 'whole', text: '原始支持片段一'}), /no longer active/);
});

test('correcting a memory purges the superseded memory excerpt', (t) => {
  const {store} = fixture(t);
  const old = store.put(memory('memory-old'));
  const excerpt = store.registerExcerpt({requestId: 'excerpt-c', memoryId: old.id, expectedRecordGeneration: old.generation, sourceVersion: old.sourceVersion, fragmentRef: 'whole', text: '旧版本支持片段'});
  const corrected = store.correct({id: old.id, text: 'Descriptor reclamation requires the completion barrier.', sourceVersion: 'v2', expectedGeneration: store.generation()});
  assert.notEqual(corrected.id, old.id);
  assert.equal(store.readExcerpt(excerpt.fragmentId), undefined);
  assert.equal(excerptBodyCount(store, excerpt.fragmentId), 0);
});

test('archiving keeps the excerpt dependent but unreadable until restore', (t) => {
  const {store} = fixture(t);
  const record = store.put(memory('memory-archived'));
  const excerpt = store.registerExcerpt({requestId: 'excerpt-a', memoryId: record.id, expectedRecordGeneration: record.generation, sourceVersion: record.sourceVersion, fragmentRef: 'whole', text: '可恢复归档依据'});
  store.archive({id: record.id, expectedGeneration: store.generation()});
  assert.equal(store.readExcerpt(excerpt.fragmentId), undefined);
  assert.equal(excerptBodyCount(store, excerpt.fragmentId), 1, 'archive retains the body');
  store.restoreArchived({id: record.id, expectedGeneration: store.generation()});
  assert.equal(store.readExcerpt(excerpt.fragmentId).text, '可恢复归档依据');
});
