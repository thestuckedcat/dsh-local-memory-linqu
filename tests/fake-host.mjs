import {Readable} from 'node:stream';
import {createUserMessage} from '../plugin/harness-sdk.mjs';

/**
 * Minimal fake Harness Context used by the M1 integration tests. It mirrors only the
 * Host seams the plugin actually consumes: event on/emit, waterfalls, effects, services,
 * a controllable fake LLM, HTTP routes and user/session identity. It never starts a real
 * profile, never reads credentials and never calls a model.
 */
export class FakeHost {
  constructor({origin = 'http://127.0.0.1:4444'} = {}) {
    this.origin = origin;
    this.root = {};
    this.listeners = new Map();
    this.effects = [];
    this.sessions = new Map();
    this.agents = new Map();
    this.tools = new Map();
    this.commands = new Map();
    this.routes = new Map();
    this.llmCalls = [];
    this.baseStreams = 0;
    this.approvalOutcome = 'allowed-once';
    this.approvalRequests = [];
    this.now = () => new Date();
    this.llm = {
      listProviders: () => [{id: 'deepseek-official', name: 'DeepSeek'}],
      prepareCall: async (config, signal) => {
        this.llmCalls.push(config);
        if (signal?.aborted) throw new Error('aborted');
        return {
          config: {provider: config.provider, model: config.model, maxTokens: config.maxTokens, reasoningEffort: undefined},
          stream: (options) => this.streamChunks(options),
        };
      },
    };
    this.sessionsService = {
      get: (id) => this.sessions.get(id),
      list: () => [...this.sessions.values()],
    };
    this.agentsService = {
      get: (id) => this.agents.get(id),
      list: () => [...this.agents.values()],
    };
    this.toolsService = {
      register: (definition) => {
        if (!definition || typeof definition.name !== 'string' || this.tools.has(definition.name)) throw new Error(`duplicate tool ${String(definition?.name)}`);
        this.tools.set(definition.name, definition);
        return () => this.tools.delete(definition.name);
      },
    };
    this.commandsService = {
      register: (definition) => {
        if (!definition || typeof definition.name !== 'string') throw new Error('invalid command');
        this.commands.set(definition.name, definition);
        return () => this.commands.delete(definition.name);
      },
    };
    this.webServerService = {
      getOrigin: () => this.origin,
      register: (route) => {
        if (!route || !['exact', 'prefix'].includes(route.kind) || typeof route.path !== 'string' || typeof route.handler !== 'function') throw new Error('invalid web route');
        if (this.routes.has(route.path)) throw new Error('duplicate route');
        this.routes.set(route.path, route);
        return () => this.routes.delete(route.path);
      },
    };
    this.approvalService = {
      request: async (request) => {
        this.approvalRequests.push(request);
        return this.approvalOutcome;
      },
    };
    this.ctx = {
      root: this.root,
      on: (name, handler) => this.on(name, handler),
      effect: (fn) => this.effect(fn),
      get: (name) => this.service(name),
      llm: this.llm,
      sessions: this.sessionsService,
      agents: this.agentsService,
      tools: this.toolsService,
      commands: this.commandsService,
      webServer: this.webServerService,
      approval: this.approvalService,
    };
  }

  service(name) {
    return {llm: this.llm, sessions: this.sessionsService, agents: this.agentsService, tools: this.toolsService, commands: this.commandsService, webServer: this.webServerService, approval: this.approvalService}[name];
  }

  on(name, handler) {
    if (typeof handler !== 'function') throw new Error('handler required');
    const set = this.listeners.get(name) ?? new Set();
    set.add(handler);
    this.listeners.set(name, set);
    return () => set.delete(handler);
  }

  effect(fn) {
    const cleanup = fn();
    const disposer = () => { if (typeof cleanup === 'function') cleanup(); };
    this.effects.push(disposer);
    return disposer;
  }

  emit(name, ...args) {
    const failures = [];
    for (const handler of [...(this.listeners.get(name) ?? [])]) {
      try { handler(...args); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }

  waterfall(name, payload, base) {
    const handlers = [...(this.listeners.get(name) ?? [])];
    let next = () => base(payload);
    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      const handler = handlers[index];
      const downstream = next;
      next = () => handler(payload, downstream);
    }
    return next();
  }

  addSession({id = 'session-1', cwd}) {
    const events = [];
    const session = {
      id,
      header: {version: 4, id, createdAt: Date.now(), cwd},
      events,
      eventAt: (seq) => events.find((event) => event.seq === seq),
      append: (event) => events.push(event),
    };
    const agent = {id, session};
    this.sessions.set(id, session);
    this.agents.set(id, agent);
    return {session, agent};
  }

  removeSession(id) {
    this.sessions.delete(id);
    this.agents.delete(id);
  }

  userMessage(session, text, {rpcId = `rpc-${session.events.length + 1}`, messageId = `msg-${session.events.length + 1}`} = {}) {
    const event = {
      type: 'user/message',
      seq: session.events.length + 1,
      time: Date.now(),
      surfaceOp: 'append',
      data: {id: messageId, role: 'user', content: [{type: 'text', text}], source: {kind: 'user', rpcId, clientTimeZone: 'Asia/Shanghai'}},
    };
    session.events.push(event);
    this.emit('session/event', session, event);
    return event;
  }

  async preStep(session, messages = []) {
    const agent = this.agents.get(session.id);
    return this.waterfall('agent/pre-step', {agent, messages, turn: 1, step: 0, signal: new AbortController().signal}, () => ({kind: 'enter', messages}));
  }

  /** Run one llm/stream waterfall call; returns the chosen async iterable plus a counter of adapter invocations. */
  async llmStream(options) {
    const before = this.baseStreams;
    const iterable = await this.waterfall('llm/stream', options, () => this.streamChunks(options));
    return {iterable, adapterCalled: this.baseStreams > before};
  }

  streamChunks(options) {
    this.baseStreams += 1;
    const system = (options.messages ?? []).find((message) => message.role === 'system');
    const systemText = system ? system.content.map((block) => block.text ?? '').join('\n') : '';
    let text;
    if (systemText.includes('work-summary') || systemText.includes('work summary')) {
      text = JSON.stringify({schema_version: 1, summary: {itemType: 'requirement', title: 'Synthetic annual item', goal: 'Test goal', myContribution: 'I verified the closed loop.', processOrConclusion: 'Candidate only.', result: 'unknown', time: {precision: 'unknown'}}});
    } else if (systemText.includes('Consolidate only')) {
      let refs = [];
      try {
        const user = (options.messages ?? []).find((message) => message.role === 'user');
        const input = JSON.parse(user.content.map((block) => block.text ?? '').join(''));
        refs = Array.isArray(input.memories) ? input.memories.map((memory) => memory.ref) : [];
      } catch { refs = []; }
      text = JSON.stringify({
        schema_version: 1,
        groups: refs.length ? [{key: 'g0', type: 'related', memoryRefs: refs, statement: 'Synthetic consolidation statement.', status: 'unverified', support: refs.map((ref) => ({memoryRef: ref, excerptRefs: []})), applicability: 'same_scope_only', freshness: {status: 'unknown', reason: 'synthetic test input'}}] : [],
        untouched: [],
      });
    } else {
      text = JSON.stringify({schema_version: 1, memories: [{text: 'Completion precedes reclamation.', kind: 'lesson'}]});
    }
    const chunks = [
      {type: 'block-start', index: 0, blockType: 'text'},
      {type: 'text-delta', index: 0, text: text.slice(0, Math.ceil(text.length / 2))},
      {type: 'text-delta', index: 0, text: text.slice(Math.ceil(text.length / 2))},
      {type: 'block-end', index: 0, block: {type: 'text', text}},
      {type: 'usage', usage: {inputTokens: 12, outputTokens: 8}},
      {type: 'finish', reason: {kind: 'stop'}},
    ];
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          if (options.signal?.aborted) throw new Error('aborted');
          yield chunk;
        }
      },
    };
  }

  /** Call the registered management HTTP route with a JSON body and return the parsed response. */
  async callApi(body, headers = {}) {
    const route = this.routes.get('/dsh-local-memory/api');
    if (!route) throw new Error('management route is not registered');
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const request = Readable.from([Buffer.from(payload, 'utf8')]);
    request.method = 'POST';
    request.url = route.path;
    request.headers = {'content-type': 'application/json', origin: this.origin, 'content-length': String(Buffer.byteLength(payload)), ...headers};
    const response = await new Promise((resolve, reject) => {
      const collected = {statusCode: 200, headers: {}, body: ''};
      const res = {
        writeHead(status, responseHeaders = {}) { collected.statusCode = status; Object.assign(collected.headers, responseHeaders); return res; },
        setHeader(name, value) { collected.headers[name.toLowerCase()] = value; },
        end(chunk) { if (chunk !== undefined) collected.body += chunk.toString('utf8'); resolve(collected); },
        write(chunk) { collected.body += chunk.toString('utf8'); },
      };
      try { Promise.resolve(route.handler(request, res)).catch(reject); } catch (error) { reject(error); }
    });
    return {status: response.statusCode, headers: response.headers, json: response.body ? JSON.parse(response.body) : undefined, raw: response.body};
  }

  tool(name) {
    return this.tools.get(name);
  }

  command(name) {
    return this.commands.get(name);
  }

  async dispose() {
    for (const disposer of this.effects.reverse()) {
      try { disposer(); } catch { /* teardown continues */ }
    }
    this.effects = [];
    this.listeners.clear();
    this.tools.clear();
    this.commands.clear();
    this.routes.clear();
    this.sessions.clear();
    this.agents.clear();
  }
}

export function newestUserMessage() {
  return createUserMessage({content: [{type: 'text', text: 'synthetic'}], source: {kind: 'user'}});
}
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function waitFor(predicate, {timeoutMs = 5000, intervalMs = 25, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
