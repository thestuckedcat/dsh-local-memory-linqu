import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/backend.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {openProjectCatalog} from '../src/projects.mjs';
import {digest} from '../src/scope.mjs';
import {createCatalogReminders} from '../src/reports.mjs';
import {installProofReminders} from '../plugin/proof-reminders.mjs';

const SESSION = Object.freeze({id: 'session-1', header: {cwd: 'E:/code/example'}});
const AGENT = Object.freeze({id: 'session-1', session: SESSION});

function hostContext(overrides = {}) {
  const handlers = new Map();
  const effects = [];
  const ctx = {
    root: {},
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(listener);
      return () => {
        const list = handlers.get(event);
        if (!list) return;
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(fn) {
      effects.push(fn);
      return () => {};
    },
    sessions: {get: (id) => (id === SESSION.id ? SESSION : undefined)},
    agents: {get: (id) => (id === AGENT.id ? AGENT : undefined)},
    ...overrides,
  };
  return {ctx, handlers, effects};
}

function fixture(t, {configReminders = {enabled: true, cooldownHours: 24, maxItems: 3}} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-reminders-'));
  const dataRoot = join(root, 'data');
  mkdirSync(dataRoot, {recursive: true});
  const catalog = openProjectCatalog(join(dataRoot, 'catalog.sqlite'), {identityPath: join(dataRoot, 'catalog.identity.json')});
  const repoDir = join(root, 'repos', 'alpha');
  mkdirSync(repoDir, {recursive: true});
  const project = catalog.registerProject({
    name: 'alpha',
    repositories: [{repoId: 'main-0', canonicalRoot: repoDir, worktreeRoot: repoDir, revision: 'workspace', buildVariant: 'test', scopeRef: 'workspace-v1:alpha'}],
  });
  const store = openStore(join(root, 'hot', digest('workspace-v1:alpha')), {scopeRef: 'workspace-v1:alpha'});
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try { catalog.close(); } catch { /* already closed */ }
    rmSync(root, {recursive: true, force: true});
  });
  const binding = Object.freeze({projectId: project.projectId, repoId: 'main-0', scopeRef: 'workspace-v1:alpha', projectRevision: 1, bindingRevision: 1});
  const registry = {
    catalog,
    getProject: (projectId) => (projectId === project.projectId ? project : undefined),
    bindingForSession: (session) => (session?.id === SESSION.id ? binding : undefined),
    storeFor: (scopeRef) => {
      if (scopeRef !== 'workspace-v1:alpha') throw new Error('scope is not registered');
      return store;
    },
  };
  const config = {
    dataRoot,
    profile: 'default',
    workSummary: {enabled: true, routeRef: 'memory-default', evidenceRoots: []},
    reminders: configReminders,
  };
  const clock = {value: new Date('2026-01-15T03:00:00.000Z')};
  const ctx = hostContext();
  const diagnostics = [];
  const created = [];
  const sessions = {get: ctx.ctx.sessions.get};
  const createUserMessage = (args) => {
    const message = {id: `reminder-${created.length + 1}`, role: 'user', content: args.content, source: args.source};
    created.push(message);
    return message;
  };
  return {
    root, dataRoot, catalog, project, store, registry, config, binding,
    ctx: ctx.ctx, handlers: ctx.handlers,
    clock, diagnostics, created,
    setNow(iso) { clock.value = new Date(iso); },
    install(overrides = {}) {
      return installProofReminders(ctx.ctx, {
        registry,
        config,
        sessions,
        createUserMessage,
        onDiagnostic: (entry) => diagnostics.push(entry),
        now: () => clock.value,
        ...overrides,
      });
    },
  };
}

function seed(store, index, {title = `Work record ${index}`, time = {start: '2025-03-05', precision: 'day'}, myContribution = 'I analysed the descriptor path.'} = {}) {
  return createWorkSummaryManager(store).save({
    requestId: `seed-${index}`,
    draft: {
      itemType: 'requirement',
      title,
      goal: 'Find the reclamation boundary',
      myContribution,
      processOrConclusion: 'Completion controls ownership.',
      result: 'unknown',
      time,
    },
    sources: [{sourceRef: `session-A/seed-${index}`, sourceVersion: 'v1', fragmentRef: 'fragment-1'}],
  });
}

async function runPreStep(host, payload, base = {kind: 'enter', messages: []}) {
  const listeners = host.handlers.get('agent/pre-step') ?? [];
  let next = async () => base;
  for (const listener of [...listeners].reverse()) {
    const inner = next;
    next = () => listener(payload, inner);
  }
  return next();
}
function preStepPayload(host, overrides = {}) {
  return {agent: AGENT, messages: [], turn: 1, step: 1, signal: new AbortController().signal, ...overrides};
}

test('proof reminders append at most one short message, dedupe for 24h and list at most three records', async (t) => {
  const f = fixture(t);
  for (let index = 0; index < 5; index++) seed(f.store, index);
  const installed = f.install();
  const first = await runPreStep(f, preStepPayload(f));
  assert.equal(first.kind, 'enter');
  assert.equal(first.messages.length, 1);
  const reminder = first.messages[0];
  assert.equal(reminder.role, 'user');
  assert.match(reminder.content[0].text, /\[本地记忆缺证提醒\]/);
  assert.equal(reminder.source.kind, 'memory-proof-reminder');
  assert.equal(reminder.source.records.length, 3, 'at most three records are listed');
  assert.ok(reminder.content[0].text.length <= 480, 'reminder text stays short');
  assert.ok(!reminder.content[0].text.includes('I analysed the descriptor path.'), 'no raw record bodies in the reminder');
  assert.ok(!/[A-Za-z]:[\\/]/.test(JSON.stringify(first)), 'reminder message contains no absolute paths');
  const second = await runPreStep(f, preStepPayload(f));
  assert.equal(second.messages.length, 1, 'the next batch of records is still eligible');
  assert.equal(second.messages[0].source.records.length, 2);
  const third = await runPreStep(f, preStepPayload(f));
  assert.equal(third.messages.length, 0, 'all five keys are now deduped inside the 24h cooldown');
  f.setNow('2026-01-16T04:00:01.000Z');
  const fourth = await runPreStep(f, preStepPayload(f));
  assert.equal(fourth.messages.length, 1, 'after 24h the records remind again');
  assert.equal(fourth.messages[0].source.records.length, 3);
  f.setNow('2026-01-17T06:00:00.000Z');
  const fifth = await runPreStep(f, preStepPayload(f));
  assert.equal(fifth.messages.length, 1);
  assert.equal(fifth.messages[0].source.records.length, 3);
  f.setNow('2026-01-17T07:00:00.000Z');
  const sixth = await runPreStep(f, preStepPayload(f));
  assert.equal(sixth.messages.length, 1);
  assert.equal(sixth.messages[0].source.records.length, 2);
  f.setNow('2026-01-17T08:00:00.000Z');
  assert.equal((await runPreStep(f, preStepPayload(f))).messages.length, 0, 'all keys are inside a cooldown window again');
  const status = installed.status();
  assert.equal(status.state, 'active');
  assert.equal(status.remindersShown, 5);
  assert.equal(status.failures, 0);
  assert.equal(status.cooldownHours, 24);
});

test('a new record generation re-arms the reminder immediately', async (t) => {
  const f = fixture(t);
  const saved = seed(f.store, 0);
  const installed = f.install();
  assert.equal((await runPreStep(f, preStepPayload(f))).messages.length, 1);
  assert.equal((await runPreStep(f, preStepPayload(f))).messages.length, 0);
  const manager = createWorkSummaryManager(f.store, {authorize: () => true});
  manager.confirmClaim({id: saved.id, claimRef: 'myContribution', expectedGeneration: f.store.generation()});
  const after = await runPreStep(f, preStepPayload(f));
  assert.equal(after.messages.length, 1, 'a new record generation is due immediately');
  assert.equal(installed.status().remindersShown, 2);
});

test('defer and disable state persist in the catalog and suppress reminders exactly as written', async (t) => {
  const f = fixture(t);
  const first = seed(f.store, 0, {title: 'First work'});
  const second = seed(f.store, 1, {title: 'Second work'});
  const reminders = createCatalogReminders(f.catalog);
  const claims = ['myContribution', 'processOrConclusion', 'result', 'time'];
  for (const claimRef of claims) {
    reminders.deferReminder({scopeRef: 'workspace-v1:alpha', recordId: first.id, claimRef, recordGeneration: first.generation, hours: 2, now: () => f.clock.value});
  }
  f.install();
  const shown = await runPreStep(f, preStepPayload(f));
  assert.equal(shown.messages.length, 1);
  assert.deepEqual(shown.messages[0].source.records.map((record) => record.id), [second.id], 'deferred claims do not remind inside the defer window');
  f.setNow('2026-01-15T06:00:00.000Z');
  const later = await runPreStep(f, preStepPayload(f));
  assert.equal(later.messages.length, 1);
  assert.deepEqual(later.messages[0].source.records.map((record) => record.id), [first.id], 'the deferred record returns after its defer window only');
  assert.ok(reminders.get('workspace-v1:alpha', first.id, 'myContribution') !== undefined);
  for (const claimRef of claims) {
    reminders.disableReminder({scopeRef: 'workspace-v1:alpha', recordId: first.id, claimRef, recordGeneration: first.generation});
    reminders.disableReminder({scopeRef: 'workspace-v1:alpha', recordId: second.id, claimRef, recordGeneration: second.generation});
  }
  f.setNow('2026-01-27T00:00:00.000Z');
  assert.equal((await runPreStep(f, preStepPayload(f))).messages.length, 0, 'disabled records never remind again');
});

test('a project-wide reminder disable and the global config switch suppress reminders', async (t) => {
  const f = fixture(t);
  seed(f.store, 0);
  const reminders = createCatalogReminders(f.catalog);
  reminders.setProjectReminders(f.project.projectId, false);
  f.install();
  assert.equal((await runPreStep(f, preStepPayload(f))).messages.length, 0);
  const g = fixture(t, {configReminders: {enabled: false, cooldownHours: 24, maxItems: 3}});
  seed(g.store, 0);
  const installed = g.install();
  assert.equal((await runPreStep(g, preStepPayload(g))).messages.length, 0);
  assert.equal(installed.status().remindersShown, 0);
});

test('reminder failures never block or alter the main chat request', async (t) => {
  const f = fixture(t);
  seed(f.store, 0);
  const installed = f.install({createUserMessage: () => { throw new Error('message factory failed'); }});
  const base = {kind: 'enter', messages: [{id: 'base-message', role: 'user', content: [{type: 'text', text: 'hello'}], source: {kind: 'user'}}]};
  const result = await runPreStep(f, preStepPayload(f), base);
  assert.equal(result, base, 'the original pre-step decision is returned unchanged');
  assert.equal(installed.status().failures, 1);
  assert.ok(f.diagnostics.some((entry) => entry.code === 'proof_reminder_failed'));
  const brokenStore = f.install({registry: {...f.registry, storeFor: () => { throw new Error('store crashed'); }}});
  const second = await runPreStep(f, preStepPayload(f));
  assert.equal(second.kind, 'enter');
  assert.equal(brokenStore.status().state, 'active');
  assert.ok(f.diagnostics.filter((entry) => entry.code === 'proof_reminder_failed').length >= 1);
});

test('non-enter decisions, aborted signals and unbound sessions are returned untouched', async (t) => {
  const f = fixture(t);
  seed(f.store, 0);
  let nextCalls = 0;
  const installed = f.install();
  const listeners = f.handlers.get('agent/pre-step');
  assert.equal(listeners.length, 1);
  const next = async () => { nextCalls++; return {kind: 'continue', messages: []}; };
  const decision = await listeners[0](preStepPayload(f), next);
  assert.equal(decision.kind, 'continue');
  assert.equal(nextCalls, 1, 'next() is always called first');
  const aborted = new AbortController();
  aborted.abort();
  const abortedDecision = await listeners[0](preStepPayload(f, {signal: aborted.signal}), async () => ({kind: 'enter', messages: []}));
  assert.equal(abortedDecision.messages.length, 0);
  const unbound = await listeners[0]({...preStepPayload(f), agent: Object.freeze({id: 'other', session: Object.freeze({id: 'other'})})}, async () => ({kind: 'enter', messages: []}));
  assert.equal(unbound.messages.length, 0);
  assert.equal(installed.status().remindersShown, 0);
});

test('dispose detaches the listener and is idempotent', async (t) => {
  const f = fixture(t);
  seed(f.store, 0);
  const installed = f.install();
  assert.equal(f.handlers.get('agent/pre-step').length, 1);
  assert.equal(installed.status().installed, true);
  installed.dispose();
  assert.equal(f.handlers.get('agent/pre-step').length, 0);
  assert.equal(installed.status().state, 'disposed');
  installed.dispose();
  assert.equal(installed.status().state, 'disposed');
});

test('reminders follow the persisted pending state: reviewed proof and confirmed claims stop the reminder', async (t) => {
  const f = fixture(t);
  const saved = seed(f.store, 0, {title: 'Reviewed work'});
  const installed = f.install();
  const first = await runPreStep(f, preStepPayload(f));
  assert.equal(first.messages.length, 1);
  const documents = join(f.root, 'documents');
  mkdirSync(documents, {recursive: true});
  const proof = join(documents, 'proof.md');
  writeFileSync(proof, 'I analysed the descriptor path.\nCompletion controls ownership.');
  const manager = createWorkSummaryManager(f.store, {evidenceRoots: [documents], authorize: () => true});
  const registered = manager.registerEvidence({
    id: saved.id,
    reference: {localPath: proof, displayName: 'Proof'},
    claimRefs: ['myContribution', 'processOrConclusion'],
    expectedGeneration: f.store.generation(),
  });
  manager.reviewEvidence({id: saved.id, evidenceRef: registered.evidenceRef, claimRef: 'myContribution', assessment: {support: 'supported', quote: 'I analysed the descriptor path.', note: 'Supports the analysis statement.'}, expectedGeneration: f.store.generation()});
  manager.reviewEvidence({id: saved.id, evidenceRef: registered.evidenceRef, claimRef: 'processOrConclusion', assessment: {support: 'supported', quote: 'Completion controls ownership.', note: 'Supports the conclusion statement.'}, expectedGeneration: f.store.generation()});
  for (const claimRef of ['myContribution', 'processOrConclusion', 'result']) {
    manager.confirmClaim({id: saved.id, claimRef, expectedGeneration: f.store.generation()});
  }
  manager.confirmTime({id: saved.id, expectedGeneration: f.store.generation()});
  f.setNow('2026-01-17T00:00:00.000Z');
  const after = await runPreStep(f, preStepPayload(f));
  assert.equal(after.messages.length, 0, 'no persisted pending evidence/confirmation remains after reviewed proof and user confirmation');
  assert.equal(installed.status().remindersShown, 1);
});
