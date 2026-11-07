import {DatabaseSync} from 'node:sqlite';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkedPath,checkedText,digest} from './scope.mjs';
import {AUTHORITY_SCHEMA,AUTHORITY_SIGNATURE,LEGACY_SIGNATURE,schemaSignature} from './schema.mjs';
import {fingerprint} from './validation.mjs';
const contexts=new WeakMap();
export function registerStore(store,ctx){contexts.set(store,ctx);}
export function contextOf(store){const ctx=contexts.get(store);if(!ctx||ctx.closed)throw new Error('Memory store unavailable');return ctx;}
export function initializeAuthority(root,{allowLegacyMigration=false}={}){
 const file=checkedPath(join(root,'authority.sqlite')),anchor=checkedPath(join(root,'authority.identity.json'));
 const hasFile=existsSync(file),hasAnchor=existsSync(anchor);
 if(hasFile!==hasAnchor)throw new Error('Deletion authority/identity is missing');
 if(!hasFile){
  const oldFiles=readdirSync(root).filter(n=>/^scope-[a-f0-9]{64}\.sqlite$/.test(n));
  if(oldFiles.length&&!allowLegacyMigration)throw new Error('Deletion authority missing; explicit legacy migration required');
  for(const name of oldFiles){const db=new DatabaseSync(checkedPath(join(root,name)),{readOnly:true});try{if(db.prepare('PRAGMA user_version').get().user_version!==1||schemaSignature(db)!==LEGACY_SIGNATURE)throw new Error('Deletion authority missing for nonlegacy data');}finally{db.close();}}
  const identity=randomUUID(),db=new DatabaseSync(file);
  try{db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;');db.exec(AUTHORITY_SCHEMA);db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity',identity);db.exec('COMMIT');writeFileSync(anchor,JSON.stringify({schema_version:1,identity}),{flag:'wx',mode:0o600});}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
 }
 const identity=readAnchor(anchor),db=new DatabaseSync(file,{readOnly:true});
 try{if(db.prepare('PRAGMA user_version').get().user_version!==1||schemaSignature(db)!==AUTHORITY_SIGNATURE||db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value!==identity)throw new Error('Invalid deletion authority schema/identity');}finally{db.close();}
 return {file,anchor,identity};
}
function readAnchor(path){try{const raw=readFileSync(path);if(raw.length>256)throw 0;const v=JSON.parse(raw.toString());if(v.schema_version!==1||typeof v.identity!=='string'||!/^[a-f0-9-]{36}$/.test(v.identity))throw 0;return v.identity;}catch{throw new Error('Deletion authority identity unavailable');}}
export function assertAuthority(ctx){
 if(ctx.closed)throw new Error('Memory store is closed');
 if(ctx.mainSchemaVersion!==undefined&&ctx.db.prepare('PRAGMA main.schema_version').get().schema_version!==ctx.mainSchemaVersion)throw new Error('Content schema/FTS changed while open');
 if(ctx.ftsSecureDeleteRequired&&ctx.db.prepare("SELECT v FROM memory_fts_config WHERE k='secure-delete'").get()?.v!==1)throw new Error('FTS secure-delete policy unavailable');
 if(!existsSync(checkedPath(ctx.authority.file))||readAnchor(checkedPath(ctx.authority.anchor))!==ctx.authority.identity)throw new Error('Deletion authority missing or replaced');
 if(ctx.db.prepare('PRAGMA ledger.user_version').get().user_version!==1||schemaSignature(ctx.db,'ledger')!==AUTHORITY_SIGNATURE||ctx.db.prepare("SELECT value FROM ledger.metadata WHERE key='identity'").get()?.value!==ctx.authority.identity)throw new Error('Deletion authority schema/identity unavailable');
}
export function write(ctx,fn){
 assertAuthority(ctx);if(ctx.depth)return sync(fn);
 ctx.db.exec('BEGIN IMMEDIATE');ctx.depth++;
 try{const result=sync(fn);ctx.db.exec('COMMIT');ctx.cache.clear();return result;}catch(e){ctx.db.exec('ROLLBACK');ctx.cache.clear();throw e;}finally{ctx.depth--;}
}
function sync(fn){const value=fn();if(value&&typeof value.then==='function')throw new Error('Storage transaction callback must be synchronous');return value;}
export function scopeState(ctx){assertAuthority(ctx);const row=ctx.db.prepare('SELECT epoch,revision FROM ledger.scope_state WHERE scope_ref=?').get(ctx.scopeRef);if(!row)throw new Error('Deletion authority scope unavailable');return row;}
export function checkEpoch(ctx,expected){if(expected!==undefined&&expected!==scopeState(ctx).epoch)throw new Error('Stale memory generation');}
export function advance(ctx,{lifecycle=false}={}){
 ctx.db.prepare('UPDATE ledger.scope_state SET revision=revision+1,epoch=epoch+? WHERE scope_ref=?').run(lifecycle?1:0,ctx.scopeRef);const state=scopeState(ctx);
 if(lifecycle){
  ctx.db.prepare('DELETE FROM job_inputs WHERE id IN(SELECT id FROM ledger.jobs WHERE scope_ref=? AND epoch<>?)').run(ctx.scopeRef,state.epoch);
  ctx.db.prepare("UPDATE ledger.jobs SET state='stale',reason='generation_changed',cost_status='not_dispatched' WHERE scope_ref=? AND epoch<>? AND state='queued'").run(ctx.scopeRef,state.epoch);
 }
 ctx.db.prepare("UPDATE metadata SET value=? WHERE key='generation'").run(String(state.revision));return state.revision;
}
export function entryState(ctx,collection,id){assertAuthority(ctx);return ctx.db.prepare('SELECT * FROM ledger.entries WHERE scope_ref=? AND collection=? AND id=?').get(ctx.scopeRef,collection,id);}
export function isSourceBlocked(ctx,source){
 return ctx.db.prepare('SELECT source_ref,source_version,subtree FROM ledger.source_blocks WHERE scope_ref=?').all(ctx.scopeRef).some(v=>(v.source_version==='*'||v.source_version===source.sourceVersion)&&(v.source_ref===source.sourceRef||(v.subtree===1&&source.sourceRef.startsWith(v.source_ref+'/'))));
}
export function assertSources(ctx,sources){for(const source of sources)if(isSourceBlocked(ctx,source))throw new Error('Source was deleted or invalidated');}
export function setEntry(ctx,{collection,id,bodyDigest,sources,generation,supersedes=null}){
 assertSources(ctx,sources);
 const previous=entryState(ctx,collection,id);if(previous&&previous.state!=='active')throw new Error('Deleted/inactive entry tombstone');
 const first=sources[0];
 ctx.db.prepare(`INSERT INTO ledger.entries(scope_ref,collection,id,state,body_digest,source_ref,source_version,generation,supersedes) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_ref,collection,id) DO UPDATE SET state=excluded.state,body_digest=excluded.body_digest,source_ref=excluded.source_ref,source_version=excluded.source_version,generation=excluded.generation,supersedes=excluded.supersedes`).run(ctx.scopeRef,collection,id,'active',bodyDigest,first.sourceRef,first.sourceVersion,generation,supersedes);
 ctx.db.prepare('DELETE FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=?').run(ctx.scopeRef,collection,id);
 const insert=ctx.db.prepare('INSERT OR IGNORE INTO ledger.entry_sources VALUES(?,?,?,?,?,?)');
 for(const s of sources)insert.run(ctx.scopeRef,collection,id,s.sourceRef,s.sourceVersion,s.fragmentRef??'whole');
}
export function memoryDigest(row){return fingerprint({text:row.text,kind:row.kind,origin:row.origin,createdAt:row.created_at,supersedes:row.supersedes??null});}
export function memoryLive(ctx,row){const state=entryState(ctx,'memories',row.id);return state?.state==='active'&&state.generation===row.generation&&state.source_ref===row.source_ref&&state.source_version===row.source_version&&state.body_digest===memoryDigest(row);}
export function reconcile(ctx){
 for(const row of ctx.db.prepare('SELECT * FROM records').all()){
  const state=entryState(ctx,'memories',row.id);if(!state||state.state==='deleted'||state.state==='superseded'||state.generation!==row.generation||state.body_digest!==memoryDigest(row))ctx.db.prepare('DELETE FROM records WHERE id=?').run(row.id);
 }
 for(const row of ctx.db.prepare('SELECT * FROM work_summaries').all()){
  const state=entryState(ctx,'work_summaries',row.id);if(!state||state.state==='deleted'||state.state==='superseded'||state.generation!==row.generation||state.body_digest!==digest(row.payload))ctx.db.prepare('DELETE FROM work_summaries WHERE id=?').run(row.id);
 }
 ctx.db.prepare("DELETE FROM job_inputs WHERE id NOT IN (SELECT j.id FROM ledger.jobs j JOIN ledger.scope_state s ON s.scope_ref=j.scope_ref AND j.epoch=s.epoch WHERE j.scope_ref=? AND j.state IN('queued','running'))").run(ctx.scopeRef);
}
export function operation(ctx,requestId,payload,fn){
 requestId=checkedText(requestId,'request ID',256);const hash=fingerprint(payload);
 return write(ctx,()=>{const prior=ctx.db.prepare('SELECT fingerprint,result_json FROM ledger.operations WHERE scope_ref=? AND request_id=?').get(ctx.scopeRef,requestId);if(prior){if(prior.fingerprint!==hash)throw new Error('Operation identity changed');return JSON.parse(prior.result_json);}const result=fn();ctx.db.prepare('INSERT INTO ledger.operations VALUES(?,?,?,?)').run(ctx.scopeRef,requestId,hash,JSON.stringify(result));return result;});
}
