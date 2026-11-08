import {mkdirSync, realpathSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {openStore} from '../src/backend.mjs';
import {createScope, checkedPath, checkedText, digest} from '../src/scope.mjs';
import {openProjectCatalog} from '../src/projects.mjs';

const SCOPE_CACHE_LIMIT = 256;

function normalizeRoot(path) {
  const resolved = realpathSync(checkedPath(path));
  if (!statSync(resolved).isDirectory()) throw new Error('Memory project root must be a directory');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
/** Source availability for applicability; never scans content and tolerates removal. */
function directoryExists(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
function boundPath(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith('\\') ? root : `${root}\\`) || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}
function bindingOf(project, repository) {
  return Object.freeze({
    projectId: project.projectId,
    projectRevision: project.revision,
    projectState: project.state,
    repoId: repository.repoId,
    canonicalRoot: repository.canonicalRoot,
    worktreeRoot: repository.worktreeRoot,
    revision: repository.revision,
    buildVariant: repository.buildVariant,
    scopeRef: repository.scopeRef,
    bindingRevision: repository.bindingRevision,
  });
}
function resolveBinding(repository) {
  const canonicalRoot = normalizeRoot(repository.canonicalRoot);
  const worktreeRoot = normalizeRoot(repository.worktreeRoot);
  const scopeRef = createScope({projectRoot: canonicalRoot, worktreeRoot, revision: repository.revision, buildVariant: repository.buildVariant});
  return Object.freeze({
    repoId: repository.repoId,
    canonicalRoot,
    worktreeRoot,
    revision: repository.revision,
    buildVariant: repository.buildVariant,
    scopeRef,
  });
}
function errorCode(error) {
  return error && typeof error.code === 'string' ? error.code : 'REGISTRY_UNAVAILABLE';
}
function failure(code, message) {
  const error = new Error(message ?? code);
  error.code = code;
  return error;
}

/** Project catalog + concrete-scope stores for one plugin activation. All writes stay single-writer. */
export function createProjectRegistry({config, createQueue, onDiagnostic = () => {}, now = () => new Date(), openStoreImpl = openStore} = {}) {
  if (!config || typeof config !== 'object') throw failure('REGISTRY_UNAVAILABLE', 'Normalized configuration required');
  const dataRoot = config.dataRoot;
  const scopes = new Map();
  const stores = new Map();
  const queues = new Map();
  const degraded = [];
  let catalog;
  let state = 'new';
  let bindings = [];
  let cwdCache = new Map();

  function diagnostic(code) {
    try { onDiagnostic(Object.freeze({code})); } catch { /* diagnostics never affect memory behavior */ }
  }
  function rebuild() {
    bindings = [];
    const projects = catalog.listProjects();
    for (const project of projects) {
      for (const repository of project.repositories) {
        if (!repository.enabled) continue;
        const binding = bindingOf(project, repository);
        scopes.set(binding.scopeRef, binding);
        if (project.state === 'active') bindings.push(binding);
      }
    }
    cwdCache = new Map();
    return projects;
  }
  function seedConfigProjects() {
    for (const declared of config.projects) {
      try {
        const repositories = declared.repositories.map(resolveBinding);
        const existing = catalog.listProjects().find((project) => project.name === declared.name);
        if (existing) {
          const same = existing.repositories.filter((repo) => repo.enabled).length === repositories.length
            && repositories.every((repo) => existing.repositories.some((known) => known.enabled && known.repoId === repo.repoId && known.scopeRef === repo.scopeRef));
          if (!same) throw failure('CONFIG_CONFLICT', `Configured project ${declared.name} disagrees with the registered project`);
          continue;
        }
        catalog.registerProject({name: declared.name, repositories, origin: 'config'});
      } catch (error) {
        degraded.push(Object.freeze({project: declared.name, code: errorCode(error)}));
        diagnostic(`config_project_${errorCode(error)}`);
      }
    }
  }
  function findProject(projectId) {
    const project = catalog.getProject(projectId);
    if (!project) throw failure('PROJECT_NOT_FOUND', 'project is not registered');
    return project;
  }
  function requireActive(projectId) {
    const project = findProject(projectId);
    if (project.state !== 'active') throw failure('PROJECT_RETIRED', 'project is retired');
    return project;
  }

  const registry = {
    get catalog() { return catalog; },
    get state() { return state; },
    dataRoot,
    initialize() {
      if (state === 'ready') return registry;
      if (state === 'failed') throw failure('REGISTRY_UNAVAILABLE', 'registry initialization already failed');
      try {
        mkdirSync(dataRoot, {recursive: true, mode: 0o700});
        catalog = openProjectCatalog(join(dataRoot, 'catalog.sqlite'), {identityPath: join(dataRoot, 'catalog.identity.json')});
        seedConfigProjects();
        rebuild();
        state = 'ready';
        return registry;
      } catch (error) {
        state = 'failed';
        throw error;
      }
    },
    list() {
      ensureReady();
      return catalog.listProjects();
    },
    getProject(projectId) {
      ensureReady();
      return catalog.getProject(checkedText(projectId, 'project id', 128));
    },
    registerProject({name, repositories, origin = 'user'}) {
      if (state !== 'ready') throw failure('REGISTRY_UNAVAILABLE', 'registry is not ready');
      const resolved = normalizeRepositories(repositories);
      let project;
      try {
        project = catalog.registerProject({name, repositories: resolved, origin});
      } catch (error) {
        throw errorCode(error) === 'PROJECT_EXISTS' ? failure('PROJECT_EXISTS', 'project name already registered with a different binding') : error;
      }
      rebuild();
      return project;
    },
    updateProject({projectId, expectedRevision, name, repositories, reason}) {
      ensureReady();
      const resolved = repositories === undefined ? undefined : normalizeRepositories(repositories);
      let project;
      try {
        project = catalog.updateProject({projectId, expectedRevision, name, repositories: resolved, reason});
      } catch (error) {
        if (errorCode(error) === 'PROJECT_EXISTS') throw failure('PROJECT_EXISTS', 'project name already registered');
        throw error;
      }
      rebuild();
      return project;
    },
    retireProject({projectId, expectedRevision, reason}) {
      ensureReady();
      const project = catalog.retireProject({projectId, expectedRevision, reason});
      rebuild();
      return project;
    },
    setPreference({projectId, expectedRevision, key, value}) {
      ensureReady();
      const project = catalog.setPreference({projectId, expectedRevision, key, value});
      rebuild();
      return project;
    },
    getPreference(projectId, key) {
      ensureReady();
      return catalog.getPreference(projectId, key);
    },
    scopesForProject(projectId) {
      ensureReady();
      return [...scopes.values()].filter((binding) => binding.projectId === projectId);
    },
    activeScopes() {
      ensureReady();
      return [...new Set(bindings.filter((binding) => binding.projectState === 'active').map((binding) => binding.scopeRef))];
    },
    allScopes() {
      ensureReady();
      return [...scopes.keys()];
    },
    bindingForScope(scopeRef) {
      ensureReady();
      return scopes.get(checkedText(scopeRef, 'scope reference', 2048));
    },
    projectForScope(scopeRef) {
      const binding = registry.bindingForScope(scopeRef);
      return binding === undefined ? undefined : catalog.getProject(binding.projectId);
    },
    /** Applicability of one concrete scope's source material (MEM-203). Cheap stat only. */
    applicabilityForScope(scopeRef) {
      ensureReady();
      const binding = registry.bindingForScope(scopeRef);
      if (!binding) return Object.freeze({applicability: 'unavailable', projectState: undefined, sourceAvailable: false, checkedAt: new Date().toISOString()});
      const project = catalog.getProject(binding.projectId);
      const sourceAvailable = directoryExists(binding.canonicalRoot);
      const applicability = project?.state === 'active' && sourceAvailable ? 'current' : 'historical_unknown';
      return Object.freeze({applicability, projectState: project?.state, sourceAvailable, checkedAt: new Date().toISOString()});
    },
    applicabilityForProject(projectId) {
      ensureReady();
      const project = catalog.getProject(checkedText(projectId, 'project id', 128));
      if (!project) return Object.freeze({applicability: 'unavailable', projectState: undefined, sourceAvailable: false, checkedAt: new Date().toISOString()});
      const repositories = project.repositories.filter((repo) => repo.enabled);
      if (repositories.length === 0) return Object.freeze({applicability: 'unavailable', projectState: project.state, sourceAvailable: false, checkedAt: new Date().toISOString()});
      // Project-level applicability is the *worst* of its enabled repositories: one unavailable
      // source root must not let the whole project claim "current".
      let sourceAvailable = true;
      for (const repository of repositories) {
        const binding = scopes.get(repository.scopeRef);
        if (!binding || !directoryExists(binding.canonicalRoot)) { sourceAvailable = false; break; }
      }
      const applicability = project.state === 'active' && sourceAvailable ? 'current' : 'historical_unknown';
      return Object.freeze({applicability, projectState: project.state, sourceAvailable, checkedAt: new Date().toISOString()});
    },
    bindingForSession(session) {
      if (state !== 'ready') return undefined;
      const cwd = session?.header?.cwd;
      if (typeof cwd !== 'string' || !cwd) return undefined;
      let resolved;
      try { resolved = normalizeRoot(cwd); } catch { return undefined; }
      const cached = cwdCache.get(resolved);
      if (cached !== undefined) return cached;
      let best;
      for (const binding of bindings) {
        if (!boundPath(binding.worktreeRoot, resolved)) continue;
        if (!best || binding.worktreeRoot.length > best.worktreeRoot.length) best = binding;
      }
      cwdCache.set(resolved, best);
      return best;
    },
    storeFor(scopeRef) {
      ensureReady();
      const binding = registry.bindingForScope(scopeRef);
      if (!binding) throw failure('SCOPE_NOT_FOUND', 'scope is not registered');
      const existing = stores.get(binding.scopeRef);
      if (existing) return existing;
      if (stores.size >= SCOPE_CACHE_LIMIT) throw failure('SCOPE_LIMIT', 'too many open memory scopes');
      const root = join(dataRoot, 'hot', 'scopes', digest(binding.scopeRef));
      try {
        const store = openStoreImpl(root, {scopeRef: binding.scopeRef});
        stores.set(binding.scopeRef, store);
        return store;
      } catch (error) {
        throw failure('STORE_UNAVAILABLE', `memory store is unavailable (${errorCode(error)})`);
      }
    },
    queueFor(scopeRef) {
      ensureReady();
      if (typeof createQueue !== 'function') throw failure('QUEUE_UNAVAILABLE', 'no queue factory was configured');
      const key = checkedText(scopeRef, 'scope reference', 2048);
      const existing = queues.get(key);
      if (existing) return existing;
      let queue;
      try { queue = createQueue(registry.storeFor(key), registry.bindingForScope(key)); } catch (error) { throw failure('QUEUE_UNAVAILABLE', `job queue is unavailable (${errorCode(error)})`); }
      queues.set(key, queue);
      return queue;
    },
    preferencesForScope(scopeRef) {
      const binding = registry.bindingForScope(scopeRef);
      if (!binding) throw failure('SCOPE_NOT_FOUND', 'scope is not registered');
      const project = catalog.getProject(binding.projectId);
      if (!project) throw failure('PROJECT_NOT_FOUND', 'project is not registered');
      return {project, preferences: project.preferences};
    },
    getReminder(scopeRef, recordId, claimRef) {
      ensureReady();
      return catalog.getReminder(scopeRef, recordId, claimRef);
    },
    setReminder(entry) {
      ensureReady();
      return catalog.setReminder(entry);
    },
    status() {
      return Object.freeze({
        state,
        dataRoot,
        projectCount: catalog ? catalog.listProjects().length : 0,
        activeProjectCount: catalog ? catalog.listProjects().filter((project) => project.state === 'active').length : 0,
        scopeCount: scopes.size,
        openStores: stores.size,
        degraded: Object.freeze([...degraded]),
      });
    },
    close() {
      for (const store of [...stores.values()]) {
        try { store.close(); } catch { diagnostic('store_close_failed'); }
      }
      stores.clear();
      queues.clear();
      scopes.clear();
      bindings = [];
      if (catalog) { try { catalog.close(); } catch { /* best effort */ } catalog = undefined; }
      state = 'closed';
    },
  };

  function ensureReady() {
    if (state !== 'ready') throw failure('REGISTRY_UNAVAILABLE', 'registry is not ready');
  }
  function normalizeRepositories(repositories) {
    if (!Array.isArray(repositories) || repositories.length < 1 || repositories.length > 16) throw failure('INVALID_REPOSITORIES', 'repositories must contain 1..16 entries');
    const seen = new Set();
    return repositories.map((repository) => {
      if (!repository || typeof repository !== 'object' || Array.isArray(repository)) throw failure('INVALID_REPOSITORIES', 'invalid repository entry');
      const resolved = resolveBinding(repository);
      if (seen.has(resolved.repoId)) throw failure('DUPLICATE_REPOSITORY', 'repository ids must be unique');
      seen.add(resolved.repoId);
      return resolved;
    });
  }
  return Object.freeze(registry);
}
