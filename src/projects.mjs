import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkedPath, checkedText, digest} from './scope.mjs';
import {clean, fingerprint, integer, shape} from './validation.mjs';

const SCHEMA_VERSION = 1;
const CATALOG_SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE projects(
 project_id TEXT PRIMARY KEY,
 name TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN('active','retired')),
 revision INTEGER NOT NULL CHECK(revision>=1),
 origin TEXT NOT NULL CHECK(origin IN('config','user')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 retired_reason TEXT
);
CREATE TABLE repositories(
 project_id TEXT NOT NULL,
 repo_id TEXT NOT NULL,
 canonical_root TEXT NOT NULL,
 worktree_root TEXT NOT NULL,
 revision TEXT NOT NULL,
 build_variant TEXT NOT NULL,
 scope_ref TEXT NOT NULL,
 binding_revision INTEGER NOT NULL CHECK(binding_revision>=1),
 enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
 PRIMARY KEY(project_id,repo_id),
 UNIQUE(scope_ref)
);
CREATE INDEX repositories_scope ON repositories(scope_ref);
CREATE TABLE preferences(project_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(project_id,key));
CREATE TABLE reminders(
 scope_ref TEXT NOT NULL,
 record_id TEXT NOT NULL,
 claim_ref TEXT NOT NULL,
 record_generation INTEGER NOT NULL,
 last_shown_at TEXT NOT NULL,
 PRIMARY KEY(scope_ref,record_id,claim_ref)
);
CREATE TABLE reports(
 report_id TEXT PRIMARY KEY,
 revision INTEGER NOT NULL CHECK(revision>=1),
 state TEXT NOT NULL CHECK(state IN('draft','approved','stale')),
 payload TEXT NOT NULL,
 digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE report_revisions(
 report_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>=1),
 digest TEXT NOT NULL,
 approved INTEGER NOT NULL CHECK(approved IN(0,1)),
 payload TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(report_id,revision)
);
CREATE TABLE operations(request_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
PRAGMA user_version=${SCHEMA_VERSION};`;

export class CatalogError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MemoryCatalogError';
    this.code = code;
  }
}

const PROJECT_ID_PATTERN = /^project-[a-f0-9]{64}$/;
const PREFERENCE_KEYS = Object.freeze(['extract', 'recall']);
const PREFERENCE_DEFAULT = Object.freeze({extract: true, recall: true});

function projectIdFor(name) {
  return `project-${digest(`local-memory-project-v1:${name}`)}`;
}
function repositoryFields(value) {
  shape(value, ['repoId', 'canonicalRoot', 'worktreeRoot', 'revision', 'buildVariant', 'scopeRef'], 'repository binding');
  return Object.freeze({
    repoId: checkedText(value.repoId, 'repository id', 128),
    canonicalRoot: checkedPath(value.canonicalRoot),
    worktreeRoot: checkedPath(value.worktreeRoot),
    revision: checkedText(value.revision, 'repository revision', 512),
    buildVariant: checkedText(value.buildVariant, 'build variant', 2048),
    scopeRef: checkedText(value.scopeRef, 'scope reference', 2048),
  });
}
function repositoryValues(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new CatalogError('INVALID_REPOSITORIES', 'repositories must contain 1..16 entries');
  const seen = new Set();
  return value.map((entry) => {
    const repo = repositoryFields(entry);
    if (seen.has(repo.repoId)) throw new CatalogError('DUPLICATE_REPOSITORY', 'repository ids must be unique');
    seen.add(repo.repoId);
    return repo;
  });
}
function sameRepository(a, b) {
  return a.canonicalRoot === b.canonicalRoot && a.worktreeRoot === b.worktreeRoot && a.revision === b.revision && a.buildVariant === b.buildVariant && a.scopeRef === b.scopeRef;
}
function writeTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* The original failure stays authoritative. */ }
    throw error;
  }
}
function readIdentity(path) {
  try {
    const raw = readFileSync(path);
    if (raw.length > 512) throw new Error('oversized');
    const value = JSON.parse(raw.toString('utf8'));
    if (value.schema_version !== 1 || typeof value.identity !== 'string' || !/^[a-f0-9-]{36}$/.test(value.identity)) throw new Error('invalid');
    return value.identity;
  } catch {
    throw new CatalogError('CATALOG_IDENTITY_UNAVAILABLE', 'project catalog identity is missing');
  }
}

/** Open (or create) the local project catalog: one writer, DELETE journal, FULL synchronous. */
export function openProjectCatalog(catalogPath, {identityPath} = {}) {
  const path = checkedPath(catalogPath);
  const anchor = checkedPath(identityPath ?? join(dirname(path), 'catalog.identity.json'));
  if (existsSync(path) !== existsSync(anchor)) throw new CatalogError('CATALOG_IDENTITY_MISMATCH', 'project catalog and its identity anchor disagree');
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path, {enableForeignKeyConstraints: true});
  let closed = false;
  try {
    db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;PRAGMA busy_timeout=5000;');
    if (!existsSync(anchor)) {
      writeTransaction(db, () => {
        db.exec(CATALOG_SCHEMA);
        const identity = randomUUID();
        db.prepare('INSERT INTO meta VALUES(?,?)').run('identity', identity);
        db.prepare('INSERT INTO meta VALUES(?,?)').run('schema_version', String(SCHEMA_VERSION));
        writeFileSync(anchor, JSON.stringify({schema_version: 1, identity}), {flag: 'wx', mode: 0o600});
      });
    }
    if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) throw new CatalogError('CATALOG_SCHEMA_MISMATCH', 'unknown project catalog schema');
    const identity = readIdentity(anchor);
    if (db.prepare("SELECT value FROM meta WHERE key='identity'").get()?.value !== identity) throw new CatalogError('CATALOG_IDENTITY_MISMATCH', 'project catalog identity changed');
    const ctx = {db, path, anchor, identity, closed: false};
    return createCatalogApi(ctx);
  } catch (error) {
    try { db.close(); } catch { /* best effort */ }
    throw error;
  }

  function createCatalogApi(ctx) {
    const assertOpen = () => {
      if (ctx.closed) throw new CatalogError('CATALOG_UNAVAILABLE', 'project catalog is closed');
      if (readIdentity(ctx.anchor) !== ctx.identity) throw new CatalogError('CATALOG_IDENTITY_MISMATCH', 'project catalog identity is missing or replaced');
    };
    function projectRows(projectId) {
      assertOpen();
      const row = ctx.db.prepare('SELECT * FROM projects WHERE project_id=?').get(checkedText(projectId, 'project id', 128));
      return row;
    }
    function repositoriesOf(projectId) {
      return ctx.db.prepare('SELECT * FROM repositories WHERE project_id=? ORDER BY repo_id').all(projectId).map((row) => Object.freeze({
        repoId: row.repo_id,
        canonicalRoot: row.canonical_root,
        worktreeRoot: row.worktree_root,
        revision: row.revision,
        buildVariant: row.build_variant,
        scopeRef: row.scope_ref,
        bindingRevision: row.binding_revision,
        enabled: row.enabled === 1,
      }));
    }
    function preferencesOf(projectId) {
      const preferences = {...PREFERENCE_DEFAULT};
      for (const row of ctx.db.prepare('SELECT key,value FROM preferences WHERE project_id=?').all(projectId)) {
        if (PREFERENCE_KEYS.includes(row.key)) preferences[row.key] = row.value === 'true';
      }
      return Object.freeze(preferences);
    }
    function view(row) {
      if (!row) return undefined;
      return Object.freeze({
        projectId: row.project_id,
        name: row.name,
        state: row.state,
        revision: row.revision,
        origin: row.origin,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        retiredReason: row.retired_reason ?? undefined,
        repositories: Object.freeze(repositoriesOf(row.project_id)),
        preferences: preferencesOf(row.project_id),
      });
    }
    function requireProject(projectId) {
      const row = projectRows(projectId);
      if (!row) throw new CatalogError('PROJECT_NOT_FOUND', 'project is not registered');
      return row;
    }
    function checkScopeConflict(repositories, projectId) {
      for (const repo of repositories) {
        const owner = ctx.db.prepare('SELECT project_id FROM repositories WHERE scope_ref=?').get(repo.scopeRef);
        if (owner && owner.project_id !== projectId) throw new CatalogError('SCOPE_CONFLICT', 'scope is already registered by another project');
      }
    }
    const api = {
      catalogPath: path,
      identity: ctx.identity,
      db: ctx.db,
      write(fn) {
        assertOpen();
        if (typeof fn !== 'function') throw new CatalogError('INVALID_OPERATION', 'transaction callback required');
        return writeTransaction(ctx.db, () => {
          const result = fn();
          if (result && typeof result.then === 'function') throw new CatalogError('INVALID_OPERATION', 'catalog transaction must be synchronous');
          return result;
        });
      },
      listProjects() {
        assertOpen();
        return ctx.db.prepare('SELECT * FROM projects ORDER BY name').all().map(view);
      },
      getProject(projectId) {
        return view(projectRows(projectId));
      },
      registerProject({name, repositories, origin = 'user'}) {
        assertOpen();
        const projectName = checkedText(name, 'project name', 128);
        if (!['config', 'user'].includes(origin)) throw new CatalogError('INVALID_ORIGIN', 'unknown project origin');
        const bindings = repositoryValues(repositories);
        const projectId = projectIdFor(projectName);
        const timestamp = new Date().toISOString();
        return writeTransaction(ctx.db, () => {
          const existing = ctx.db.prepare('SELECT * FROM projects WHERE name=?').get(projectName);
          if (existing) {
            const current = repositoriesOf(existing.project_id);
            const desired = new Map(bindings.map((repo) => [repo.repoId, repo]));
            if (existing.project_id === projectId && current.length === bindings.length && current.every((repo) => desired.has(repo.repoId) && sameRepository(repo, desired.get(repo.repoId)))) return view(existing);
            throw new CatalogError('PROJECT_EXISTS', 'a project with this name is already registered with a different binding');
          }
          checkScopeConflict(bindings, projectId);
          ctx.db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)').run(projectId, projectName, 'active', 1, origin, timestamp, timestamp, null);
          const insert = ctx.db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?)');
          for (const repo of bindings) insert.run(projectId, repo.repoId, repo.canonicalRoot, repo.worktreeRoot, repo.revision, repo.buildVariant, repo.scopeRef, 1, 1);
          return view(projectRows(projectId));
        });
      },
      updateProject({projectId, expectedRevision, name, repositories, reason}) {
        assertOpen();
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'project revision');
        const current = requireProject(projectId);
        if (current.state !== 'active') throw new CatalogError('PROJECT_RETIRED', 'retired projects cannot be edited');
        if (current.revision !== expectedRevision) throw new CatalogError('STALE_REVISION', 'project revision changed');
        const desiredName = name === undefined ? current.name : checkedText(name, 'project name', 128);
        const bindings = repositories === undefined ? undefined : repositoryValues(repositories);
        const timestamp = new Date().toISOString();
        return writeTransaction(ctx.db, () => {
          const fresh = requireProject(projectId);
          if (fresh.revision !== expectedRevision) throw new CatalogError('STALE_REVISION', 'project revision changed');
          if (desiredName !== fresh.name) {
            const taken = ctx.db.prepare('SELECT project_id FROM projects WHERE name=?').get(desiredName);
            if (taken && taken.project_id !== projectId) throw new CatalogError('DUPLICATE_NAME', 'project name is already used');
            ctx.db.prepare('UPDATE projects SET name=? WHERE project_id=?').run(desiredName, projectId);
          }
          if (bindings) {
            const existing = ctx.db.prepare('SELECT * FROM repositories WHERE project_id=?').all(projectId);
            const byId = new Map(existing.map((row) => [row.repo_id, row]));
            const wanted = new Map(bindings.map((repo) => [repo.repoId, repo]));
            checkScopeConflict(bindings, projectId);
            for (const repo of bindings) {
              const row = byId.get(repo.repoId);
              if (!row) {
                ctx.db.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?,?,?,?)').run(projectId, repo.repoId, repo.canonicalRoot, repo.worktreeRoot, repo.revision, repo.buildVariant, repo.scopeRef, 1, 1);
                continue;
              }
              const unchanged = row.canonical_root === repo.canonicalRoot && row.worktree_root === repo.worktreeRoot && row.revision === repo.revision && row.build_variant === repo.buildVariant && row.scope_ref === repo.scopeRef;
              if (!unchanged) ctx.db.prepare('UPDATE repositories SET canonical_root=?,worktree_root=?,revision=?,build_variant=?,scope_ref=?,binding_revision=binding_revision+1,enabled=1 WHERE project_id=? AND repo_id=?').run(repo.canonicalRoot, repo.worktreeRoot, repo.revision, repo.buildVariant, repo.scopeRef, projectId, repo.repoId);
              else if (row.enabled === 0) ctx.db.prepare('UPDATE repositories SET binding_revision=binding_revision+1,enabled=1 WHERE project_id=? AND repo_id=?').run(projectId, repo.repoId);
            }
            for (const row of existing) {
              if (wanted.has(row.repo_id) || row.enabled === 0) continue;
              ctx.db.prepare('UPDATE repositories SET enabled=0,binding_revision=binding_revision+1 WHERE project_id=? AND repo_id=?').run(projectId, row.repo_id);
            }
          }
          ctx.db.prepare('UPDATE projects SET revision=revision+1,updated_at=? WHERE project_id=?').run(timestamp, projectId);
          return view(projectRows(projectId));
        });
      },
      retireProject({projectId, expectedRevision, reason}) {
        assertOpen();
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'project revision');
        return writeTransaction(ctx.db, () => {
          const fresh = requireProject(projectId);
          if (fresh.state === 'retired') {
            if (fresh.revision !== expectedRevision) throw new CatalogError('STALE_REVISION', 'project revision changed');
            return view(fresh);
          }
          if (fresh.revision !== expectedRevision) throw new CatalogError('STALE_REVISION', 'project revision changed');
          const text = checkedText(reason, 'retirement reason', 2000);
          ctx.db.prepare("UPDATE projects SET state='retired',revision=revision+1,updated_at=?,retired_reason=? WHERE project_id=?").run(new Date().toISOString(), text, projectId);
          return view(projectRows(projectId));
        });
      },
      getPreference(projectId, key) {
        assertOpen();
        if (!PREFERENCE_KEYS.includes(key)) throw new CatalogError('INVALID_PREFERENCE', 'unknown preference key');
        requireProject(projectId);
        const row = ctx.db.prepare('SELECT value FROM preferences WHERE project_id=? AND key=?').get(projectId, key);
        return row ? row.value === 'true' : PREFERENCE_DEFAULT[key];
      },
      setPreference({projectId, expectedRevision, key, value}) {
        assertOpen();
        integer(expectedRevision, 1, Number.MAX_SAFE_INTEGER, 'project revision');
        if (!PREFERENCE_KEYS.includes(key) || typeof value !== 'boolean') throw new CatalogError('INVALID_PREFERENCE', 'invalid preference');
        return writeTransaction(ctx.db, () => {
          const fresh = requireProject(projectId);
          if (fresh.revision !== expectedRevision) throw new CatalogError('STALE_REVISION', 'project revision changed');
          if (fresh.state !== 'active') throw new CatalogError('PROJECT_RETIRED', 'retired projects cannot change preferences');
          ctx.db.prepare('INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET value=excluded.value').run(projectId, key, String(value));
          ctx.db.prepare('UPDATE projects SET revision=revision+1,updated_at=? WHERE project_id=?').run(new Date().toISOString(), projectId);
          return view(projectRows(projectId));
        });
      },
      getReminder(scopeRef, recordId, claimRef) {
        assertOpen();
        return ctx.db.prepare('SELECT * FROM reminders WHERE scope_ref=? AND record_id=? AND claim_ref=?').get(checkedText(scopeRef, 'scope reference', 2048), checkedText(recordId, 'record id', 256), checkedText(claimRef, 'claim reference', 256));
      },
      setReminder({scopeRef, recordId, claimRef, recordGeneration, shownAt}) {
        assertOpen();
        integer(recordGeneration, 0, Number.MAX_SAFE_INTEGER, 'record generation');
        const at = checkedText(shownAt, 'reminder timestamp', 64);
        if (Number.isNaN(Date.parse(at))) throw new CatalogError('INVALID_TIMESTAMP', 'invalid reminder timestamp');
        return writeTransaction(ctx.db, () => {
          ctx.db.prepare('INSERT INTO reminders VALUES(?,?,?,?,?) ON CONFLICT(scope_ref,record_id,claim_ref) DO UPDATE SET record_generation=excluded.record_generation,last_shown_at=excluded.last_shown_at').run(checkedText(scopeRef, 'scope reference', 2048), checkedText(recordId, 'record id', 256), checkedText(claimRef, 'claim reference', 256), recordGeneration, at);
          return Object.freeze({scopeRef, recordId, claimRef, recordGeneration, lastShownAt: at});
        });
      },
      operate(requestId, payload, fn) {
        assertOpen();
        const id = checkedText(requestId, 'operation id', 256);
        clean(payload);
        const hash = fingerprint(payload);
        return writeTransaction(ctx.db, () => {
          const prior = ctx.db.prepare('SELECT fingerprint,result FROM operations WHERE request_id=?').get(id);
          if (prior) {
            if (prior.fingerprint !== hash) throw new CatalogError('OPERATION_CONFLICT', 'operation id was already used with a different payload');
            return JSON.parse(prior.result);
          }
          const result = fn();
          if (result && typeof result.then === 'function') throw new CatalogError('INVALID_OPERATION', 'operation callbacks must be synchronous');
          ctx.db.prepare('INSERT INTO operations VALUES(?,?,?)').run(id, hash, JSON.stringify(result));
          return result;
        });
      },
      reportRows() {
        assertOpen();
        return ctx.db.prepare('SELECT * FROM reports ORDER BY created_at DESC').all();
      },
      close() {
        if (!ctx.closed) {
          ctx.closed = true;
          ctx.db.close();
        }
      },
    };
    Object.defineProperty(api, 'closed', {get: () => ctx.closed, enumerable: false});
    return Object.freeze(api);
  }
}
