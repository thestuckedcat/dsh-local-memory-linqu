import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openStore} from '../src/backend.mjs';
import {contextOf} from '../src/store-internals.mjs';
import {createCorrectionManager, detectCorrectionIntent} from '../plugin/correction.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {authorizeTestExecution, extraction, job, routeA} from './helpers.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-correction-'));
  const store = openStore(join(root, 'scope'), {scopeRef: 'A'});
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 50});
  });
  return {root, store};
}
function memory(store, id = 'memory-1') {
  return store.put({id, sourceRef: 'session-A/turn-1', sourceVersion: 'v1', kind: 'lesson', text: 'Descriptor reclamation waits for completion.', origin: 'user'});
}
function attributionFor(record) {
  return {latestCited: () => ({turn: 2, records: [record]})};
}

test('correction intent is narrow and does not fire on ordinary discussion', () => {
  for (const text of ['这里已经改了', '上次理解错了', '不是这样，正确的是 completion barrier。', 'That is wrong; the barrier is required.', 'correction: ownership precedes reclamation']) {
    assert.equal(detectCorrectionIntent(text), true, text);
  }
  for (const text of ['请解释 descriptor reclamation', '这个设计看起来如何？', 'Maybe we should discuss the barrier.', '']) {
    assert.equal(detectCorrectionIntent(text), false, text);
  }
});

test('an explicit correction suspends only the cited memory and purges its excerpt', (t) => {
  const {store} = fixture(t);
  const record = memory(store);
  const excerpt = store.registerExcerpt({requestId: 'excerpt-correction', memoryId: record.id, expectedRecordGeneration: record.generation, sourceVersion: record.sourceVersion, fragmentRef: 'whole', text: 'original support'});
  const correction = createCorrectionManager({attribution: attributionFor({id: record.id, ref: '记1', generation: record.generation, scopeRef: 'A'})});
  const enqueued = [];
  const result = correction.onMessageAdmitted({candidate: {input: '这里已经改了：需要 completion barrier。', id: 'msg-1'}, session: {id: 'session-1'}, binding: {store, queue: {enqueue: (args) => enqueued.push(args)}, scopeRef: 'A', sessionRef: 'session-ref', routeRef: 'registered-A'}, sourceRef: 'session-A/event/1/message/abc', sourceVersion: 'version-A'});
  assert.equal(result.state, 'corrected');
  assert.equal(result.suspended, 1);
  assert.equal(result.enqueued, true);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].purpose, 'memory_extract');
  assert.equal(enqueued[0].generation, store.generation(), 'the new extraction job must use the post-suspension epoch');
  assert.deepEqual(correction.status(), {detected: 1, applied: 1, unresolved: 0, failed: 0, suspended: 1});
  const entry = contextOf(store).db.prepare("SELECT state FROM ledger.entries WHERE scope_ref='A' AND collection='memories' AND id=?").get(record.id);
  assert.equal(entry.state, 'stale');
  assert.deepEqual(store.list({limit: 10}), []);
  assert.deepEqual(store.search('descriptor reclamation'), []);
  assert.equal(store.readExcerpt(excerpt.fragmentId), undefined);
  assert.throws(() => store.suspendForCorrection({id: record.id, expectedGeneration: store.generation()}), /not active/i);
});

test('a correction without a cited memory or with another session is not applied', (t) => {
  const {store} = fixture(t);
  memory(store);
  const correction = createCorrectionManager({attribution: {latestCited: () => undefined}});
  const result = correction.onMessageAdmitted({candidate: {input: '上次理解错了'}, session: {id: 'session-1'}, binding: {store}});
  assert.equal(result.state, 'unresolved');
  assert.equal(result.reason, 'no_cited_memory');
  assert.deepEqual(correction.status(), {detected: 1, applied: 0, unresolved: 1, failed: 0, suspended: 0});
  assert.equal(store.list({limit: 10}).length, 1);
  const ordinary = correction.onMessageAdmitted({candidate: {input: '请解释这个设计'}, session: {id: 'session-1'}, binding: {store}});
  assert.equal(ordinary.state, 'none');
});

test('correction re-extraction is accepted by the real job queue identity checks', (t) => {
  const {store} = fixture(t);
  const record = memory(store);
  const provider = createControlledProvider({resolveRoute: () => routeA, invoke: async () => extraction()});
  const queue = createJobQueue(store, {provider, authorizeExecution: authorizeTestExecution});
  queue.enqueue({...job(store), sourceRef: 'session-A/event/1/message/abc', sourceVersion: 'version-A'});
  const correction = createCorrectionManager({attribution: attributionFor({id: record.id, ref: '记1', generation: record.generation, scopeRef: 'A'})});
  const result = correction.onMessageAdmitted({
    candidate: {input: '这里已经改了：需要 completion barrier。', id: 'msg-correction'},
    session: {id: 'session-1'},
    binding: {store, queue, scopeRef: 'A', sessionRef: 'session-ref', routeRef: 'registered-A'},
    sourceRef: 'session-A/event/1/message/abc',
    sourceVersion: 'version-A',
  });
  assert.equal(result.state, 'corrected');
  assert.equal(result.enqueued, true, 'the correction extraction must not be rejected by source identity');
  const count = contextOf(store).db.prepare("SELECT count(*) AS n FROM ledger.jobs WHERE scope_ref='A' AND purpose='memory_extract'").get().n;
  assert.equal(count, 2);
});
