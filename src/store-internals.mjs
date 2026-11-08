import {DatabaseSync} from 'node:sqlite';
import {existsSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {checkedPath,checkedText,digest} from './scope.mjs';
import {AUTHORITY_SIGNATURE,AUTHORITY_V2_SCHEMA,AUTHORITY_V2_SIGNATURE,CONTENT_V3_SIGNATURE,LEGACY_SIGNATURE,AUTHORITY_SCHEMA_VERSION,CONTENT_SCHEMA_VERSION,schemaSignature,migrateConsolidationSchema} from './schema.mjs';
import {shape,clean,canonical,fingerprint} from './validation.mjs';
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
  try{db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;BEGIN IMMEDIATE;');db.exec(AUTHORITY_V2_SCHEMA);db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity',identity);db.exec('COMMIT');writeFileSync(anchor,JSON.stringify({schema_version:1,identity}),{flag:'wx',mode:0o600});}catch(e){try{db.exec('ROLLBACK');}catch{}throw e;}finally{db.close();}
 }
 const identity=readAnchor(anchor),db=new DatabaseSync(file,{readOnly:true});
 try{
  const version=db.prepare('PRAGMA user_version').get().user_version,signature=schemaSignature(db);
  const known=(version===1&&signature===AUTHORITY_SIGNATURE)||(version===AUTHORITY_SCHEMA_VERSION&&signature===AUTHORITY_V2_SIGNATURE);
  if(!known||db.prepare("SELECT value FROM metadata WHERE key='identity'").get()?.value!==identity)throw new Error('Invalid deletion authority schema/identity');
  return {file,anchor,identity,version};
 }finally{db.close();}
}
function readAnchor(path){try{const raw=readFileSync(path);if(raw.length>256)throw 0;const v=JSON.parse(raw.toString());if(v.schema_version!==1||typeof v.identity!=='string'||!/^[a-f0-9-]{36}$/.test(v.identity))throw 0;return v.identity;}catch{throw new Error('Deletion authority identity unavailable');}}
export function assertAuthority(ctx){
 if(ctx.closed)throw new Error('Memory store is closed');
 if(ctx.mainSchemaVersion!==undefined&&ctx.db.prepare('PRAGMA main.schema_version').get().schema_version!==ctx.mainSchemaVersion)throw new Error('Content schema/FTS changed while open');
 if(ctx.contentVersion!==undefined&&ctx.db.prepare('PRAGMA main.user_version').get().user_version!==ctx.contentVersion)throw new Error('Content schema changed while open');
 if(ctx.ftsSecureDeleteRequired&&ctx.db.prepare("SELECT v FROM memory_fts_config WHERE k='secure-delete'").get()?.v!==1)throw new Error('FTS secure-delete policy unavailable');
 if(!existsSync(checkedPath(ctx.authority.file))||readAnchor(checkedPath(ctx.authority.anchor))!==ctx.authority.identity)throw new Error('Deletion authority missing or replaced');
 if(ctx.db.prepare('PRAGMA ledger.user_version').get().user_version!==AUTHORITY_SCHEMA_VERSION||schemaSignature(ctx.db,'ledger')!==AUTHORITY_V2_SIGNATURE||ctx.db.prepare("SELECT value FROM ledger.metadata WHERE key='identity'").get()?.value!==ctx.authority.identity)throw new Error('Deletion authority schema/identity unavailable');
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

// ---- Evidence excerpts (content body + authority entry/roots) -------------
// Minimal Phase D storage API: the grants/expiry, queue and publication
// layers are not wired yet. Bodies live only in the content database.
export const EXCERPT_COLLECTION='consolidation_excerpts';
const EXCERPT_TEXT_LIMIT=1500;
function memoryRoots(ctx,memoryId){
 return ctx.db.prepare('SELECT source_ref AS sourceRef,source_version AS sourceVersion,fragment_ref AS fragmentRef FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=?').all(ctx.scopeRef,'memories',memoryId);
}
function currentRootFirst(roots,row){const current=roots.find(s=>s.sourceRef===row.source_ref&&s.sourceVersion===row.source_version);return current?[current,...roots.filter(s=>s!==current)]:roots;}
export function registerExcerpt(store,args){
 shape(args,['requestId','memoryId','expectedRecordGeneration','sourceVersion','fragmentRef','text'],'excerpt');
 const ctx=contextOf(store),requestId=checkedText(args.requestId,'request ID',256),memoryId=checkedText(args.memoryId,'memory reference',256);
 const sourceVersion=checkedText(args.sourceVersion,'source version',512),fragmentRef=checkedText(args.fragmentRef,'fragment reference',512);
 const text=checkedText(args.text,'excerpt text',EXCERPT_TEXT_LIMIT);
 if(!Number.isSafeInteger(args.expectedRecordGeneration)||args.expectedRecordGeneration<0)throw new Error('Invalid excerpt record generation');
 const payload={memoryId,expectedRecordGeneration:args.expectedRecordGeneration,sourceVersion,fragmentRef,text},hash=fingerprint(payload);
 return write(ctx,()=>{
  const prior=ctx.db.prepare('SELECT fingerprint,result_json FROM ledger.operations WHERE scope_ref=? AND request_id=?').get(ctx.scopeRef,requestId);
  if(prior){
   if(prior.fingerprint!==hash)throw new Error('Operation identity changed');
   // A revoked/forgotten excerpt must never be replayed as if it were still readable.
   const replay=JSON.parse(prior.result_json),current=entryState(ctx,EXCERPT_COLLECTION,replay.fragmentId);
   if(!current||current.state!=='active')throw new Error('Excerpt registration is no longer active');
   return replay;
  }
  const row=ctx.db.prepare('SELECT * FROM records WHERE id=? AND scope_ref=?').get(memoryId,ctx.scopeRef);
  if(!row)throw new Error('Excerpt source memory is unavailable');
  const state=entryState(ctx,'memories',memoryId);
  if(!state||state.state!=='active'||!memoryLive(ctx,row))throw new Error('Excerpt source memory is unavailable');
  if(row.generation!==args.expectedRecordGeneration)throw new Error('Stale excerpt record generation');
  if(row.source_version!==sourceVersion)throw new Error('Excerpt source version changed');
  const roots=memoryRoots(ctx,memoryId);if(!roots.length)throw new Error('Excerpt source roots unavailable');
  assertSources(ctx,roots);
  const id=`mc-excerpt:${randomUUID()}`,bodyDigest=digest(text),generation=advance(ctx);
  ctx.db.prepare('INSERT INTO consolidation_excerpts VALUES(?,?,?,?)').run(id,ctx.scopeRef,text,bodyDigest);
  setEntry(ctx,{collection:EXCERPT_COLLECTION,id,bodyDigest,sources:currentRootFirst(roots,row),generation});
  ctx.db.prepare('INSERT INTO ledger.consolidation_dependencies VALUES(?,?,?,?,?,?,?)').run(ctx.scopeRef,'excerpt',id,'memory',memoryId,row.generation,memoryDigest(row));
  const result={fragmentId:id,digest:bodyDigest,sourceRef:row.source_ref,sourceVersion:row.source_version,recordGeneration:row.generation,generation,state:'active'};
  ctx.db.prepare('INSERT INTO ledger.operations VALUES(?,?,?,?)').run(ctx.scopeRef,requestId,hash,JSON.stringify(result));
  return result;
 });
}
export function readExcerpt(store,id){
 const ctx=contextOf(store);assertAuthority(ctx);id=checkedText(id,'excerpt ID',256);
 const entry=entryState(ctx,EXCERPT_COLLECTION,id);if(!entry||entry.state!=='active')return undefined;
 const row=ctx.db.prepare('SELECT * FROM consolidation_excerpts WHERE id=? AND scope_ref=?').get(id,ctx.scopeRef);
 if(!row||row.scope_ref!==ctx.scopeRef||row.digest!==digest(row.text)||entry.body_digest!==row.digest)throw new Error('Excerpt body/authority integrity unavailable');
 const deps=ctx.db.prepare("SELECT * FROM ledger.consolidation_dependencies WHERE scope_ref=? AND owner_kind='excerpt' AND owner_id=? AND base_kind='memory'").all(ctx.scopeRef,id);
 if(deps.length!==1)throw new Error('Excerpt dependency unavailable');
 const dep=deps[0],memory=ctx.db.prepare('SELECT * FROM records WHERE id=? AND scope_ref=?').get(dep.base_id,ctx.scopeRef);
 if(!memory)return undefined;
 const memoryState=entryState(ctx,'memories',dep.base_id),memoryBody=memoryDigest(memory);
 if(memory.generation!==dep.base_generation||memoryBody!==dep.base_digest)throw new Error('Excerpt dependency integrity unavailable');
 if(!memoryState||memoryState.state!=='active'||!memoryLive(ctx,memory))return undefined;
 if(entry.source_ref!==memory.source_ref||entry.source_version!==memory.source_version)throw new Error('Excerpt source identity changed');
 const roots=ctx.db.prepare('SELECT source_ref AS sourceRef,source_version AS sourceVersion,fragment_ref AS fragmentRef FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=?').all(ctx.scopeRef,EXCERPT_COLLECTION,id);
 if(!roots.length||!roots.some(s=>s.sourceRef===memory.source_ref&&s.sourceVersion===memory.source_version))throw new Error('Excerpt root sources unavailable');
 for(const source of roots)if(isSourceBlocked(ctx,source))return undefined;
 return {fragmentId:row.id,scopeRef:row.scope_ref,text:row.text,digest:row.digest,sourceRef:entry.source_ref,sourceVersion:entry.source_version,recordGeneration:dep.base_generation,generation:entry.generation,state:'active'};
}
export function forgetExcerpt(store,id){
 const ctx=contextOf(store);id=checkedText(id,'excerpt ID',256);
 return write(ctx,()=>{
  const entry=entryState(ctx,EXCERPT_COLLECTION,id);if(!entry)throw new Error('Unknown excerpt');
  if(entry.state==='deleted')return {deleted:true,alreadyDeleted:true,generation:store.generation(),currentSqliteBodyCleared:true,backupCopies:'not-revoked'};
  advance(ctx);
  ctx.db.prepare('DELETE FROM consolidation_excerpts WHERE id=? AND scope_ref=?').run(id,ctx.scopeRef);
  ctx.db.prepare("UPDATE ledger.entries SET state='deleted' WHERE scope_ref=? AND collection=? AND id=?").run(ctx.scopeRef,EXCERPT_COLLECTION,id);
  return {deleted:true,alreadyDeleted:false,generation:store.generation(),currentSqliteBodyCleared:true,backupCopies:'not-revoked'};
 });
}

// ---- Snapshot restore (v2 compatibility plus the v3 safe subset) ----------
function snapshotDigest(value,label){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error(`Invalid snapshot ${label}`);return value;}
function snapshotSource(value){shape(value,['sourceRef','sourceVersion','fragmentRef'],'snapshot version source');checkedText(value.sourceRef,'source reference',2048);checkedText(value.sourceVersion,'source version',512);checkedText(value.fragmentRef,'fragment reference',512);}
function snapshotDependency(value){
 shape(value,['ownerKind','ownerId','baseKind','baseId','baseGeneration','baseDigest'],'snapshot version dependency');
 if(value.ownerKind!=='version')throw new Error('Invalid snapshot dependency owner');checkedText(value.ownerId,'dependency owner ID',256);
 if(!['memory','excerpt'].includes(value.baseKind))throw new Error('Invalid snapshot dependency base');checkedText(value.baseId,'dependency base ID',256);
 if(!Number.isSafeInteger(value.baseGeneration)||value.baseGeneration<0)throw new Error('Invalid snapshot dependency generation');snapshotDigest(value.baseDigest,'dependency digest');
}
// The v3 subset exports live published version metadata and its source refs,
// but no version body. Restore therefore revalidates each entry and skips it
// fail-closed instead of fabricating a body; records/workSummaries keep their
// historical v2 semantics.
function snapshotVersion(value){
 shape(value,['versionId','revision','digest','manifestDigest','createdAt','head','sources','dependencies'],'snapshot version');
 const versionId=checkedText(value.versionId,'version ID',256);
 if(!Number.isSafeInteger(value.revision)||value.revision<1)throw new Error('Invalid snapshot version revision');
 snapshotDigest(value.digest,'version digest');snapshotDigest(value.manifestDigest,'manifest digest');checkedText(value.createdAt,'version date',64);
 if(typeof value.head!=='boolean')throw new Error('Invalid snapshot version head');
 if(!Array.isArray(value.sources)||value.sources.length>64)throw new Error('Invalid snapshot version sources');
 for(const source of value.sources)snapshotSource(source);
 if(!Array.isArray(value.dependencies)||value.dependencies.length>128)throw new Error('Invalid snapshot version dependencies');
 for(const dependency of value.dependencies)snapshotDependency(dependency);
 return versionId;
}
export function restoreSnapshot(store,snapshot){
 shape(snapshot,['schema_version','scopeRef','authorityId','records','workSummaries','versions'],'snapshot');clean(snapshot);
 const ctx=contextOf(store);
 if(![2,3].includes(snapshot.schema_version)||snapshot.scopeRef!==ctx.scopeRef||snapshot.authorityId!==ctx.authority.identity||!Array.isArray(snapshot.records)||!Array.isArray(snapshot.workSummaries)||snapshot.records.length+snapshot.workSummaries.length>500)throw new Error('Snapshot scope/authority/size mismatch');
 if(snapshot.schema_version===2&&snapshot.versions!==undefined)throw new Error('Snapshot schema/version mismatch');
 if(snapshot.schema_version===3&&(!Array.isArray(snapshot.versions)||snapshot.versions.length>25))throw new Error('Snapshot version/size mismatch');
 return write(ctx,()=>{
  let restored=0,skipped=0;const seen=new Set();
  for(const raw of snapshot.records){
   shape(raw,['id','scopeRef','sourceRef','sourceVersion','text','kind','origin','verification','state','generation','createdAt','supersedes'],'snapshot memory');
   if(raw.scopeRef!==ctx.scopeRef)throw new Error('Snapshot record scope mismatch');
   const value=store.validate({id:raw.id,sourceRef:raw.sourceRef,sourceVersion:raw.sourceVersion,text:raw.text,kind:raw.kind,origin:raw.origin});
   const key=`memories:${raw.id}`;if(seen.has(key))throw new Error('Duplicate snapshot identity');seen.add(key);
   const state=entryState(ctx,'memories',raw.id),row={text:value.text,kind:value.kind,origin:value.origin,created_at:raw.createdAt,supersedes:raw.supersedes??null};
   if(!state||state.state!=='active'||state.generation!==raw.generation||state.source_ref!==value.sourceRef||state.source_version!==value.sourceVersion||state.body_digest!==memoryDigest(row)){skipped++;continue;}
   ctx.insertMemory({...value,createdAt:checkedText(raw.createdAt,'created date',64),supersedes:raw.supersedes},state.generation);restored++;
  }
  for(const raw of snapshot.workSummaries){
   if(raw.collection!=='work_summaries'||raw.scopeRef!==ctx.scopeRef||typeof raw.id!=='string')throw new Error('Snapshot work scope mismatch');
   const key=`work_summaries:${raw.id}`;if(seen.has(key))throw new Error('Duplicate snapshot identity');seen.add(key);
   const payload=canonical(raw),state=entryState(ctx,'work_summaries',raw.id);
   if(!state||state.state!=='active'||state.generation!==raw.generation||state.body_digest!==digest(payload)){skipped++;continue;}
   ctx.db.prepare('INSERT INTO work_summaries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,text_hash=excluded.text_hash,generation=excluded.generation').run(raw.id,ctx.scopeRef,payload,digest(payload),state.generation);restored++;
  }
  let versionsSkipped=0;
  for(const raw of snapshot.versions??[]){snapshotVersion(raw);versionsSkipped++;}
  advance(ctx);return {restored,skipped,versionsRestored:0,versionsSkipped,authorityPreserved:true};
 });
}

/** Explicit removal propagation: clear excerpt bodies that depend on a deleted/superseded memory. */
export function purgeExcerptsForMemory(ctx,memoryId){
 const dependencies=ctx.db.prepare("SELECT owner_id FROM ledger.consolidation_dependencies WHERE scope_ref=? AND owner_kind='excerpt' AND base_kind='memory' AND base_id=?").all(ctx.scopeRef,memoryId);
 let purged=0;
 for(const {owner_id:excerptId} of dependencies){
  const entry=entryState(ctx,EXCERPT_COLLECTION,excerptId);
  if(entry&&entry.state!=='deleted'){ctx.db.prepare('DELETE FROM consolidation_excerpts WHERE id=? AND scope_ref=?').run(excerptId,ctx.scopeRef);ctx.db.prepare("UPDATE ledger.entries SET state='deleted' WHERE scope_ref=? AND collection=? AND id=?").run(ctx.scopeRef,EXCERPT_COLLECTION,excerptId);purged+=1;}
 }
 return purged;
}

/** Metadata-only excerpt listing for a memory; bodies/read permissions stay behind readExcerpt. */
export function listExcerptsForMemory(store,{memoryId,limit=20}={}){
 const ctx=contextOf(store);assertAuthority(ctx);
 const memory=checkedText(memoryId,'memory reference',256);integerLimit(limit,1,100,'excerpt limit');
 const rows=ctx.db.prepare(`SELECT d.base_generation AS recordGeneration, e.id AS fragmentId, e.source_ref AS sourceRef, e.source_version AS sourceVersion, e.state AS state, e.generation AS generation
  FROM ledger.consolidation_dependencies d JOIN ledger.entries e ON e.scope_ref=d.scope_ref AND e.collection='consolidation_excerpts' AND e.id=d.owner_id
  WHERE d.scope_ref=? AND d.owner_kind='excerpt' AND d.base_kind='memory' AND d.base_id=? ORDER BY e.generation DESC LIMIT ?`).all(ctx.scopeRef,memory,limit);
 return Object.freeze(rows.map(row=>Object.freeze({fragmentId:row.fragmentId,sourceRef:row.sourceRef,sourceVersion:row.sourceVersion,recordGeneration:row.recordGeneration,state:row.state,generation:row.generation})));
}
function integerLimit(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error('Invalid '+label);return value;}

/** Invalidate queued/running consolidation jobs whose pinned manifest contains this memory. */
export function invalidateConsolidationJobsForMemory(ctx,memoryId){
 const jobs=ctx.db.prepare("SELECT id,manifest_json FROM ledger.consolidation_jobs WHERE scope_ref=? AND state IN ('queued','running')").all(ctx.scopeRef);
 let invalidated=0;
 for(const job of jobs){
  let manifest;try{manifest=JSON.parse(job.manifest_json);}catch{manifest=undefined;}
  if(!manifest||!Array.isArray(manifest.memories)||!manifest.memories.some((memory)=>memory&&memory.id===memoryId))continue;
  ctx.db.prepare("UPDATE ledger.consolidation_jobs SET state='stale',reason='source_deleted',candidate_id=NULL,run_token=NULL,updated_at=? WHERE scope_ref=? AND id=?").run(new Date().toISOString(),ctx.scopeRef,job.id);
  ctx.db.prepare('DELETE FROM consolidation_inputs WHERE job_id=?').run(job.id);
  invalidated+=1;
 }
 return invalidated;
}
/** Archive propagation: keep derived bodies but make their entries unreadable and clear an invalid head. */
export function markDerivedStaleForMemory(ctx,memoryId){
 const owners=ctx.db.prepare("SELECT owner_kind AS kind,owner_id AS id FROM ledger.consolidation_dependencies WHERE scope_ref=? AND base_kind='memory' AND base_id=?").all(ctx.scopeRef,memoryId);
 let stale=0,headCleared=false;
 for(const owner of owners){
  if(owner.kind==='candidate'){ctx.db.prepare("UPDATE ledger.entries SET state='stale' WHERE scope_ref=? AND collection='consolidation_candidates' AND id=?").run(ctx.scopeRef,owner.id);stale+=1;}
  else if(owner.kind==='version'){ctx.db.prepare("UPDATE ledger.entries SET state='stale' WHERE scope_ref=? AND collection='consolidation_versions' AND id=?").run(ctx.scopeRef,owner.id);stale+=1;const head=ctx.db.prepare('SELECT * FROM ledger.consolidation_head WHERE scope_ref=?').get(ctx.scopeRef);if(head&&head.version_id===owner.id){ctx.db.prepare('UPDATE ledger.consolidation_head SET revision=revision+1,version_id=NULL WHERE scope_ref=?').run(ctx.scopeRef);headCleared=true;}}
 }
 invalidateConsolidationJobsForMemory(ctx,memoryId);
 return {stale,headCleared};
}
/** Deletion/correction propagation: purge candidate/version bodies derived from a memory and clear an invalid head. */
export function purgeDerivedForMemory(ctx,memoryId){
 invalidateConsolidationJobsForMemory(ctx,memoryId);
 const owners=ctx.db.prepare("SELECT owner_kind AS kind,owner_id AS id FROM ledger.consolidation_dependencies WHERE scope_ref=? AND base_kind='memory' AND base_id=?").all(ctx.scopeRef,memoryId);
 const candidates=[],versions=[];
 for(const owner of owners){if(owner.kind==='candidate')candidates.push(owner.id);else if(owner.kind==='version')versions.push(owner.id);else if(owner.kind==='excerpt'){/* excerpts have their own purge path */}}
 let headCleared=false;
 for(const id of candidates){
  ctx.db.prepare('DELETE FROM consolidation_bodies WHERE id=? AND scope_ref=?').run(id,ctx.scopeRef);
  ctx.db.prepare("UPDATE ledger.entries SET state='deleted' WHERE scope_ref=? AND collection='consolidation_candidates' AND id=?").run(ctx.scopeRef,id);
  ctx.db.prepare("UPDATE ledger.consolidation_jobs SET state='stale',reason='source_deleted',candidate_id=NULL WHERE scope_ref=? AND candidate_id=?").run(ctx.scopeRef,id);
 }
 for(const id of versions){
  ctx.db.prepare('DELETE FROM consolidation_bodies WHERE id=? AND scope_ref=?').run(id,ctx.scopeRef);
  ctx.db.prepare("UPDATE ledger.entries SET state='deleted' WHERE scope_ref=? AND collection='consolidation_versions' AND id=?").run(ctx.scopeRef,id);
  const head=ctx.db.prepare('SELECT * FROM ledger.consolidation_head WHERE scope_ref=?').get(ctx.scopeRef);
  if(head&&head.version_id===id){ctx.db.prepare('UPDATE ledger.consolidation_head SET revision=revision+1,version_id=NULL WHERE scope_ref=?').run(ctx.scopeRef);headCleared=true;}
 }
 return {candidates:candidates.length,versions:versions.length,headCleared};
}

/** Stop using a memory version for recall after an explicit user correction; body stays until normal delete/archive. */
export function suspendMemoryForCorrection(store,{id,expectedGeneration,reason='user_correction'}={}){
 const ctx=contextOf(store);const memoryId=checkedText(id,'memory reference',256);
 return write(ctx,()=>{
  const entry=entryState(ctx,'memories',memoryId);
  if(!entry||entry.state!=='active')throw new Error('Memory is not active');
  checkEpoch(ctx,expectedGeneration);advance(ctx,{lifecycle:true});
  ctx.db.prepare("UPDATE ledger.entries SET state='stale' WHERE scope_ref=? AND collection='memories' AND id=?").run(ctx.scopeRef,memoryId);
  purgeExcerptsForMemory(ctx,memoryId);purgeDerivedForMemory(ctx,memoryId);
  return Object.freeze({suspended:true,id:memoryId,reason:checkedText(reason,'correction reason',256),generation:scopeState(ctx).epoch});
 });
}
