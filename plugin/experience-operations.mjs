import {checkedText} from '../src/scope.mjs';
import {integer} from '../src/validation.mjs';

/**
 * Read-only experience operations exposed to the Memory Center client.
 * `memory.attribution` only resolves within the caller's own session for non-user actors.
 */
export function createExperienceOperations({attribution, sessions} = {}) {
  if (!attribution || typeof attribution.read !== 'function') throw new Error('Attribution manager required');
  function read(input, context) {
    const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
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
  return Object.freeze({'memory.attribution': (input, context) => {
    try { return read(input, context); }
    catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'INVALID_INPUT';
      return {ok: false, error: {code, message: 'Memory attribution is unavailable.'}};
    }
  }});
}
