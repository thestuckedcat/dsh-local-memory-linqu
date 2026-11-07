import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, readdirSync, realpathSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CORE_TABLES_SQL, FTS_SQL, FTS_REBUILD_SQL } from '../vendor/kovey/store/sqlite/schema.js';
import { materialize, upsertRecord, rawSearch, extractTerms } from '../vendor/kovey/store/sqlite/records.js';
import { checkedText, checkedScope, assertClean, digest } from './policy.mjs';

function rejectLink(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Memory path must not be a symlink');
}
function protectedDirectory(path) {
  rejectLink(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}
const AUTHORITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS authority.identity (id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS authority.scopes (scope_ref TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS authority.record_state (
 scope_ref TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL,
 text_hash TEXT NOT NULL, source_ref TEXT NOT NULL, source_version TEXT NOT NULL,
 generation INTEGER NOT NULL, PRIMARY KEY(scope_ref,record_id));
CREATE INDEX IF NOT EXISTS authority.record_source ON record_state(scope_ref,source_ref,source_version,text_hash);
CREATE TABLE IF NOT EXISTS authority.events (scope_ref TEXT NOT NULL,event_id TEXT NOT NULL,generation INTEGER NOT NULL,PRIMARY KEY(scope_ref,event_id));`;

/** One private database per explicit scope. The separate authority is not part of content backups. */
export function openStore(root, { scopeRef } = {}) {
  scopeRef = checkedScope(scopeRef);
  root = resolve(root);
  protectedDirectory(root);
  root = realpathSync(root);
  const scopesDir = join(root, 'scopes');
  protectedDirectory(scopesDir);
  const authorityPath = join(root, 'authority.sqlite');
  rejectLink(authorityPath);
  if (!existsSync(authorityPath) && readdirSync(scopesDir).length) throw new Error('Deletion authority is missing for existing memory');
  const scopeDir = join(scopesDir, digest(scopeRef));
  protectedDirectory(scopeDir);
  const file = join(scopeDir, 'memory.sqlite');
  rejectLink(file);
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
    db.prepare('ATTACH DATABASE ? AS authority').run(authorityPath);
    db.exec('PRAGMA authority.journal_mode=DELETE; PRAGMA authority.synchronous=FULL; PRAGMA authority.secure_delete=ON;');
    db.exec(AUTHORITY_SCHEMA);
    db.exec(CORE_TABLES_SQL);
    db.exec(FTS_SQL);
    db.exec(`CREATE TABLE IF NOT EXISTS controlled_records (
      id TEXT PRIMARY KEY REFERENCES records(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL, source_version TEXT NOT NULL, kind TEXT NOT NULL,
      generation INTEGER NOT NULL, text_hash TEXT NOT NULL, supersedes TEXT, origin TEXT NOT NULL);`);
    db.exec('BEGIN IMMEDIATE');
    let identity = db.prepare('SELECT id FROM authority.identity').get()?.id;
    if (!identity) { identity = randomUUID(); db.prepare('INSERT INTO authority.identity VALUES(?)').run(identity); }
    const saved = db.prepare("SELECT value FROM meta WHERE key='controlled_authority'").get()?.value;
    if (saved && saved !== identity) throw new Error('Deletion authority identity mismatch');
    const savedScope = db.prepare("SELECT value FROM meta WHERE key='controlled_scope'").get()?.value;
    if (savedScope && savedScope !== scopeRef) throw new Error('Memory scope identity mismatch');
    db.prepare("INSERT OR IGNORE INTO meta VALUES('controlled_authority',?)").run(identity);
    db.prepare("INSERT OR IGNORE INTO meta VALUES('controlled_scope',?)").run(scopeRef);
    db.prepare('INSERT OR IGNORE INTO authority.scopes VALUES(?,0)').run(scopeRef);
    db.exec('COMMIT');
    return new MemoryStore(db, { root, scopeRef, identity });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active transaction */ }
    db.close();
    throw error;
  }
}

class MemoryStore {
  constructor(db, context) { this.db = db; Object.assign(this, context); }
  generation() { return Number(this.db.prepare('SELECT generation FROM authority.scopes WHERE scope_ref=?').get(this.scopeRef).generation); }
  state(id) { return this.db.prepare('SELECT * FROM authority.record_state WHERE scope_ref=? AND record_id=?').get(this.scopeRef, id); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  checkGeneration(expected) { if (expected !== undefined && expected !== this.generation()) throw new Error('Stale memory generation'); }
  advance() {
    this.db.prepare('UPDATE authority.scopes SET generation=generation+1 WHERE scope_ref=?').run(this.scopeRef);
    return this.generation();
  }
  validate(input) {
    assertClean(input);
    const text = checkedText(input.text), id = checkedText(input.id, 'id', 256);
    const sourceRef = checkedText(input.sourceRef, 'source reference', 2048);
    const sourceVersion = checkedText(input.sourceVersion, 'source version', 512);
    const kind = input.kind ?? 'lesson';
    if (!['lesson', 'fact', 'preference', 'decision'].includes(kind)) throw new Error('Invalid memory kind');
    return { ...input, id, text, sourceRef, sourceVersion, kind, origin: input.origin === 'model' ? 'model' : 'user' };
  }
  put(input, { expectedGeneration } = {}) {
    const value = this.validate(input);
    return this.transaction(() => {
      this.checkGeneration(expectedGeneration);
      const previous = this.state(value.id);
      const hash = digest(value.text);
      if (previous && previous.state !== 'active') throw new Error('Deleted or superseded memory tombstone');
      if (previous && previous.text_hash !== hash) throw new Error('Use explicit correction instead of overwriting memory');
      const duplicate = this.db.prepare('SELECT * FROM authority.record_state WHERE scope_ref=? AND source_ref=? AND source_version=? AND text_hash=?').get(this.scopeRef, value.sourceRef, value.sourceVersion, hash);
      if (duplicate) {
        if (duplicate.state !== 'active') throw new Error('Deleted source tombstone');
        const existing = this.get(duplicate.record_id);
        if (existing) return existing;
      }
      return this.insert(value, this.advance());
    });
  }
  insert(value, generation) {
    const hash = digest(value.text);
    const record = materialize({ title: value.text.slice(0, 160), body: value.text, layer: 'project', scopeKind: 'project', repo: this.scopeRef, confidence: 0.7, origin: value.origin, source: { ref: value.sourceRef, version: value.sourceVersion } });
    record.id = value.id;
    upsertRecord(this.db, record);
    this.db.prepare(`INSERT INTO controlled_records VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET source_ref=excluded.source_ref,source_version=excluded.source_version,kind=excluded.kind,generation=excluded.generation,text_hash=excluded.text_hash,supersedes=excluded.supersedes,origin=excluded.origin`).run(value.id,value.sourceRef,value.sourceVersion,value.kind,generation,hash,value.supersedes ?? null,value.origin);
    this.db.prepare(`INSERT INTO authority.record_state VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(scope_ref,record_id) DO UPDATE SET state=excluded.state,text_hash=excluded.text_hash,source_ref=excluded.source_ref,source_version=excluded.source_version,generation=excluded.generation`).run(this.scopeRef,value.id,'active',hash,value.sourceRef,value.sourceVersion,generation);
    return this.get(value.id);
  }
  get(id) {
    const row = this.db.prepare(`SELECT r.id,r.body,r.status,r.created_at,c.* FROM records r JOIN controlled_records c ON c.id=r.id WHERE r.id=? AND r.status='active'`).get(id);
    if (!row) return undefined;
    const state = this.state(id);
    if (!state || state.state !== 'active' || state.text_hash !== row.text_hash || state.source_version !== row.source_version || state.generation !== row.generation) return undefined;
    return { id, scopeRef: this.scopeRef, text: row.body, sourceRef: row.source_ref, sourceVersion: row.source_version, kind: row.kind, generation: row.generation, state: 'active', origin: row.origin, verification: row.origin === 'model' ? 'unverified' : 'user-provided', supersedes: row.supersedes ?? undefined, createdAt: row.created_at };
  }
  list({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid memory limit');
    return this.db.prepare("SELECT id FROM records WHERE status='active' ORDER BY updated_at DESC LIMIT ?").all(limit).map(row => this.get(row.id)).filter(Boolean);
  }
  search(query, { limit = 5 } = {}) {
    query = checkedText(query, 'query', 2000);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recall limit');
    return rawSearch(this.db, extractTerms(query), true, { status: ['active'], scopeKind: 'project', limit: 500 }).map(hit => this.get(hit.id)).filter(Boolean).slice(0, limit);
  }
  correct({ id, text, sourceVersion, expectedGeneration }) {
    const old = this.get(id);
    if (!old) throw new Error('Memory is not active');
    const value = this.validate({ ...old, id: randomUUID(), text, sourceVersion, supersedes: id, origin: 'user' });
    return this.transaction(() => {
      this.checkGeneration(expectedGeneration);
      if (!this.get(id)) throw new Error('Memory changed before correction');
      const generation = this.advance();
      this.db.prepare("UPDATE authority.record_state SET state='superseded',generation=? WHERE scope_ref=? AND record_id=?").run(generation,this.scopeRef,id);
      this.db.prepare('DELETE FROM records WHERE id=?').run(id);
      return this.insert(value,generation);
    });
  }
  forget({ id, expectedGeneration }) {
    return this.transaction(() => {
      this.checkGeneration(expectedGeneration);
      const old = this.state(id);
      if (!old) throw new Error('Unknown memory');
      if (old.state === 'deleted') return { generation: this.generation(), deleted: true };
      const generation = this.advance();
      this.db.prepare("UPDATE authority.record_state SET state='deleted',generation=? WHERE scope_ref=? AND record_id=?").run(generation,this.scopeRef,id);
      this.db.prepare('DELETE FROM records WHERE id=?').run(id);
      return { generation, deleted: true };
    });
  }
  exportSnapshot() { return { schema_version: 1, scopeRef: this.scopeRef, authorityId: this.identity, records: this.list({ limit: 500 }) }; }
  restoreSnapshot(snapshot) {
    if (snapshot.schema_version !== 1 || snapshot.scopeRef !== this.scopeRef || snapshot.authorityId !== this.identity || !Array.isArray(snapshot.records) || snapshot.records.length > 500) throw new Error('Invalid backup authority/scope');
    const values = snapshot.records.map(value => this.validate(value));
    return this.transaction(() => {
      let restored = 0;
      for (const value of values) {
        const state = this.state(value.id);
        if (!state || state.state !== 'active' || state.text_hash !== digest(value.text) || state.source_version !== value.sourceVersion) continue;
        this.insert(value,state.generation); restored++;
      }
      return { restored, skipped: values.length-restored };
    });
  }
  rebuildIndex() { this.db.exec(FTS_REBUILD_SQL); }
  close() { this.db.close(); }
}
