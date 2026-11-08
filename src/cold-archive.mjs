import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fingerprint} from './validation.mjs';
import {planLayout} from './storage-layout.mjs';

/**
 * Cold-transfer journal skeleton (MEM-304 subset).
 *
 * It records only local transfer metadata and digests, never memory text. This increment does not
 * copy, index, recall or delete any memory body; it proves the prepared -> copied_verified ->
 * index_switched -> source_cleaned journal contract and fail-closed recovery.
 */
const STATES = Object.freeze(['prepared', 'copied_verified', 'index_switched', 'source_cleaned']);
const NEXT = Object.freeze({prepared: 'copied_verified', copied_verified: 'index_switched', index_switched: 'source_cleaned', source_cleaned: null});
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function fail(message) {
  const error = new Error(message);
  error.code = 'MEM_COLD_JOURNAL_INVALID';
  throw error;
}
function checkId(id) {
  if (typeof id !== 'string' || !ID.test(id)) fail('Invalid cold journal id');
  return id;
}
function digestOf(value) { const {digest, ...rest} = value; return fingerprint(rest); }
function checkState(state) {
  if (!STATES.includes(state)) fail('Unknown cold journal state');
  return state;
}

export function createColdJournal({root, now = () => new Date()} = {}) {
  if (typeof root !== 'string' || root.trim() === '') fail('Local data root required for the cold journal');
  if (typeof now !== 'function') fail('Cold journal clock required');
  const dir = planLayout(root).coldJournal;
  const fileOf = (id) => join(dir, `${checkId(id)}.json`);
  function clock() { try { return now().toISOString(); } catch { return new Date().toISOString(); } }
  function read(id) {
    const file = fileOf(id);
    if (!existsSync(file)) fail('Cold journal entry not found');
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('Cold journal entry is corrupt'); }
    if (!raw || raw.schema_version !== 1 || raw.id !== id || !STATES.includes(raw.state) || typeof raw.digest !== 'string') fail('Cold journal entry is invalid');
    if (digestOf(raw) !== raw.digest) fail('Cold journal digest mismatch');
    return Object.freeze({...raw});
  }
  function writeAtomic(id, value) {
    const file = fileOf(id);
    const temp = `${file}.tmp-${randomUUID()}`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {encoding: 'utf8', flag: 'wx', mode: 0o600});
    renameSync(temp, file);
  }
  function begin({id, scopeRef, sourceDigest, size} = {}) {
    const operationId = checkId(id);
    if (typeof scopeRef !== 'string' || scopeRef.length < 1 || scopeRef.length > 2048) fail('Cold journal scope required');
    if (typeof sourceDigest !== 'string' || !HEX.test(sourceDigest)) fail('Cold journal source digest required');
    if (!Number.isSafeInteger(size) || size < 0 || size > 1_000_000_000) fail('Cold journal size required');
    if (existsSync(fileOf(operationId))) fail('Cold journal entry already exists');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const base = {schema_version: 1, id: operationId, scopeRef, sourceDigest, size, state: 'prepared', payloadDigest: null, createdAt: clock(), updatedAt: clock()};
    const value = {...base, digest: digestOf(base)};
    writeAtomic(operationId, value);
    return Object.freeze({...value});
  }
  function advance({id, state, payloadDigest} = {}) {
    const entry = read(id);
    const next = checkState(state);
    if (NEXT[entry.state] !== next) fail(`Cold journal cannot move ${entry.state} -> ${next}`);
    if (next === 'copied_verified' && (typeof payloadDigest !== 'string' || !HEX.test(payloadDigest))) fail('Cold journal copied payload digest required');
    const base = {schema_version: 1, id: entry.id, scopeRef: entry.scopeRef, sourceDigest: entry.sourceDigest, size: entry.size, state: next, payloadDigest: next === 'copied_verified' ? payloadDigest : entry.payloadDigest, createdAt: entry.createdAt, updatedAt: clock()};
    const value = {...base, digest: fingerprint(base)};
    writeAtomic(entry.id, value);
    return Object.freeze({...value});
  }
  function recover() {
    if (!existsSync(dir)) return Object.freeze({entries: Object.freeze([]), corrupt: Object.freeze([])});
    const entries = [], corrupt = [];
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      try { entries.push(read(name.slice(0, -5))); } catch { corrupt.push(name); }
    }
    return Object.freeze({entries: Object.freeze(entries), corrupt: Object.freeze(corrupt)});
  }
  return Object.freeze({begin, advance, recover, read});
}

export {STATES as COLD_JOURNAL_STATES};
