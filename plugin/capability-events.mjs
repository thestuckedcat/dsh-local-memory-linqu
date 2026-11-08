import {consumeCapabilityEvent} from '../src/lifecycle.mjs';
import {checkedText} from '../src/scope.mjs';
import {clean, fingerprint, integer, shape} from '../src/validation.mjs';

/**
 * MEM-204 capability-event consumer (contract v1).
 *
 * A future 03 adapter persists a producer outbox and hands events to this consumer. The consumer
 * is deliberately conservative: it never treats "no event" as freshness, never silently applies a
 * late/gapped/partial/unknown outcome, and never guesses the producer's current generation. A
 * trusted baseline (`establishBaseline`) or a trusted `getScopeState` recheck is required before a
 * held scope resumes; absent that seam the affected scope stays held and the plugin pauses its use.
 *
 * The module does not claim that the real Host/03 currently emits these events. In this build the
 * optional `capability/event` Host bus listener is a future transport seam; tests drive the
 * consumer directly with fixture events.
 */
const SOURCE = '03-session-management';
const KINDS = Object.freeze(['session_surface_rewound', 'workspace_files_restored', 'session_removed']);
const OUTCOMES = Object.freeze(['completed', 'partial', 'outcome_unknown']);
const FIELDS = Object.freeze(['schema_version', 'event_id', 'kind', 'source_capability', 'scope_ref', 'session_ref', 'operation_id', 'generation', 'affected_refs', 'outcome', 'before_snapshot', 'after_snapshot', 'occurred_at']);
const MAX_AFFECTED = 100;
const MAX_EVENTS = 2048;

function error(code, message = code) {
  const value = new Error(message);
  value.code = code;
  return value;
}

export function createCapabilityEventConsumer({catalog, registry, now = () => new Date(), getScopeState} = {}) {
  if (!catalog || typeof catalog.read !== 'function' || typeof catalog.write !== 'function' || typeof catalog.db?.prepare !== 'function') throw error('CAPABILITY_CONSUMER_UNAVAILABLE', 'project catalog required');
  if (!registry || typeof registry.storeFor !== 'function') throw error('CAPABILITY_CONSUMER_UNAVAILABLE', 'project registry required');
  if (typeof now !== 'function') throw error('CAPABILITY_CONSUMER_UNAVAILABLE', 'consumer clock required');
  if (getScopeState !== undefined && typeof getScopeState !== 'function') throw error('CAPABILITY_CONSUMER_UNAVAILABLE', 'getScopeState must be a function');
  const db = catalog.db;
  const clock = () => {
    try {
      const value = now();
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(+date)) throw new Error('clock');
      return date.toISOString();
    } catch {
      return new Date().toISOString();
    }
  };
  function cursor(source, scopeRef) {
    return catalog.read(() => db.prepare('SELECT * FROM capability_cursors WHERE source_capability=? AND scope_ref=?').get(source, scopeRef));
  }
  function holds(scopeRef) {
    return catalog.read(() => db.prepare('SELECT * FROM capability_holds WHERE scope_ref=? ORDER BY created_at').all(scopeRef));
  }
  function hold(source, scopeRef, reason, generation, detail) {
    const at = clock();
    catalog.write(() => {
      db.prepare(`INSERT INTO capability_holds(source_capability,scope_ref,reason,observed_generation,detail,created_at,updated_at)
 VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(source_capability,scope_ref,reason) DO UPDATE SET observed_generation=excluded.observed_generation,detail=excluded.detail,updated_at=excluded.updated_at`)
        .run(source, scopeRef, reason, Number.isSafeInteger(generation) ? generation : null, detail ?? null, at, at);
    });
    return Object.freeze({state: 'held', reason});
  }
  function noteEvent(scopeRef, eventId, eventFingerprint, applied) {
    const at = clock();
    catalog.write(() => {
      db.prepare(`INSERT INTO capability_events(scope_ref,event_id,fingerprint,applied,received_at) VALUES(?,?,?,?,?)
 ON CONFLICT(scope_ref,event_id) DO UPDATE SET fingerprint=excluded.fingerprint,applied=excluded.applied,received_at=excluded.received_at`)
        .run(scopeRef, eventId, eventFingerprint, applied ? 1 : 0, at);
      db.prepare("DELETE FROM capability_events WHERE rowid IN (SELECT rowid FROM capability_events ORDER BY received_at DESC LIMIT -1 OFFSET ?)").run(MAX_EVENTS);
    });
  }
  function validate(event) {
    shape(event, FIELDS, 'capability event');
    clean(event);
    if (event.schema_version !== 1) throw error('CAPABILITY_EVENT_INVALID', 'unsupported capability event schema');
    if (event.source_capability !== SOURCE) throw error('CAPABILITY_EVENT_INVALID', 'unknown capability event source');
    if (!KINDS.includes(event.kind)) throw error('CAPABILITY_EVENT_INVALID', 'unknown capability event kind');
    if (!OUTCOMES.includes(event.outcome)) throw error('CAPABILITY_EVENT_INVALID', 'unknown capability event outcome');
    if (!Number.isSafeInteger(event.generation) || event.generation < 0) throw error('CAPABILITY_EVENT_INVALID', 'invalid capability event generation');
    if (!Array.isArray(event.affected_refs) || event.affected_refs.length < 1 || event.affected_refs.length > MAX_AFFECTED) throw error('CAPABILITY_EVENT_INVALID', 'invalid affected refs');
    const scopeRef = checkedText(event.scope_ref, 'capability scope', 2048);
    const eventId = checkedText(event.event_id, 'capability event ID', 256);
    checkedText(event.operation_id, 'capability operation ID', 256);
    checkedText(event.occurred_at, 'capability event time', 64);
    event.affected_refs.forEach((ref) => checkedText(ref, 'affected source', 2048));
    if (event.kind === 'session_removed') checkedText(event.session_ref, 'session reference', 512);
    return {scopeRef, eventId, eventFingerprint: fingerprint(event)};
  }
  /** Record the producer's current generation after a trusted adapter recheck; never guessed. */
  function establishBaseline({scopeRef, generation, eventId = null, outcome = 'completed'} = {}) {
    const scope = checkedText(scopeRef, 'capability scope', 2048);
    integer(generation, 0, Number.MAX_SAFE_INTEGER, 'capability baseline generation');
    const at = clock();
    catalog.write(() => {
      db.prepare(`INSERT INTO capability_cursors(source_capability,scope_ref,last_generation,last_event_id,last_outcome,updated_at)
 VALUES(?,?,?,?,?,?)
 ON CONFLICT(source_capability,scope_ref) DO UPDATE SET last_generation=excluded.last_generation,last_event_id=excluded.last_event_id,last_outcome=excluded.last_outcome,updated_at=excluded.updated_at`)
        .run(SOURCE, scope, generation, eventId ?? null, outcome, at);
      // A trusted baseline is the adapter's recheck; it is the only path that resumes a held scope.
      db.prepare('DELETE FROM capability_holds WHERE source_capability=? AND scope_ref=?').run(SOURCE, scope);
    });
    return Object.freeze({state: 'baseline', scopeRef: scope, generation});
  }
  /**
   * Consume one contract-v1 event. Sequential completed events apply through the existing
   * lifecycle authority; anything that cannot be confirmed (no baseline, gap, late, partial,
   * unknown, unregistered scope, store error) creates a visible hold and does not apply.
   */
  function consume(event) {
    const {scopeRef, eventId, eventFingerprint} = validate(event);
    const priorEvent = catalog.read(() => db.prepare('SELECT applied FROM capability_events WHERE scope_ref=? AND event_id=?').get(scopeRef, eventId));
    if (priorEvent && priorEvent.applied === 1) return Object.freeze({state: 'duplicate', applied: true, eventId});
    const current = cursor(SOURCE, scopeRef);
    if (event.outcome !== 'completed') {
      noteEvent(scopeRef, eventId, eventFingerprint, false);
      return hold(SOURCE, scopeRef, event.outcome === 'outcome_unknown' ? 'outcome_unknown' : `outcome_${event.outcome}`, event.generation, eventId);
    }
    if (getScopeState !== undefined) {
      let state;
      try { state = getScopeState({sourceCapability: SOURCE, scopeRef, generation: event.generation}); } catch { state = undefined; }
      if (state && Number.isSafeInteger(state.generation) && state.generation !== event.generation) {
        noteEvent(scopeRef, eventId, eventFingerprint, false);
        return hold(SOURCE, scopeRef, 'producer_state_mismatch', event.generation, eventId);
      }
    }
    if (!current) {
      noteEvent(scopeRef, eventId, eventFingerprint, false);
      return hold(SOURCE, scopeRef, 'baseline_unknown', event.generation, eventId);
    }
    if (event.generation > current.last_generation + 1) {
      noteEvent(scopeRef, eventId, eventFingerprint, false);
      return hold(SOURCE, scopeRef, 'generation_gap', event.generation, eventId);
    }
    if (event.generation <= current.last_generation) {
      noteEvent(scopeRef, eventId, eventFingerprint, false);
      return hold(SOURCE, scopeRef, 'late_generation_requires_recheck', event.generation, eventId);
    }
    let store;
    try {
      const binding = registry.bindingForScope?.(scopeRef);
      if (!binding) {
        noteEvent(scopeRef, eventId, eventFingerprint, false);
        return hold(SOURCE, scopeRef, 'scope_not_registered', event.generation, eventId);
      }
      store = registry.storeFor(scopeRef);
    } catch {
      noteEvent(scopeRef, eventId, eventFingerprint, false);
      return hold(SOURCE, scopeRef, 'store_unavailable', event.generation, eventId);
    }
    try {
      const result = consumeCapabilityEvent(store, {...event});
      let derivedInvalidated;
      try { derivedInvalidated = store.invalidateConsolidationScope?.({reason: `capability:${event.kind}`}); } catch { derivedInvalidated = undefined; }
      const at = clock();
      catalog.write(() => {
        db.prepare(`INSERT INTO capability_cursors(source_capability,scope_ref,last_generation,last_event_id,last_outcome,updated_at)
 VALUES(?,?,?,?,?,?)
 ON CONFLICT(source_capability,scope_ref) DO UPDATE SET last_generation=excluded.last_generation,last_event_id=excluded.last_event_id,last_outcome=excluded.last_outcome,updated_at=excluded.updated_at`)
          .run(SOURCE, scopeRef, event.generation, eventId, event.outcome, at);
      });
      noteEvent(scopeRef, eventId, eventFingerprint, true);
      return Object.freeze({state: 'applied', duplicate: result?.duplicate === true, generation: event.generation, eventId, ...(derivedInvalidated ? {derivedInvalidated} : {})});
    } catch {
      noteEvent(scopeRef, eventId, eventFingerprint, false);
      return hold(SOURCE, scopeRef, 'apply_failed', event.generation, eventId);
    }
  }
  function isHeld(scopeRef) {
    if (typeof scopeRef !== 'string' || !scopeRef) return false;
    try { return holds(scopeRef).length > 0; } catch { return true; }
  }
  function status() {
    const value = catalog.read(() => ({
      cursors: db.prepare('SELECT count(*) AS n FROM capability_cursors').get().n,
      holds: db.prepare('SELECT count(*) AS n FROM capability_holds').get().n,
      events: db.prepare('SELECT count(*) AS n FROM capability_events').get().n,
      applied: db.prepare('SELECT count(*) AS n FROM capability_events WHERE applied=1').get().n,
    }));
    return Object.freeze(value);
  }
  return Object.freeze({consume, establishBaseline, isHeld, status});
}
