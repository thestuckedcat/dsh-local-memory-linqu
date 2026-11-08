import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {createConsolidationDirty} from '../src/consolidation-dirty.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-dirty-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  let ms = Date.parse('2026-11-09T00:00:00.000Z');
  const dirty = createConsolidationDirty({now: () => new Date(ms)});
  t.after(() => {
    try { store.close(); } catch { /* closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {store, dirty, advance: (delta) => { ms += delta; }};
}

test('dirty marker counts changes without storing memory text and resets cleanly', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.dirty.status(f.store), {changes: 0, firstAt: null, lastAt: null, scopeRef: 'A'});
  f.dirty.noteChange(f.store, {count: 3});
  f.advance(1000);
  f.dirty.noteChange(f.store);
  const status = f.dirty.status(f.store);
  assert.equal(status.changes, 4);
  assert.equal(status.scopeRef, 'A');
  assert.ok(Date.parse(status.firstAt) <= Date.parse(status.lastAt));
  const file = join(dirname(f.store.databasePath), 'consolidation-dirty.json');
  const raw = readFileSync(file, 'utf8');
  assert.match(raw, /"changes": 4/);
  assert.doesNotMatch(raw, /Descriptor|memory|text/i);
  assert.equal(f.dirty.reset(f.store).changes, 0);
  assert.equal(f.dirty.status(f.store).changes, 0);
});

test('due uses the change threshold or the maximum wait window', (t) => {
  const f = fixture(t);
  f.dirty.noteChange(f.store, {count: 2});
  assert.equal(f.dirty.due(f.store, {threshold: 2, maxWaitMs: 3600_000}).due, true);
  assert.equal(f.dirty.due(f.store, {threshold: 10, maxWaitMs: 3600_000}).reason, 'waiting');
  f.advance(3600_000);
  const due = f.dirty.due(f.store, {threshold: 10, maxWaitMs: 3600_000});
  assert.equal(due.due, true);
  assert.equal(due.reason, 'max_wait');
});

test('a corrupt dirty marker fails closed and never claims work is due', (t) => {
  const f = fixture(t);
  const file = join(dirname(f.store.databasePath), 'consolidation-dirty.json');
  writeFileSync(file, '{not json', 'utf8');
  assert.throws(() => f.dirty.status(f.store), /corrupt|invalid/i);
  assert.throws(() => f.dirty.due(f.store), /corrupt|invalid/i);
});
