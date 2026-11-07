import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,job,routeA,extraction,latch,draft} from './helpers.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {openStore} from '../src/backend.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {createControlledProvider} from '../src/provider.mjs';

function setup(t){
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'authorization-A'}));
 const h={store,root:f.root,calls:0,allowed:true,version:'approval-1',controller:new AbortController(),checks:[],invoke:async()=>extraction()};
 h.provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async request=>{h.calls++;return h.invoke(request);}});
 h.authorize=request=>{h.checks.push(request);return h.allowed?{authorizationVersion:h.version,signal:h.controller.signal}:undefined;};
 h.queue=options=>createJobQueue(store,{provider:h.provider,authorizeExecution:h.authorize,...options});
 h.inputs=()=>{const db=new DatabaseSync(store.databasePath,{readOnly:true});try{return db.prepare('SELECT count(*) AS n FROM job_inputs').get().n;}finally{db.close();}};
 return h;
}

test('execution is denied by default even for an intact queued job and approved model route',async t=>{
 const h=setup(t),q=createJobQueue(h.store,{provider:h.provider}),saved=q.enqueue(job(h.store));
 const result=await q.runJob(saved.jobId);assert.equal(h.calls,0);assert.equal(result.state,'failed');assert.equal(result.costStatus,'not_dispatched');assert.equal(result.reason,'execution_authorization_unavailable');assert.equal(h.inputs(),0);
});

test('revoking a queued admission prevents dispatch and discards the durable input',async t=>{
 const h=setup(t),q=h.queue(),saved=q.enqueue(job(h.store));h.allowed=false;
 const result=await q.runJob(saved.jobId);assert.equal(h.calls,0);assert.equal(result.state,'failed');assert.equal(h.inputs(),0);
});

test('permission revoked in flight returns unknown, retains quarantine, and ignores late output',async t=>{
 const h=setup(t),started=latch(),pending=latch();let modelSignal;
 h.invoke=async request=>{modelSignal=request.signal;started.resolve();return pending.promise;};
 const q=h.queue(),saved=q.enqueue(job(h.store));const running=q.runJob(saved.jobId,{timeoutMs:1000});await started.promise;h.controller.abort();
 let timer,result;try{result=await Promise.race([running,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Revocation did not stop local waiting')),200);})]);}catch(error){pending.resolve(extraction());await running;throw error;}finally{clearTimeout(timer);}
 assert.equal(result.state,'outcome_unknown');assert.equal(modelSignal.aborted,true);assert.equal(h.inputs(),0);assert.deepEqual(h.store.list(),[]);
 const second=q.enqueue(job(h.store,{requestId:'second',sourceRef:'different'}));assert.equal((await q.runJob(second.jobId)).reason,'dispatch_gate_held');
 pending.resolve(extraction());await new Promise(resolve=>setTimeout(resolve,5));assert.deepEqual(h.store.list(),[]);assert.equal(q.get(saved.jobId).state,'outcome_unknown');assert.equal((await q.runJob(second.jobId)).reason,'dispatch_gate_held');
});

test('a claim-to-dispatch denial is not dispatched and a replaced signal cannot reuse a lease',async t=>{
 const h=setup(t),q=h.queue({authorizeExecution:request=>request.phase==='claim'?h.authorize(request):undefined}),saved=q.enqueue(job(h.store));
 assert.equal((await q.runJob(saved.jobId)).costStatus,'not_dispatched');assert.equal(h.calls,0);
 const h2=setup(t),q2=h2.queue();h2.invoke=async()=>{h2.controller=new AbortController();return extraction();};
 const second=q2.enqueue(job(h2.store));assert.equal((await q2.runJob(second.jobId)).state,'stale');assert.deepEqual(h2.store.list(),[]);
});

test('post-write authorization failure rolls back ordinary and annual records atomically',async t=>{
 for(const purpose of ['memory_extract','work_summary_extract']){
  const h=setup(t),q=h.queue({authorizeExecution:request=>request.phase==='commit-complete'?undefined:h.authorize(request)});
  h.invoke=async()=>purpose==='memory_extract'?extraction():{text:JSON.stringify({schema_version:1,summary:draft()}),finishReason:'stop'};
  const saved=q.enqueue(job(h.store,{purpose}));assert.equal((await q.runJob(saved.jobId)).state,'stale');assert.deepEqual(h.store.list(),[]);assert.equal(createWorkSummaryManager(h.store).list().items.length,0);assert.equal(h.inputs(),0);
 }
});

test('annual merge may advance its own epoch but post-merge revocation rolls the whole change back',async t=>{
 for(const allowCommit of [true,false]){
  const h=setup(t),work=createWorkSummaryManager(h.store),savedWork=work.save({requestId:'manual',itemRef:'work-item',draft:draft(),sources:[{sourceRef:'initial-source',sourceVersion:'initial-v',fragmentRef:'whole'}],expectedGeneration:h.store.generation()});
  const before=work.get(savedWork.id),epoch=h.store.generation();h.invoke=async()=>({text:JSON.stringify({schema_version:1,summary:draft({myContribution:'I added another verified boundary check.'})}),finishReason:'stop'});
  const q=h.queue({authorizeExecution:request=>request.phase==='commit-complete'&&!allowCommit?undefined:h.authorize(request)}),saved=q.enqueue(job(h.store,{purpose:'work_summary_merge',itemRef:savedWork.id}));
  const result=await q.runJob(saved.jobId);assert.equal(result.state,allowCommit?'completed':'stale');
  const current=work.get(savedWork.id);if(allowCommit){assert.equal(h.store.generation(),epoch+1);assert.equal(current.sources.length,2);assert.equal(current.myContribution.text,before.myContribution.text);assert.equal(current.conflicts.length,1);}else{assert.equal(h.store.generation(),epoch);assert.deepEqual(current,before);}
  assert.equal(h.inputs(),0);
 }
});

test('a synchronous Provider throw becomes a contained unknown outcome',async t=>{
 const h=setup(t),provider={...h.provider,execute(){throw new Error('CANARY_SYNC_PROVIDER');}},q=h.queue({provider}),saved=q.enqueue(job(h.store));
 const result=await q.runJob(saved.jobId);assert.equal(result.state,'outcome_unknown');assert.ok(!JSON.stringify(result).includes('CANARY'));assert.equal(h.inputs(),0);
});

test('revocation winning the completion race keeps quarantine even if the Provider fulfills immediately',async t=>{
 const h=setup(t),provider={...h.provider,execute(){h.controller.abort();return Promise.resolve(extraction());}},q=h.queue({provider}),saved=q.enqueue(job(h.store));
 assert.equal((await q.runJob(saved.jobId)).state,'outcome_unknown');h.controller=new AbortController();
 const second=q.enqueue(job(h.store,{requestId:'after-race',sourceRef:'after-race'}));assert.equal((await q.runJob(second.jobId)).reason,'dispatch_gate_held');assert.deepEqual(h.store.list(),[]);
});

test('caller cancellation between fulfilled response and queue commit never saves results',async t=>{
 for(const depth of [3,4]){
  const h=setup(t),caller=new AbortController(),later=(n,fn)=>n?queueMicrotask(()=>later(n-1,fn)):fn();
  const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{later(depth,()=>caller.abort());return extraction();}});
  const q=h.queue({provider}),saved=q.enqueue(job(h.store));const result=await q.runJob(saved.jobId,{signal:caller.signal});
  assert.equal(caller.signal.aborted,true);assert.notEqual(result.state,'completed');assert.deepEqual(h.store.list(),[]);assert.equal(h.inputs(),0);
 }
 for(const phase of ['commit','commit-complete']){
  const h=setup(t),caller=new AbortController(),q=h.queue({authorizeExecution:request=>{if(request.phase===phase)caller.abort();return h.authorize(request);}}),saved=q.enqueue(job(h.store));
  assert.equal((await q.runJob(saved.jobId,{signal:caller.signal})).state,'stale');assert.deepEqual(h.store.list(),[]);
 }
});

test('lifecycle or route changes inside final approval cannot overwrite current worker state',async t=>{
 for(const kind of ['worker','route']){
  const h=setup(t);let q,route=routeA;
  const provider=createControlledProvider({resolveRoute:()=>route,invoke:async()=>extraction()});
  q=h.queue({provider,authorizeExecution:request=>{if(request.phase==='commit-complete'){if(kind==='worker')q.recoverInterrupted();else route={...routeA,routeVersion:'new-version'};}return h.authorize(request);}});
  const saved=q.enqueue(job(h.store));assert.notEqual((await q.runJob(saved.jobId)).state,'completed');assert.deepEqual(h.store.list(),[]);
 }
});

test('a changed approval after model completion cannot commit ordinary or annual output',async t=>{
 for(const purpose of ['memory_extract','work_summary_extract']){
  const h=setup(t),q=h.queue();h.invoke=async()=>{h.version='approval-2';return purpose==='memory_extract'?extraction():{text:JSON.stringify({schema_version:1,summary:draft()}),finishReason:'stop'};};
  const saved=q.enqueue(job(h.store,{purpose}));assert.notEqual((await q.runJob(saved.jobId)).state,'completed');assert.deepEqual(h.store.list(),[]);assert.equal(createWorkSummaryManager(h.store).list().items.length,0);
 }
});

test('authorization callbacks receive immutable task identity without plaintext',async t=>{
 const h=setup(t),q=h.queue(),saved=q.enqueue(job(h.store));assert.equal((await q.runJob(saved.jobId)).state,'completed');
 assert.ok(h.checks.length>=3);for(const request of h.checks){assert.equal(request.scopeRef,h.store.scopeRef);assert.equal(request.jobId,saved.jobId);assert.equal(request.purpose,'memory_extract');assert.equal(request.sourceRef,'session-A/turn-1');assert.equal(request.input,undefined);assert.equal(request.inputDigest.length,64);assert.equal(Object.isFrozen(request),true);assert.equal(Object.isFrozen(request.route),true);}
});

test('invalid, throwing or asynchronous execution authority is observed and fails closed',async t=>{
 const fakeSignal=Object.create(AbortSignal.prototype);Object.defineProperty(fakeSignal,'aborted',{value:false});
 const h=setup(t);for(const [i,authorizeExecution] of [()=>true,()=>({authorizationVersion:'v'}),()=>{throw new Error('CANARY_AUTH_DETAIL');},()=>Promise.reject(new Error('CANARY_AUTH_ASYNC')),()=>({authorizationVersion:'v',signal:fakeSignal})].entries()){
  const q=h.queue({authorizeExecution}),saved=q.enqueue(job(h.store,{requestId:'invalid-'+i,sourceRef:'invalid-source-'+i}));
  const result=await q.runJob(saved.jobId);assert.equal(result.state,'failed');assert.equal(h.calls,0);assert.ok(!JSON.stringify(result).includes('CANARY'));
 }
 await new Promise(resolve=>setTimeout(resolve,5));
});
