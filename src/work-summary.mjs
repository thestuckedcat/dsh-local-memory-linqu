import {resolve,relative,isAbsolute} from 'node:path';
import {contextOf,write,checkEpoch,advance,entryState,assertSources,setEntry,operation,assertAuthority} from './store-internals.mjs';
import {checkedText,checkedPath,digest} from './scope.mjs';
import {shape,clean,canonical,fingerprint,sourceIdentity,integer} from './validation.mjs';
import {readProof,currentProofStatus} from './work-summary-evidence.mjs';
const CLAIMS=['myContribution','processOrConclusion','result'];
export function validateWorkDraft(value){
 shape(value,['itemType','title','goal',...CLAIMS,'time','projectRef','requirementRef','problemRef','problemState'],'work draft');clean(value);
 if(!['project','requirement','problem'].includes(value.itemType))throw new Error('Invalid work item type');
 const draft={itemType:value.itemType,title:checkedText(value.title,'work title',512),goal:checkedText(value.goal??'unknown','goal',4000)};
 for(const claim of CLAIMS)draft[claim]=checkedText(value[claim]??'unknown',claim,4000);
 const time=value.time??{precision:'unknown'};shape(time,['start','end','precision'],'work time');
 if(!['unknown','year','month','day'].includes(time.precision))throw new Error('Invalid work time precision');
 const pattern={year:/^\d{4}$/,month:/^\d{4}-(0[1-9]|1[0-2])$/,day:/^\d{4}-\d{2}-\d{2}$/};
 const checkedDate=input=>{if(input===undefined||input===null)return null;const text=checkedText(input,'work date',10);if(!pattern[time.precision]?.test(text))throw new Error('Invalid work date/precision');if(time.precision==='day'&&(Number.isNaN(Date.parse(text))||new Date(text).toISOString().slice(0,10)!==text))throw new Error('Invalid calendar date');return text;};
 draft.time={start:checkedDate(time.start),end:checkedDate(time.end),precision:time.precision};
 if(time.precision==='unknown'&&(time.start||time.end))throw new Error('Unknown time cannot have guessed dates');
 if(draft.time.start&&draft.time.end&&draft.time.start>draft.time.end)throw new Error('Work time range is reversed');
 for(const k of ['projectRef','requirementRef','problemRef'])if(value[k]!==undefined)draft[k]=checkedText(value[k],k,512);
 if(value.problemState!==undefined){if(!['exploring','solved','not_reproduced','inconclusive'].includes(value.problemState))throw new Error('Invalid problem state');draft.problemState=value.problemState;}
 return draft;
}
function checkedSources(value){if(!Array.isArray(value)||value.length<1||value.length>20)throw new Error('Work sources required');const map=new Map();for(const item of value){const s=sourceIdentity(item);map.set(fingerprint(s),s);}return [...map.values()];}
function makeClaim(text,origin){return {text,basis:origin==='model'?'inferred':'user_reported',support:'missing',confirmation:'pending',evidenceRefs:[]};}
function pending(row){
 row.pendingEvidence=CLAIMS.filter(k=>row[k].text!=='unknown'&&row[k].support!=='supported');
 row.pendingConfirmation=[...new Set([...CLAIMS.filter(k=>row[k].confirmation!=='user_confirmed'),...(row.time.precision==='unknown'||!row.time.start||row.time.confirmation!=='user_confirmed'?['time']:[]),...(row.conflicts??[]).map(v=>v.claimRef)])];
 return row;
}
function fromDraft(id,scopeRef,draft,sources,origin){const now=new Date().toISOString();const row={schema_version:1,id,collection:'work_summaries',scopeRef,itemType:draft.itemType,title:draft.title,goal:draft.goal,time:{...draft.time,basis:origin==='model'?'inferred':'user_reported',confirmation:'pending',observedAt:now},sources,evidenceRefs:[],conflicts:[],recordState:'draft',dimensionMapping:{status:'pending_reference'},evidenceVerification:'at_recorded_version',createdAt:now,updatedAt:now};for(const k of CLAIMS)row[k]=makeClaim(draft[k],origin);for(const k of ['projectRef','requirementRef','problemRef','problemState'])if(draft[k]!==undefined)row[k]=draft[k];return pending(row);}
function rawWork(ctx,id){assertAuthority(ctx);const row=ctx.db.prepare('SELECT * FROM work_summaries WHERE id=? AND scope_ref=?').get(checkedText(id,'work id',256),ctx.scopeRef);if(!row)return undefined;const state=entryState(ctx,'work_summaries',id);if(!state||state.state!=='active')return undefined;if(state.generation!==row.generation||state.body_digest!==digest(row.payload)||row.text_hash!==digest(row.payload))throw new Error('Work record authority integrity unavailable');const body=JSON.parse(row.payload);if(body.id!==id||body.scopeRef!==ctx.scopeRef||body.collection!=='work_summaries'||body.generation!==row.generation)throw new Error('Work identity mismatch');return body;}
function commitWork(ctx,body,{lifecycle=false}={}){
 assertSources(ctx,body.sources);const previous=entryState(ctx,'work_summaries',body.id);if(previous&&previous.state!=='active')throw new Error('Deleted/inactive work tombstone');
 const generation=advance(ctx,{lifecycle});body.generation=generation;body.updatedAt=new Date().toISOString();pending(body);clean(body);
 const payload=canonical(body),hash=digest(payload);
 ctx.db.prepare('INSERT INTO work_summaries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,text_hash=excluded.text_hash,generation=excluded.generation').run(body.id,ctx.scopeRef,payload,hash,generation);
 setEntry(ctx,{collection:'work_summaries',id:body.id,bodyDigest:hash,sources:body.sources,generation,supersedes:body.supersedes??null});return {id:body.id,generation,recordState:body.recordState,pendingEvidence:body.pendingEvidence,pendingConfirmation:body.pendingConfirmation};
}
export function createWorkSummaryManager(store,{evidenceRoots=[],authorize=()=>false}={}){
 const ctx=contextOf(store),roots=evidenceRoots.map(p=>checkedPath(p));
 function localReference(path){
  path=checkedText(path,'evidence path',4096);if(!/^[A-Za-z]:[\\/]/.test(path)||path.includes(':',2))throw new Error('Evidence must use an approved local root');
  const full=resolve(path);if(!roots.some(root=>{const r=relative(root,full);return !r.startsWith('..')&&!isAbsolute(r);} ))throw new Error('Evidence path outside approved roots');
  if(/(?:^|[\\/])(?:\.env(?:\..*)?|\.credentials[^\\/]*|id_(?:rsa|ed25519)|[^\\/]*\.(?:pem|key))$/i.test(full))throw new Error('Credential evidence source denied');
  return checkedPath(full);
 }
 function allowed(action,fields){if(authorize(Object.freeze({action,scopeRef:ctx.scopeRef,...fields}))!==true)throw new Error('User authorization required');}
 function active(id){const row=rawWork(ctx,id);if(!row)throw new Error('Work summary is not active');return row;}
 const api={
  save(args){
   shape(args,['requestId','scopeRef','itemRef','draft','sources','expectedGeneration','origin'],'work save');if(args.scopeRef!==undefined&&args.scopeRef!==ctx.scopeRef)throw new Error('Work scope override denied');
   const value=validateWorkDraft(args.draft),sources=checkedSources(args.sources),origin=args.origin??'user';if(!['user','model'].includes(origin))throw new Error('Invalid work origin');
   const anchors=[...new Map(sources.map(s=>[fingerprint({sourceRef:s.sourceRef,fragmentRef:s.fragmentRef}),{sourceRef:s.sourceRef,fragmentRef:s.fragmentRef}])).values()];
   if(args.itemRef===undefined&&anchors.length!==1)throw new Error('Explicit item reference required for multiple source anchors');
   const itemRef=args.itemRef===undefined?fingerprint(anchors[0]):checkedText(args.itemRef,'item reference',512),id=`work-${digest(ctx.scopeRef+':'+itemRef)}`;
   const receipt=operation(ctx,args.requestId,{itemRef,value,sources,origin},()=>{
    checkEpoch(ctx,args.expectedGeneration);assertSources(ctx,sources);
    const existing=rawWork(ctx,id);
    if(existing){
     const same=existing.title===value.title&&existing.itemType===value.itemType&&existing.goal===value.goal&&CLAIMS.every(k=>existing[k].text===value[k])&&fingerprint(existing.sources)===fingerprint(sources)&&fingerprint({start:existing.time.start,end:existing.time.end,precision:existing.time.precision})===fingerprint(value.time);
     if(!same)throw new Error('Work identity is immutable; use explicit merge/correction');
     return {id,generation:existing.generation,recordState:existing.recordState,pendingEvidence:existing.pendingEvidence,pendingConfirmation:existing.pendingConfirmation};
    }
    return commitWork(ctx,fromDraft(id,ctx.scopeRef,value,sources,origin));
   });return {...receipt,currentState:entryState(ctx,'work_summaries',id)?.state??'unavailable'};
  },
  get(id){
   const row=rawWork(ctx,id);if(!row)return undefined;
   for(const claim of CLAIMS)if(row[claim].support==='supported'||row[claim].support==='partial'||row[claim].support==='conflicting'){
    const refs=row[claim].evidenceRefs.map(ref=>row.evidenceRefs.find(e=>e.id===ref));
    if(!refs.length||refs.some(ref=>{if(!ref||ref.digest!==(row[claim].supportVersions?.[ref.id]??row[claim].supportValidAtDigest))return true;try{if(authorize(Object.freeze({action:'revalidateEvidence',scopeRef:ctx.scopeRef,id:row.id,evidenceRef:ref.id,localPath:ref.localPath,documentDigest:ref.digest}))!==true)return true;}catch{return true;}return currentProofStatus(ref,localReference)!=='current';}))row[claim].support='unread';
   }
   return pending(row);
  },
  list({limit=100,cursor}={}){
   integer(limit,1,500,'work limit');const revision=store.revision();let offset=0;
   if(cursor){shape(cursor,['revision','offset'],'work cursor');if(cursor.revision!==revision)throw new Error('Stale work cursor');offset=integer(cursor.offset,0,100000,'work offset');}
   const ids=ctx.db.prepare("SELECT w.id FROM work_summaries w JOIN ledger.entries e ON e.scope_ref=w.scope_ref AND e.collection='work_summaries' AND e.id=w.id AND e.state='active' WHERE w.scope_ref=? ORDER BY w.generation,w.id LIMIT ? OFFSET ?").all(ctx.scopeRef,limit+1,offset);
   const total=ctx.db.prepare("SELECT count(*) AS n FROM ledger.entries WHERE scope_ref=? AND collection='work_summaries' AND state='active'").get(ctx.scopeRef).n;
   return {items:ids.slice(0,limit).map(row=>api.get(row.id)),nextCursor:ids.length>limit?{revision,offset:offset+limit}:null,total};
  },
  merge(args){
   shape(args,['id','draft','sources','origin','expectedGeneration'],'work merge');const candidate=validateWorkDraft(args.draft),sources=checkedSources(args.sources);
   return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);assertSources(ctx,sources);const row=active(args.id),before=fingerprint({sources:row.sources,conflicts:row.conflicts});
    if(row.itemType!==candidate.itemType||row.title!==candidate.title)throw new Error('Merge requires explicit same work identity');
    const union=new Map([...row.sources,...sources].map(s=>[fingerprint(s),s]));row.sources=[...union.values()];
    for(const k of CLAIMS)if(candidate[k]!==row[k].text&&candidate[k]!=='unknown'&&!row.conflicts.some(c=>c.claimRef===k&&c.text===candidate[k]))row.conflicts.push({claimRef:k,text:candidate[k],basis:'inferred'});
    const propose=(key,text)=>{if(!row.conflicts.some(c=>c.claimRef===key&&c.text===text))row.conflicts.push({claimRef:key,text,basis:'inferred'});};
    if(candidate.time.precision!=='unknown'&&(candidate.time.start||candidate.time.end)&&fingerprint(candidate.time)!==fingerprint({start:row.time.start,end:row.time.end,precision:row.time.precision}))propose('time',canonical(candidate.time));
    for(const key of ['goal','projectRef','requirementRef','problemRef','problemState'])if(candidate[key]!==undefined&&candidate[key]!=='unknown'&&candidate[key]!==row[key])propose(key,candidate[key]);
    if(row.conflicts.length>30)throw new Error('Work conflict limit');
    if(before===fingerprint({sources:row.sources,conflicts:row.conflicts}))return {id:row.id,generation:row.generation,recordState:row.recordState,pendingEvidence:row.pendingEvidence,pendingConfirmation:row.pendingConfirmation};
    row.supersedes=`${row.id}@${row.generation}`;return commitWork(ctx,row,{lifecycle:true});
   });
  },
  correct(args){
   shape(args,['id','draft','sources','expectedGeneration'],'work correction');const draft=validateWorkDraft(args.draft),sources=checkedSources(args.sources);allowed('correctWork',{id:args.id});
   return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);const old=active(args.id),body=fromDraft(old.id,ctx.scopeRef,draft,checkedSources([...old.sources,...sources]),'user');body.createdAt=old.createdAt;body.supersedes=`${old.id}@${old.generation}`;body.evidenceRefs=old.evidenceRefs;return commitWork(ctx,body,{lifecycle:true});});
  },
  confirmClaim(args){shape(args,['id','claimRef','expectedGeneration'],'confirmation');if(!CLAIMS.includes(args.claimRef))throw new Error('Invalid claim');allowed('confirmClaim',{id:args.id,claimRef:args.claimRef});return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);const row=active(args.id);row[args.claimRef].confirmation='user_confirmed';return commitWork(ctx,row,{lifecycle:true});});},
  confirmTime(args){shape(args,['id','expectedGeneration'],'time confirmation');allowed('confirmTime',{id:args.id});return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);const row=active(args.id);if(row.time.precision==='unknown'||!row.time.start)throw new Error('Unknown work date cannot be confirmed');row.time.confirmation='user_confirmed';return commitWork(ctx,row,{lifecycle:true});});},
  registerEvidence(args){
   shape(args,['id','reference','claimRefs','expectedGeneration'],'evidence registration');shape(args.reference,['localPath','url','displayName'],'evidence reference');clean(args.reference);
   if(!Array.isArray(args.claimRefs)||!args.claimRefs.length||args.claimRefs.some(k=>!CLAIMS.includes(k)))throw new Error('Invalid evidence claim refs');
   const ref={displayName:checkedText(args.reference.displayName??'Evidence','evidence name',256),claimRefs:[...new Set(args.claimRefs)],accessStatus:'unread'};
   if(args.reference.localPath!==undefined&&args.reference.url===undefined)ref.localPath=localReference(args.reference.localPath);
   else if(args.reference.url!==undefined&&args.reference.localPath===undefined){const url=new URL(checkedText(args.reference.url,'evidence URL',2048));if(url.protocol!=='https:'&&url.protocol!=='http:')throw new Error('Unsupported evidence reference');ref.url=url.href;ref.accessStatus='not_retrieved';}
   else throw new Error('One evidence reference required');
   ref.id=`evidence-${fingerprint({localPath:ref.localPath?.toLowerCase()??null,url:ref.url??null})}`;
   return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);const row=active(args.id),old=row.evidenceRefs.find(e=>e.id===ref.id);if(old){const union=[...new Set([...old.claimRefs,...ref.claimRefs])];if(union.length!==old.claimRefs.length){old.claimRefs=union;commitWork(ctx,row,{lifecycle:true});}return {evidenceRef:old.id,accessStatus:old.accessStatus,supportUnchanged:true};}if(row.evidenceRefs.length>=20)throw new Error('Evidence limit');row.evidenceRefs.push(ref);commitWork(ctx,row,{lifecycle:true});return {evidenceRef:ref.id,accessStatus:ref.accessStatus,supportUnchanged:true};});
  },
  reviewEvidence(args){
   shape(args,['id','evidenceRef','claimRef','assessment','expectedGeneration'],'evidence review');shape(args.assessment,['support','quote','note'],'assessment');clean(args.assessment);
   if(!CLAIMS.includes(args.claimRef)||!['supported','partial','conflicting'].includes(args.assessment.support))throw new Error('Invalid evidence assessment');
   const current=active(args.id),ref=current.evidenceRefs.find(r=>r.id===args.evidenceRef);if(!ref||!ref.localPath||!ref.claimRefs.includes(args.claimRef))throw new Error('Evidence is not linked to this claim');
   allowed('readEvidence',{id:args.id,evidenceRef:ref.id,claimRef:args.claimRef});
   const proof=readProof(localReference(ref.localPath)),quote=checkedText(args.assessment.quote,'support quote',500),note=checkedText(args.assessment.note,'support note',2000);
   if(!proof.text.includes(quote))throw new Error('Evidence quote does not match this document version');
   allowed('reviewEvidence',{id:args.id,evidenceRef:ref.id,claimRef:args.claimRef,documentDigest:proof.digest,support:args.assessment.support});
   return write(ctx,()=>{checkEpoch(ctx,args.expectedGeneration);const row=active(args.id);if(row.generation!==current.generation)throw new Error('Stale evidence review');const entry=row.evidenceRefs.find(e=>e.id===ref.id);Object.assign(entry,{digest:proof.digest,readAuthorized:true,accessStatus:'read',reviewedAt:new Date().toISOString()});
    Object.assign(row[args.claimRef],{support:args.assessment.support,evidenceRefs:[...new Set([...row[args.claimRef].evidenceRefs,ref.id])],supportNote:note,supportQuote:quote,supportValidAtDigest:proof.digest,supportVersions:{...row[args.claimRef].supportVersions,[ref.id]:proof.digest}});return commitWork(ctx,row,{lifecycle:true});
   });
  }
 };
 return Object.freeze(api);
}
