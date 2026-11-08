import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';

/**
 * Per-scope dirty marker for optional automatic consolidation (MEM-BG-1 BG-S01 partial).
 *
 * The marker is a small local JSON file next to the scope store; it never contains memory text.
 * It is local, single-writer (the plugin process) and best-effort: a corrupt marker is treated as
 * unavailable and never makes the worker send a model request. Automatic enqueue is still gated
 * by config.consolidation.enabled and the foreground idle gate.
 */
const FILE = 'consolidation-dirty.json';
function fileOf(store) {
  if (typeof store?.scopeRef !== 'string' || typeof store?.databasePath !== 'string') throw new Error('Memory store with scope/database path required');
  return join(dirname(store.databasePath), FILE);
}
function clampChanges(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100000) throw new Error('Invalid dirty change count');
  return value;
}
function read(store, now) {
  const file = fileOf(store);
  if (!existsSync(file)) return {changes: 0, firstAt: null, lastAt: null};
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Consolidation dirty marker is corrupt'); }
  if (!raw || raw.schema_version !== 1 || raw.scopeRef !== store.scopeRef || !Number.isSafeInteger(raw.changes)) throw new Error('Consolidation dirty marker is invalid');
  if (raw.changes === 0) return {changes: 0, firstAt: null, lastAt: null};
  const first = Date.parse(raw.firstAt), last = Date.parse(raw.lastAt);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) throw new Error('Consolidation dirty marker is invalid');
  return {changes: raw.changes, firstAt: raw.firstAt, lastAt: raw.lastAt};
}
function write(store, value, now) {
  const at = now().toISOString();
  const file = fileOf(store);
  const temp = `${file}.tmp-${randomUUID()}`;
  const payload = {schema_version: 1, scopeRef: store.scopeRef, changes: value.changes, firstAt: value.firstAt, lastAt: value.lastAt, updatedAt: at};
  writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', {encoding: 'utf8', flag: 'wx', mode: 0o600});
  renameSync(temp, file);
  return {changes: value.changes, firstAt: value.firstAt, lastAt: value.lastAt};
}
export function createConsolidationDirty({now = () => new Date()} = {}) {
  if (typeof now !== 'function') throw new Error('Dirty marker clock required');
  function clock() { try { return now(); } catch { return new Date(); } }
  function status(store) {
    const value = read(store, clock);
    return Object.freeze({...value, scopeRef: store.scopeRef});
  }
  function noteChange(store, {count = 1, at} = {}) {
    const increment = clampChanges(count);
    if (increment === 0) return status(store);
    const existing = read(store, clock);
    const time = at === undefined ? clock().toISOString() : new Date(at).toISOString();
    if (Number.isNaN(Date.parse(time))) throw new Error('Invalid dirty change time');
    const next = {changes: Math.min(100000, existing.changes + increment), firstAt: existing.firstAt ?? time, lastAt: time};
    return Object.freeze({...write(store, next, clock), scopeRef: store.scopeRef});
  }
  function reset(store) {
    const values = write(store, {changes: 0, firstAt: null, lastAt: null}, clock);
    return Object.freeze({...values, scopeRef: store.scopeRef});
  }
  function due(store, {threshold = 10, maxWaitMs = 3600_000} = {}) {
    const value = read(store, clock);
    if (value.changes === 0) return Object.freeze({due: false, ...value, reason: 'clean'});
    if (value.changes >= threshold) return Object.freeze({due: true, ...value, reason: 'threshold'});
    const age = clock().getTime() - Date.parse(value.firstAt);
    if (age >= maxWaitMs) return Object.freeze({due: true, ...value, reason: 'max_wait'});
    return Object.freeze({due: false, ...value, reason: 'waiting'});
  }
  return Object.freeze({status, noteChange, reset, due});
}
