import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySourceLock} from './source-lock.mjs';
import {checkedText,checkedPath,digest} from './scope.mjs';
import {EXTENSION_SCHEMA,LEGACY_SIGNATURE,CONTENT_SIGNATURE,CONTENT_V3_SCHEMA,CONTENT_V3_SIGNATURE,AUTHORITY_V2_SIGNATURE,AUTHORITY_SCHEMA_VERSION,CONTENT_SCHEMA_VERSION,schemaSignature,migrateConsolidationSchema} from './schema.mjs';
import {registerStore,contextOf,initializeAuthority,assertAuthority,write,scopeState,checkEpoch,advance,entryState,assertSources,setEntry,memoryDigest,memoryLive,reconcile,registerExcerpt,readExcerpt,forgetExcerpt,listExcerptsForMemory,suspendMemoryForCorrection,restoreSnapshot} from './store-internals.mjs';
import {shape} from './validation.mjs';
import {forget,archive,restoreArchived,correctMemory} from './lifecycle.mjs';
export {createScope} from './scope.mjs';
export {registerExcerpt,readExcerpt,forgetExcerpt,listExcerptsForMemory,suspendMemoryForCorrection,restoreSnapshot};
verifySourceLock(fileURLToPath(new URL('../',import.meta.url)));
const {cjkBigrams,cjkClause,hasCjk}=await import('../vendor/kovey/cjk.js');

export function openStore(root,{scopeRef,allowLegacyMigration=false}={}){
 scopeRef=checkedText(scopeRef,'scope',2048);root=checkedPath(root);mkdirSync(root,{recursive:true,mode:0o700});root=realpathSync(root);
 const authority=initializeAuthority(root,{allowLegacyMigration}),databasePath=checkedPath(join(root,`scope-${digest(scopeRef)}.sqlite`)),existing=existsSync(databasePath);
 const db=new DatabaseSync(databasePath,{enableForeignKeyConstraints:true});
 const ctx={db,root,scopeRef,authority,databasePath,depth:0,closed:false,cache:new Map()};
 try{
  db.exec('PRAGMA busy_timeout=5000;');
  const originalVersion=existing?db.prepare('PRAGMA user_version').get().user_version:undefined;
  if(existing){
   if(![1,2,3].includes(originalVersion))throw new Error('Unknown memory schema; no automatic migration');
   const signature=originalVersion===1?LEGACY_SIGNATURE:originalVersion===2?CONTENT_SIGNATURE:CONTENT_V3_SIGNATURE;
   if(schemaSignature(db)!==signature)throw new Error('Memory schema/FTS index definition mismatch');
   if(originalVersion===1&&!allowLegacyMigration)throw new Error('Explicit legacy migration required');
   if(db.prepare("SELECT value FROM metadata WHERE key='scope_ref'").get()?.value!==scopeRef||db.prepare("SELECT value FROM metadata WHERE key='owner'").get()?.value!=='@local/dsh-controlled-memory')throw new Error('Memory scope/schema identity mismatch');
   const saved=db.prepare("SELECT value FROM metadata WHERE key='authority_id'").get()?.value;
   if(saved&&saved!==authority.identity)throw new Error('Deletion authority identity mismatch');
   if(originalVersion>=2&&!saved)throw new Error('Deletion authority identity missing');
   ctx.contentVersion=CONTENT_SCHEMA_VERSION;
  }
  db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA secure_delete=ON;');
  db.prepare('ATTACH DATABASE ? AS ledger').run(authority.file);
  db.exec('PRAGMA ledger.journal_mode=DELETE;PRAGMA ledger.synchronous=FULL;PRAGMA ledger.secure_delete=ON;');
  const finishFts=()=>{
   const priorSecureDelete=db.prepare("SELECT v FROM memory_fts_config WHERE k='secure-delete'").get()?.v;
   db.exec("INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',1)");
   reconcile(ctx);
   if(priorSecureDelete!==1)db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
  };
  const initializeExisting=()=>{
   const saved=db.prepare("SELECT value FROM metadata WHERE key='authority_id'").get()?.value;
   if(saved&&saved!==authority.identity)throw new Error('Deletion authority identity mismatch');
   db.prepare("INSERT OR IGNORE INTO metadata VALUES('authority_id',?)").run(authority.identity);
   const legacyRevision=Number(db.prepare("SELECT value FROM metadata WHERE key='generation'").get().value);
   db.prepare('INSERT OR IGNORE INTO ledger.scope_state VALUES(?,0,?)').run(scopeRef,legacyRevision);
   if(originalVersion===1){for(const row of db.prepare('SELECT * FROM records').all()){
    checkedText(row.text,'legacy memory');if(row.scope_ref!==scopeRef)throw new Error('Legacy scope mismatch');
    if(!entryState(ctx,'memories',row.id))setEntry(ctx,{collection:'memories',id:row.id,bodyDigest:memoryDigest(row),sources:[{sourceRef:row.source_ref,sourceVersion:row.source_version,fragmentRef:'whole'}],generation:row.generation});
   }}
   finishFts();
  };
  const initializeNew=()=>{
   db.exec(CONTENT_V3_SCHEMA);
   const set=db.prepare('INSERT INTO metadata VALUES(?,?)');set.run('scope_ref',scopeRef);set.run('owner','@local/dsh-controlled-memory');set.run('generation','0');
   db.prepare("INSERT INTO metadata VALUES('authority_id',?)").run(authority.identity);
   db.prepare('INSERT INTO ledger.scope_state VALUES(?,0,0)').run(scopeRef);
   finishFts();
  };
  const verify=()=>{
   if(existing&&schemaSignature(db)!==CONTENT_V3_SIGNATURE)throw new Error('Memory schema/FTS index definition mismatch');
   if(schemaSignature(db,'ledger')!==AUTHORITY_V2_SIGNATURE)throw new Error('Deletion authority schema/identity unavailable');
  };
  if(!existing){
   if(authority.version<AUTHORITY_SCHEMA_VERSION)migrateConsolidationSchema(db,{contentVersion:CONTENT_SCHEMA_VERSION,authorityVersion:authority.version,verify,afterMigration:initializeNew});
   else write(ctx,initializeNew);
  }else if(originalVersion<CONTENT_SCHEMA_VERSION||authority.version<AUTHORITY_SCHEMA_VERSION){
   migrateConsolidationSchema(db,{contentVersion:originalVersion,authorityVersion:authority.version,legacyContentSql:EXTENSION_SCHEMA,verify,afterMigration:initializeExisting});
  }else write(ctx,initializeExisting);
  if(schemaSignature(db)!==CONTENT_V3_SIGNATURE)throw new Error('Memory schema/FTS index definition mismatch');
  try{db.exec("INSERT INTO memory_fts(memory_fts,rank) VALUES('integrity-check',1)");}catch{throw new Error('Memory FTS index unavailable; no fallback');}
  ctx.mainSchemaVersion=db.prepare('PRAGMA main.schema_version').get().schema_version;ctx.contentVersion=CONTENT_SCHEMA_VERSION;ctx.authority.version=AUTHORITY_SCHEMA_VERSION;ctx.ftsSecureDeleteRequired=true;
  const store=new MemoryStore(ctx);ctx.insertMemory=(value,generation)=>insertMemory(ctx,value,generation);return store;
 }catch(error){try{db.exec('ROLLBACK');}catch{}db.close();throw error;}
}
function insertMemory(ctx,value,generation){
 const createdAt=value.createdAt??new Date().toISOString();
 ctx.db.prepare(`INSERT INTO records(id,scope_ref,source_ref,source_version,kind,text,cjk,text_hash,origin,generation,created_at,supersedes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_ref=excluded.source_ref,source_version=excluded.source_version,kind=excluded.kind,text=excluded.text,cjk=excluded.cjk,text_hash=excluded.text_hash,origin=excluded.origin,generation=excluded.generation,created_at=excluded.created_at,supersedes=excluded.supersedes`).run(value.id,ctx.scopeRef,value.sourceRef,value.sourceVersion,value.kind,value.text,cjkBigrams(value.text),digest(value.text),value.origin,generation,createdAt,value.supersedes??null);
 return ctx.db.prepare('SELECT * FROM records WHERE id=?').get(value.id);
}
class MemoryStore{
 constructor(ctx){registerStore(this,ctx);Object.defineProperties(this,{scopeRef:{value:ctx.scopeRef,enumerable:true},databasePath:{value:ctx.databasePath,enumerable:true}});}
 generation(){return scopeState(contextOf(this)).epoch;}
 revision(){return scopeState(contextOf(this)).revision;}
 transaction(fn){return write(contextOf(this),fn);}
 validate(input){
  shape(input,['id','scopeRef','sourceRef','sourceVersion','kind','text','origin'],'memory');
  if(input.scopeRef!==undefined&&input.scopeRef!==this.scopeRef)throw new Error('Memory scope override denied');
  const value={id:checkedText(input.id,'id',256),sourceRef:checkedText(input.sourceRef,'source reference',2048),sourceVersion:checkedText(input.sourceVersion,'source version',512),text:checkedText(input.text,'memory text'),kind:input.kind??'lesson',origin:input.origin??'user'};
  if(!['fact','lesson','preference','decision'].includes(value.kind)||!['user','model'].includes(value.origin))throw new Error('Invalid memory field');return value;
 }
 put(input,{expectedGeneration}={}){
  const value=this.validate(input),ctx=contextOf(this);
  return write(ctx,()=>{
   checkEpoch(ctx,expectedGeneration);const previous=this.get(value.id),state=entryState(ctx,'memories',value.id);
   if(state&&state.state!=='active')throw new Error('Deleted/inactive memory tombstone');
   if(previous){if(previous.text===value.text&&previous.sourceRef===value.sourceRef&&previous.sourceVersion===value.sourceVersion&&previous.kind===value.kind&&previous.origin===value.origin)return previous;throw new Error('Memory identity is immutable; use explicit correction');}
   assertSources(ctx,[value]);
   const duplicate=ctx.db.prepare('SELECT id FROM records WHERE scope_ref=? AND source_ref=? AND source_version=? AND text_hash=?').get(this.scopeRef,value.sourceRef,value.sourceVersion,digest(value.text));
   if(duplicate){const known=this.get(duplicate.id);if(known)return known;throw new Error('Inactive source identity');}
   const generation=advance(ctx),row=insertMemory(ctx,value,generation);
   setEntry(ctx,{collection:'memories',id:value.id,bodyDigest:memoryDigest(row),sources:[{...value,fragmentRef:'whole'}],generation});return this.get(value.id);
  });
 }
 get(id){
  const ctx=contextOf(this);assertAuthority(ctx);id=checkedText(id,'id',256);
  const row=ctx.db.prepare('SELECT * FROM records WHERE id=? AND scope_ref=?').get(id,this.scopeRef);if(!row)return undefined;
  const state=entryState(ctx,'memories',id);if(!state||state.state!=='active')return undefined;
  if(digest(row.text)!==row.text_hash||!memoryLive(ctx,row))throw new Error('Memory record/authority integrity unavailable');
  return {id:row.id,scopeRef:this.scopeRef,sourceRef:row.source_ref,sourceVersion:row.source_version,text:row.text,kind:row.kind,origin:row.origin,verification:'unverified',state:'active',generation:row.generation,createdAt:row.created_at,supersedes:row.supersedes??undefined};
 }
 list({limit=100}={}){const ctx=contextOf(this);assertAuthority(ctx);this.limit(limit,500);return ctx.db.prepare("SELECT r.id FROM records r JOIN ledger.entries e ON e.scope_ref=r.scope_ref AND e.collection='memories' AND e.id=r.id AND e.state='active' WHERE r.scope_ref=? ORDER BY r.generation DESC LIMIT ?").all(this.scopeRef,limit).map(row=>this.get(row.id));}
 search(query,{limit=5}={}){
  query=checkedText(query,'query',2000);this.limit(limit,100);const ctx=contextOf(this),revision=this.revision(),key=JSON.stringify([this.scopeRef,query,limit,'fts-cjk-v1',revision]);
  const cached=ctx.cache.get(key);if(cached)return cached.map(id=>this.get(id)).filter(Boolean);
  const terms=[...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{1,64}/gu)??[])].filter(t=>t.length>=2||hasCjk(t)).slice(0,12),expression=terms.map(t=>cjkClause(t)).filter(Boolean).join(' OR ');if(!expression)return [];
  const ids=ctx.db.prepare("SELECT r.id FROM memory_fts JOIN records r ON r.rowid=memory_fts.rowid JOIN ledger.entries e ON e.scope_ref=r.scope_ref AND e.collection='memories' AND e.id=r.id AND e.state='active' WHERE memory_fts MATCH ? AND r.scope_ref=? ORDER BY bm25(memory_fts),r.id LIMIT ?").all(expression,this.scopeRef,limit).map(r=>r.id);
  if(!ctx.depth){if(ctx.cache.size>=32)ctx.cache.clear();ctx.cache.set(key,ids);}return ids.map(id=>this.get(id)).filter(Boolean);
 }
 exportSnapshot(){const ctx=contextOf(this);return write(ctx,()=>{
  const records=this.list({limit:500}),work=ctx.db.prepare("SELECT w.id,w.payload,w.generation FROM work_summaries w JOIN ledger.entries e ON e.scope_ref=w.scope_ref AND e.collection='work_summaries' AND e.id=w.id AND e.state='active' WHERE w.scope_ref=?").all(this.scopeRef);
  const count=ctx.db.prepare("SELECT count(*) AS n FROM ledger.entries WHERE scope_ref=? AND state='active' AND collection IN('memories','work_summaries')").get(this.scopeRef).n;
  if(count>500||work.length>500)throw new Error('Snapshot exceeds the bounded export limit; pagination required');
  for(const row of work){const state=entryState(ctx,'work_summaries',row.id);if(state.generation!==row.generation||state.body_digest!==digest(row.payload))throw new Error('Work authority integrity unavailable');}
  const head=ctx.db.prepare('SELECT revision,version_id AS versionId FROM ledger.consolidation_head WHERE scope_ref=?').get(this.scopeRef);
  const versionRows=ctx.db.prepare("SELECT v.id AS versionId,v.revision,v.digest,v.manifest_digest AS manifestDigest,v.created_at AS createdAt FROM ledger.consolidation_versions v JOIN ledger.entries e ON e.scope_ref=v.scope_ref AND e.collection='consolidation_versions' AND e.id=v.id AND e.state='active' WHERE v.scope_ref=? ORDER BY v.revision DESC").all(this.scopeRef);
  if(versionRows.length>25)throw new Error('Snapshot exceeds the bounded export limit; pagination required');
  const versions=versionRows.map(row=>{
   const sources=ctx.db.prepare('SELECT source_ref AS sourceRef,source_version AS sourceVersion,fragment_ref AS fragmentRef FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=? ORDER BY source_ref,source_version,fragment_ref').all(this.scopeRef,'consolidation_versions',row.versionId);
   if(sources.length>64)throw new Error('Snapshot exceeds the bounded export limit; pagination required');
   const dependencies=ctx.db.prepare("SELECT owner_kind AS ownerKind,owner_id AS ownerId,base_kind AS baseKind,base_id AS baseId,base_generation AS baseGeneration,base_digest AS baseDigest FROM ledger.consolidation_dependencies WHERE scope_ref=? AND owner_kind='version' AND owner_id=? ORDER BY base_kind,base_id").all(this.scopeRef,row.versionId);
   if(dependencies.length>128)throw new Error('Snapshot exceeds the bounded export limit; pagination required');
   return {versionId:row.versionId,revision:row.revision,digest:row.digest,manifestDigest:row.manifestDigest,createdAt:row.createdAt,head:head?.versionId===row.versionId,sources:sources.map(s=>({sourceRef:s.sourceRef,sourceVersion:s.sourceVersion,fragmentRef:s.fragmentRef})),dependencies:dependencies.map(d=>({ownerKind:d.ownerKind,ownerId:d.ownerId,baseKind:d.baseKind,baseId:d.baseId,baseGeneration:d.baseGeneration,baseDigest:d.baseDigest}))};
  });
  return {schema_version:3,scopeRef:this.scopeRef,authorityId:ctx.authority.identity,records,workSummaries:work.map(r=>JSON.parse(r.payload)),versions};
 });}
 restoreSnapshot(snapshot){return restoreSnapshot(this,snapshot);}
 registerExcerpt(args){return registerExcerpt(this,args);}
 readExcerpt(id){return readExcerpt(this,id);}
 forgetExcerpt(id){return forgetExcerpt(this,id);}
 listExcerpts(args){return listExcerptsForMemory(this,args);}
 suspendForCorrection(args){return suspendMemoryForCorrection(this,args);}
 correct(args){return correctMemory(this,args);}
 forget(args){return forget(this,args);}
 archive(args){return archive(this,args);}
 restoreArchived(args){return restoreArchived(this,args);}
 rebuildIndex(){const ctx=contextOf(this);return write(ctx,()=>{reconcile(ctx);ctx.db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");advance(ctx);return {rebuilt:true};});}
 limit(v,max){if(!Number.isSafeInteger(v)||v<1||v>max)throw new Error('Invalid memory limit');}
 close(){let ctx;try{ctx=contextOf(this);}catch{return;}ctx.db.close();ctx.closed=true;ctx.cache.clear();}
}
