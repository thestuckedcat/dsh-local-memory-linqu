import {integer} from '../src/validation.mjs';

const DEFAULT_SCHEDULER=Object.freeze({pollMs:1000,concurrency:1,jobTimeoutMs:10000,recoverOnStart:true});
const POLL_RANGE=Object.freeze([100,60000]),JOB_TIMEOUT_RANGE=Object.freeze([100,30000]);
const STOP_WAIT_MS=1000,SCOPE_LIMIT=256;
const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const errorCode=error=>error&&typeof error.code==='string'?error.code:'scheduler_error';

/**
 * Polling scheduler over the durable per-scope queues. It never creates a queue, never
 * re-selects a Provider route, never re-sends an unknown outcome and never retries a job
 * itself: the queue owns budgets, claims, authorization and terminal classification.
 */
export function createScheduler({config,registry,grants,provider,limits,queueFor,onDiagnostic=()=>{},now=()=>new Date()}={}){
 if(!isPlain(config))throw new Error('Normalized memory configuration required');
 if(!registry||['allScopes','activeScopes'].every(key=>typeof registry[key]!=='function'))throw new Error('Trusted project registry required');
 if(!grants||typeof grants.currentAuthorizationVersion!=='function')throw new Error('Trusted execution grants required');
 if(provider!==undefined&&(provider===null||typeof provider!=='object'))throw new Error('Controlled Provider required');
 if(limits!==undefined&&(limits===null||typeof limits!=='object'))throw new Error('Trusted budget limits required');
 if(typeof queueFor!=='function'||typeof onDiagnostic!=='function'||typeof now!=='function')throw new Error('Trusted scheduler services required');
 const raw=config.scheduler===undefined?{}:config.scheduler;
 if(!isPlain(raw))throw new Error('Invalid scheduler configuration');
 const policy=Object.freeze({
  pollMs:raw.pollMs===undefined?DEFAULT_SCHEDULER.pollMs:integer(raw.pollMs,POLL_RANGE[0],POLL_RANGE[1],'scheduler poll interval'),
  concurrency:raw.concurrency===undefined?DEFAULT_SCHEDULER.concurrency:integer(raw.concurrency,1,4,'scheduler concurrency'),
  jobTimeoutMs:raw.jobTimeoutMs===undefined?DEFAULT_SCHEDULER.jobTimeoutMs:integer(raw.jobTimeoutMs,JOB_TIMEOUT_RANGE[0],JOB_TIMEOUT_RANGE[1],'job timeout'),
  recoverOnStart:raw.recoverOnStart===undefined?DEFAULT_SCHEDULER.recoverOnStart:raw.recoverOnStart,
 });
 if(typeof policy.recoverOnStart!=='boolean')throw new Error('Invalid scheduler recovery setting');
 const inflight=new Set(),runs=new Set(),busyScopes=new Set();
 let state='new',timer=null,lastTickAt=null,lastError=null,stopPromise=null;
 function diagnostic(code){try{const value=onDiagnostic(Object.freeze({code}));if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});}catch{/* diagnostics never affect scheduling */}}
 function stamp(){const instant=now();if(!(instant instanceof Date)||Number.isNaN(+instant))throw new Error('Invalid scheduler clock');return instant.toISOString();}
 function enumerateScopes(){
  const scopes=registry.allScopes();
  if(!Array.isArray(scopes))throw new Error('Scope enumeration unavailable');
  const unique=[];
  for(const scopeRef of scopes)if(typeof scopeRef==='string'&&scopeRef.length>0&&!unique.includes(scopeRef)){unique.push(scopeRef);if(unique.length>=SCOPE_LIMIT)break;}
  return unique;
 }
 function queueOf(scopeRef){const queue=queueFor(scopeRef);return queue&&typeof queue.pending==='function'&&typeof queue.runJob==='function'?queue:undefined;}
 function currentVersion(){try{const value=grants.currentAuthorizationVersion();return typeof value==='string'?value:undefined;}catch{return undefined;}}
 function reconcileRevocations(){
  const version=currentVersion();
  if(version===undefined)return;
  for(const entry of [...runs])if(entry.version!==version){try{entry.controller.abort();}catch{/* local cancellation only */}diagnostic('authorization_changed');}
 }
 async function execute(entry,queue){
  try{
   return await queue.runJob(entry.jobId,{timeoutMs:policy.jobTimeoutMs,signal:entry.controller.signal});
  }catch(error){
   lastError=errorCode(error);diagnostic('job_execution_failed');return undefined;
  }finally{
   inflight.delete(entry.promise);runs.delete(entry);busyScopes.delete(entry.scopeRef);
  }
 }
 function launch(scopeRef,queue,jobId){
  const entry={scopeRef,jobId,controller:new AbortController(),version:currentVersion(),promise:null};
  busyScopes.add(scopeRef);
  const promise=execute(entry,queue);
  entry.promise=promise;
  inflight.add(promise);runs.add(entry);
  return promise;
 }
 function recoverInterrupted(){
  const scopes=enumerateScopes(),runningScopes=[];
  let recovered=0;
  for(const scopeRef of scopes){
   const queue=queueOf(scopeRef);
   if(!queue||typeof queue.recoverInterrupted!=='function')continue;
   try{
    const value=queue.recoverInterrupted();
    if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});throw new Error('Synchronous recovery required');}
    if(Number.isSafeInteger(value)&&value>0)recovered+=value;
    runningScopes.push(scopeRef);
   }catch{lastError='recovery_failed';diagnostic('queue_recovery_failed');}
  }
  return Object.freeze({scopes:runningScopes.length,recovered});
 }
 async function tick(){
  if(state!=='running')return status();
  try{reconcileRevocations();}catch{lastError='authorization_unavailable';}
  if(inflight.size>=policy.concurrency)return status();
  try{lastTickAt=stamp();}catch{lastError='scheduler_clock_invalid';}
  const launched=[];
  let scopes;
  try{scopes=enumerateScopes();}
  catch{lastError='scope_enumeration_unavailable';diagnostic('scope_enumeration_failed');return status();}
  for(const scopeRef of scopes){
   if(inflight.size>=policy.concurrency)break;
   if(busyScopes.has(scopeRef))continue;
   let queue;
   try{queue=queueOf(scopeRef);}
   catch{lastError='queue_unavailable';diagnostic('queue_unavailable');continue;}
   if(!queue)continue;
   let pending;
   try{pending=queue.pending({limit:1});}
   catch{lastError='queue_pending_failed';diagnostic('queue_pending_failed');continue;}
   if(!Array.isArray(pending)||pending.length<1)continue;
   const job=pending[0];
   if(!job||typeof job.jobId!=='string'||job.state!=='queued')continue;
   launched.push(launch(scopeRef,queue,job.jobId));
  }
  if(launched.length)await Promise.allSettled(launched);
  return status();
 }
 function runTick(){if(state!=='running')return;tick().catch(error=>{lastError=errorCode(error);diagnostic('tick_failed');});}
 function start(){
  if(state!=='new')return stop;
  state='running';
  try{if(policy.recoverOnStart)recoverInterrupted();}
  catch{lastError='recovery_unavailable';diagnostic('scheduler_recovery_failed');}
  try{
   timer=setInterval(runTick,policy.pollMs);
   if(timer&&typeof timer.unref==='function')timer.unref();
  }catch{state='stopped';lastError='timer_unavailable';diagnostic('scheduler_timer_failed');return stop;}
  Promise.resolve().then(()=>{if(state==='running')runTick();});
  return stop;
 }
 function receipt(){return Object.freeze({state,pendingJobs:inflight.size,remoteStopConfirmed:false});}
 function stop(){
  if(stopPromise)return stopPromise;
  if(state==='new'){state='stopped';stopPromise=Promise.resolve(receipt());return stopPromise;}
  if(state==='stopped'){stopPromise=Promise.resolve(receipt());return stopPromise;}
  state='stopping';
  if(timer){try{clearInterval(timer);}catch{/* local timer only */}timer=null;}
  for(const entry of [...runs]){try{entry.controller.abort();}catch{/* local cancellation only */}}
  const pending=[...inflight];
  stopPromise=(async()=>{
   let waitTimer;
   if(pending.length){
    try{await Promise.race([Promise.allSettled(pending),new Promise(resolve=>{waitTimer=setTimeout(resolve,STOP_WAIT_MS);})]);}
    finally{if(waitTimer)clearTimeout(waitTimer);}
   }
   state='stopped';
   return receipt();
  })();
  return stopPromise;
 }
 function status(){
  let pendingScopes=[];
  try{
   pendingScopes=enumerateScopes().filter(scopeRef=>{
    try{const queue=queueOf(scopeRef);const pending=queue?queue.pending({limit:1}):[];return Array.isArray(pending)&&pending.length>0;}catch{return false;}
   });
  }catch{pendingScopes=[];}
  return Object.freeze({state,running:inflight.size,pendingScopes:Object.freeze(pendingScopes),lastTickAt,lastError});
 }
 return Object.freeze({start,tick,status,stop,recoverInterrupted});
}
