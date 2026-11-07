import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const hostRoot=process.env.DSH_AUDIT_APP_ROOT;
assert.equal(hostRoot,'E:/dsh/resources/app.asar/dsh');
const host=async name=>import(pathToFileURL(`${hostRoot}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const {Context}=await host('cordis');
const {LlmRuntime,LlmAdapter,createUserMessage,BlockAssembler}=await host('dsh-llm');
const {SessionStore}=await host('dsh-session');
const {agentEvents}=await host('dsh-agent');
const {createScope}=await host('dsh-scope');
const boot=await host('dsh-app-boot');
const message=()=>createUserMessage({content:[{type:'text',text:'synthetic audit input'}],source:{kind:'user'}});
async function context(t){const ctx=new Context();t.after(()=>ctx.fiber.dispose());return ctx;}
async function llmContext(t){const ctx=await context(t);await ctx.plugin(LlmRuntime);return ctx;}
async function collect(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return chunks;}
class TextAdapter extends LlmAdapter{
 calls=[];
 constructor(text='synthetic-output'){super();this.text=text;}
 async *stream(options){this.calls.push(options);yield {type:'text-delta',index:0,text:this.text};yield {type:'usage',usage:{inputTokens:1,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};}
}

test('the pinned installed host exposes the expected runtime and service lifecycle',async t=>{
 assert.equal(process.versions.node,'24.21.0');assert.equal(process.versions.electron,'44.7.0');assert.equal(boot.getDshRuntimeVersion(),'0.2.1-rc.5');
 const ctx=await llmContext(t);assert.deepEqual(ctx.llm.listProviders(),[]);assert.equal(typeof ctx.llm.prepareCall,'function');
 // This Cordis version starts via the awaitable plugin fiber, not ctx.start().
 assert.equal(ctx.start,undefined);assert.equal(typeof ctx.fiber.dispose,'function');
});

test('real Cordis plugin disposal removes event listeners and contributions',async t=>{
 const ctx=await context(t);let seen=0,cleaned=0;
 const fiber=ctx.plugin(c=>{c.on('audit/event',()=>{seen++;});c.effect(()=>()=>{cleaned++;});});await fiber;
 ctx.emit('audit/event');assert.equal(seen,1);await fiber.dispose();ctx.emit('audit/event');assert.equal(seen,1);assert.equal(cleaned,1);
});

test('prepareCall freezes explicit controls and dispatches once through the registered adapter',async t=>{
 const ctx=await llmContext(t),adapter=new TextAdapter();const unregister=ctx.llm.registerAdapter(['audit-provider'],adapter);
 const prepared=await ctx.llm.prepareCall({provider:'audit-provider',model:'audit-model',maxTokens:16});
 assert.ok(Object.isFrozen(prepared.config));assert.throws(()=>prepared.stream({...prepared.config,maxTokens:17,messages:[message()]}),{code:'INVALID_PREPARED_CALL'});
 const assembler=new BlockAssembler();for(const chunk of await collect(prepared.stream({...prepared.config,messages:[message()]})))assembler.push(chunk);
 assert.equal(adapter.calls.length,1);assert.equal(adapter.calls[0].maxTokens,16);assert.deepEqual(assembler.usage,{inputTokens:1,outputTokens:2});assert.equal(assembler.blocks()[0].text,'synthetic-output');
 assert.throws(()=>prepared.stream({...prepared.config,messages:[message()]}),{code:'INVALID_PREPARED_CALL'});
 unregister();assert.deepEqual(ctx.llm.listProviders(),[]);
});

test('a prepared call remains bound to its adapter generation after registration replacement',async t=>{
 const ctx=await llmContext(t),a=new TextAdapter('A'),b=new TextAdapter('B');
 const removeA=ctx.llm.registerAdapter(['audit-provider'],a);const prepared=await ctx.llm.prepareCall({provider:'audit-provider',model:'audit-model',maxTokens:16});
 removeA();ctx.llm.registerAdapter(['audit-provider'],b);
 const chunks=await collect(prepared.stream({...prepared.config,messages:[message()]}));assert.equal(chunks.find(c=>c.type==='text-delta').text,'A');assert.equal(a.calls.length,1);assert.equal(b.calls.length,0);
});

test('host error and aborted chunks can be synthesized locally and are not remote completion receipts',async t=>{
 const ctx=await llmContext(t);let calls=0;
 class Broken extends LlmAdapter{async *stream(){calls++;throw new Error('synthetic transport failure');}}
 ctx.llm.registerAdapter(['audit-provider'],new Broken());
 const errorChunks=await collect(ctx.llm.stream({provider:'audit-provider',model:'audit-model',maxTokens:16,messages:[message()]}));
 assert.equal(errorChunks.at(-1).reason.kind,'error');assert.equal(calls,1);
 const controller=new AbortController();controller.abort();
 const aborted=await collect(ctx.llm.stream({provider:'audit-provider',model:'audit-model',maxTokens:16,messages:[message()],signal:controller.signal}));
 assert.equal(aborted.at(-1).reason.kind,'aborted');assert.equal(calls,2);
});

test('BlockAssembler defaults to stop without a finish chunk so bridge must track explicit termination',()=>{
 const assembler=new BlockAssembler();assembler.push({type:'text-delta',index:0,text:'partial'});
 assert.equal(assembler.finish.kind,'stop');
 // No adapter receipt was supplied. Do not turn this convenience getter into known completion.
 assert.equal(assembler.blocks()[0].text,'partial');
});

test('agent pre-step waterfall supplies the subject and filters unrelated scoped listeners',async t=>{
 const ctx=await context(t),a={id:'agent-A'},b={id:'agent-B'};const scopedA=createScope(ctx,a),scopedB=createScope(ctx,b);let aCalls=0,bCalls=0;
 scopedA.ctx.on('agent/pre-step',async(payload,next)=>{assert.equal(payload.agent,a);aCalls++;return next();});
 scopedB.ctx.on('agent/pre-step',async(_payload,next)=>{bCalls++;return next();});
 const inputs=[message()],controller=new AbortController();const result=await agentEvents(ctx,a).waterfall('agent/pre-step',{messages:inputs,turn:1,step:0,signal:controller.signal},()=>Promise.resolve({kind:'enter',messages:inputs}));
 assert.equal(result.kind,'enter');assert.equal(result.messages[0].id,inputs[0].id);assert.equal(aCalls,1);assert.equal(bCalls,0);
 await scopedA.dispose();await scopedB.dispose();
});

test('session notifications carry stable event sequence and source identity in an in-memory store',async t=>{
 const ctx=await context(t);await ctx.plugin(SessionStore);const seen=[];ctx.on('session/event',(session,event)=>seen.push({session,event}));
 const session=ctx.sessions.create('audit-session',{meta:{cwd:'E:/dsh/plugin'}});const input=message();session.append('user/message',input,{surfaceOp:'append'});
 assert.equal(session.header.cwd,'E:/dsh/plugin');assert.equal(seen.length,1);assert.equal(seen[0].session,session);assert.equal(seen[0].event.data.id,input.id);assert.ok(Number.isSafeInteger(seen[0].event.seq));assert.ok(Object.isFrozen(seen[0].event.data));
 // These producer tags are synthetic; live frontend source classification remains an integration task.
 assert.equal(await ctx.sessions.flush(session),false);
});

test('bundle compatibility and telemetry switch use the pinned boot APIs without initializing a profile',()=>{
 assert.equal(boot.evaluatePluginCompatibility({name:'@local/probe',version:'0.1.0',engines:{dsh:'0.2.1-rc.5'}}),undefined);
 assert.ok(boot.evaluatePluginCompatibility({name:'@local/probe',version:'0.1.0',engines:{dsh:'0.0.0'}}));
 assert.deepEqual(boot.resolveTelemetryPatch('1',true),{id:'session-telemetry-otel',disabled:true});assert.deepEqual(boot.resolveTelemetryPatch('false',true),{id:'session-telemetry-otel',disabled:true});assert.equal(boot.resolveTelemetryPatch('1',false),undefined);
 assert.deepEqual(boot.bundlePatchPaths('E:/local-package',{patch:'cordis.patch.yml'}),['E:\\local-package\\cordis.patch.yml']);
});

test('the audit guard blocks covered connection APIs and earlier imports or cases did not invoke these covered sinks',async()=>{
 const attempts=globalThis[Symbol.for('local-memory.host-audit.network-attempts')];assert.ok(Array.isArray(attempts));assert.deepEqual(attempts,[]);
 const net=await import('node:net'),http=await import('node:http');assert.throws(()=>net.connect(9,'127.0.0.1'),/Network disabled/);assert.throws(()=>http.request('http://127.0.0.1:9'),/Network disabled/);await assert.rejects(fetch('https://example.invalid'),/Network disabled/);assert.equal(attempts.length,3);
});
