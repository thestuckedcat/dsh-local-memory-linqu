import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { task2,fixture,memory,draft,routeA,job,latch,extraction ,authorizeTestExecution} from './helpers.mjs';

test('persistent queue binds original route and request identity despite active model switching',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),calls=[];
 let active='registered-A';const provider=createControlledProvider({resolveRoute:ref=>ref==='registered-A'?routeA:undefined,invoke:async request=>{calls.push(request.route);return extraction();}});
 let s=f.track(openStore(f.root,{scopeRef:'A'})),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider}),input=job(s);
 const saved=q.enqueue(input);s.close();active='registered-B';
 s=f.track(openStore(f.root,{scopeRef:'A'}));q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});assert.equal(active,'registered-B');
 assert.equal((await q.runJob(saved.jobId)).state,'completed');assert.equal(calls[0].provider,'provider-A');
 assert.equal(q.enqueue(input).jobId,saved.jobId);await q.runJob(saved.jobId);assert.equal(calls.length,1);
 assert.throws(()=>q.enqueue({...input,input:'changed input'}),/identity/i);
 assert.equal(s.list()[0].sourceRef,'session-A/turn-1');
});
test('revoked or changed route fails before dispatch with no fallback',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));let approved=routeA,calls=0;
 const provider=createControlledProvider({resolveRoute:()=>approved,invoke:async()=>{calls++;return extraction();}}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});
 const saved=q.enqueue(job(s));approved={...routeA,routeVersion:'2',provider:'other'};
 assert.equal((await q.runJob(saved.jobId)).state,'failed');assert.equal(calls,0);assert.deepEqual(s.list(),[]);
});
test('timeout becomes outcome_unknown and ignored late result never writes back',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),pending=latch();let calls=0;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;return pending.promise;}}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});
 const saved=q.enqueue(job(s));assert.equal((await q.runJob(saved.jobId,{timeoutMs:20})).state,'outcome_unknown');
 pending.resolve(extraction());await new Promise(r=>setTimeout(r,5));await q.runJob(saved.jobId);
 assert.equal(calls,1);assert.deepEqual(s.list(),[]);assert.equal(q.get(saved.jobId).costStatus,'unknown');
});
test('an unknown timed-out dispatch keeps the root gate after settling until trusted confirmation',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),pending=latch();let calls=0;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;return calls===1?pending.promise:extraction();}}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});
 const first=q.enqueue(job(s)),second=q.enqueue(job(s,{requestId:'second',sourceRef:'different-source'}));
 assert.equal((await q.runJob(first.jobId,{timeoutMs:10})).state,'outcome_unknown');assert.equal((await q.runJob(second.jobId)).state,'queued');assert.equal(calls,1);
 pending.resolve(extraction());await new Promise(r=>setTimeout(r,5));assert.equal((await q.runJob(second.jobId)).reason,'dispatch_gate_held');
 assert.throws(()=>q.confirmRemoteQuiescence({jobId:first.jobId,status:'remote_finished',confirmationRef:'not-approved'}),/authoriz/i);
 const trusted=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider,authorizeRecovery:()=>true});trusted.confirmRemoteQuiescence({jobId:first.jobId,status:'remote_finished',confirmationRef:'synthetic-finished-receipt'});
 assert.equal((await trusted.runJob(second.jobId)).state,'completed');assert.equal(calls,2);assert.equal(s.list().length,1);
});
test('foreign scopes cannot clear quarantine and a late old callback cannot clear the new owner lock',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),a=f.track(openStore(f.root,{scopeRef:'A'})),b=f.track(openStore(f.root,{scopeRef:'B'})),old=latch(),next=latch(),started=latch();let calls=0;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;if(calls===1)return old.promise;if(calls===2){started.resolve();return next.promise;}return extraction();}}),qa=createJobQueue(a,{authorizeExecution:authorizeTestExecution,provider,authorizeRecovery:()=>true}),qb=createJobQueue(b,{authorizeExecution:authorizeTestExecution,provider,authorizeRecovery:()=>true});
 const first=qa.enqueue(job(a)),second=qb.enqueue(job(b,{requestId:'B'})),third=qa.enqueue(job(a,{requestId:'A-next',sourceRef:'another-source'}));
 await qa.runJob(first.jobId,{timeoutMs:10});assert.equal(qb.get(first.jobId),undefined);assert.throws(()=>qb.confirmRemoteQuiescence({jobId:first.jobId,status:'remote_finished',confirmationRef:'foreign'}),/scoped/i);
 qa.confirmRemoteQuiescence({jobId:first.jobId,status:'remote_finished',confirmationRef:'trusted-host/receipt'});
 const running=qb.runJob(second.jobId);await started.promise;old.resolve(extraction());await new Promise(r=>setTimeout(r,5));
 assert.equal((await qa.runJob(third.jobId)).state,'queued');assert.equal(calls,2);next.resolve(extraction());await running;assert.equal((await qa.runJob(third.jobId)).state,'completed');
});
test('forget during a model request rejects its late result under the old epoch',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),pending=latch(),started=latch();
 s.put(memory());const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{started.resolve();return pending.promise;}}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});
 const saved=q.enqueue(job(s)),running=q.runJob(saved.jobId);await started.promise;
 s.forget({id:'one',expectedGeneration:s.generation()});pending.resolve(extraction());
 assert.equal((await running).state,'stale');assert.deepEqual(s.list(),[]);
});
test('ordinary and annual jobs share durable daily and session budgets',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>extraction()}),limits={dailyRequests:1,sessionRequests:1,dailyInputChars:8000,dailyOutputTokens:2048};
 let q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider,limits});q.enqueue(job(s));q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider,limits});
 assert.throws(()=>q.enqueue(job(s,{requestId:'annual',sourceRef:'other',purpose:'work_summary_extract'})),/budget/i);
 assert.throws(()=>q.enqueue(job(s,{requestId:'secret',inputClass:'credentials'})),/source|credential/i);
 assert.throws(()=>q.enqueue(job(s,{requestId:'secret-text',input:'OPENAI_API_KEY=CANARY_PRIVATE_987654321'})),/secret/i);
});
test('global concurrency one leaves a second request queued instead of dispatching twice',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),a=f.track(openStore(f.root,{scopeRef:'A'})),b=f.track(openStore(f.root,{scopeRef:'B'})),pending=latch(),started=latch();let calls=0;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;if(calls===1){started.resolve();return pending.promise;}return extraction();}}),qa=createJobQueue(a,{authorizeExecution:authorizeTestExecution,provider}),qb=createJobQueue(b,{authorizeExecution:authorizeTestExecution,provider});
 const first=qa.enqueue(job(a)),second=qb.enqueue(job(b,{requestId:'second'}));const running=qa.runJob(first.jobId);await started.promise;
 assert.equal((await qb.runJob(second.jobId)).state,'queued');assert.equal(calls,1);
 pending.resolve(extraction());await running;assert.equal((await qb.runJob(second.jobId)).state,'completed');assert.equal(calls,2);
});
test('model scope/path overrides and secret output are rejected atomically',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));let output;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>({text:JSON.stringify(output),finishReason:'stop'})}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});
 for(const [i,value] of [{schema_version:1,scopeRef:'B',memories:[{text:'Safe fact',kind:'fact'}]},{schema_version:1,memories:[{text:'Safe fact',kind:'fact'},{text:'password=CANARY_PRIVATE_987654321',kind:'fact'}]}].entries()){
  output=value;const saved=q.enqueue(job(s,{requestId:`bad-${i}`,sourceRef:`source-${i}`}));assert.equal((await q.runJob(saved.jobId)).state,'failed');assert.deepEqual(s.list(),[]);
 }
});
test('worker death is recovered as unknown without replay',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t);let s=f.track(openStore(f.root,{scopeRef:'A'}));
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>extraction()});let q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});const saved=q.enqueue(job(s));s.close();
 const base=pathToFileURL(resolve('src/backend.mjs')).href,jobs=pathToFileURL(resolve('src/jobs.mjs')).href,providers=pathToFileURL(resolve('src/provider.mjs')).href;
 const code=`import {openStore} from ${JSON.stringify(base)};import {createJobQueue} from ${JSON.stringify(jobs)};import {createControlledProvider} from ${JSON.stringify(providers)};const s=openStore(${JSON.stringify(f.root)},{scopeRef:'A'});const childSignal=new AbortController().signal;const p=createControlledProvider({resolveRoute:()=>(${JSON.stringify(routeA)}),invoke:()=>process.exit(17)});await createJobQueue(s,{authorizeExecution:()=>({authorizationVersion:"child-test",signal:childSignal}),provider:p}).runJob(${JSON.stringify(saved.jobId)});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{windowsHide:true,encoding:'utf8',timeout:10000});assert.equal(child.status,17,child.stderr);
 s=f.track(openStore(f.root,{scopeRef:'A'}));q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});assert.equal(q.recoverInterrupted(),1);assert.equal((await q.runJob(saved.jobId)).state,'outcome_unknown');assert.deepEqual(s.list(),[]);
 const second=q.enqueue(job(s,{requestId:'after-crash',sourceRef:'other'}));assert.equal((await q.runJob(second.jobId)).state,'queued');
 assert.throws(()=>q.confirmRemoteQuiescence({jobId:saved.jobId,status:'remote_cancel_confirmed',confirmationRef:'trusted-host/receipt-1'}),/authoriz/i);
 const trusted=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider,authorizeRecovery:()=>true});trusted.confirmRemoteQuiescence({jobId:saved.jobId,status:'remote_cancel_confirmed',confirmationRef:'trusted-host/receipt-1'});
 assert.equal((await trusted.runJob(second.jobId)).state,'completed');assert.equal(trusted.get(saved.jobId).state,'outcome_unknown');
});
test('restoring a pre-completion body database never dispatches the completed request again',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t);let calls=0,s=f.track(openStore(f.root,{scopeRef:'A'}));
 const p=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;return extraction();}});let q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider:p});const saved=q.enqueue(job(s)),file=s.databasePath,backup=join(f.root,'queue-body-backup.sqlite');s.close();copyFileSync(file,backup);
 s=f.track(openStore(f.root,{scopeRef:'A'}));q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider:p});assert.equal((await q.runJob(saved.jobId)).state,'completed');s.close();copyFileSync(backup,file);
 s=f.track(openStore(f.root,{scopeRef:'A'}));q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider:p});assert.equal((await q.runJob(saved.jobId)).state,'completed');assert.equal(calls,1);
});
test('queued requests expire at the next Shanghai budget day instead of spending yesterday reservation',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));let calls=0,date=new Date('2026-11-03T15:59:00Z');
 const p=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;return extraction();}}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider:p,now:()=>date});const saved=q.enqueue(job(s));date=new Date('2026-11-03T16:01:00Z');
 assert.equal((await q.runJob(saved.jobId)).state,'failed');assert.equal(calls,0);
});
test('cancellation of a dispatched request is unknown and provider errors cannot expose raw secrets',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),started=latch(),pending=latch(),controller=new AbortController();
 const p=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{started.resolve();return pending.promise;}}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider:p});const saved=q.enqueue(job(s));const running=q.runJob(saved.jobId,{signal:controller.signal});await started.promise;controller.abort();assert.equal((await running).state,'outcome_unknown');
 pending.reject(new Error('password=CANARY_PRIVATE_987654321'));await new Promise(r=>setTimeout(r,5));assert.doesNotMatch(JSON.stringify(q.get(saved.jobId)),/CANARY|password/);assert.deepEqual(s.list(),[]);
});
test('work model output is an unverified draft in its own collection',async t=>{
 const {openStore,createJobQueue,createControlledProvider,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>({text:JSON.stringify({schema_version:1,summary:draft()}),finishReason:'stop'})}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider});
 const saved=q.enqueue(job(s,{purpose:'work_summary_extract'}));assert.equal((await q.runJob(saved.jobId)).state,'completed');
 assert.deepEqual(s.list(),[]);const work=createWorkSummaryManager(s).list().items[0];assert.equal(work.myContribution.basis,'inferred');assert.equal(work.result.support,'missing');assert.equal(work.dimensionMapping.status,'pending_reference');
});
