import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {setImmediate as turn} from 'node:timers/promises';
import {createHarnessProviderBridge} from '../../plugin/harness-provider.mjs';
import {fixture,job,latch,authorizeTestExecution} from '../../tests/helpers.mjs';
import {openStore} from '../../src/backend.mjs';
import {createJobQueue} from '../../src/jobs.mjs';
import {RouteUnavailable,ProviderResponseError} from '../../src/provider.mjs';

const root=process.env.DSH_AUDIT_APP_ROOT;assert.equal(root,'E:/dsh/resources/app.asar/dsh');
const host=name=>import(pathToFileURL(`${root}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const {Context}=await host('cordis');
const sdk=await host('dsh-llm');
const rawRoute={routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'approval-1'};
const text=JSON.stringify({schema_version:1,memories:[{kind:'lesson',text:'Completion precedes reclamation.'}]});
async function* success(){yield {type:'text-delta',index:0,text};yield {type:'usage',usage:{inputTokens:10,outputTokens:12,totalTokens:22}};yield {type:'finish',reason:{kind:'stop'}};}
async function setup(t,{stream=success,prepare}={}){
 const ctx=new Context();await ctx.plugin(sdk.LlmRuntime);let calls=0;const requests=[];
 class Adapter extends sdk.LlmAdapter{
  async prepareCall(provider,model,signal){if(prepare)return prepare(provider,model,signal);return super.prepareCall(provider,model,signal);}
  stream(options){calls++;requests.push(options);return stream(options);}
 }
 ctx.llm.registerAdapter(['provider-A'],new Adapter());
 let bridge;const fiber=ctx.plugin({inject:['llm'],apply(c){bridge=createHarnessProviderBridge({ctx:c,sdk,readApprovedRoute:()=>rawRoute,cleanupBudgetMs:5});}});await fiber;
 t.after(()=>ctx.fiber.dispose());
 return {ctx,bridge,fiber,calls:()=>calls,requests};
}
async function execute(provider,extra={}){return provider.execute(provider.bind('registered-A','memory_extract'),{purpose:'memory_extract',input:'The user established the completion boundary.',requestId:'native-request',maxTokens:64,...extra});}
const unknown=e=>e instanceof Error&&!(e instanceof RouteUnavailable)&&!(e instanceof ProviderResponseError)&&!e.message.includes('CANARY');

test('actual Host Context and SDK feed a completed prepared stream into the real memory queue',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'native-A'})),h=await setup(t);const queue=createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider:h.bridge.provider}),request=queue.enqueue(job(store));
 assert.equal((await queue.runJob(request.jobId)).state,'completed');assert.equal(store.list().length,1);assert.equal(h.calls(),1);assert.equal(h.requests[0].messages.length,2);assert.equal(h.requests[0].maxTokens,512);assert.equal(h.requests[0].tools,undefined);assert.equal(h.requests[0].messages[1].source.kind,'memory-extraction');
});

test('actual Runtime local error finish keeps the real queue unknown and quarantined',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'native-A'})),h=await setup(t,{stream:async function*(){throw new Error('CANARY local transport detail');}});const queue=createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider:h.bridge.provider}),request=queue.enqueue(job(store));
 assert.equal((await queue.runJob(request.jobId)).state,'outcome_unknown');const next=queue.enqueue(job(store,{requestId:'next',sourceRef:'session-A/turn-2',inputRef:'session-A/turn-2#fragment-1'}));assert.equal((await queue.runJob(next.jobId)).reason,'dispatch_gate_held');assert.equal(h.calls(),1);assert.equal(store.list().length,0);
});

test('actual assembler default stop is not accepted when an adapter returns partial text then EOF',async t=>{
 const h=await setup(t,{stream:async function*(){yield {type:'text-delta',index:0,text};}});await assert.rejects(execute(h.bridge.provider),unknown);assert.equal(h.calls(),1);
});

test('a settings event with unchanged provider metadata rejects a queued request before SDK I/O',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'native-A'})),h=await setup(t);const queue=createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider:h.bridge.provider}),request=queue.enqueue(job(store));h.ctx.emit('settings/document-updated','synthetic-model-namespace',2);
 assert.equal((await queue.runJob(request.jobId)).state,'failed');assert.equal(h.calls(),0);assert.equal(h.bridge.status().state,'invalidated');
});

test('actual SDK block assembly preserves text while discarding reasoning and replay metadata',async t=>{
 const h=await setup(t,{stream:async function*(){yield {type:'block-start',index:0,blockType:'reasoning'};yield {type:'reasoning-delta',index:0,text:'synthetic reasoning'};yield {type:'block-end',index:0,block:{type:'reasoning',text:'synthetic reasoning'}};yield {type:'text-delta',index:1,text};yield {type:'block-end',index:1,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'},replayState:{opaque:'not exported'}};}});
 const result=await execute(h.bridge.provider);assert.deepEqual(result,{text,finishReason:'stop'});assert.equal(h.calls(),1);
});

test('a failure in actual prepareCall remains unknown without invoking adapter stream',async t=>{
 const h=await setup(t,{prepare(){throw new RouteUnavailable();}});await assert.rejects(execute(h.bridge.provider),unknown);assert.equal(h.calls(),0);
});

test('native fiber disposal cancels a hung stream with bounded cleanup and never accepts late stop',async t=>{
 const gate=latch(),h=await setup(t,{stream:async function*(){await gate.promise;yield {type:'text-delta',index:0,text};yield {type:'finish',reason:{kind:'stop'}};}});
 const pending=execute(h.bridge.provider);await turn();const disposing=h.fiber.dispose();await assert.rejects(pending,unknown);await disposing;assert.equal(h.bridge.status().state,'disposed');assert.equal((await h.bridge.dispose()).pendingCleanup,1);gate.resolve();await turn();await turn();assert.equal(h.bridge.status().activeCalls,0);assert.equal(h.calls(),1);
});

test('the actual installed-library bridge suite never invokes the guarded network API sinks',()=>{
 assert.deepEqual(globalThis[Symbol.for('local-memory.host-audit.network-attempts')],[]);
});
