import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {fixture,job,latch,extraction} from '../../tests/helpers.mjs';
import {openStore} from '../../src/backend.mjs';
import {createJobQueue} from '../../src/jobs.mjs';
import {createHarnessProviderBridge} from '../../plugin/harness-provider.mjs';

const root=process.env.DSH_AUDIT_APP_ROOT;assert.equal(root,'E:/dsh/resources/app.asar/dsh');
const host=name=>import(pathToFileURL(root+'/node_modules/@deepseek-ai/'+name+'/lib/index.js').href);
const {Context}=await host('cordis'),sdk=await host('dsh-llm');
async function setup(t){
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'native-execution'})),ctx=new Context();await ctx.plugin(sdk.LlmRuntime);
 const h={store,allowed:true,controller:new AbortController(),prepares:0,streams:0,prepare:async()=>{},stream:async function*(){yield {type:'text-delta',index:0,text:extraction().text};yield {type:'finish',reason:{kind:'stop'}};}};
 class Adapter extends sdk.LlmAdapter{
  async prepareCall(...args){h.prepares++;await h.prepare();return super.prepareCall(...args);}
  stream(options){h.streams++;return h.stream(options);}
 }
 ctx.llm.registerAdapter(['provider-A'],new Adapter());let bridge;
 const fiber=ctx.plugin({inject:['llm'],apply(c){bridge=createHarnessProviderBridge({ctx:c,sdk,readApprovedRoute:()=>({routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'native-execution-1'}),cleanupBudgetMs:5});}});await fiber;
 h.authorize=()=>h.allowed?{authorizationVersion:'permission-1',signal:h.controller.signal}:undefined;
 h.queue=options=>createJobQueue(store,{provider:bridge.provider,authorizeExecution:h.authorize,...options});t.after(()=>ctx.fiber.dispose());return h;
}

test('native LLM services cannot prepare without an explicit execution authority',async t=>{
 const h=await setup(t),q=h.queue({authorizeExecution:undefined}),saved=q.enqueue(job(h.store));assert.equal((await q.runJob(saved.jobId)).costStatus,'not_dispatched');assert.equal(h.prepares,0);assert.equal(h.streams,0);
});

test('native preparation awaiting permission revocation never starts the adapter stream',async t=>{
 const h=await setup(t),started=latch(),resume=latch();h.prepare=async()=>{started.resolve();await resume.promise;};
 const q=h.queue(),saved=q.enqueue(job(h.store));const running=q.runJob(saved.jobId);await started.promise;h.allowed=false;resume.resolve();assert.equal((await running).state,'outcome_unknown');assert.equal(h.streams,0);assert.deepEqual(h.store.list(),[]);
});

test('native stream revocation stays unknown after late stop and leaves the next job gated',async t=>{
 const h=await setup(t),started=latch(),resume=latch();h.stream=async function*(){started.resolve();await resume.promise;yield {type:'text-delta',index:0,text:extraction().text};yield {type:'finish',reason:{kind:'stop'}};};
 const q=h.queue(),saved=q.enqueue(job(h.store));const running=q.runJob(saved.jobId);await started.promise;h.controller.abort();assert.equal((await running).state,'outcome_unknown');resume.resolve();await new Promise(resolve=>setTimeout(resolve,5));
 h.controller=new AbortController();const next=q.enqueue(job(h.store,{requestId:'next',sourceRef:'next-source'}));assert.equal((await q.runJob(next.jobId)).reason,'dispatch_gate_held');assert.deepEqual(h.store.list(),[]);assert.equal(h.streams,1);
});

test('native successful execution commits only with the same live authority',async t=>{
 const h=await setup(t),q=h.queue(),saved=q.enqueue(job(h.store));assert.equal((await q.runJob(saved.jobId)).state,'completed');assert.equal(h.store.list().length,1);assert.equal(h.prepares,1);assert.equal(h.streams,1);
});

test('native execution cases do not invoke covered network sinks',()=>{
 assert.deepEqual(globalThis[Symbol.for('local-memory.host-audit.network-attempts')],[]);
});
