import {randomUUID} from 'node:crypto';
import {createJobQueue} from '../src/jobs.mjs';
import {createReportManager} from '../src/reports.mjs';
import {createAbstractManager} from '../src/abstracts.mjs';
import {createSharingManager} from '../src/sharing.mjs';
import {checkedText, digest} from '../src/scope.mjs';
import {fingerprint} from '../src/validation.mjs';
import {createHarnessProviderBridge} from './harness-provider.mjs';
import {installSessionHooks} from './session-hooks.mjs';
import {createProjectRegistry} from './project-registry.mjs';
import {createHostGrants} from './host-grants.mjs';
import {createScheduler} from './scheduler.mjs';
import {createFinalProjection} from './final-projection.mjs';
import {createManagementOperations, createManagementHttp} from './management.mjs';
import {createWorkOperations} from './work-management.mjs';
import {createM2Operations} from './m2-management.mjs';
import {installProofReminders} from './proof-reminders.mjs';
import {normalizeConfig, routeApproval, routeRefFor, configErrorReason} from './configuration.mjs';
import {createUserMessage, createSystemMessage, BlockAssembler} from './harness-sdk.mjs';

const PLUGIN = 'dsh-local-memory-linqu';
const OWNER_KEY = Symbol.for('dsh-local-memory-linqu/host/v1');
const HOST_SDK = Object.freeze({createUserMessage, createSystemMessage, BlockAssembler});
const TOOL_OUTPUT = Object.freeze({
  schema: {type: 'object'},
  render: (args, value) => [{type: 'text', text: JSON.stringify(value, null, 2)}],
});

export const inject = Object.freeze(['llm', 'tools', 'commands', 'webServer', 'sessions', 'agents', 'approval']);

if (globalThis[OWNER_KEY] === undefined) Object.defineProperty(globalThis, OWNER_KEY, {value: new WeakMap()});
const owners = globalThis[OWNER_KEY];

/**
 * Host half of the local memory plugin. Registers only through the verified Host seams
 * documented in docs/m1-plugin-design.md; never throws out of apply (Cordis failure would
 * take down sibling rows), never handles credentials and never scans historical sessions.
 */
export function apply(ctx, rawConfig = {}) {
  if (!(owners instanceof WeakMap)) throw new Error('Memory plugin ownership registry unavailable');
  if (!ctx || typeof ctx.effect !== 'function' || typeof ctx.on !== 'function' || !ctx.root) throw new Error('Trusted Host context required');
  if (owners.has(ctx.root)) throw new Error('Local memory plugin is already installed for this Host root');
  const token = Symbol('local-memory');
  owners.set(ctx.root, {token, api: null});

  const diagnostics = [];
  const status = {
    plugin: PLUGIN,
    state: 'starting',
    reason: null,
    dataRoot: null,
    projects: 0,
    scopes: 0,
    provider: 'unknown',
    scheduler: null,
    recallIntegration: 'pending',
    cold: Object.freeze({status: 'not_configured', detail: 'M3 cold tier is not implemented; all memory data stays local.'}),
    degraded: [],
  };
  function diagnostic(code) {
    if (!code) return;
    if (diagnostics.length >= 50) diagnostics.shift();
    diagnostics.push(Object.freeze({code, at: new Date().toISOString()}));
    status.lastDiagnostic = code;
  }
  function noteDiagnostic(entry) {
    diagnostic(typeof entry === 'string' ? entry : entry?.code);
  }
  function registerStatusSurface(reason) {
    status.state = 'degraded';
    status.reason = reason;
    diagnostic(reason);
    try {
      ctx.effect(() => ctx.tools.register({
        name: 'memory_status',
        description: 'Report local memory plugin state. Memory extraction and recall are disabled until configuration is fixed.',
        parameters: {type: 'object', properties: {}, additionalProperties: false},
        output: TOOL_OUTPUT,
        execute: async () => ({ok: false, error: {code: reason, message: 'Local memory is unavailable; fix the plugin configuration.'}}),
      }));
    } catch { /* the Host root may not expose tools; status stays in the plugin log */ }
    try {
      ctx.effect(() => ctx.webServer.register({
        kind: 'exact',
        path: '/dsh-local-memory/api',
        handler: (req, res) => {
          res.writeHead(200, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
          res.end(JSON.stringify({ok: false, error: {code: reason, message: 'Local memory is unavailable.'}}));
        },
      }));
    } catch { /* route registration is optional for a degraded plugin */ }
    ctx.effect(() => () => {
      if (owners.get(ctx.root)?.token === token) owners.delete(ctx.root);
    });
  }

  let config;
  try {
    config = normalizeConfig(rawConfig);
  } catch (error) {
    registerStatusSurface(configErrorReason(error));
    return;
  }
  status.dataRoot = config.dataRoot;

  let registry;
  let bridge;
  let grants;
  let scheduler;
  let projection;
  let operations;
  let http;
  let hooks;
  let reminders;
  let reports;
  let abstracts;
  let sharing;
  let m2Operations;
  let disposed = false;
  const schedulerFacade = {
    status: () => scheduler?.status() ?? Object.freeze({state: 'unavailable'}),
    tick: () => scheduler?.tick(),
    stop: () => scheduler?.stop(),
  };

  function ensureScope(scopeRef) {
    return {store: registry.storeFor(scopeRef), queue: registry.queueFor(scopeRef)};
  }
  function callContext(exec) {
    const agent = exec?.agent;
    if (!agent || typeof agent.id !== 'string') throw new Error('Agent identity unavailable');
    const session = ctx.sessions.get(agent.id);
    if (!session) throw new Error('Session is not live');
    const binding = registry.bindingForSession(session);
    return {agent, session, binding};
  }
  function scopeOf(binding) {
    if (!binding) throw new Error('Memory project is not bound to this session');
    return ensureScope(binding.scopeRef);
  }
  function modelOperation(operation, input, exec) {
    const {agent, session, binding} = callContext(exec);
    if (!binding) return {ok: false, error: {code: 'UNBOUND', message: 'Register this project in the memory center before using memory; ordinary chat continues.'}};
    const value = input && typeof input === 'object' && !Array.isArray(input) ? {...input} : {};
    if (value.projectId === undefined) value.projectId = binding.projectId;
    return operations.dispatch({operation, operationId: randomUUID(), input: value, actor: 'model', agent, sessionId: session.id});
  }
  function userOperation(operation, input, agent) {
    const session = agent ? ctx.sessions.get(agent.id) : undefined;
    return operations.dispatch({operation, operationId: randomUUID(), input, actor: 'user', agent, sessionId: session?.id});
  }
  /** Model dispatch with the exact documented input (no implicit projectId injection). */
  function modelDispatch(operation, input, exec) {
    const {agent, session} = callContext(exec);
    return operations.dispatch({operation, operationId: randomUUID(), input, actor: 'model', agent, sessionId: session.id});
  }
  function registerTool(definition) {
    ctx.effect(() => ctx.tools.register(Object.freeze({
      ...definition,
      output: TOOL_OUTPUT,
      execute: async (args, exec) => {
        try {
          return await definition.execute(args ?? {}, exec);
        } catch (error) {
          diagnostic('tool_failed');
          return {ok: false, error: {code: 'TOOL_FAILED', message: 'Local memory operation failed; see plugin status.'}};
        }
      },
    })));
  }
  function tool(name, description, properties, execute) {
    registerTool({name, description, parameters: {type: 'object', properties, additionalProperties: false}, execute});
  }
  function enqueueAnnualDraft(info) {
    if (!config.workSummary.enabled || disposed) return;
    try {
      const runtime = info?.binding;
      if (!runtime || typeof runtime.scopeRef !== 'string') return;
      runtime.queue.enqueue({
        requestId: `work-v1:${fingerprint({scope: runtime.scopeRef, message: info.candidate?.id, purpose: 'work_summary_extract'})}`,
        scopeRef: runtime.scopeRef,
        sessionRef: info.sessionRef ?? info.session?.id,
        sourceRef: info.sourceRef,
        sourceVersion: info.sourceVersion,
        fragmentRef: 'user-text-v1',
        inputRef: `${info.sourceRef}/text`,
        inputClass: 'conversation_fragment',
        input: info.candidate.input,
        routeRef: config.workSummary.routeRef,
        generation: runtime.generation,
        purpose: 'work_summary_extract',
      });
    } catch {
      diagnostic('annual_draft_refused');
    }
  }

  try {
    registry = createProjectRegistry({
      config,
      createQueue: (store) => createJobQueue(store, {
        provider: bridge.provider,
        limits: config.limits,
        authorizeExecution: (metadata) => grants.authorizeExecution(metadata),
        authorizeRecovery: (args) => grants.authorizeRecovery(args),
      }),
      onDiagnostic: (entry) => noteDiagnostic(entry),
    });
    registry.initialize();
    const registryStatus = registry.status();
    status.projects = registryStatus.projectCount;
    status.scopes = registryStatus.scopeCount;
    status.degraded = [...registryStatus.degraded];
    // A configured project that disagrees with the persisted catalog must not silently keep
    // extracting under the old binding: stop automatic extraction/recall while keeping manual
    // management available (design §6 config_conflict).
    if (registryStatus.degraded.some((entry) => entry.code === 'CONFIG_CONFLICT')) {
      config = {
        ...config,
        extraction: {...config.extraction, enabled: false},
        recall: {...config.recall, enabled: false},
        workSummary: {...config.workSummary, enabled: false},
      };
      status.automaticDisabled = 'config_conflict';
      noteDiagnostic('config_conflict_automatic_memory_disabled');
    }

    bridge = createHarnessProviderBridge({ctx, sdk: HOST_SDK, readApprovedRoute: routeApproval(config), cleanupBudgetMs: 100});
    status.provider = bridge.status().state;
    grants = createHostGrants({config, registry, sessions: ctx.sessions, agents: ctx.agents});
    reports = createReportManager({registry, config});
    abstracts = createAbstractManager({
      catalog: registry.catalog,
      registry,
      thresholds: {dirtyCountThreshold: config.abstracts.dirtyCountThreshold, ageHours: config.abstracts.ageHours},
    });
    sharing = createSharingManager({catalog: registry.catalog, registry, abstracts});
    const workOperations = createWorkOperations({registry, config, reports, approval: ctx.approval, sessions: ctx.sessions});
    m2Operations = createM2Operations({registry, abstracts, sharing, sessions: ctx.sessions});
    operations = createManagementOperations({
      config,
      registry,
      grants,
      scheduler: schedulerFacade,
      provider: bridge.provider,
      extras: {...workOperations, ...m2Operations},
      onMemoryChange: (change) => {
        try {
          if (typeof change.projectId === 'string' && change.projectId) abstracts.noteChange(change.projectId, {count: 1});
        } catch {
          noteDiagnostic('abstract_dirty_failed');
        }
      },
      status: () => ({
        ...status,
        dataRoot: undefined,
        scheduler: schedulerFacade.status(),
        grants: grants.status(),
        abstracts: abstracts.status(),
        sharing: sharing.status(),
      }),
    });
    http = createManagementHttp({operations, getOrigin: () => ctx.webServer.getOrigin()});
    projection = createFinalProjection({config, registry, grants, sessions: ctx.sessions, onDiagnostic: (entry) => noteDiagnostic(entry)});
    scheduler = createScheduler({
      config,
      registry,
      grants,
      provider: bridge.provider,
      limits: config.limits,
      queueFor: (scopeRef) => registry.queueFor(scopeRef),
      onDiagnostic: (entry) => noteDiagnostic(entry),
      onJobSettled: ({scopeRef, result}) => {
        try {
          if (result?.state !== 'completed' || result?.purpose !== 'memory_extract') return;
          const ids = Array.isArray(result?.result?.ids) ? result.result.ids : [];
          if (ids.length === 0) return;
          const project = registry.projectForScope(scopeRef);
          if (project?.projectId) abstracts.noteChange(project.projectId, {count: ids.length});
        } catch { noteDiagnostic('abstract_dirty_failed'); }
      },
    });

    hooks = installSessionHooks(ctx, {
      resolveScope: ({session}) => {
        const binding = registry.bindingForSession(session);
        if (!binding) throw new Error('Memory project is not bound');
        const runtime = ensureScope(binding.scopeRef);
        return {
          scopeRef: binding.scopeRef,
          store: runtime.store,
          queue: runtime.queue,
          routeRef: routeRefFor(config, 'memory_extract'),
          generation: runtime.store.generation(),
          authorizationVersion: grants.currentAuthorizationVersion(),
        };
      },
      admitMessage: (request) => grants.admitMessage(request),
      createUserMessage: (input) => HOST_SDK.createUserMessage(input),
      onDiagnostic: (entry) => noteDiagnostic(entry),
      limits: {maxRecallRecords: config.recall.maxRecords, maxRecallChars: config.recall.maxChars},
      onRecallMessage: (info) => projection.record(info),
      onMessageAdmitted: (info) => enqueueAnnualDraft(info),
    });


    // Tools: the model may read and propose; user-only actions stay in the memory center UI/commands.
    tool('memory_status', 'Report local memory state: binding, project, scheduler, provider and degraded reasons.', {}, async () => {
      const registryStatus = registry.status();
      return {
        ok: true,
        value: {
          plugin: {
            plugin: status.plugin,
            state: status.state,
            reason: status.reason,
            projects: status.projects,
            scopes: status.scopes,
            provider: status.provider,
            recallIntegration: status.recallIntegration,
            cold: status.cold,
            automaticDisabled: status.automaticDisabled ?? false,
            degraded: status.degraded,
            lastDiagnostic: status.lastDiagnostic,
          },
          registry: {
            state: registryStatus.state,
            projectCount: registryStatus.projectCount,
            activeProjectCount: registryStatus.activeProjectCount,
            scopeCount: registryStatus.scopeCount,
            openStores: registryStatus.openStores,
            degraded: registryStatus.degraded,
          },
          scheduler: schedulerFacade.status(),
          grants: grants.status(),
          abstracts: abstracts.status(),
          sharing: sharing.status(),
        },
      };
    });
    tool('memory_search', 'Search unverified local memories of the current project. Returns source references and verification state.', {
      query: {type: 'string', description: 'Search text (local lexical search, current project only).'},
      limit: {type: 'integer', minimum: 1, maximum: 20},
    }, async (args, exec) => modelOperation('memory.search', {query: String(args.query ?? ''), limit: args.limit, mode: 'manual'}, exec));
    tool('memory_list', 'List the newest local memories of the current project.', {limit: {type: 'integer', minimum: 1, maximum: 50}}, async (args, exec) => modelOperation('memory.list', {limit: args.limit}, exec));
    tool('memory_get', 'Read one local memory record with its sources and state.', {id: {type: 'string'}}, async (args, exec) => modelOperation('memory.get', {id: String(args.id)}, exec));
    tool('memory_remember', 'Manually remember one short fact/lesson/preference/decision explicitly requested by the user.', {
      text: {type: 'string', description: 'Memory text, at most 8000 characters.'},
      kind: {type: 'string', enum: ['fact', 'lesson', 'preference', 'decision']},
    }, async (args, exec) => {
      const {session, binding} = callContext(exec);
      if (!binding) return {ok: false, error: {code: 'UNBOUND', message: 'Register this project before storing memories.'}};
      const text = checkedText(args.text, 'memory text', 8000);
      const kind = args.kind ?? 'lesson';
      if (!['fact', 'lesson', 'preference', 'decision'].includes(kind)) throw new Error('Invalid memory kind');
      const store = scopeOf(binding).store;
      const record = store.put({
        id: `memory-${digest(`${binding.scopeRef}:${fingerprint({kind, text})}`)}`,
        sourceRef: `${session.id}/manual`,
        sourceVersion: `manual-${digest(text)}`,
        kind,
        text,
        origin: 'user',
      });
      try { abstracts.noteChange(binding.projectId, {count: 1}); } catch { noteDiagnostic('abstract_dirty_failed'); }
      return {ok: true, value: {id: record.id, generation: record.generation, verification: record.verification, state: record.state}};
    });
    tool('memory_correct', 'Correct one memory record with a new source version. The old version becomes superseded.', {
      id: {type: 'string'},
      text: {type: 'string'},
      newSourceVersion: {type: 'string'},
    }, async (args, exec) => modelOperation('memory.correct', {id: args.id, text: args.text, sourceVersion: args.newSourceVersion}, exec));
    tool('memory_archive', 'Archive one memory record (recoverable, excluded from automatic recall).', {id: {type: 'string'}, expectedGeneration: {type: 'integer'}}, async (args, exec) => modelOperation('memory.archive', {id: args.id, expectedGeneration: args.expectedGeneration}, exec));
    tool('memory_delete', 'Explicitly delete one memory record. This is a local clear action; archived records cannot restore it.', {id: {type: 'string'}, expectedGeneration: {type: 'integer'}}, async (args, exec) => modelOperation('memory.delete', {id: args.id, expectedGeneration: args.expectedGeneration}, exec));
    tool('memory_tasks', 'List or inspect persistent memory extraction tasks of the current project.', {
      action: {type: 'string', enum: ['list', 'inspect']},
      jobId: {type: 'string'},
    }, async (args, exec) => args.action === 'inspect' ? modelOperation('task.inspect', {jobId: args.jobId}, exec) : modelOperation('task.list', {limit: 20}, exec));
    tool('work_list', 'List annual work-record drafts of the current project. Drafts are unverified model or user notes.', {limit: {type: 'integer', minimum: 1, maximum: 50}}, async (args, exec) => modelOperation('work.list', {limit: args.limit}, exec));
    tool('work_get', 'Read one annual work record with claim confirmation and evidence state.', {id: {type: 'string'}}, async (args, exec) => modelOperation('work.get', {id: args.id}, exec));
    tool('memory_abstracts', 'List the current project abstract and discoverable abstracts from other local projects. Only summaries/sources are returned; no cross-project memory body is copied.', {}, async (args, exec) => {
      const {agent, session, binding} = callContext(exec);
      if (!binding) return {ok: false, error: {code: 'UNBOUND', message: 'Register this project before using abstracts.'}};
      const own = operations.dispatch({operation: 'abstract.list', operationId: randomUUID(), input: {projectId: binding.projectId}, actor: 'model', agent, sessionId: session.id});
      const discover = operations.dispatch({operation: 'share.discover', operationId: randomUUID(), input: {targetProjectId: binding.projectId}, actor: 'model', agent, sessionId: session.id});
      return {
        ok: true,
        value: {
          own: own.ok ? own.value : null,
          discoverable: discover.ok ? discover.value.sources : [],
          ...(discover.ok ? {} : {discoverError: discover.error}),
        },
      };
    });
    tool('memory_shared_search', 'Search memory details of another local project only when the user has granted an active share to the current project. Results keep source references and are never copied.', {
      sourceProjectId: {type: 'string', description: 'Registered source project id.'},
      query: {type: 'string', description: 'Local lexical query.'},
      limit: {type: 'integer', minimum: 1, maximum: 20},
    }, async (args, exec) => modelDispatch('shared.search', {sourceProjectId: String(args.sourceProjectId ?? ''), query: String(args.query ?? ''), ...(args.limit === undefined ? {} : {limit: args.limit})}, exec));


    // Human command: one entry for the most common user actions; UI remains the full center.
    ctx.effect(() => ctx.commands.register({
      name: 'memory',
      description: 'Local memory: status, search, remember, projects, register, forget.',
      input: {hint: 'status | search <text> | remember <text> | projects | register <name> | forget <id>'},
      handler: async ({agent, rawInput}) => {
        try {
          const parts = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
          const command = parts.shift() ?? 'status';
          const rest = parts.join(' ');
          if (command === 'status') {
            const snapshot = schedulerFacade.status();
            return {kind: 'success', text: `memory: ${status.state}; projects=${status.projects}; scopes=${status.scopes}; provider=${status.provider}; scheduler=${snapshot.state ?? 'unknown'}; recall=${status.recallIntegration}`};
          }
          if (command === 'projects') {
            return {kind: 'success', text: registry.list().map((project) => `${project.name} (${project.state})`).join('\n') || 'no project registered'};
          }
          if (command === 'search') {
            const result = await userOperation('memory.search', {query: rest, limit: 5}, agent);
            return result.ok ? {kind: 'success', text: JSON.stringify(result.value.items ?? result.value, null, 2)} : {kind: 'error', text: result.error.message};
          }
          if (command === 'remember') {
            const {session} = callContext({agent});
            const binding = registry.bindingForSession(session);
            if (!binding) return {kind: 'error', text: 'Register this project first: /memory register <name>'};
            const text = checkedText(rest, 'memory text', 8000);
            const record = scopeOf(binding).store.put({id: `memory-${digest(`${binding.scopeRef}:${fingerprint({kind: 'lesson', text})}`)}`, sourceRef: `${session.id}/manual`, sourceVersion: `manual-${digest(text)}`, kind: 'lesson', text, origin: 'user'});
            try { abstracts.noteChange(binding.projectId, {count: 1}); } catch { noteDiagnostic('abstract_dirty_failed'); }
            return {kind: 'success', text: `remembered ${record.id}`};
          }
          if (command === 'register') {
            const {session} = callContext({agent});
            if (!session.header.cwd) return {kind: 'error', text: 'this session has no local working directory'};
            const name = rest || session.header.cwd.split(/[\\/]/).filter(Boolean).pop();
            const result = await userOperation('project.register', {
              name,
              repositories: [{repoId: 'main', canonicalRoot: session.header.cwd, worktreeRoot: session.header.cwd, revision: 'workspace', buildVariant: `${process.platform}-node${process.versions.node.split('.')[0]}`}],
            }, agent);
            return result.ok ? {kind: 'success', text: `registered project ${result.value.project?.name ?? result.value.name}; memory will attach on the next session event`} : {kind: 'error', text: result.error.message};
          }
          if (command === 'forget') {
            const result = await userOperation('memory.get', {id: rest}, agent);
            if (!result.ok) return {kind: 'error', text: result.error.message};
            const removed = await userOperation('memory.delete', {id: rest, expectedGeneration: result.value.generation}, agent);
            return removed.ok ? {kind: 'success', text: `deleted ${rest} (explicit local clear)`} : {kind: 'error', text: removed.error.message};
          }
          return {kind: 'error', text: 'usage: /memory status | search <text> | remember <text> | projects | register <name> | forget <id>'};
        } catch (error) {
          diagnostic('command_failed');
          return {kind: 'error', text: 'local memory command failed; see plugin status'};
        }
      },
    }));

    ctx.effect(() => ctx.webServer.register({kind: 'exact', path: http.path, handler: http.handler}));
    ctx.effect(() => projection.install(ctx));
    ctx.effect(() => {
      scheduler.start();
      return () => scheduler.stop();
    });
    // Low-frequency local abstract maintenance. It never calls a model and never blocks chat;
    // read-time basis validation still applies before any abstract is served or shared.
    ctx.effect(() => {
      let stopped = false;
      const maintain = () => {
        if (stopped) return;
        let projects;
        try { projects = registry.list(); } catch { noteDiagnostic('abstract_maintenance_failed'); return; }
        for (const project of projects) {
          if (project.state !== 'active') continue;
          try { abstracts.read({projectId: project.projectId}); } catch { noteDiagnostic('abstract_maintenance_failed'); }
        }
      };
      const timer = setInterval(maintain, config.abstracts.pollMs);
      timer.unref?.();
      const immediate = setTimeout(maintain, 1000);
      immediate.unref?.();
      return () => { stopped = true; clearInterval(timer); clearTimeout(immediate); };
    });
    reminders = installProofReminders(ctx, {
      registry,
      config,
      sessions: ctx.sessions,
      createUserMessage: HOST_SDK.createUserMessage,
      onDiagnostic: (entry) => noteDiagnostic(entry),
    });
    status.recallIntegration = projection ? 'llm-stream-gate' : 'unavailable';
    status.state = 'ready';
    status.scheduler = schedulerFacade.status();
  } catch (error) {
    try { hooks?.dispose(); } catch { /* degraded cleanup */ }
    try { reminders?.dispose(); } catch { /* degraded cleanup */ }
    try { projection?.dispose(); } catch { /* degraded cleanup */ }
    try { scheduler?.stop(); } catch { /* degraded cleanup */ }
    try { grants?.revoke('activation_failed'); } catch { /* degraded cleanup */ }
    try { const closing = bridge?.dispose(); if (closing && typeof closing.then === 'function') closing.catch(() => {}); } catch { /* degraded cleanup */ }
    try { registry?.close(); } catch { /* degraded cleanup */ }
    diagnostic('activation_failed');
    registerStatusSurface('activation_failed');
  }

  ctx.effect(() => () => {
    if (disposed) return;
    disposed = true;
    try { hooks?.dispose(); } catch { /* local cleanup only */ }
    try { reminders?.dispose(); } catch { /* local cleanup only */ }
    try { projection?.dispose(); } catch { /* local cleanup only */ }
    try { scheduler?.stop(); } catch { /* local cleanup only */ }
    try { grants?.revoke('plugin_disposed'); } catch { /* local cleanup only */ }
    try { const closing = bridge?.dispose(); if (closing && typeof closing.then === 'function') closing.catch(() => {}); } catch { /* local cleanup only */ }
    try { registry?.close(); } catch { /* local cleanup only */ }
    if (owners.get(ctx.root)?.token === token) owners.delete(ctx.root);
    status.state = 'disposed';
  });
}

