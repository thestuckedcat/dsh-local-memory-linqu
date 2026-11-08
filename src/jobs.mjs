import {randomUUID} from 'node:crypto';
import {checkedText} from './scope.mjs';
import {shape,clean,canonical,fingerprint,sourceIdentity,integer} from './validation.mjs';
import {contextOf,write,assertAuthority,checkEpoch,assertSources,scopeState} from './store-internals.mjs';
import {PURPOSES,RouteUnavailable,ProviderResponseError} from './provider.mjs';
import {createWorkSummaryManager,validateWorkDraft} from './work-summary.mjs';
const DEFAULTS=Object.freeze({dailyRequests:20,sessionRequests:5,dailyInputChars:80000,dailyOutputTokens:4096,maxOutputTokens:512});
const CAPS=Object.freeze({dailyRequests:100,sessionRequests:20,dailyInputChars:320000,dailyOutputTokens:20000,maxOutputTokens:2048});
const queueOwners=new WeakMap();
const signalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
/** Internal Host integration seam: validate real ownership and capture only approved routing metadata. */
export function snapshotQueueRoute(queue,store,routeRef,purpose='memory_extract'){
 const owner=queueOwners.get(queue);if(!owner||owner.store!==store||!PURPOSES.includes(purpose))throw new Error('Queue/store ownership unavailable');
 const raw=owner.provider.bind(routeRef,purpose);
 if(raw&&typeof raw.then==='function'){Promise.resolve(raw).catch(()=>{});throw new Error('Synchronous route required');}
 shape(raw,['routeRef','provider','model','routeVersion'],'queue route');
 const result=Object.fromEntries(['routeRef','provider','model','routeVersion'].map(key=>[key,checkedText(raw[key],key,512)]));
 if(result.routeRef!==routeRef)throw new Error('Queue route identity mismatch');return Object.freeze(result);
}
function limitsOf(value){shape(value,Object.keys(DEFAULTS),'budget limits');return Object.fromEntries(Object.keys(DEFAULTS).map(k=>[k,integer(value[k]??DEFAULTS[k],1,CAPS[k],k)]));}
const terminal=state=>!['queued','running'].includes(state);
const dayOf=date=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
export function createJobQueue(store,{provider,limits={},now=()=>new Date(),authorizeRecovery=()=>false,authorizeExecution=()=>undefined,onMemoryExtracted}={}){
 if(!provider||typeof provider.bind!=='function'||typeof provider.execute!=='function'||typeof provider.approved!=='function')throw new Error('Controlled provider required');
 if(provider.measureInput!==undefined&&typeof provider.measureInput!=='function')throw new Error('Trusted input measurement required');
 if(typeof authorizeExecution!=='function')throw new Error('Trusted execution authority required');
 if(onMemoryExtracted!==undefined&&typeof onMemoryExtracted!=='function')throw new Error('Memory extraction observer must be a function');
 const ctx=contextOf(store),policy=limitsOf(limits),policyHash=fingerprint(policy);
 function inputSize(input,purpose){
  try{const value=provider.measureInput===undefined?input.length:provider.measureInput(Object.freeze({input,purpose}));if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});throw new Error('Asynchronous input measurement');}return integer(value,input.length,8000,'model input length');}
  catch{throw new Error('Model input accounting unavailable');}
 }
 function raw(id){assertAuthority(ctx);return ctx.db.prepare('SELECT * FROM ledger.jobs WHERE id=? AND scope_ref=?').get(checkedText(id,'job ID',256),ctx.scopeRef);}
 function view(row){if(!row)return undefined;return {jobId:row.id,state:row.state,purpose:row.purpose,costStatus:row.cost_status,reason:row.reason??undefined,result:row.result_json?JSON.parse(row.result_json):undefined};}
 function finish(row,state,{reason=null,cost='unknown',result=null,quarantine=false}={}){
  if(quarantine)ctx.db.prepare("UPDATE ledger.dispatch_lock SET phase='unknown' WHERE job_id=? AND run_token=?").run(row.id,row.run_token);
  else ctx.db.prepare('DELETE FROM ledger.dispatch_lock WHERE job_id=? AND run_token=?').run(row.id,row.run_token);
  ctx.db.prepare('UPDATE ledger.jobs SET state=?,reason=?,cost_status=?,result_json=?,run_token=NULL WHERE id=? AND scope_ref=?').run(state,reason,cost,result?canonical(result):null,row.id,ctx.scopeRef);
  ctx.db.prepare('DELETE FROM job_inputs WHERE id=?').run(row.id);return view(raw(row.id));
 }
 function executionMetadata(row,payload,route){return Object.freeze({jobId:row.id,scopeRef:ctx.scopeRef,payloadFingerprint:row.fingerprint,purpose:row.purpose,sessionRef:payload.sessionRef,sourceRef:payload.sourceRef,sourceVersion:payload.sourceVersion,fragmentRef:payload.fragmentRef,inputClass:payload.inputClass,inputDigest:fingerprint(payload.input),generation:row.epoch,route:Object.freeze({...route}),itemRef:payload.itemRef});}
 function executionApproval(metadata,phase){
  const value=authorizeExecution(Object.freeze({...metadata,phase}));
  if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});throw new Error('Execution authority unavailable');}
  shape(value,['authorizationVersion','signal'],'execution approval');
  const authorizationVersion=checkedText(value.authorizationVersion,'execution authorization version',512),signal=value.signal;
  if(signalAborted.call(signal))throw new Error('Execution authority unavailable');
  return {authorizationVersion,signal};
 }
 function executionLease(metadata){
  const approval=executionApproval(metadata,'claim');let invalid=false;
  return {signal:approval.signal,assertActive(){if(invalid||signalAborted.call(approval.signal)){invalid=true;throw new Error('Execution authority unavailable');}},check(phase){
   if(invalid||signalAborted.call(approval.signal)){invalid=true;throw new Error('Execution authority unavailable');}
   try{const live=executionApproval(metadata,phase);if(live.authorizationVersion!==approval.authorizationVersion||live.signal!==approval.signal||signalAborted.call(approval.signal))throw new Error('Execution authority changed');}
   catch{invalid=true;throw new Error('Execution authority unavailable');}
  }};
 }
 const api={
  enqueue(args){
   shape(args,['requestId','scopeRef','sessionRef','sourceRef','sourceVersion','fragmentRef','inputRef','inputClass','input','routeRef','generation','purpose','itemRef'],'queued request');clean(args);
   if(args.scopeRef!==ctx.scopeRef)throw new Error('Queue scope mismatch');if(!['conversation_fragment','user_summary'].includes(args.inputClass))throw new Error('Credential or untrusted input source denied');
   if(!PURPOSES.includes(args.purpose))throw new Error('Unsupported queue purpose');
   if(args.purpose==='work_summary_merge'&&!args.itemRef)throw new Error('Explicit work item required for merge');
   const route=provider.bind(args.routeRef,args.purpose),source=sourceIdentity({sourceRef:args.sourceRef,sourceVersion:args.sourceVersion,fragmentRef:args.fragmentRef});
   const requestId=checkedText(args.requestId,'request ID',256),sessionRef=checkedText(args.sessionRef,'session reference',512),input=checkedText(args.input,'model input',8000),inputRef=checkedText(args.inputRef,'input reference',2048);
   integer(args.generation,0,Number.MAX_SAFE_INTEGER,'generation');
   const inputChars=inputSize(input,args.purpose);
   const payload={...source,input,inputChars,inputRef,inputClass:args.inputClass,purpose:args.purpose,route,generation:args.generation,sessionRef,itemRef:args.itemRef??null,maxTokens:policy.maxOutputTokens};
   if(payload.itemRef!==null)checkedText(payload.itemRef,'work item',512);
   const hash=fingerprint(payload),eventKey=fingerprint({source,purpose:args.purpose,itemRef:payload.itemRef});
   return write(ctx,()=>{
    const previous=ctx.db.prepare('SELECT * FROM ledger.jobs WHERE scope_ref=? AND (request_id=? OR event_key=?)').all(ctx.scopeRef,requestId,eventKey);
    if(previous.length){if(previous.length!==1||previous[0].fingerprint!==hash)throw new Error('Request/source identity changed');return view(previous[0]);}
    checkEpoch(ctx,args.generation);assertSources(ctx,[source]);
    const instant=now();if(!(instant instanceof Date)||Number.isNaN(+instant))throw new Error('Invalid queue clock');const day=dayOf(instant);
    const daily=ctx.db.prepare('SELECT * FROM ledger.daily_budget WHERE day=?').get(day)??{requests:0,input_chars:0,output_tokens:0};
    const session=ctx.db.prepare('SELECT requests FROM ledger.session_budget WHERE scope_ref=? AND session_ref=?').get(ctx.scopeRef,sessionRef)?.requests??0;
    if(daily.requests+1>policy.dailyRequests||daily.input_chars+inputChars>policy.dailyInputChars||daily.output_tokens+policy.maxOutputTokens>policy.dailyOutputTokens||session+1>policy.sessionRequests)throw new Error('Model budget exhausted');
    ctx.db.prepare('INSERT INTO ledger.daily_budget VALUES(?,?,?,?) ON CONFLICT(day) DO UPDATE SET requests=excluded.requests,input_chars=excluded.input_chars,output_tokens=excluded.output_tokens').run(day,daily.requests+1,daily.input_chars+inputChars,daily.output_tokens+policy.maxOutputTokens);
    ctx.db.prepare('INSERT INTO ledger.session_budget VALUES(?,?,?) ON CONFLICT(scope_ref,session_ref) DO UPDATE SET requests=excluded.requests').run(ctx.scopeRef,sessionRef,session+1);
    const id=randomUUID();
    ctx.db.prepare("INSERT INTO ledger.jobs VALUES(?,?,?,?,?,'queued',?,?,?,?,?,?,NULL,'not_dispatched',NULL,NULL,?)").run(id,ctx.scopeRef,requestId,eventKey,hash,canonical(route),args.purpose,args.generation,day,sessionRef,policyHash,instant.toISOString());
    ctx.db.prepare('INSERT INTO job_inputs VALUES(?,?)').run(id,canonical(payload));return view(raw(id));
   });
  },
  get(id){return view(raw(id));},
  /** Read-only oldest-first queued views for the Host scheduler; no claim, no write. */
  pending({limit=1}={}){integer(limit,1,100,'pending job limit');const ctx=contextOf(store);assertAuthority(ctx);return ctx.db.prepare("SELECT * FROM ledger.jobs WHERE scope_ref=? AND state='queued' ORDER BY created_at,rowid LIMIT ?").all(ctx.scopeRef,limit).map(view);},
  /** Read-only job views by optional state; never changes state, budget, locks or inputs. */
  list({state,limit=20}={}){
   if(state!==undefined&&!['queued','running','completed','failed','stale','outcome_unknown'].includes(state))throw new Error('Invalid job state filter');
   integer(limit,1,100,'job list limit');const ctx=contextOf(store);assertAuthority(ctx);
   const rows=state===undefined?ctx.db.prepare('SELECT * FROM ledger.jobs WHERE scope_ref=? ORDER BY created_at,rowid LIMIT ?').all(ctx.scopeRef,limit):ctx.db.prepare('SELECT * FROM ledger.jobs WHERE scope_ref=? AND state=? ORDER BY created_at,rowid LIMIT ?').all(ctx.scopeRef,state,limit);
   return rows.map(view);
  },
  recoverInterrupted(){return write(ctx,()=>{const rows=ctx.db.prepare("SELECT * FROM ledger.jobs WHERE scope_ref=? AND state='running'").all(ctx.scopeRef);for(const row of rows)finish(row,'outcome_unknown',{reason:'worker_interrupted',quarantine:true});return rows.length;});},
  confirmRemoteQuiescence(args){
   shape(args,['jobId','status','confirmationRef'],'quiescence confirmation');
   if(!['remote_finished','remote_cancel_confirmed'].includes(args.status))throw new Error('Remote completion evidence required');
   const row=raw(args.jobId);if(!row)throw new Error('Unknown scoped job');
   const confirmationRef=checkedText(args.confirmationRef,'Host confirmation reference',512);
   if(authorizeRecovery(Object.freeze({action:'confirmRemoteQuiescence',scopeRef:ctx.scopeRef,jobId:row.id,status:args.status,confirmationRef}))!==true)throw new Error('Trusted Host authorization required');
   return write(ctx,()=>{const current=raw(row.id);if(current.state!=='outcome_unknown')throw new Error('Only unknown dispatch can be acknowledged');const lock=ctx.db.prepare('SELECT * FROM ledger.dispatch_lock WHERE job_id=?').get(row.id);if(!lock)return {released:false};ctx.db.prepare('DELETE FROM ledger.dispatch_lock WHERE job_id=? AND run_token=?').run(row.id,lock.run_token);return {released:true,originalJobRetried:false};});
  },
  async runJob(id,{timeoutMs=10000,signal}={}){
   integer(timeoutMs,1,30000,'model timeout');
   const claim=write(ctx,()=>{
    const row=raw(id);if(!row)throw new Error('Unknown scoped job');if(terminal(row.state)||row.state==='running')return {status:view(row)};
    if(ctx.db.prepare('SELECT 1 FROM ledger.dispatch_lock LIMIT 1').get())return {status:{...view(row),reason:'dispatch_gate_held'}};
    if(signal?.aborted)return {status:finish(row,'failed',{reason:'cancelled_before_dispatch',cost:'not_dispatched'})};
    if(row.day!==dayOf(now())||row.policy_hash!==policyHash)return {status:finish(row,'failed',{reason:'budget_day_or_policy_changed',cost:'not_dispatched'})};
    if(row.epoch!==store.generation())return {status:finish(row,'stale',{reason:'generation_changed',cost:'not_dispatched'})};
    const inputRow=ctx.db.prepare('SELECT payload FROM job_inputs WHERE id=?').get(id);if(!inputRow)return {status:finish(row,'failed',{reason:'input_unavailable',cost:'not_dispatched'})};
    const payload=JSON.parse(inputRow.payload);
    if(fingerprint(payload)!==row.fingerprint)throw new Error('Queue input integrity unavailable');
    try{integer(payload.inputChars,payload.input.length,8000,'reserved input length');if(inputSize(payload.input,row.purpose)!==payload.inputChars)throw new Error('Changed input measurement');}catch{return {status:finish(row,'failed',{reason:'input_accounting_changed_or_unavailable',cost:'not_dispatched'})};}
    try{assertSources(ctx,[payload]);}catch{return {status:finish(row,'stale',{reason:'source_invalidated',cost:'not_dispatched'})};}
    const route=JSON.parse(row.route_json);if(!provider.approved(route,row.purpose))return {status:finish(row,'failed',{reason:'route_unavailable',cost:'not_dispatched'})};
    let lease;try{lease=executionLease(executionMetadata(row,payload,route));}catch{return {status:finish(row,'failed',{reason:'execution_authorization_unavailable',cost:'not_dispatched'})};}
    const token=randomUUID();ctx.db.prepare("UPDATE ledger.jobs SET state='running',run_token=?,cost_status='unknown' WHERE id=?").run(token,id);ctx.db.prepare("INSERT INTO ledger.dispatch_lock VALUES(1,?,?,'in_flight')").run(id,token);return {row,payload,route,token,lease};
   });
   if(claim.status)return claim.status;
   try{claim.lease.check('dispatch');}catch{return write(ctx,()=>finish(raw(id),'failed',{reason:'execution_authorization_unavailable',cost:'not_dispatched'}));}
   const controller=new AbortController();let timer,onAbort;
   function checkRunning(phase,expectedEpoch=claim.row.epoch){
    claim.lease.check(phase);
    if(!provider.approved(claim.route,claim.row.purpose))throw new Error('Stale route');
    // Recheck internal invariants after all external authority/route callbacks.
    const row=raw(id);if(row.state!=='running'||row.run_token!==claim.token)throw new Error('Inactive worker');
    checkEpoch(ctx,expectedEpoch);assertSources(ctx,[claim.payload]);claim.lease.assertActive();
    if(controller.signal.aborted||signal?.aborted)throw new Error('Cancelled');
   }
   const ended=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Model timeout'));},timeoutMs);onAbort=()=>{controller.abort();reject(new Error('Model cancelled'));};signal?.addEventListener('abort',onAbort,{once:true});claim.lease.signal.addEventListener('abort',onAbort,{once:true});if(signal?.aborted||claim.lease.signal.aborted)onAbort();});
   let response;
   const assertExecution=()=>{try{
    write(ctx,()=>checkRunning('dispatch'));
   }catch{controller.abort();throw new RouteUnavailable();}};
   const invocation=Promise.resolve().then(()=>{assertExecution();return provider.execute(claim.route,{purpose:claim.row.purpose,input:claim.payload.input,requestId:id,maxTokens:claim.payload.maxTokens,signal:controller.signal,assertExecution});});
   try{response=await Promise.race([invocation,ended]);}
   catch(error){return write(ctx,()=>{const current=raw(id);if(current.state!=='running'||current.run_token!==claim.token)return view(current);const pre=error instanceof RouteUnavailable,complete=error instanceof ProviderResponseError;return finish(current,pre||complete?'failed':'outcome_unknown',{reason:pre?'route_unavailable':complete?'invalid_provider_response':'provider_outcome_unknown',cost:pre?'not_dispatched':'unknown',quarantine:!(pre||complete)});});}
   finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);claim.lease.signal.removeEventListener('abort',onAbort);}
   const cost=response.usage?'reported':'unknown';
   let parsed;
   try{
    parsed=JSON.parse(response.text);clean(parsed);
    if(claim.row.purpose==='memory_extract'){
     shape(parsed,['schema_version','memories'],'model extraction');if(parsed.schema_version!==1||!Array.isArray(parsed.memories)||parsed.memories.length>5)throw new Error('Invalid extraction schema');
     parsed.memories=parsed.memories.map((v,index)=>{shape(v,['text','kind'],'memory candidate');return store.validate({id:`model-${id}-${index}`,sourceRef:claim.payload.sourceRef,sourceVersion:claim.payload.sourceVersion,text:v.text,kind:v.kind??'lesson',origin:'model'});});
    }else{shape(parsed,['schema_version','summary'],'work extraction');if(parsed.schema_version!==1)throw new Error('Invalid extraction schema');parsed.summary=validateWorkDraft(parsed.summary);}
   }catch{return write(ctx,()=>{const row=raw(id);if(row.state!=='running'||row.run_token!==claim.token)return view(row);return finish(row,'failed',{reason:'invalid_model_result',cost});});}
   try{return write(ctx,()=>{
    const row=raw(id);if(row.state!=='running'||row.run_token!==claim.token)return view(row);
    checkRunning('commit');
    let ids;
    if(row.purpose==='memory_extract'){
     const saved=parsed.memories.map(v=>store.put(v,{expectedGeneration:claim.row.epoch}));ids=saved.map(v=>v.id);
     if(typeof onMemoryExtracted==='function')try{onMemoryExtracted(Object.freeze({jobId:id,scopeRef:ctx.scopeRef,purpose:row.purpose,input:claim.payload.input,sourceRef:claim.payload.sourceRef,sourceVersion:claim.payload.sourceVersion,fragmentRef:claim.payload.fragmentRef,generation:claim.row.epoch,records:Object.freeze(saved)}));}catch{/* Evidence capture is best effort; the memory write remains committed. */}
    }
    else{
     const work=createWorkSummaryManager(store),source={sourceRef:claim.payload.sourceRef,sourceVersion:claim.payload.sourceVersion,fragmentRef:claim.payload.fragmentRef};
     const saved=row.purpose==='work_summary_merge'?work.merge({id:claim.payload.itemRef,draft:parsed.summary,sources:[source],origin:'model',expectedGeneration:claim.row.epoch}):work.save({requestId:`job-${id}`,itemRef:claim.payload.itemRef??undefined,draft:parsed.summary,sources:[source],origin:'model',expectedGeneration:claim.row.epoch});ids=[saved.id];
    }
    // Work merges legitimately advance the epoch. Capture our completed local write before Host callbacks.
    const writtenEpoch=scopeState(ctx).epoch;checkRunning('commit-complete',writtenEpoch);return finish(row,'completed',{cost,result:{ids}});
   });}catch{return write(ctx,()=>{const row=raw(id);if(row.state!=='running'||row.run_token!==claim.token)return view(row);return finish(row,'stale',{reason:'commit_generation_source_route_or_authorization_changed',cost});});}
  }
 };
 const result=Object.freeze(api);queueOwners.set(result,{store,provider});return result;
}
