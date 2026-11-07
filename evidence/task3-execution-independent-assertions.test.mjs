import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/backend.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {fixture,job,routeA,extraction,latch,draft,source,authorizeTestExecution} from '../tests/helpers.mjs';

test('independent: execution denial keeps the durable request reservation across reopen',async t=>{
 const f=fixture(t),provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>extraction()});
 let store=f.track(openStore(f.root,{scopeRef:'reservation'})),queue=createJobQueue(store,{provider,limits:{dailyRequests:1}});
 const saved=queue.enqueue(job(store));assert.equal((await queue.runJob(saved.jobId)).state,'failed');store.close();
 store=f.track(openStore(f.root,{scopeRef:'reservation'}));queue=createJobQueue(store,{provider,authorizeExecution:authorizeTestExecution,limits:{dailyRequests:1}});
 assert.throws(()=>queue.enqueue(job(store,{requestId:'next',sourceRef:'new-source'})),/budget exhausted/);
});

test('independent: revoked unknown stays quarantined across reopen and late settle',async t=>{
 const f=fixture(t),started=latch(),late=latch(),grant=new AbortController();let calls=0;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>{calls++;started.resolve();return calls===1?late.promise:extraction();}});
 let store=f.track(openStore(f.root,{scopeRef:'persistence'})),queue=createJobQueue(store,{provider,authorizeExecution:()=>({authorizationVersion:'v1',signal:grant.signal})});
 const saved=queue.enqueue(job(store)),running=queue.runJob(saved.jobId);await started.promise;grant.abort();assert.equal((await running).state,'outcome_unknown');store.close();late.resolve(extraction());await new Promise(resolve=>setImmediate(resolve));
 store=f.track(openStore(f.root,{scopeRef:'persistence'}));queue=createJobQueue(store,{provider,authorizeExecution:authorizeTestExecution,authorizeRecovery:()=>true});
 const next=queue.enqueue(job(store,{requestId:'next',sourceRef:'new-source'}));assert.equal((await queue.runJob(next.jobId)).reason,'dispatch_gate_held');assert.equal(calls,1);assert.deepEqual(store.list(),[]);
 assert.deepEqual(queue.confirmRemoteQuiescence({jobId:saved.jobId,status:'remote_finished',confirmationRef:'synthetic-end-receipt'}),{released:true,originalJobRetried:false});
 assert.equal((await queue.runJob(next.jobId)).state,'completed');assert.equal(queue.get(saved.jobId).state,'outcome_unknown');
});

test('independent: annual merge rolls back a final denial while an authorized merge completes',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'annual-merge'})),work=createWorkSummaryManager(store,{authorize:()=>true});
 const seeded=work.save({requestId:'seed',draft:draft(),sources:[source({sourceRef:'seed-source'})]});work.confirmClaim({id:seeded.id,claimRef:'myContribution',expectedGeneration:store.generation()});
 const before=work.get(seeded.id),epoch=store.generation(),revision=store.revision();let allowed=false;
 const provider=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>({text:JSON.stringify({schema_version:1,summary:draft({myContribution:'I inspected the live completion callback.'})}),finishReason:'stop'})});
 const queue=createJobQueue(store,{provider,authorizeExecution:request=>request.phase==='commit-complete'&&!allowed?undefined:authorizeTestExecution(request)});
 const denied=queue.enqueue(job(store,{purpose:'work_summary_merge',itemRef:seeded.id}));assert.equal((await queue.runJob(denied.jobId)).state,'stale');
 assert.deepEqual(work.get(seeded.id),before);assert.equal(store.generation(),epoch);assert.equal(store.revision(),revision);
 allowed=true;const saved=queue.enqueue(job(store,{requestId:'authorized-merge',sourceRef:'second-source',purpose:'work_summary_merge',itemRef:seeded.id}));
 assert.equal((await queue.runJob(saved.jobId)).state,'completed');assert.equal(work.get(seeded.id).myContribution.confirmation,'user_confirmed');assert.equal(work.get(seeded.id).conflicts.length,1);
});
