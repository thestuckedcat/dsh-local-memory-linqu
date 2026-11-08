import {randomUUID} from 'node:crypto';
import {checkedText} from './scope.mjs';
import {canonical, fingerprint, integer, shape} from './validation.mjs';
import {assertAuthority, contextOf, write} from './store-internals.mjs';

/**
 * Local consolidation queue (MC-API-05 partial).
 *
 * This increment persists the queued job, its pinned manifest and its bounded InputSnapshot, and
 * implements idempotent enqueue/pending/get/list/cancel/recover. It deliberately has NO provider
 * execution: runJob/candidate publication arrive in a later increment. No model is called here.
 *
 * The queue never scans history or sources: the caller supplies the explicit memory selection and
 * trusted route. The manifest/permission layer rechecks all pins before the job row is written.
 */
const STATES = Object.freeze(['queued', 'running', 'ready', 'published', 'discarded', 'cancelled', 'failed', 'stale', 'outcome_unknown']);
const TERMINAL = new Set(['published', 'discarded', 'cancelled', 'failed', 'stale', 'outcome_unknown']);
const MAX_PENDING = 2;

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function dayOf(date) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).format(date);
}
function jobView(row) {
  if (!row) return undefined;
  return Object.freeze({
    jobId: row.id,
    state: row.state,
    reason: row.reason ?? undefined,
    candidateId: row.candidate_id ?? undefined,
    costStatus: row.cost_status,
    expectedEpoch: row.epoch,
    expectedScopeRevision: row.scope_revision,
    headRevision: row.base_head_revision,
    manifestDigest: row.manifest_digest,
    permissionId: row.permission_id,
    createdAt: row.created_at,
  });
}

export function createConsolidationQueue(store, {inputs, now = () => new Date(), maxOutputTokens = 1024, budgetDay} = {}) {
  if (!store || typeof store.scopeRef !== 'string') throw failure('MC_QUEUE_UNAVAILABLE', 'memory store required');
  if (!inputs || typeof inputs.snapshot !== 'function' || typeof inputs.authorizeBatch !== 'function') throw failure('MC_QUEUE_UNAVAILABLE', 'consolidation inputs required');
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 128 || maxOutputTokens > 2048) throw failure('MC_QUEUE_UNAVAILABLE', 'invalid output token bound');
  const ctx = contextOf(store);
  function clock() {
    try {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(+date)) throw new Error('clock');
      return date;
    } catch {
      return new Date();
    }
  }
  function currentHead() {
    const row = ctx.db.prepare('SELECT revision FROM ledger.consolidation_head WHERE scope_ref=?').get(store.scopeRef);
    return row ? row.revision : 0;
  }
  function fingerprintOf(selection, expected) {
    return fingerprint({selection: {memoryIds: selection.memoryIds, excerptIds: selection.excerptIds ?? [], mode: selection.mode}, expectedEpoch: expected.expectedEpoch, expectedScopeRevision: expected.expectedScopeRevision, expectedHeadRevision: expected.expectedHeadRevision});
  }
  function operationRow(requestId) {
    return ctx.db.prepare('SELECT * FROM ledger.consolidation_operations WHERE scope_ref=? AND request_id=?').get(store.scopeRef, requestId);
  }
  function pendingCount() {
    return ctx.db.prepare("SELECT count(*) AS n FROM ledger.consolidation_jobs WHERE scope_ref=? AND state='queued'").get(store.scopeRef).n;
  }
  function enqueue({requestId, selection, expectedEpoch, expectedScopeRevision, expectedHeadRevision, route} = {}) {
    assertAuthority(ctx);
    const request = checkedText(requestId, 'request id', 256);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) throw failure('MC_SELECTION_INVALID');
    shape(selection, ['memoryIds', 'excerptIds', 'mode'], 'consolidation selection');
    if (selection.excerptIds !== undefined && (!Array.isArray(selection.excerptIds) || selection.excerptIds.length > 0)) throw failure('MC_EXCERPTS_NOT_READY');
    const memoryIds = Array.isArray(selection.memoryIds) ? selection.memoryIds : [];
    const expected = {
      expectedEpoch: integer(expectedEpoch, 0, Number.MAX_SAFE_INTEGER, 'expected epoch'),
      expectedScopeRevision: integer(expectedScopeRevision, 0, Number.MAX_SAFE_INTEGER, 'expected revision'),
      expectedHeadRevision: integer(expectedHeadRevision, 0, Number.MAX_SAFE_INTEGER, 'expected head revision'),
    };
    const callerPayload = fingerprintOf({memoryIds, excerptIds: [], mode: selection.mode}, expected);
    return write(ctx, () => {
      const previous = operationRow(request);
      if (previous) {
        if (previous.fingerprint !== callerPayload) throw failure('OPERATION_CONFLICT', 'the same request id has a different consolidation payload');
        const result = JSON.parse(previous.result_json);
        const existing = ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND id=?').get(store.scopeRef, result.jobId);
        if (!existing) throw failure('MC_QUEUE_UNAVAILABLE', 'replayed operation has no job');
        return jobView(existing);
      }
      if (pendingCount() >= MAX_PENDING) throw failure('MC_QUEUE_FULL', 'too many pending consolidation jobs for this scope');
      if (expected.expectedEpoch !== store.generation()) throw failure('MC_EPOCH_CHANGED', 'store epoch changed before enqueue');
      if (expected.expectedScopeRevision !== store.revision()) throw failure('MC_REVISION_CHANGED', 'store revision changed before enqueue');
      if (expected.expectedHeadRevision !== currentHead()) throw failure('MC_HEAD_CHANGED', 'consolidation head changed before enqueue');
      const jobId = `mc-job:${randomUUID()}`;
      const permissionId = `mc-permission:${randomUUID()}`;
      const snapshot = inputs.snapshot({jobId, permissionId, memoryIds, mode: selection.mode ?? 'memory_only', route, baseHeadRevision: expected.expectedHeadRevision});
      const permission = inputs.authorizeBatch({manifest: snapshot.manifest, requestId: request, actor: 'user'});
      if (pendingCount() + (ctx.db.prepare("SELECT count(*) AS n FROM ledger.consolidation_jobs WHERE scope_ref=? AND state='running'").get(store.scopeRef).n) >= MAX_PENDING) throw failure('MC_QUEUE_FULL');
      const at = clock();
      const inputJson = canonical(snapshot.input);
      const manifestJson = canonical(snapshot.manifest);
      ctx.db.prepare(`INSERT INTO consolidation_inputs(job_id,payload,digest) VALUES(?,?,?)`).run(jobId, inputJson, snapshot.manifest.inputDigest);
      ctx.db.prepare(`INSERT INTO ledger.consolidation_jobs(id,scope_ref,request_id,fingerprint,state,epoch,scope_revision,base_head_revision,manifest_digest,manifest_json,route_json,policy_digest,policy_revision,permission_id,budget_day,input_chars,max_tokens,run_token,cost_status,candidate_id,reason,invalidated_at,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        jobId, store.scopeRef, request, snapshot.manifest.manifestDigest, 'queued', snapshot.manifest.epoch, snapshot.manifest.scopeRevision,
        snapshot.manifest.baseHeadRevision, snapshot.manifest.manifestDigest, manifestJson, canonical(snapshot.manifest.route),
        fingerprint({policyRevision: snapshot.manifest.policyRevision, configDigest: snapshot.manifest.configDigest}), snapshot.manifest.policyRevision,
        permission.permissionId, budgetDay ?? dayOf(at), snapshot.inputChars, maxOutputTokens, null, 'not_dispatched', null, null, null,
        at.toISOString(), at.toISOString(),
      );
      const result = {jobId, permissionId: permission.permissionId, state: 'queued', manifestDigest: snapshot.manifest.manifestDigest};
      ctx.db.prepare('INSERT INTO ledger.consolidation_operations(scope_ref,request_id,fingerprint,result_json) VALUES(?,?,?,?)').run(store.scopeRef, request, callerPayload, canonical(result));
      return jobView(ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND id=?').get(store.scopeRef, jobId));
    });
  }
  function get(jobId) {
    assertAuthority(ctx);
    const id = checkedText(jobId, 'job id', 128);
    return jobView(ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND id=?').get(store.scopeRef, id));
  }
  function pending({limit = MAX_PENDING} = {}) {
    assertAuthority(ctx);
    const count = integer(limit, 1, MAX_PENDING, 'pending limit');
    return Object.freeze(ctx.db.prepare("SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND state='queued' ORDER BY created_at,id LIMIT ?").all(store.scopeRef, count).map(jobView));
  }
  function list({state, limit = 20, cursor} = {}) {
    assertAuthority(ctx);
    const count = integer(limit, 1, 25, 'list limit');
    if (state !== undefined && !STATES.includes(state)) throw failure('MC_QUEUE_INVALID', 'unknown job state');
    const offset = cursor === undefined ? 0 : integer(Number(cursor), 0, 500, 'cursor');
    const rows = state === undefined
      ? ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? ORDER BY created_at,id LIMIT ? OFFSET ?').all(store.scopeRef, count, offset)
      : ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND state=? ORDER BY created_at,id LIMIT ? OFFSET ?').all(store.scopeRef, state, count, offset);
    return Object.freeze({items: Object.freeze(rows.map(jobView)), nextCursor: rows.length === count ? offset + count : undefined});
  }
  function cancel({requestId, jobId, expectedEpoch} = {}) {
    assertAuthority(ctx);
    const request = checkedText(requestId, 'request id', 256);
    const id = checkedText(jobId, 'job id', 128);
    const epoch = integer(expectedEpoch, 0, Number.MAX_SAFE_INTEGER, 'expected epoch');
    return write(ctx, () => {
      const row = ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND id=?').get(store.scopeRef, id);
      if (!row) throw failure('MC_JOB_NOT_FOUND');
      if (row.state === 'cancelled') return jobView(row);
      if (TERMINAL.has(row.state)) throw failure('MC_JOB_TERMINAL', 'job is already terminal');
      if (row.epoch !== epoch) throw failure('MC_EPOCH_CHANGED', 'job epoch changed');
      ctx.db.prepare("UPDATE ledger.consolidation_jobs SET state='cancelled',reason='cancelled',updated_at=? WHERE scope_ref=? AND id=?").run(clock().toISOString(), store.scopeRef, id);
      ctx.db.prepare('DELETE FROM consolidation_inputs WHERE job_id=?').run(id);
      return jobView(ctx.db.prepare('SELECT * FROM ledger.consolidation_jobs WHERE scope_ref=? AND id=?').get(store.scopeRef, id));
    });
  }
  function recoverInterrupted() {
    assertAuthority(ctx);
    return write(ctx, () => {
      const rows = ctx.db.prepare("SELECT id FROM ledger.consolidation_jobs WHERE scope_ref=? AND state='running'").all(store.scopeRef);
      const at = clock().toISOString();
      for (const row of rows) {
        ctx.db.prepare("UPDATE ledger.consolidation_jobs SET state='outcome_unknown',reason='recovered_unknown',updated_at=? WHERE scope_ref=? AND id=?").run(at, store.scopeRef, row.id);
        ctx.db.prepare('DELETE FROM consolidation_inputs WHERE job_id=?').run(row.id);
      }
      return rows.length;
    });
  }
  return Object.freeze({enqueue, pending, get, list, cancel, recoverInterrupted});
}
