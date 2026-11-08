import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {canonical,fingerprint} from '../src/validation.mjs';
import {fixture,job,latch,task2,authorizeTestExecution} from './helpers.mjs';
import {RouteUnavailable,ProviderResponseError} from '../src/provider.mjs';

const rawRoute=()=>({routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'approval-1'});
const responseText=JSON.stringify({schema_version:1,memories:[{kind:'lesson',text:'Completion precedes reclamation.'}]});
async function* success(){yield {type:'text-delta',index:0,text:responseText};yield {type:'usage',usage:{inputTokens:12,outputTokens:15,totalTokens:27,cacheReadTokens:0}};yield {type:'finish',reason:{kind:'stop'}};}
class Assembler{
 constructor(){this.blocksByIndex=new Map();}
 get finish(){assert.fail('Bridge must not infer completion from assembler.finish');}
 push(chunk){if(chunk.type==='text-delta'||chunk.type==='reasoning-delta'){const b=this.blocksByIndex.get(chunk.index)??{type:chunk.type==='text-delta'?'text':'reasoning',text:''};b.text+=chunk.text;this.blocksByIndex.set(chunk.index,b);}else if(chunk.type==='block-end')this.blocksByIndex.set(chunk.index,chunk.block);}
 blocks(){return [...this.blocksByIndex.values()];}
}
const sdk={BlockAssembler:Assembler,createSystemMessage:text=>({id:randomUUID(),role:'system',content:[{type:'text',text}],source:{kind:'system'}}),createUserMessage:input=>({id:randomUUID(),role:'user',...input})};
function host({stream=success,prepare}={}){
 const listeners=new Map(),effects=[],seen={prepare:[],stream:[]};let route=rawRoute();
 const ctx={
  on(name,callback){const list=listeners.get(name)??new Set();listeners.set(name,list);list.add(callback);return()=>list.delete(callback);},
  effect(callback){const dispose=callback();effects.push(dispose);return()=>{};},
  emit(name){for(const callback of [...listeners.get(name)??[]])callback();},
  llm:{listProviders:()=>[{id:'provider-A',name:'A'}],async prepareCall(config,signal){seen.prepare.push({config,signal});if(prepare)return prepare(config,signal,ctx,seen);return {config:Object.freeze({...config}),stream(options){seen.stream.push(options);return stream(options);}};}}
 };
 return {ctx,seen,listeners,effects,readApprovedRoute:()=>route,setRoute:value=>{route=value;}};
}
async function bridge(t,h=host()){
 let createHarnessProviderBridge;
 try{({createHarnessProviderBridge}=await import('../plugin/harness-provider.mjs'));}catch(error){if(error.code==='ERR_MODULE_NOT_FOUND')assert.fail('Harness Provider bridge is not implemented');throw error;}
 const b=createHarnessProviderBridge({ctx:h.ctx,sdk,readApprovedRoute:h.readApprovedRoute,cleanupBudgetMs:5});t.after(()=>b.dispose());return {...h,b,provider:b.provider};
}
async function execute(provider,extra={}){return provider.execute(provider.bind('registered-A','memory_extract'),{purpose:'memory_extract',input:'The user established the completion boundary.',requestId:randomUUID(),maxTokens:64,...extra});}
const unknown=error=>error instanceof Error&&!(error instanceof RouteUnavailable)&&!(error instanceof ProviderResponseError)&&!error.message.includes('CANARY');

test('bridge sends only the bounded fragment and fixed purpose prompt through one prepared call',async t=>{
 const {provider,seen}=await bridge(t);const result=await execute(provider);
 assert.equal(result.text,responseText);assert.deepEqual(result.usage,{inputTokens:12,outputTokens:15});assert.equal(result.finishReason,'stop');assert.equal(seen.prepare.length,1);assert.equal(seen.stream.length,1);
 const options=seen.stream[0];assert.equal(options.provider,'provider-A');assert.equal(options.model,'model-A');assert.equal(options.maxTokens,64);assert.equal(options.messages.length,2);assert.equal(options.messages[0].role,'system');assert.equal(options.messages[1].role,'user');assert.equal(options.messages[1].content[0].text,'The user established the completion boundary.');assert.equal(options.messages[1].source.kind,'memory-extraction');assert.equal(options.tools,undefined);assert.equal(options.sessionId,undefined);assert.ok(Object.isFrozen(options));assert.ok(Object.isFrozen(options.messages[1].content));
});

test('each allowed purpose has a fixed schema prompt and unknown purposes cannot dispatch',async t=>{
 const {provider,seen}=await bridge(t);for(const purpose of ['memory_extract','work_summary_extract','work_summary_merge'])await execute(provider,{purpose});
 assert.equal(new Set(seen.stream.map(o=>o.messages[0].content[0].text)).size,3);assert.ok(seen.stream[1].messages[0].content[0].text.includes('unknown'));assert.throws(()=>provider.bind('registered-A','arbitrary'),/Unsupported/);assert.equal(seen.stream.length,3);
});

test('text followed by EOF without explicit finish is unknown',async t=>{
 const {provider}=await bridge(t,host({stream:async function*(){yield {type:'text-delta',index:0,text:responseText};}}));await assert.rejects(execute(provider),unknown);
});

test('synthesized error, aborted and truncation finishes do not become known completion',async t=>{
 for(const kind of ['error','aborted','max-tokens']){const {provider,seen}=await bridge(t,host({stream:async function*(){yield {type:'finish',reason:{kind,failure:{message:'CANARY transport detail'}}};}}));await assert.rejects(execute(provider),unknown);assert.equal(seen.stream.length,1);}
});

test('duplicate finish, text after stop, and an iterator throw after stop stay unknown',async t=>{
 for(const trailing of ['finish','text','throw']){const {provider}=await bridge(t,host({stream:async function*(){yield {type:'text-delta',index:0,text:responseText};yield {type:'finish',reason:{kind:'stop'}};if(trailing==='throw')throw new Error('CANARY iterator detail');yield trailing==='finish'?{type:'finish',reason:{kind:'stop'}}:{type:'text-delta',index:0,text:'extra'};}}));await assert.rejects(execute(provider),unknown);}
});

test('once prepareCall was touched its failure is unknown even when stream never started',async t=>{
 const {provider,seen}=await bridge(t,host({prepare(){throw new RouteUnavailable();}}));await assert.rejects(execute(provider),unknown);assert.equal(seen.prepare.length,1);assert.equal(seen.stream.length,0);
});

test('changed approval before prepare is refused without dispatch and activation versions do not rebind',async t=>{
 const h=host(),one=await bridge(t,h),bound=one.provider.bind('registered-A','memory_extract');h.setRoute({...rawRoute(),routeVersion:'endpoint-changed'});
 await assert.rejects(one.provider.execute(bound,{purpose:'memory_extract',input:'Current bounded fragment.',requestId:'changed',maxTokens:64}),RouteUnavailable);assert.equal(h.seen.prepare.length,0);
 h.setRoute(rawRoute());const two=await bridge(t,h);assert.notEqual(two.provider.bind('registered-A','memory_extract').routeVersion,bound.routeVersion);assert.equal(two.provider.approved(bound,'memory_extract'),false);
});

test('all four host configuration events permanently invalidate an activation and remove listeners on dispose',async t=>{
 for(const event of ['llm/adapters-updated','loader/volatile-update','settings/document-updated','app-boot/config-reload']){const {b,provider,ctx,seen,listeners}=await bridge(t);const bound=provider.bind('registered-A','memory_extract');ctx.emit(event);ctx.emit(event);assert.equal(b.status().state,'invalidated');assert.equal(provider.approved(bound,'memory_extract'),false);await assert.rejects(execute(provider),RouteUnavailable);assert.equal(seen.prepare.length,0);await b.dispose();assert.equal([...listeners.values()].reduce((n,s)=>n+s.size,0),0);}
});

test('approval changes during preparation are unknown and never reach prepared.stream',async t=>{
 const gate=latch(),h=host({prepare:async config=>{await gate.promise;return {config,stream(){h.seen.stream.push('unexpected');return success();}};}});const {provider}=await bridge(t,h);const pending=execute(provider);await turn();h.setRoute({...rawRoute(),routeVersion:'credential-reference-changed'});gate.resolve();await assert.rejects(pending,unknown);assert.equal(h.seen.prepare.length,1);assert.equal(h.seen.stream.length,0);
});

test('an invalidation between preparation and dispatch is rechecked before sending the fragment',async t=>{
 const h=host({prepare(config,_signal,ctx){return {get config(){ctx.emit('loader/volatile-update');return config;},stream(){h.seen.stream.push('unexpected');return success();}};}});const {provider}=await bridge(t,h);await assert.rejects(execute(provider),unknown);assert.equal(h.seen.stream.length,0);
});

test('cancellation during a non-cooperative prepare returns unknown and observes its later rejection',async t=>{
 const gate=latch(),controller=new AbortController(),h=host({prepare:()=>gate.promise});const {provider,b}=await bridge(t,h);const pending=execute(provider,{signal:controller.signal});await turn();controller.abort();await assert.rejects(pending,unknown);const receipt=await b.dispose();assert.equal(receipt.pendingCleanup,1);gate.reject(new Error('CANARY late prepare failure'));await turn();await turn();assert.equal(b.status().activeCalls,0);assert.equal(h.seen.stream.length,0);
});

test('stop without EOF cannot complete and dispose waits only its cleanup budget',async t=>{
 const gate=latch();let nexts=0,returns=0;const h=host({stream:()=>({[Symbol.asyncIterator](){return this;},next(){return ++nexts===1?Promise.resolve({done:false,value:{type:'finish',reason:{kind:'stop'}}}):gate.promise;},return(){returns++;return new Promise(()=>{});}})});const {provider,b}=await bridge(t,h);const pending=execute(provider);await turn();const disposing=b.dispose();await assert.rejects(pending,unknown);const receipt=await disposing;assert.equal(receipt.pendingCleanup,1);assert.equal(returns,1);assert.equal(nexts,2);assert.equal((await b.dispose()).state,'disposed');assert.equal(returns,1);gate.resolve({done:true});await turn();assert.equal(b.status().activeCalls,1);
});

test('late stop after queue timeout does not write memory or release the unknown root gate',async t=>{
 const api=await task2(),f=fixture(t),store=f.track(api.openStore(f.root,{scopeRef:'scope-A'})),gate=latch();
 const {provider}=await bridge(t,host({stream:async function*(){yield {type:'text-delta',index:0,text:responseText};await gate.promise;yield {type:'finish',reason:{kind:'stop'}};}}));const queue=api.createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider});const first=queue.enqueue(job(store));const outcome=await queue.runJob(first.jobId,{timeoutMs:10});assert.equal(outcome.state,'outcome_unknown');gate.resolve();await turn();await turn();assert.equal(store.list().length,0);const second=queue.enqueue(job(store,{requestId:'second',sourceRef:'session-A/turn-2',fragmentRef:'fragment-2',inputRef:'session-A/turn-2#fragment-2'}));assert.equal((await queue.runJob(second.jobId)).reason,'dispatch_gate_held');
});

test('a rejecting iterator return is observed without exposing details and is never retried',async t=>{
 const h=host({stream:()=>({[Symbol.asyncIterator](){return this;},async next(){throw new Error('CANARY next detail');},async return(){throw new Error('CANARY cleanup detail');}})});const {provider,b}=await bridge(t,h);await assert.rejects(execute(provider),unknown);await turn();const receipt=await b.dispose();assert.equal(receipt.pendingCleanup,0);assert.equal(receipt.cleanupIssues,1);assert.equal(h.seen.stream.length,1);
});

test('old activation cancellation and late cleanup cannot disable a newly created activation',async t=>{
 const gate=latch(),h=host();let calls=0;h.ctx.llm.prepareCall=async config=>({config,stream:async function*(){if(++calls===1){await gate.promise;}yield {type:'text-delta',index:0,text:responseText};yield {type:'finish',reason:{kind:'stop'}};}});const old=await bridge(t,h),pending=execute(old.provider);await turn();h.ctx.emit('settings/document-updated');await assert.rejects(pending,unknown);const current=await bridge(t,h);assert.equal((await execute(current.provider)).finishReason,'stop');gate.resolve();await turn();await old.b.dispose();assert.equal(current.b.status().state,'active');assert.equal((await execute(current.provider)).finishReason,'stop');
});

test('EOF microtasks cannot return success after cancellation or activation invalidation',async t=>{
 for(const kind of ['configuration','abort']){
  const controller=new AbortController();let next=0;const h=host({stream:()=>({[Symbol.asyncIterator](){return this;},next(){next++;if(next===1)return Promise.resolve({done:false,value:{type:'text-delta',index:0,text:responseText}});if(next===2)return Promise.resolve({done:false,value:{type:'finish',reason:{kind:'stop'}}});queueMicrotask(()=>queueMicrotask(()=>{if(kind==='abort')controller.abort();else h.ctx.emit('loader/volatile-update');}));return Promise.resolve({done:true});}})});
  const {provider}=await bridge(t,h);await assert.rejects(execute(provider,{signal:controller.signal}),unknown);
 }
});

test('async or malformed approved route readers are rejected without leaking their errors',async t=>{
 for(const reader of [()=>Promise.reject(new Error('CANARY reader detail')),()=>({...rawRoute(),apiKey:'CANARY key detail'}),()=>{throw new Error('CANARY config detail');}]){const h=host();h.readApprovedRoute=reader;const {provider,seen}=await bridge(t,h);assert.throws(()=>provider.bind('registered-A','memory_extract'),error=>error instanceof RouteUnavailable&&!error.message.includes('CANARY'));assert.equal(seen.prepare.length,0);await turn();}
});

test('oversized or tool-bearing protocol data is refused while known complete secret text is classified separately',async t=>{
 for(const chunk of [{type:'text-delta',index:0,text:'a'.repeat(70000)},{type:'tool-call-delta',index:0,id:'call',name:'outside',argumentsDelta:'{}'}]){const {provider}=await bridge(t,host({stream:async function*(){yield chunk;yield {type:'finish',reason:{kind:'stop'}};}}));await assert.rejects(execute(provider),unknown);}
 const {provider}=await bridge(t,host({stream:async function*(){yield {type:'text-delta',index:0,text:'password=CANARY_VALUE'};yield {type:'finish',reason:{kind:'stop'}};}}));await assert.rejects(execute(provider),ProviderResponseError);
});

test('contradictory or repeated block frames cannot be silently accepted by a tolerant assembler',async t=>{
 const cases=[
  [{type:'block-start',index:0,blockType:'text'},{type:'block-start',index:0,blockType:'text'}],
  [{type:'block-end',index:0,block:{type:'text',text:responseText}},{type:'text-delta',index:0,text:'extra'}],
  [{type:'text-delta',index:0,text:responseText},{type:'reasoning-delta',index:0,text:'wrong type'}],
  [{type:'text-delta',index:0,text:responseText},{type:'block-end',index:0,block:{type:'text',text:'different'}}]
 ];
 for(const frames of cases){const {provider}=await bridge(t,host({stream:async function*(){yield* frames;yield {type:'finish',reason:{kind:'stop'}};}}));await assert.rejects(execute(provider),unknown);}
});

test('system prompt plus fragment fits exactly 8000 UTF-16 units and excess is refused before SDK preparation',async t=>{
 const {provider,seen}=await bridge(t);const overhead=provider.measureInput({purpose:'memory_extract',input:'x'})-1;
 const input='x'.repeat(8000-overhead);assert.equal(provider.measureInput({purpose:'memory_extract',input}),8000);await execute(provider,{input});
 await assert.rejects(execute(provider,{input:input+'x'}),RouteUnavailable);assert.equal(seen.prepare.length,1);
 assert.notEqual(provider.measureInput({purpose:'work_summary_extract',input:'x'}),provider.measureInput({purpose:'memory_extract',input:'x'}));
});

test('input accounting includes whitespace that direct execution actually forwards to the SDK',async t=>{
 const {provider,seen}=await bridge(t);const overhead=provider.measureInput({purpose:'memory_extract',input:'x'})-1,input='x'.repeat(7999-overhead)+' ';
 assert.equal(provider.measureInput({purpose:'memory_extract',input}),8000);await execute(provider,{input});await assert.rejects(execute(provider,{input:input+' '}),RouteUnavailable);assert.equal(seen.prepare.length,1);
});

test('durable queue includes fixed prompts in the daily input limit and replay reserves only once',async t=>{
 const api=await task2(),f=fixture(t),store=f.track(api.openStore(f.root,{scopeRef:'scope-A'}));const {provider,seen}=await bridge(t);const queue=api.createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider,limits:{sessionRequests:20,maxOutputTokens:16}});
 const overhead=provider.measureInput({purpose:'memory_extract',input:'x'})-1,input='x'.repeat(Math.floor(80000/11)+1-overhead);
 let first;for(let i=0;i<10;i++){const args=job(store,{requestId:`budget-${i}`,sourceRef:`session-A/turn-${i}`,inputRef:`session-A/turn-${i}#fragment-1`,input});const result=queue.enqueue(args);if(i===0){first=result;assert.deepEqual(queue.enqueue(args),first);}}
 assert.throws(()=>queue.enqueue(job(store,{requestId:'budget-over',sourceRef:'session-A/turn-over',inputRef:'session-A/turn-over#fragment-1',input})),/budget exhausted/);assert.equal(seen.prepare.length,0);
});

test('invalid or changing input meters never spend budget or silently update an existing reservation',async t=>{
 const api=await task2(),f=fixture(t),store=f.track(api.openStore(f.root,{scopeRef:'scope-A'}));let meter=()=>NaN,calls=0;
 const controlled=api.createControlledProvider({resolveRoute:()=>rawRoute(),invoke:async()=>{calls++;return {text:responseText,finishReason:'stop'};}}),provider={...controlled,measureInput:args=>meter(args)};
 const queue=api.createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider,limits:{dailyRequests:1}});
 for(const fn of [()=>NaN,()=>-1,()=>1.5,()=>8001,()=>Promise.reject(new Error('CANARY meter detail')),()=>{throw new Error('CANARY meter detail');}]){meter=fn;assert.throws(()=>queue.enqueue(job(store)),e=>!e.message.includes('CANARY'));await turn();}
 meter=({input})=>input.length;const request=queue.enqueue(job(store));meter=({input})=>input.length+1;const result=await queue.runJob(request.jobId);assert.equal(result.state,'failed');assert.equal(result.reason,'input_accounting_changed_or_unavailable');assert.equal(calls,0);
});

test('authenticated older queued payloads without frozen input accounting cannot resume',async t=>{
 const api=await task2(),f=fixture(t),store=f.track(api.openStore(f.root,{scopeRef:'scope-A'}));const {provider,seen}=await bridge(t);const queue=api.createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider}),request=queue.enqueue(job(store));
 // Reconstruct the previous queue payload contract, including its matching authority fingerprint.
 const db=new DatabaseSync(store.databasePath);try{db.prepare('ATTACH DATABASE ? AS ledger').run(join(f.root,'authority.sqlite'));const payload=JSON.parse(db.prepare('SELECT payload FROM job_inputs WHERE id=?').get(request.jobId).payload);delete payload.inputChars;db.exec('BEGIN IMMEDIATE');db.prepare('UPDATE job_inputs SET payload=? WHERE id=?').run(canonical(payload),request.jobId);db.prepare('UPDATE ledger.jobs SET fingerprint=? WHERE id=?').run(fingerprint(payload),request.jobId);db.exec('COMMIT');}finally{db.close();}
 const result=await queue.runJob(request.jobId);assert.equal(result.state,'failed');assert.equal(result.reason,'input_accounting_changed_or_unavailable');assert.equal(seen.prepare.length,0);
});

test('execution authorization revoked during prepare prevents the prepared stream from starting',async t=>{
 const api=await task2(),f=fixture(t),store=f.track(api.openStore(f.root,{scopeRef:'scope-A'})),prepared=latch(),resume=latch();let streams=0,allowed=true;
 const h=await bridge(t,host({prepare:async config=>{prepared.resolve();await resume.promise;return {config,stream(){streams++;return success();}};}}));
 const signal=new AbortController().signal,queue=api.createJobQueue(store,{provider:h.provider,authorizeExecution:()=>allowed?{authorizationVersion:'v1',signal}:undefined}),saved=queue.enqueue(job(store));
 const running=queue.runJob(saved.jobId);await prepared.promise;allowed=false;resume.resolve();assert.equal((await running).state,'outcome_unknown');assert.equal(streams,0);assert.deepEqual(store.list(),[]);
});

test('a source invalidated during prepare cannot reach a later prepared stream',async t=>{
 const api=await task2(),f=fixture(t),store=f.track(api.openStore(f.root,{scopeRef:'scope-A'})),prepared=latch(),resume=latch();let streams=0;
 const h=await bridge(t,host({prepare:async config=>{prepared.resolve();await resume.promise;return {config,stream(){streams++;return success();}};}}));
 const queue=api.createJobQueue(store,{provider:h.provider,authorizeExecution:authorizeTestExecution}),saved=queue.enqueue(job(store));
 const running=queue.runJob(saved.jobId);await prepared.promise;store.put({id:'invalidator',sourceRef:'session-A/turn-1',sourceVersion:'version-A',text:'Completion boundary.',kind:'lesson'});store.forget({id:'invalidator',expectedGeneration:store.generation()});resume.resolve();
 assert.equal((await running).state,'outcome_unknown');assert.equal(streams,0);assert.deepEqual(store.list(),[]);
});

test('memory_consolidate has its own fixed prompt and bounded accounting',async t=>{
 const {provider,seen}=await bridge(t),bound=provider.bind('registered-A','memory_consolidate');
 await provider.execute(bound,{purpose:'memory_consolidate',input:'{"schema_version":1}',requestId:randomUUID(),maxTokens:64});
 assert.equal(seen.stream.length,1);
 assert.ok(seen.stream[0].messages[0].content[0].text.includes('Consolidate only'));
 assert.ok(seen.stream[0].messages[0].content[0].text.includes('untouched'));
 assert.notEqual(provider.measureInput({purpose:'memory_consolidate',input:'x'}),provider.measureInput({purpose:'memory_extract',input:'x'}));
 assert.throws(()=>provider.bind('registered-A','memory_consolidate_v2'),/Unsupported/);
});
