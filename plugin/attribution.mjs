import {checkedText, digest} from '../src/scope.mjs';

/**
 * Turn-level memory attribution (MEM-EXP-1 / BG-U03).
 *
 * The plugin records which short refs were injected into a turn, parses the assistant's explicit
 * `〔记N〕` markers after the turn closes, and re-checks the cited records against the trusted
 * binding and live store before exposing a <=100-Unicode-code-point mapping. This is a visible
 * attribution aid, not proof that a model internally used a record: only declared markers count.
 * Records are never copied into the assistant message by this module.
 *
 * The first increment keeps attributions in process memory (lost on restart); durable storage is
 * a later migration and is not claimed here.
 */
const MARKER = /〔记(\d{1,2})〕|\[记(\d{1,2})\]/g;
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const MAPPING_LIMIT = 100;
const ENTRY_LIMIT = 512;

export function createAttributionManager({registry, now = () => new Date()} = {}) {
  if (!registry || typeof registry.bindingForSession !== 'function' || typeof registry.storeFor !== 'function') throw new Error('Trusted registry required for attribution');
  if (typeof now !== 'function') throw new Error('Attribution clock required');
  const turns = new Map();

  function keyOf(sessionId, turn) {
    return `${checkedText(sessionId, 'session id', 256)}:${Number(turn)}`;
  }
  function textOf(value) {
    return typeof value === 'string' ? value : '';
  }
  function assistantText(session, turn) {
    const parts = [];
    let events;
    try { events = session.ownEvents(); } catch { return ''; }
    for (const event of events) {
      if (event?.type !== 'assistant/message' || event.data?.turn !== turn) continue;
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('');
  }
  function noteRecall(info) {
    if (!info || typeof info.sessionId !== 'string' || !Number.isSafeInteger(info.turn)) return;
    const key = keyOf(info.sessionId, info.turn);
    const previous = turns.get(key);
    const records = new Map(previous?.records ?? []);
    for (const record of Array.isArray(info.records) ? info.records : []) {
      if (!record || typeof record.id !== 'string' || typeof record.ref !== 'string') continue;
      records.set(record.ref, Object.freeze({
        id: record.id,
        ref: record.ref,
        sourceRef: textOf(record.sourceRef),
        sourceVersion: textOf(record.sourceVersion),
        generation: record.generation,
        scopeRef: info.scopeRef,
      }));
    }
    turns.set(key, {sessionId: info.sessionId, turn: info.turn, records, scopeRef: info.scopeRef, at: now().toISOString()});
    if (turns.size > ENTRY_LIMIT) turns.delete(turns.keys().next().value);
  }
  function shortName(text) {
    const cleaned = textOf(text).replace(/\s+/g, ' ').replace(/[“”"]/g, '').trim();
    return Array.from(cleaned).slice(0, 14).join('') || '记录';
  }
  function resolveLive(record, session) {
    if (!record) return undefined;
    let binding;
    try { binding = registry.bindingForSession(session); } catch { return undefined; }
    if (!binding || binding.scopeRef !== record.scopeRef) return undefined;
    let live;
    try { live = registry.storeFor(binding.scopeRef).get(record.id); } catch { return undefined; }
    if (!live || live.state !== 'active') return undefined;
    if (live.generation !== record.generation) return undefined;
    if (live.sourceRef !== record.sourceRef || live.sourceVersion !== record.sourceVersion) return undefined;
    return {id: live.id, ref: record.ref, name: shortName(live.text), sourceRef: live.sourceRef, sourceVersion: live.sourceVersion, generation: live.generation};
  }
  function mappingOf(items) {
    const entries = items.map((item, index) => `${CIRCLED[index] ?? `(${index + 1})`}参考${item.ref}“${item.name}”`);
    return `记忆影响：${entries.join('；')}。`;
  }
  function handleTurnStopping({agent, turn} = {}) {
    const session = agent?.session;
    if (!session || !Number.isSafeInteger(turn)) return undefined;
    const key = keyOf(session.id, turn);
    const entry = turns.get(key);
    if (!entry || entry.records.size === 0) {
      turns.delete(key);
      return Object.freeze({state: 'none'});
    }
    const text = assistantText(session, turn);
    const seen = new Set();
    const items = [];
    let invalid = false;
    MARKER.lastIndex = 0;
    let match;
    while ((match = MARKER.exec(text)) !== null) {
      const ref = `记${Number(match[1] ?? match[2])}`;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const item = resolveLive(entry.records.get(ref), session);
      if (!item) { invalid = true; break; }
      items.push(item);
    }
    if (invalid) {
      turns.set(key, {sessionId: entry.sessionId, turn, records: entry.records, scopeRef: entry.scopeRef, state: 'unavailable', at: now().toISOString()});
      return Object.freeze({state: 'unavailable'});
    }
    if (items.length === 0) {
      turns.set(key, {sessionId: entry.sessionId, turn, records: entry.records, scopeRef: entry.scopeRef, state: 'none', at: now().toISOString()});
      return Object.freeze({state: 'none'});
    }
    let mapping = mappingOf(items);
    if (Array.from(mapping).length > MAPPING_LIMIT) {
      const shortened = items.map((item) => ({...item, name: Array.from(item.name).slice(0, 6).join('')}));
      mapping = mappingOf(shortened);
    }
    if (Array.from(mapping).length > MAPPING_LIMIT) {
      turns.set(key, {sessionId: entry.sessionId, turn, records: entry.records, scopeRef: entry.scopeRef, state: 'over_limit', items: Object.freeze(items), at: now().toISOString()});
      return Object.freeze({state: 'over_limit'});
    }
    const stored = {sessionId: entry.sessionId, turn, records: entry.records, scopeRef: entry.scopeRef, state: 'available', items: Object.freeze(items), mapping, at: now().toISOString()};
    turns.set(key, stored);
    return Object.freeze({state: 'available', mapping, items: Object.freeze(items)});
  }
  function read({sessionId, turn, session} = {}) {
    const key = keyOf(sessionId, turn);
    const entry = turns.get(key);
    if (!entry || entry.state === 'none') return Object.freeze({state: 'none', turn});
    if (entry.state !== 'available') return Object.freeze({state: entry.state, turn});
    const live = [];
    for (const item of entry.items) {
      const resolved = resolveLive({id: item.id, ref: item.ref, sourceRef: item.sourceRef, sourceVersion: item.sourceVersion, generation: item.generation, scopeRef: entry.scopeRef}, session);
      if (!resolved) return Object.freeze({state: 'unavailable', turn});
      live.push(Object.freeze({ref: resolved.ref, name: resolved.name, sourceRef: resolved.sourceRef, sourceVersion: resolved.sourceVersion}));
    }
    return Object.freeze({state: 'available', turn, mapping: entry.mapping, items: Object.freeze(live)});
  }
  function status() {
    let available = 0, unavailable = 0, overLimit = 0;
    for (const entry of turns.values()) {
      if (entry.state === 'available') available += 1;
      else if (entry.state === 'unavailable') unavailable += 1;
      else if (entry.state === 'over_limit') overLimit += 1;
    }
    return Object.freeze({turns: turns.size, available, unavailable, overLimit});
  }
  return Object.freeze({noteRecall, handleTurnStopping, read, status});
}
