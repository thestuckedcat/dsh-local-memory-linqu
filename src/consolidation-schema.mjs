// Consolidation storage contract for 05-local-memory v0.4.0 Phase D.
// The exact content v3 / authority v2 additions follow
// docs/memory-consolidation-design.md §6.1. The historical v1/v2 definitions
// stay in ./schema.mjs; this module only owns the additions, the schema
// versions and the synchronous two-database migration helper.
//
// This module has no import from ./schema.mjs on purpose: schema.mjs imports
// these constants to derive the current signatures, so a reverse import would
// create an uninitialised ESM cycle.

export const CONTENT_SCHEMA_VERSION=3;
export const AUTHORITY_SCHEMA_VERSION=2;

// Content v3 additions (design §6.1). Bodies stay in the content database;
// authority/catalog/audit never receive excerpt text.
export const CONSOLIDATION_CONTENT_SCHEMA=`
CREATE TABLE consolidation_inputs(job_id TEXT PRIMARY KEY,payload TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE consolidation_excerpts(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,text TEXT NOT NULL,digest TEXT NOT NULL);
CREATE TABLE consolidation_bodies(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,
 body_kind TEXT NOT NULL CHECK(body_kind IN('candidate','version')),payload TEXT NOT NULL,digest TEXT NOT NULL);`;

// Authority v2 additions (design §6.1). Complete field contract: values are
// validated in code, while every UNIQUE/PK/CHECK listed here is enforced by
// SQLite. No excerpt/candidate/version body is stored in this database.
export const CONSOLIDATION_AUTHORITY_SCHEMA=`
CREATE TABLE consolidation_jobs(
 id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('queued','running','ready','published','discarded','cancelled','failed','stale','outcome_unknown')),
 epoch INTEGER NOT NULL,scope_revision INTEGER NOT NULL,base_head_revision INTEGER NOT NULL,
 manifest_digest TEXT NOT NULL,manifest_json TEXT NOT NULL,route_json TEXT NOT NULL,
 policy_digest TEXT NOT NULL,policy_revision INTEGER NOT NULL,permission_id TEXT NOT NULL,
 budget_day TEXT NOT NULL,input_chars INTEGER NOT NULL,max_tokens INTEGER NOT NULL,
 run_token TEXT,cost_status TEXT NOT NULL CHECK(cost_status IN('not_dispatched','reported','unknown')),
 candidate_id TEXT,reason TEXT,invalidated_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 UNIQUE(scope_ref,request_id));
CREATE TABLE consolidation_permissions(
 id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('batch','excerpt','publication')),
 state TEXT NOT NULL CHECK(state IN('active','revoked','expired')),
 subject_id TEXT NOT NULL,subject_digest TEXT NOT NULL,route_digest TEXT,
 epoch INTEGER NOT NULL,policy_revision INTEGER NOT NULL,expires_at TEXT,created_at TEXT NOT NULL,
 CHECK((kind='publication' AND expires_at IS NULL) OR (kind IN('batch','excerpt') AND expires_at IS NOT NULL)));
CREATE TABLE consolidation_dependencies(
 scope_ref TEXT NOT NULL,owner_kind TEXT NOT NULL CHECK(owner_kind IN('job','excerpt','candidate','version')),
 owner_id TEXT NOT NULL,base_kind TEXT NOT NULL CHECK(base_kind IN('memory','excerpt')),
 base_id TEXT NOT NULL,base_generation INTEGER NOT NULL,base_digest TEXT NOT NULL,
 PRIMARY KEY(scope_ref,owner_kind,owner_id,base_kind,base_id));
CREATE INDEX consolidation_dep_base ON consolidation_dependencies(scope_ref,base_kind,base_id);
CREATE TABLE consolidation_head(scope_ref TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=0),version_id TEXT);
CREATE TABLE consolidation_versions(
 id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,revision INTEGER NOT NULL,candidate_id TEXT NOT NULL UNIQUE,
 digest TEXT NOT NULL,manifest_digest TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(scope_ref,revision));
CREATE TABLE consolidation_policy(scope_ref TEXT PRIMARY KEY,revision INTEGER NOT NULL CHECK(revision>=1));
CREATE TABLE consolidation_operations(scope_ref TEXT NOT NULL,request_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(scope_ref,request_id));
CREATE TABLE consolidation_audit(seq INTEGER PRIMARY KEY,scope_ref TEXT NOT NULL,operation_id TEXT NOT NULL,
 kind TEXT NOT NULL,object_id TEXT,reason TEXT,occurred_at TEXT NOT NULL);`;

// Migration DDL. The authority variant is only safe on a connection whose
// main database is the authority file; for the attached `ledger` namespace the
// helper below sets `PRAGMA ledger.user_version` explicitly.
export const CONTENT_V3_ADDITIONS=`${CONSOLIDATION_CONTENT_SCHEMA}
PRAGMA user_version=${CONTENT_SCHEMA_VERSION};`;
export const AUTHORITY_V2_ADDITIONS=`${CONSOLIDATION_AUTHORITY_SCHEMA}
PRAGMA user_version=${AUTHORITY_SCHEMA_VERSION};`;

const CONTENT_NAMESPACES=Object.freeze(['main']);
const AUTHORITY_NAMESPACES=Object.freeze(['ledger']);

function namespace(name,allowed){
 if(typeof name!=='string'||!allowed.includes(name))throw new Error('Invalid migration schema namespace');
 return name;
}
// Unqualified CREATE statements on an attached connection always target main.
// Qualify the authority DDL for the `ledger` namespace; SQLite stores the SQL
// without the qualifier, so the resulting schema signature equals the one of a
// freshly created authority database.
function authoritySchemaFor(schemaNamespace){
 return CONSOLIDATION_AUTHORITY_SCHEMA.replace(/(^|\n)CREATE TABLE /g,`$1CREATE TABLE ${schemaNamespace}.`).replace(/(^|\n)CREATE INDEX /g,`$1CREATE INDEX ${schemaNamespace}.`);
}

/**
 * Apply the v2→v3 content and v1→v2 authority additions in one synchronous
 * transaction and verify the result before COMMIT. The caller must already
 * have verified the historical signatures and must have set DELETE
 * journal/FULL on both databases. `legacyContentSql` supplies the historical
 * v1→v2 DDL when contentVersion is 1, so this module never has to import the
 * definitions it must not duplicate.
 *
 * `onStep` is a progress/fault-injection hook; a throw rolls both databases
 * back. `afterMigration` runs inside the same transaction, which lets openStore
 * keep the v1 record adoption and initialization atomic with the migration.
 */
export function migrateConsolidationSchema(db,{contentVersion,authorityVersion,legacyContentSql,onStep,verify,afterMigration,contentNamespace='main',authorityNamespace='ledger'}={}){
 contentNamespace=namespace(contentNamespace,CONTENT_NAMESPACES);
 authorityNamespace=namespace(authorityNamespace,AUTHORITY_NAMESPACES);
 if(!Number.isInteger(contentVersion)||![1,2,3].includes(contentVersion))throw new Error('Unknown content schema migration source');
 if(!Number.isInteger(authorityVersion)||![1,2].includes(authorityVersion))throw new Error('Unknown authority schema migration source');
 if(contentVersion===CONTENT_SCHEMA_VERSION&&authorityVersion===AUTHORITY_SCHEMA_VERSION)return {migrated:false};
 db.exec('BEGIN IMMEDIATE');
 try{
  if(contentVersion===1){
   if(typeof legacyContentSql!=='string'||!legacyContentSql.trim())throw new Error('Legacy content migration requires the historical v1→v2 SQL');
   db.exec(legacyContentSql);onStep?.('content-v2');
  }
  if(contentVersion<CONTENT_SCHEMA_VERSION){
   db.exec(CONSOLIDATION_CONTENT_SCHEMA);
   db.exec(`PRAGMA ${contentNamespace}.user_version=${CONTENT_SCHEMA_VERSION};`);onStep?.('content-v3');
  }
  if(authorityVersion<AUTHORITY_SCHEMA_VERSION){
   db.exec(authoritySchemaFor(authorityNamespace));
   db.exec(`PRAGMA ${authorityNamespace}.user_version=${AUTHORITY_SCHEMA_VERSION};`);onStep?.('authority-v2');
  }
  verify?.();
  afterMigration?.();
  db.exec('COMMIT');
  return {migrated:true,contentVersion:CONTENT_SCHEMA_VERSION,authorityVersion:AUTHORITY_SCHEMA_VERSION};
 }catch(error){
  try{db.exec('ROLLBACK');}catch{}
  throw error;
 }
}
