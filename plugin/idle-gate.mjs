/**
 * Conservative foreground-idle gate for background memory work (MEM-BG-1 BG-S03).
 *
 * The gate is read-only: it observes Host agent/session status events and never dispatches a
 * model request. A background dispatcher (not part of this increment) may call `canDispatch()`
 * before any send. Unknown initial state, a running agent, or an unexpired quiet window all
 * fail closed; the gate never treats a missing event as proof of idleness.
 *
 * The 30s quiet window is measured from the last observed idle transition/activity. It is a
 * design default, not a claim that a real background queue exists.
 */
const DEFAULT_QUIET_MS = 30_000;
const MAX_AGENTS = 512;

export function createBusyGate({agents, now = () => Date.now(), quietMs = DEFAULT_QUIET_MS} = {}) {
  if (!Number.isSafeInteger(quietMs) || quietMs < 0 || quietMs > 3_600_000) throw new Error('Invalid quiet window');
  if (typeof now !== 'function') throw new Error('Busy-gate clock required');
  const statuses = new Map();
  let lastActivityAt = null;
  let listFailure = false;
  function clock() {
    const value = now();
    const ms = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(ms) ? ms : Date.now();
  }
  lastActivityAt = clock();
  function listAgents() {
    if (!agents || typeof agents.list !== 'function') return [];
    try {
      const value = agents.list();
      if (!Array.isArray(value)) throw new Error('agent list unavailable');
      listFailure = false;
      return value;
    } catch {
      listFailure = true;
      return null;
    }
  }
  function discover() {
    const listed = listAgents();
    if (listed === null) return;
    for (const agent of listed) {
      const id = typeof agent === 'string' ? agent : agent?.id;
      if (typeof id !== 'string' || !id) continue;
      if (!statuses.has(id) && statuses.size < MAX_AGENTS) statuses.set(id, {state: 'unknown', since: null});
    }
  }
  function prune() {
    const listed = listAgents();
    if (listed === null) return;
    const live = new Set(listed.map((agent) => (typeof agent === 'string' ? agent : agent?.id)).filter((id) => typeof id === 'string' && id));
    for (const id of [...statuses.keys()]) if (!live.has(id)) statuses.delete(id);
  }
  function setStatus(id, state) {
    if (typeof id !== 'string' || !id) return;
    const current = statuses.get(id);
    if (current?.state === state) return;
    const at = clock();
    statuses.set(id, {state, since: at});
    // Starting a run or going idle both restart the quiet window; a stale idle transition from
    // another agent must not make the whole Host look quiet immediately.
    lastActivityAt = at;
  }
  function noteAgentStatus(idOrAgent, status) {
    const id = typeof idOrAgent === 'string' ? idOrAgent : idOrAgent?.id;
    if (status === 'running' || status === 'idle') setStatus(id, status);
  }
  function noteSessionStatus(sessionId, running) {
    if (typeof sessionId !== 'string' || !sessionId) return;
    setStatus(sessionId, running === true ? 'running' : 'idle');
  }
  function noteDisposed(idOrAgent) {
    const id = typeof idOrAgent === 'string' ? idOrAgent : idOrAgent?.id;
    if (typeof id === 'string' && id) statuses.delete(id);
  }
  function status() {
    discover();
    const at = clock();
    if (listFailure) {
      let running = 0, unknown = 0, idle = 0;
      for (const entry of statuses.values()) {
        if (entry.state === 'running') running += 1;
        else if (entry.state === 'unknown') unknown += 1;
        else idle += 1;
      }
      const quietForMs = lastActivityAt === null ? null : Math.max(0, at - lastActivityAt);
      return Object.freeze({state: 'unknown', running, unknown, idle, agents: statuses.size, quietForMs, quietMs, listFailed: true, at: new Date(at).toISOString()});
    }
    prune();
    let running = 0, unknown = 0, idle = 0;
    for (const entry of statuses.values()) {
      if (entry.state === 'running') running += 1;
      else if (entry.state === 'unknown') unknown += 1;
      else idle += 1;
    }
    const quietForMs = lastActivityAt === null ? null : Math.max(0, at - lastActivityAt);
    const state = running > 0 ? 'busy'
      : unknown > 0 ? 'unknown'
      : quietForMs === null || quietForMs < quietMs ? 'quieting'
      : 'idle';
    return Object.freeze({state, running, unknown, idle, agents: statuses.size, quietForMs, quietMs, at: new Date(at).toISOString()});
  }
  function canDispatch() {
    return status().state === 'idle';
  }
  return Object.freeze({noteAgentStatus, noteSessionStatus, noteDisposed, status, canDispatch});
}
