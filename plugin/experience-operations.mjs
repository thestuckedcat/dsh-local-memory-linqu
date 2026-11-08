import {checkedText} from '../src/scope.mjs';
import {integer} from '../src/validation.mjs';

/**
 * Read-only experience operations exposed to the Memory Center client.
 * `memory.attribution` only resolves within the caller's own session for non-user actors;
 * `memory.excerpts` returns metadata/source refs only (never the evidence body).
 */
export function createExperienceOperations({attribution, sessions, registry} = {}) {
  if (!attribution || typeof attribution.read !== 'function') throw new Error('Attribution manager required');
  function rawObject(input) {
    return input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  }
  function readAttribution(input, context) {
    const raw = rawObject(input);
    const sessionReader = sessions && typeof sessions.get === 'function' ? sessions : undefined;
    const contextSession = context?.sessionId ?? context?.session?.id;
    const requested = raw.sessionId === undefined ? contextSession : checkedText(raw.sessionId, 'session id', 256);
    if (raw.sessionId !== undefined && context?.actor !== 'user' && requested !== contextSession) {
      return {ok: false, error: {code: 'USER_ACTION_REQUIRED', message: 'A model may only read its own session attribution.'}};
    }
    if (typeof requested !== 'string' || !requested) return {ok: false, error: {code: 'SESSION_REQUIRED', message: 'Session is required for memory attribution.'}};
    const turn = integer(raw.turn, 0, Number.MAX_SAFE_INTEGER, 'turn');
    const session = sessionReader?.get(requested);
    if (!session) return {ok: false, error: {code: 'SESSION_NOT_FOUND', message: 'Session is not live; attribution is unavailable.'}};
    const value = attribution.read({sessionId: requested, turn, session});
    return {ok: true, value: Object.freeze({...value})};
  }
  function projectIdOf(input, context) {
    if (input.projectId !== undefined) return checkedText(input.projectId, 'project id', 128);
    if (registry && typeof registry.bindingForSession === 'function' && sessions && typeof sessions.get === 'function') {
      const sessionId = context?.sessionId ?? context?.session?.id;
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      const binding = session ? registry.bindingForSession(session) : undefined;
      if (binding?.projectId) return binding.projectId;
    }
    return undefined;
  }
  function readExcerpts(input, context) {
    const raw = rawObject(input);
    const projectId = projectIdOf(raw, context);
    if (!projectId) return {ok: false, error: {code: 'PROJECT_REQUIRED', message: 'Select a project to list memory excerpts.'}};
    if (!registry || typeof registry.getProject !== 'function' || typeof registry.storeFor !== 'function') {
      return {ok: false, error: {code: 'REGISTRY_UNAVAILABLE', message: 'Project registry is unavailable.'}};
    }
    const project = registry.getProject(projectId);
    if (!project) return {ok: false, error: {code: 'PROJECT_NOT_FOUND', message: 'Project is not registered.'}};
    const repository = (project.repositories ?? []).find((entry) => entry.enabled);
    if (!repository) return {ok: false, error: {code: 'SCOPE_NOT_FOUND', message: 'Project has no enabled repository.'}};
    const memoryId = checkedText(raw.memoryId, 'memory reference', 256);
    const limit = raw.limit === undefined ? 20 : integer(raw.limit, 1, 100, 'excerpt limit');
    const items = registry.storeFor(repository.scopeRef).listExcerpts({memoryId, limit});
    return {ok: true, value: Object.freeze({projectId, memoryId, items, total: items.length})};
  }
  return Object.freeze({
    'memory.attribution': (input, context) => {
      try { return readAttribution(input, context); }
      catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'INVALID_INPUT';
        return {ok: false, error: {code, message: 'Memory attribution is unavailable.'}};
      }
    },
    'memory.excerpts': (input, context) => {
      try { return readExcerpts(input, context); }
      catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'INVALID_INPUT';
        return {ok: false, error: {code, message: 'Memory excerpts are unavailable.'}};
      }
    },
  });
}
