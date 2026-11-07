import {DatabaseSync} from 'node:sqlite';
import {digest} from './scope.mjs';
export const LEGACY_SCHEMA=`
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE records(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,source_ref TEXT NOT NULL,
 source_version TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,cjk TEXT NOT NULL,
 text_hash TEXT NOT NULL,origin TEXT NOT NULL,generation INTEGER NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(source_ref,source_version,text_hash));
CREATE VIRTUAL TABLE memory_fts USING fts5(text,cjk,content='records',content_rowid='rowid');
CREATE TRIGGER memory_ai AFTER INSERT ON records BEGIN INSERT INTO memory_fts(rowid,text,cjk) VALUES(new.rowid,new.text,new.cjk); END;
CREATE TRIGGER memory_ad AFTER DELETE ON records BEGIN INSERT INTO memory_fts(memory_fts,rowid,text,cjk) VALUES('delete',old.rowid,old.text,old.cjk); END;
CREATE TRIGGER memory_au AFTER UPDATE ON records BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,text,cjk) VALUES('delete',old.rowid,old.text,old.cjk);
 INSERT INTO memory_fts(rowid,text,cjk) VALUES(new.rowid,new.text,new.cjk); END;
PRAGMA user_version=1;`;
export const EXTENSION_SCHEMA=`
ALTER TABLE records ADD COLUMN supersedes TEXT;
CREATE TABLE work_summaries(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,payload TEXT NOT NULL,text_hash TEXT NOT NULL,generation INTEGER NOT NULL);
CREATE TABLE job_inputs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
PRAGMA user_version=2;`;
export const AUTHORITY_SCHEMA=`
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE scope_state(scope_ref TEXT PRIMARY KEY,epoch INTEGER NOT NULL CHECK(epoch>=0),revision INTEGER NOT NULL CHECK(revision>=0));
CREATE TABLE entries(scope_ref TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('active','archived','stale','superseded','deleted')),body_digest TEXT NOT NULL,source_ref TEXT NOT NULL,source_version TEXT NOT NULL,generation INTEGER NOT NULL,supersedes TEXT,PRIMARY KEY(scope_ref,collection,id));
CREATE TABLE entry_sources(scope_ref TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,source_ref TEXT NOT NULL,source_version TEXT NOT NULL,fragment_ref TEXT NOT NULL,PRIMARY KEY(scope_ref,collection,id,source_ref,source_version,fragment_ref));
CREATE TABLE source_blocks(scope_ref TEXT NOT NULL,source_ref TEXT NOT NULL,source_version TEXT NOT NULL,subtree INTEGER NOT NULL,PRIMARY KEY(scope_ref,source_ref,source_version,subtree));
CREATE TABLE events(scope_ref TEXT NOT NULL,event_id TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(scope_ref,event_id));
CREATE TABLE operations(scope_ref TEXT NOT NULL,request_id TEXT NOT NULL,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(scope_ref,request_id));
CREATE TABLE jobs(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,request_id TEXT NOT NULL,event_key TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('queued','running','completed','failed','stale','outcome_unknown')),route_json TEXT NOT NULL,purpose TEXT NOT NULL,epoch INTEGER NOT NULL,day TEXT NOT NULL,session_ref TEXT NOT NULL,policy_hash TEXT NOT NULL,run_token TEXT,cost_status TEXT NOT NULL,result_json TEXT,reason TEXT,created_at TEXT NOT NULL,UNIQUE(scope_ref,request_id),UNIQUE(scope_ref,event_key));
CREATE UNIQUE INDEX one_running_job ON jobs((1)) WHERE state='running';
CREATE TABLE dispatch_lock(singleton INTEGER PRIMARY KEY CHECK(singleton=1),job_id TEXT NOT NULL UNIQUE,run_token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN('in_flight','unknown')));
CREATE TABLE daily_budget(day TEXT PRIMARY KEY,requests INTEGER NOT NULL,input_chars INTEGER NOT NULL,output_tokens INTEGER NOT NULL);
CREATE TABLE session_budget(scope_ref TEXT NOT NULL,session_ref TEXT NOT NULL,requests INTEGER NOT NULL,PRIMARY KEY(scope_ref,session_ref));
PRAGMA user_version=1;`;
export function schemaSignature(db,namespace='main'){if(!['main','ledger'].includes(namespace))throw new Error('Invalid schema namespace');return digest(JSON.stringify(db.prepare(`SELECT type,name,tbl_name,sql FROM ${namespace}.sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name`).all()));}
function expected(sql){const db=new DatabaseSync(':memory:');try{db.exec(sql);return schemaSignature(db);}finally{db.close();}}
export const LEGACY_SIGNATURE=expected(LEGACY_SCHEMA);
export const CONTENT_SIGNATURE=expected(LEGACY_SCHEMA+EXTENSION_SCHEMA);
export const AUTHORITY_SIGNATURE=expected(AUTHORITY_SCHEMA);
