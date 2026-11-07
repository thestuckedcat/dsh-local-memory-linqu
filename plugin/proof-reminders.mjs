/**
 * Dialogue proof reminders (MEM-402).
 *
 * Registers its own `agent/pre-step` waterfall listener, always calls `next()` first, and then
 * appends at most one short user-message reminder when the current bound project has active work
 * records whose claims still miss evidence or confirmation. Dedupe state is persisted in the
 * catalog `reminders` table via `(scopeRef, recordId, claimRef, recordGeneration)`; the default
 * cooldown is 24h and `reminder.defer` / `reminder.disable` (management operations) write the same
 * state. Every failure is contained and reported through `onDiagnostic`; a reminder failure can
 * never abort or alter the main chat request.
 */
import {randomUUID} from 'node:crypto';
import {checkedText, digest} from '../src/scope.mjs';
import {shape, integer} from '../src/validation.mjs';
import {contextOf, entryState} from '../src/store-internals.mjs';
import {createCatalogReminders, REMINDER_CLAIM_LABELS} from '../src/reports.mjs';

const PLUGIN = '@local/dsh-controlled-memory';
const PREFIX = '[本地记忆缺证提醒]';
const DEFAULT_COOLDOWN_HOURS = 24;
const MAX_RECORDS = 3;
const MAX_TITLE_CHARS = 60;
const MESSAGE_LIMIT = 480;
const REMINDABLE_CLAIMS = Object.freeze(Object.keys(REMINDER_CLAIM_LABELS));

function frozen(value) {
  return Object.freeze(value);
}

/**
 * @param {object} ctx Host context (`on`, `effect`, `sessions.get`, optional `agents.get`).
 * @param {{registry: object, config: object, sessions: object,
 *          createUserMessage: Function, onDiagnostic?: Function, now?: () => Date}} deps
 */
export function installProofReminders(ctx, deps = {}) {
  if (!ctx || typeof ctx !== 'object' || typeof ctx.on !== 'function' || typeof ctx.effect !== 'function') throw new Error('Trusted Host context required for proof reminders');
  const options = deps && typeof deps === 'object' ? deps : {};
  const {registry, config, sessions, createUserMessage, onDiagnostic = () => {}} = options;
  const now = typeof options.now === 'function' ? options.now : () => new Date();
  if (!registry || typeof registry.storeFor !== 'function' || typeof registry.bindingForSession !== 'function' || typeof registry.getProject !== 'function') throw new Error('Trusted project registry required for proof reminders');
  if (!config || typeof config !== 'object') throw new Error('Normalized configuration required for proof reminders');
  if (!sessions || typeof sessions.get !== 'function') throw new Error('Trusted session service required for proof reminders');
  if (typeof createUserMessage !== 'function' || typeof onDiagnostic !== 'function') throw new Error('Trusted message factory required for proof reminders');
  if (!registry.catalog?.db) throw new Error('Project catalog required for proof reminders');
  const reminders = createCatalogReminders(registry.catalog);
  const cooldownHours = integer(config.reminders?.cooldownHours ?? DEFAULT_COOLDOWN_HOURS, 1, 720, 'reminder cooldown');
  const maxItems = integer(config.reminders?.maxItems ?? MAX_RECORDS, 1, MAX_RECORDS, 'reminder item limit');
  const activation = randomUUID();
  let state = 'active';
  let disposer;
  let effects = [];
  const stats = {remindersShown: 0, failures: 0, lastShownAt: null, lastFailure: null};

  function diagnostic(code) {
    try {
      const value = onDiagnostic(frozen({code}));
      if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
    } catch { /* diagnostics never affect the main request */ }
  }
  function fail(code) {
    stats.failures++;
    stats.lastFailure = code;
    diagnostic(code);
  }
  function nowIso() {
    const value = now();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('Invalid reminder clock');
    return date.toISOString();
  }
  function sessionOf(payload) {
    const agent = payload?.agent;
    const session = agent?.session;
    if (!agent || !session || typeof session.id !== 'string') return undefined;
    if (ctx.agents?.get && ctx.agents.get(agent.id) !== agent) return undefined;
    if (ctx.sessions?.get && ctx.sessions.get(session.id) !== session) return undefined;
    if (sessions.get(session.id) !== session) return undefined;
    return {agent, session};
  }
  function storeOf(scopeRef) {
    const store = registry.storeFor(scopeRef);
    if (!store || typeof store.generation !== 'function') throw new Error('Work record store is unavailable');
    return store;
  }
  /**
   * Read the PERSISTED pendingEvidence/pendingConfirmation of active work records only. This never
   * reads evidence files: an automatically installed reminder must not re-validate (or demote)
   * previously reviewed proof support, and it must not depend on user authorization. The ledger
   * generation/body digest is re-checked so tombstoned or rewritten records never remind.
   */
  function persistedPendingRecords(store) {
    const ctx = contextOf(store);
    const scopeRef = store.scopeRef;
    const rows = ctx.db.prepare("SELECT w.id,w.payload,w.generation FROM work_summaries w JOIN ledger.entries e ON e.scope_ref=w.scope_ref AND e.collection='work_summaries' AND e.id=w.id AND e.state='active' WHERE w.scope_ref=? ORDER BY w.generation,w.id LIMIT 200").all(scopeRef);
    const records = [];
    for (const row of rows) {
      const entry = entryState(ctx, 'work_summaries', row.id);
      if (!entry || entry.state !== 'active' || entry.generation !== row.generation) continue;
      if (digest(row.payload) !== entry.body_digest) continue;
      let body;
      try { body = JSON.parse(row.payload); } catch { continue; }
      if (!body || body.id !== row.id || body.scopeRef !== scopeRef) continue;
      records.push(body);
    }
    return records;
  }
  function pendingClaims(row) {
    const evidence = (row.pendingEvidence ?? []).filter((claimRef) => REMINDABLE_CLAIMS.includes(claimRef));
    const confirmation = (row.pendingConfirmation ?? []).filter((claimRef) => REMINDABLE_CLAIMS.includes(claimRef));
    const claims = [];
    for (const claimRef of evidence) claims.push({claimRef, missing: true});
    for (const claimRef of confirmation) if (!claims.some((entry) => entry.claimRef === claimRef)) claims.push({claimRef, missing: false});
    return claims;
  }
  function renderReminder(selected) {
    const parts = selected.map((entry) => {
      const title = entry.title.length > MAX_TITLE_CHARS ? `${entry.title.slice(0, MAX_TITLE_CHARS - 1)}…` : entry.title;
      const missing = entry.claims.filter((claim) => claim.missing).map((claim) => REMINDER_CLAIM_LABELS[claim.claimRef]);
      const pending = entry.claims.filter((claim) => !claim.missing).map((claim) => REMINDER_CLAIM_LABELS[claim.claimRef]);
      const detail = [];
      if (missing.length) detail.push(`缺证：${missing.join('、')}`);
      if (pending.length) detail.push(`待确认：${pending.join('、')}`);
      return `${title}（${detail.join('；')}）`;
    });
    let text = `${PREFIX} 有 ${selected.length} 项工作记录仍缺证明或待确认：${parts.join('；')}。可在记忆中心补充证明引用，或延后/关闭本提醒；本提醒不改变记录的事实状态。`;
    if (text.length > MESSAGE_LIMIT) text = `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
    return text;
  }
  async function createReminderMessage(text, selected) {
    const source = {
      kind: 'memory-proof-reminder',
      plugin: PLUGIN,
      activation,
      records: selected.map((entry) => ({
        id: entry.id,
        generation: entry.generation,
        claimRefs: entry.claims.map((claim) => claim.claimRef),
      })),
    };
    let generated = createUserMessage({content: [{type: 'text', text}], source});
    if (generated && typeof generated.then === 'function') generated = await generated;
    shape(generated, ['id', 'role', 'content', 'source'], 'proof reminder message');
    if (generated.role !== 'user') throw new Error('Proof reminder message must be a user message');
    const id = checkedText(generated.id, 'proof reminder message id', 512);
    if (!Array.isArray(generated.content) || generated.content.length < 1 || !generated.content.every((block) => block?.type === 'text' && typeof block.text === 'string')) throw new Error('Invalid proof reminder content');
    return {id, role: 'user', content: [{type: 'text', text}], source: generated.source};
  }
  async function appendReminder(payload, decision) {
    if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision;
    if (payload?.signal?.aborted) return decision;
    const identity = sessionOf(payload);
    if (!identity) return decision;
    let binding;
    try {
      binding = registry.bindingForSession(identity.session);
    } catch {
      return decision;
    }
    if (!binding?.scopeRef || !binding.projectId) return decision;
    let project;
    try {
      project = registry.getProject(binding.projectId);
    } catch {
      return decision;
    }
    if (!project || project.state !== 'active') return decision;
    if (config.reminders?.enabled === false) return decision;
    let projectEnabled;
    try {
      projectEnabled = reminders.projectRemindersEnabled(project.projectId);
    } catch {
      return decision;
    }
    if (projectEnabled !== true) return decision;
    const store = storeOf(binding.scopeRef);
    let rows;
    try {
      rows = persistedPendingRecords(store);
    } catch {
      return decision;
    }
    const candidates = [];
    for (const row of rows) {
      const claims = pendingClaims(row);
      if (!claims.length) continue;
      candidates.push({row, claims});
    }
    if (!candidates.length) return decision;
    const at = nowIso();
    const due = [];
    for (const candidate of candidates) {
      const dueClaims = [];
      for (const claim of candidate.claims) {
        let result;
        try {
          result = reminders.reminderDue({
            scopeRef: binding.scopeRef,
            recordId: candidate.row.id,
            claimRef: claim.claimRef,
            recordGeneration: candidate.row.generation,
            now: () => new Date(at),
          });
        } catch {
          continue;
        }
        if (result?.due === true) dueClaims.push(claim);
      }
      if (dueClaims.length) due.push({...candidate, claims: dueClaims});
      if (due.length >= maxItems) break;
    }
    if (!due.length) return decision;
    const text = renderReminder(due.map((entry) => ({title: entry.row.title, claims: entry.claims})));
    const message = await createReminderMessage(text, due.map((entry) => ({id: entry.row.id, generation: entry.row.generation, claims: entry.claims})));
    for (const entry of due) {
      for (const claim of entry.claims) {
        try {
          reminders.markShown({
            scopeRef: binding.scopeRef,
            recordId: entry.row.id,
            claimRef: claim.claimRef,
            recordGeneration: entry.row.generation,
            cooldownHours,
            now: () => new Date(at),
          });
        } catch { /* dedupe state failure never repeats the reminder in this request */ }
      }
    }
    stats.remindersShown++;
    stats.lastShownAt = at;
    return {...decision, messages: [...decision.messages, message]};
  }
  async function onPreStep(payload, next) {
    const decision = await next();
    if (state !== 'active') return decision;
    try {
      return await appendReminder(payload, decision);
    } catch {
      fail('proof_reminder_failed');
      return decision;
    }
  }
  function status() {
    return frozen({
      state,
      installed: state === 'active',
      remindersShown: stats.remindersShown,
      failures: stats.failures,
      lastShownAt: stats.lastShownAt,
      lastFailure: stats.lastFailure,
      cooldownHours,
      maxItems,
    });
  }
  function dispose() {
    if (state !== 'disposed') {
      state = 'disposed';
      if (typeof disposer === 'function') { try { disposer(); } catch { /* local cleanup only */ } }
      for (const cleanup of effects.splice(0)) { try { cleanup(); } catch { /* local cleanup only */ } }
    }
  }
  try {
    disposer = ctx.on('agent/pre-step', onPreStep);
    const effect = ctx.effect(() => () => dispose(), 'controlled-memory: dispose proof reminders');
    if (typeof effect === 'function') effects.push(effect);
  } catch {
    state = 'disposed';
    try { if (typeof disposer === 'function') disposer(); } catch { /* local cleanup only */ }
    throw new Error('Proof reminders could not be registered');
  }
  return Object.freeze({dispose, status});
}
