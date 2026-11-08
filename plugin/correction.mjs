/**
 * Explicit natural-language correction intake (MEM-EXP-1 EXP-05 partial).
 *
 * This module only reacts to a narrow set of explicit correction phrases and only to memory refs
 * the assistant actually cited in the latest completed turn. It immediately stops those old
 * versions from future recall (entry state -> stale, derived/excerpt copies invalidated) and keeps
 * their stored body for normal archive/delete. It does not claim to know the correct replacement:
 * the current user message still goes through the normal extraction/admission path, and deeper
 * background reflection/root-cause analysis is not implemented in this increment.
 */
import {fingerprint} from '../src/validation.mjs';

const CORRECTION_PATTERNS = Object.freeze([
  /这里(?:已经|已经)?改(?:了|成|过)/u,
  /上次(?:理解|记|说)(?:错|反)了/u,
  /(?:我|你)(?:之前|上次)(?:说|理解|记)(?:错|反)了/u,
  /不是这样(?:的)?(?:了|了|，|,|。|$)/u,
  /更正一下|纠正一下|说错了|记错了/u,
  /已经(?:不再|不)适用|现已(?:变更|修改|改用)/u,
  /\bthat(?:'s| is) wrong\b/i,
  /\bi was wrong\b/i,
  /\b(?:already|has) changed\b/i,
  /\bno longer (?:true|applicable)\b/i,
  /\bcorrect(?:ion| that)\b/i,
]);

export function detectCorrectionIntent(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  return CORRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function createCorrectionManager({attribution, now = () => new Date()} = {}) {
  if (!attribution || typeof attribution.latestCited !== 'function') throw new Error('Attribution citations required for corrections');
  if (typeof now !== 'function') throw new Error('Correction clock required');
  const counters = {detected: 0, applied: 0, unresolved: 0, failed: 0, suspended: 0};
  function onMessageAdmitted(info) {
    const input = info?.candidate?.input;
    if (!detectCorrectionIntent(input)) return Object.freeze({state: 'none'});
    counters.detected += 1;
    const sessionId = info?.session?.id ?? info?.sessionId;
    let latest;
    try { latest = attribution.latestCited(sessionId); } catch { latest = undefined; }
    if (!latest || latest.records.length === 0) {
      counters.unresolved += 1;
      return Object.freeze({state: 'unresolved', reason: 'no_cited_memory'});
    }
    const store = info?.binding?.store;
    if (!store || typeof store.suspendForCorrection !== 'function') {
      counters.unresolved += 1;
      return Object.freeze({state: 'unresolved', reason: 'store_unavailable'});
    }
    let suspended = 0;
    let failed = 0;
    for (const record of latest.records) {
      try {
        store.suspendForCorrection({id: record.id, expectedGeneration: store.generation(), reason: 'user_correction'});
        suspended += 1;
      } catch { failed += 1; }
    }
    let enqueued = false;
    if (suspended > 0) {
      counters.applied += 1;
      counters.suspended += suspended;
      const queue = info?.binding?.queue;
      const sourceRef = typeof info.sourceRef === 'string' ? info.sourceRef : undefined;
      const sourceVersion = typeof info.sourceVersion === 'string' ? info.sourceVersion : undefined;
      const text = typeof input === 'string' ? input.slice(0, 8000) : '';
      if (queue && typeof queue.enqueue === 'function' && sourceRef && sourceVersion && text.trim()) {
        try {
          queue.enqueue({
            requestId: `correction-v1:${fingerprint({session: info.binding.sessionRef, message: info.candidate?.id, generation: store.generation()})}`,
            scopeRef: info.binding.scopeRef,
            sessionRef: info.binding.sessionRef,
            sourceRef,
            sourceVersion,
            fragmentRef: 'user-text-v1',
            inputRef: `${sourceRef}/text`,
            inputClass: 'conversation_fragment',
            input: text,
            routeRef: info.binding.routeRef,
            generation: store.generation(),
            purpose: 'memory_extract',
          });
          enqueued = true;
        } catch { failed += 1; }
      }
    }
    if (failed > 0) counters.failed += 1;
    return Object.freeze({
      state: suspended > 0 ? 'corrected' : 'unresolved',
      turn: latest.turn,
      suspended,
      failed,
      enqueued,
      at: now().toISOString(),
    });
  }
  function status() {
    return Object.freeze({...counters});
  }
  return Object.freeze({onMessageAdmitted, status});
}
