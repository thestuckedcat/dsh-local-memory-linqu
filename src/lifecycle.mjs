import {randomUUID} from 'node:crypto';
import {checkedText,digest} from './scope.mjs';
import {shape,clean,canonical,fingerprint} from './validation.mjs';
import {contextOf,write,checkEpoch,advance,entryState,assertSources,setEntry,memoryDigest,purgeExcerptsForMemory} from './store-internals.mjs';

function target(store,args){
 shape(args,['id','collection','scopeRef','expectedGeneration'],'lifecycle');
 if(args.scopeRef!==undefined&&args.scopeRef!==store.scopeRef)throw new Error('Lifecycle scope mismatch');
 const collection=args.collection??'memories';if(!['memories','work_summaries'].includes(collection))throw new Error('Unknown collection');
 return {id:checkedText(args.id,'record id',256),collection};
}
function sourcesFor(ctx,collection,id){return ctx.db.prepare('SELECT source_ref AS sourceRef,source_version AS sourceVersion,fragment_ref AS fragmentRef FROM ledger.entry_sources WHERE scope_ref=? AND collection=? AND id=?').all(ctx.scopeRef,collection,id);}
function blockSources(ctx,sources){for(const s of sources)ctx.db.prepare('INSERT OR IGNORE INTO ledger.source_blocks VALUES(?,?,?,0)').run(ctx.scopeRef,s.sourceRef,s.sourceVersion);}
function updateState(ctx,collection,id,state){ctx.db.prepare('UPDATE ledger.entries SET state=? WHERE scope_ref=? AND collection=? AND id=?').run(state,ctx.scopeRef,collection,id);}
export function forget(store,args){
 const {id,collection}=target(store,args),ctx=contextOf(store);
 return write(ctx,()=>{
  const old=entryState(ctx,collection,id);if(!old)throw new Error('Unknown record');
  if(old.state==='deleted')return {deleted:true,generation:store.generation(),backupCopies:'not-revoked'};
  checkEpoch(ctx,args.expectedGeneration);advance(ctx,{lifecycle:true});
  blockSources(ctx,sourcesFor(ctx,collection,id));updateState(ctx,collection,id,'deleted');
  ctx.db.prepare(`DELETE FROM ${collection==='memories'?'records':'work_summaries'} WHERE id=? AND scope_ref=?`).run(id,ctx.scopeRef);
  if(collection==='memories')purgeExcerptsForMemory(ctx,id);
  // Persisted inputs for invalidated epochs cannot remain a hidden copy of deleted material.
  ctx.db.prepare('DELETE FROM job_inputs WHERE id IN (SELECT id FROM ledger.jobs WHERE scope_ref=? AND epoch<>?)').run(ctx.scopeRef,store.generation());
  return {deleted:true,generation:store.generation(),currentSqliteBodyAndIndexCleared:true,backupCopies:'not-revoked'};
 });
}
export function archive(store,args){const {id,collection}=target(store,args),ctx=contextOf(store);return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);if(entryState(ctx,collection,id)?.state!=='active')throw new Error('Record is not active');advance(ctx,{lifecycle:true});updateState(ctx,collection,id,'archived');return {archived:true,bodyRetained:true,generation:store.generation()};});}
export function restoreArchived(store,args){const {id,collection}=target(store,args),ctx=contextOf(store);return write(ctx,()=>{
 checkEpoch(ctx,args.expectedGeneration);const old=entryState(ctx,collection,id);if(old?.state!=='archived')throw new Error('Only archived entries can be restored; deleted entries cannot');assertSources(ctx,sourcesFor(ctx,collection,id));
 const row=ctx.db.prepare(`SELECT * FROM ${collection==='memories'?'records':'work_summaries'} WHERE id=? AND scope_ref=?`).get(id,ctx.scopeRef);
 if(!row||old.generation!==row.generation||old.body_digest!==(collection==='memories'?memoryDigest(row):digest(row.payload)))throw new Error('Archived body integrity unavailable');
 advance(ctx,{lifecycle:true});updateState(ctx,collection,id,'active');return {restored:true,generation:store.generation()};
});}
export function correctMemory(store,args){
 shape(args,['id','text','sourceVersion','expectedGeneration'],'correction');const ctx=contextOf(store),old=store.get(args.id);if(!old)throw new Error('Memory is not active');
 const value=store.validate({id:randomUUID(),text:args.text,sourceRef:old.sourceRef,sourceVersion:args.sourceVersion,kind:old.kind,origin:'user'});
 if(value.sourceVersion===old.sourceVersion)throw new Error('Correction requires its new source version');
 return write(ctx,()=>{
  checkEpoch(ctx,args.expectedGeneration);if(store.get(old.id)?.generation!==old.generation)throw new Error('Stale correction');
  const generation=advance(ctx,{lifecycle:true});blockSources(ctx,sourcesFor(ctx,'memories',old.id));updateState(ctx,'memories',old.id,'superseded');ctx.db.prepare('DELETE FROM records WHERE id=?').run(old.id);purgeExcerptsForMemory(ctx,old.id);
  const row=ctx.insertMemory({...value,supersedes:old.id},generation);setEntry(ctx,{collection:'memories',id:value.id,bodyDigest:memoryDigest(row),sources:[{sourceRef:value.sourceRef,sourceVersion:value.sourceVersion,fragmentRef:'whole'}],generation,supersedes:old.id});return store.get(value.id);
 });
}
export function restoreSnapshot(store,snapshot){
 shape(snapshot,['schema_version','scopeRef','authorityId','records','workSummaries'],'snapshot');clean(snapshot);
 const ctx=contextOf(store);
 if(snapshot.schema_version!==2||snapshot.scopeRef!==ctx.scopeRef||snapshot.authorityId!==ctx.authority.identity||!Array.isArray(snapshot.records)||!Array.isArray(snapshot.workSummaries)||snapshot.records.length+snapshot.workSummaries.length>500)throw new Error('Snapshot scope/authority/size mismatch');
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
  advance(ctx);return {restored,skipped,authorityPreserved:true};
 });
}
export function consumeCapabilityEvent(store,event){
 shape(event,['schema_version','event_id','kind','source_capability','scope_ref','session_ref','operation_id','generation','affected_refs','outcome','before_snapshot','after_snapshot','occurred_at'],'capability event');clean(event);
 const ctx=contextOf(store);
 if(event.schema_version!==1||event.source_capability!=='03-session-management'||event.scope_ref!==ctx.scopeRef)throw new Error('Capability event scope/version mismatch');
 if(!['session_surface_rewound','workspace_files_restored','session_removed'].includes(event.kind)||!['completed','partial','outcome_unknown'].includes(event.outcome)||!Number.isSafeInteger(event.generation)||event.generation<0||!Array.isArray(event.affected_refs)||event.affected_refs.length>100)throw new Error('Invalid capability event');
 if(event.kind==='session_removed')checkedText(event.session_ref,'session reference',512);
 const id=checkedText(event.event_id,'event ID',256);checkedText(event.operation_id,'operation ID',256);checkedText(event.occurred_at,'event date',64);
 const refs=[...new Set([...event.affected_refs.map(r=>checkedText(r,'affected source',2048)),...(event.kind==='session_removed'?[event.session_ref]:[])])],hash=fingerprint(event);
 if(!refs.length)throw new Error('Capability event requires explicit affected refs');
 return write(ctx,()=>{
  const previous=ctx.db.prepare('SELECT fingerprint FROM ledger.events WHERE scope_ref=? AND event_id=?').get(ctx.scopeRef,id);
  if(previous){if(previous.fingerprint!==hash)throw new Error('Event identity changed');return {duplicate:true,generation:store.generation()};}
  advance(ctx,{lifecycle:true});
  const rows=ctx.db.prepare('SELECT DISTINCT collection,id,source_ref FROM ledger.entry_sources WHERE scope_ref=?').all(ctx.scopeRef);
  for(const ref of refs){ctx.db.prepare("INSERT OR IGNORE INTO ledger.source_blocks VALUES(?,?,'*',1)").run(ctx.scopeRef,ref);for(const row of rows)if(row.source_ref===ref||row.source_ref.startsWith(ref+'/'))ctx.db.prepare("UPDATE ledger.entries SET state='stale' WHERE scope_ref=? AND collection=? AND id=? AND state IN('active','archived')").run(ctx.scopeRef,row.collection,row.id);}
  ctx.db.prepare('DELETE FROM job_inputs WHERE id IN(SELECT id FROM ledger.jobs WHERE scope_ref=? AND epoch<>?)').run(ctx.scopeRef,store.generation());
  ctx.db.prepare('INSERT INTO ledger.events VALUES(?,?,?)').run(ctx.scopeRef,id,hash);return {duplicate:false,generation:store.generation()};
 });
}
