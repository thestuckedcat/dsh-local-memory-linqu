import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
import {fixture,memory,draft} from './helpers.mjs';
import {createWorkSummaryManager} from '../src/work-summary.mjs';
import {openStore} from '../src/backend.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {fingerprint} from '../src/validation.mjs';

const freeze=v=>{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;};
const input=(id='message-1',text='DMA completion boundary',source={kind:'user',rpcId:`rpc-${id}`})=>freeze({id,role:'user',content:[{type:'text',text}],source});
const hash=msg=>fingerprint({id:msg.id,role:msg.role,rpcId:msg.source.rpcId,content:msg.content});
const sessionRef=session=>`${session.id}/${fingerprint({id:session.id,version:session.header.version,createdAt:session.header.createdAt})}`;
const makeMessage=value=>freeze({id:randomUUID(),role:'user',...structuredClone(value)});

async function setup(t,{limits={},diagnostic,isScopeHeld}={}){
 const f=fixture(t),a=f.track(openStore(f.root,{scopeRef:'scope-A'})),b=f.track(openStore(f.root,{scopeRef:'scope-B'}));
 const listeners=new Map(),sessions=new Map(),agents=new Map(),root={},receipts=new Map(),diagnostics=[];
 const h={rootPath:f.root,a,b,scope:a,allowed:true,version:'grant-1',revokeDuringMeter:false,receipts,diagnostics,limits};
 const ctx={root,sessions:{get:id=>sessions.get(id)},agents:{get:id=>agents.get(id)},
  on(name,fn){const set=listeners.get(name)??new Set();listeners.set(name,set);set.add(fn);return()=>set.delete(fn);},effect(fn){fn();return()=>{};},
  emit(name,...args){for(const fn of [...listeners.get(name)??[]])fn(...args);},
  async preStep(payload,next){let index=0;const fns=[...listeners.get('agent/pre-step')??[]];const go=()=>index<fns.length?fns[index++](payload,go):next();return go();}
 };
 h.ctx=ctx;h.listeners=listeners;
 function session(id,createdAt){const log=new Map();const s={id,header:freeze({id,version:4,createdAt}),eventAt:seq=>log.get(seq),append(message,options={}){const event=freeze({type:'user/message',seq:log.size,time:100,data:structuredClone(message),surfaceOp:'append',...options});log.set(event.seq,event);ctx.emit('session/event',s,event);return event;}};sessions.set(id,s);const agent={id,session:s};agents.set(id,agent);return {session:s,agent};}
 Object.assign(h,session('session-A',1));h.other=session('session-B',2);h.sessions=sessions;h.agents=agents;
 let calls=0;const controlled=createControlledProvider({resolveRoute:()=>({routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'route-1'}),invoke:async()=>{calls++;return {text:JSON.stringify({schema_version:1,memories:[]}),finishReason:'stop'};}});
 const provider={...controlled,measureInput({input}){if(h.revokeDuringMeter)h.allowed=false;return input.length;}};
 h.qa=createJobQueue(a,{provider});h.qb=createJobQueue(b,{provider});h.providerCalls=()=>calls;
 h.resolveScope=()=>({scopeRef:h.scope.scopeRef,store:h.scope,queue:h.queueOverride??(h.scope===a?h.qa:h.qb),routeRef:'registered-A',generation:h.scope.generation(),authorizationVersion:h.version});
 h.grant=(message,s=h.session)=>receipts.set(`${sessionRef(s)}:${message.id}`,{scopeRef:h.scope.scopeRef,rpcId:message.source.rpcId,contentHash:hash(message),originRef:`approved-rpc:${message.source.rpcId}`});
 h.admitMessage=args=>{const receipt=receipts.get(`${args.sessionRef}:${args.messageId}`);return h.allowed&&receipt&&receipt.scopeRef===args.scopeRef&&receipt.rpcId===args.rpcId&&receipt.contentHash===args.contentHash?{originRef:receipt.originRef,contentHash:receipt.contentHash,authorizationVersion:h.version}:undefined;};
 h.options={resolveScope:arg=>h.resolveScope(arg),admitMessage:arg=>h.admitMessage(arg),createUserMessage:makeMessage,onDiagnostic:info=>{diagnostics.push(info);return diagnostic?.(info);},limits,...(isScopeHeld?{isScopeHeld}:{})};
 let installSessionHooks;try{({installSessionHooks}=await import('../plugin/session-hooks.mjs'));}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND')assert.fail('Current-message hooks are not implemented');throw e;}
 h.install=(c=ctx,options=h.options)=>installSessionHooks(c,options);h.hooks=h.install();t.after(()=>h.hooks.dispose());
 h.step=(messages,next=()=>Promise.resolve({kind:'enter',messages,custom:'preserve'}),extra={})=>ctx.preStep({agent:h.agent,messages,turn:1,step:1,signal:new AbortController().signal,...extra},next);
 h.rows=()=>{const db=new DatabaseSync(join(f.root,'authority.sqlite'),{readOnly:true});try{return {jobs:db.prepare('SELECT count(*) AS n FROM jobs').get().n,budget:db.prepare('SELECT coalesce(sum(requests),0) AS n FROM daily_budget').get().n};}finally{db.close();}};
 h.inputs=()=>{const db=new DatabaseSync(a.databasePath,{readOnly:true});try{return db.prepare('SELECT count(*) AS n FROM job_inputs').get().n;}finally{db.close();}};
 return h;
}
function own(decision){return decision.messages.filter(m=>m.source?.kind==='memory-recall'&&m.source.plugin==='@local/dsh-controlled-memory');}

test('only an accepted current user event enqueues and repeated delivery spends one reservation',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);const event=h.session.append(msg);h.ctx.emit('session/event',h.session,event);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:1,budget:1});assert.equal(h.inputs(),1);assert.equal(h.providerCalls(),0);
});

test('claimed rejection and claimed-only messages never enqueue or add recall',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const rejected={kind:'reject',reason:'kept'};let calls=0;
 assert.equal(await h.step([msg],async()=>{calls++;return rejected;}),rejected);await h.hooks.drain();assert.equal(calls,1);assert.deepEqual(h.rows(),{jobs:0,budget:0});
});

test('same message ID with edited text or a second event sequence is refused as a new source',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.session.append(msg);await h.hooks.drain();h.session.append(msg);const edited=input('message-1','DMA ownership differs');h.grant(edited);h.session.append(edited);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:1,budget:1});
});

test('unapproved user tags and non-user producer classes do not gain extraction permission',async t=>{
 const h=await setup(t);h.session.append(input('forged'));for(const kind of ['model-selection','runtime-context','memory-recall','memory-extraction','tool-registry']){const msg=input(kind,'DMA completion boundary',{kind,rpcId:`rpc-${kind}`});h.grant(msg);h.session.append(msg);}await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});
});

test('attachments, secret-like text, oversized input and unsupported source data are not partly extracted',async t=>{
 const h=await setup(t);const cases=[freeze({...input('attachment'),content:[{type:'text',text:'DMA completion boundary'},{type:'image',attachment:{id:'synthetic'}}]}),input('secret','password=CANARY_SECRET'),input('large','x'.repeat(8001)),input('extra','DMA',{kind:'user',rpcId:'rpc-extra',cookie:'CANARY_COOKIE'})];for(const msg of cases){h.grant(msg);h.session.append(msg);}await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});assert.equal(h.inputs(),0);
});

test('a forged event object or replay into an unapproved session cannot reuse an admission',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);const event=h.session.append(msg);await h.hooks.drain();h.ctx.emit('session/event',h.session,{...event});h.other.session.append(msg);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:1,budget:1});
});

test('a delayed A event cannot be rebound to a newly selected B scope',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.session.append(msg);h.scope=h.b;await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});assert.equal(h.inputs(),0);
});

test('post-enqueue permission revocation rolls back jobs, plaintext and budget together',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.revokeDuringMeter=true;h.session.append(msg);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});assert.equal(h.inputs(),0);
});

test('a foreign queue is refused before any cross-store write',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.queueOverride=h.qb;h.session.append(msg);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});assert.equal(h.inputs(),0);
});

test('a held scope suppresses recall while the ordinary request continues',async t=>{
 const h=await setup(t,{isScopeHeld:()=>true}),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion waits for the ownership barrier.'}));
 const result=await h.step([msg],async()=>({kind:'enter',messages:[msg]}));
 assert.equal(own(result).length,0);
 assert.equal(result.messages.length,1);
});

test('recall preserves the final decision and injects only ordinary active memory once',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion waits for the ownership barrier.'}));const base={kind:'enter',messages:[msg],custom:{value:'preserve'}};const result=await h.step([msg],async()=>base);
 assert.equal(result.custom,base.custom);assert.equal(result.messages[0],msg);assert.equal(own(result).length,1);assert.ok(own(result)[0].content[0].text.includes('DMA completion waits'));assert.equal(own(result)[0].source.kind,'memory-recall');assert.notEqual(own(result)[0].source.kind,'runtime-context');assert.equal(h.providerCalls(),0);
});

test('replaced or removed claimed input cannot become a historical fallback query',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const changed=input('message-1','different text');h.grant(changed);
 assert.equal(own(await h.step([msg],async()=>({kind:'enter',messages:[changed]}))).length,0);assert.equal(own(await h.step([msg],async()=>({kind:'enter',messages:[]}))).length,0);
});

test('scope and authorization changes while next is awaiting never inject the old scope',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));let release;const wait=new Promise(r=>{release=r;});const pending=h.step([msg],async()=>{await wait;return {kind:'enter',messages:[msg]};});h.scope=h.b;release();assert.equal(own(await pending).length,0);
 h.scope=h.a;const revoked=await h.step([msg],async()=>{h.version='revoked-v2';return {kind:'enter',messages:[msg]};});assert.equal(own(revoked).length,0);
});

test('uncommitted reentry keeps identity but deletion removes old recalled body instead of caching it',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const first=await h.step([msg]),again=await h.step([msg]);assert.equal(own(first)[0].id,own(again)[0].id);
 h.a.forget({id:'one',expectedGeneration:h.a.generation()});const result=await h.step([msg],async()=>({kind:'enter',messages:[msg,...own(first)]}));assert.equal(own(result).length,0);assert.ok(!JSON.stringify(result).includes('DMA completion boundary is established.'));
});

test('changed recalled content gets a new injection ID rather than reusing the old body identity',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const first=await h.step([msg]);h.a.correct({id:'one',text:'DMA completion now requires another barrier.',sourceVersion:'v2',expectedGeneration:h.a.generation()});const current=await h.step([msg]);assert.equal(own(current).length,1);assert.notEqual(own(current)[0].id,own(first)[0].id);assert.ok(!own(current)[0].content[0].text.includes('is established'));
});

test('only an exact self-commit receipt suppresses reentry and never enqueues the recalled content',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const first=await h.step([msg]),recall=own(first)[0];const fake=freeze({...recall,content:[{type:'text',text:'different body'}]});h.session.append(fake);await h.hooks.drain();assert.equal(own(await h.step([msg])).length,1);
 h.session.append(recall);await h.hooks.drain();assert.equal(own(await h.step([msg])).length,0);assert.deepEqual((await h.step([msg],()=>Promise.resolve({kind:'enter',messages:[msg,recall]}))).messages,[msg]);assert.deepEqual(h.rows(),{jobs:0,budget:0});
});

test('same-root sibling fibers and a second module copy cannot install duplicate writers',async t=>{
 const h=await setup(t),sibling={...h.ctx};assert.throws(()=>h.install(sibling),/already installed/);const {installSessionHooks}=await import('../plugin/session-hooks.mjs?second-copy');assert.throws(()=>installSessionHooks(sibling,h.options),/already installed/);
 const old=h.hooks,closing=old.dispose();const current=h.install(sibling);h.hooks=current;await closing;await old.dispose();const msg=input();h.grant(msg);h.session.append(msg);await current.drain();assert.deepEqual(h.rows(),{jobs:1,budget:1});
});

test('dispose drops not-yet-admitted material and late callbacks but reports durable queued material retained',async t=>{
 const h=await setup(t),first=input();h.grant(first);h.session.append(first);await h.hooks.drain();const next=input('message-2');h.grant(next);h.session.append(next);const receipt=await h.hooks.dispose();h.session.append(input('late'));await h.hooks.drain();assert.equal(receipt.queuedInputs,'retained_by_queue');assert.deepEqual(h.rows(),{jobs:1,budget:1});assert.equal(h.inputs(),1);
});

test('retrieval or authorization failures never return a previous recalled body or raw diagnostic error',async t=>{
 const h=await setup(t,{diagnostic(){return Promise.reject(new Error('password=CANARY_ERROR'));}}),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const first=await h.step([msg]);writeFileSync(join(h.rootPath,'authority.identity.json'),'invalid-local-authority');
 const result=await h.step([msg],async()=>({kind:'enter',messages:[msg,...own(first)]}));h.session.append(input('unavailable'));await h.hooks.drain();assert.equal(own(result).length,0);assert.ok(h.diagnostics.length>0);assert.ok(!JSON.stringify(h.diagnostics).includes('CANARY'));
});

test('non-canonical session IDs and asynchronous authority callbacks fail closed',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.resolveScope=()=>Promise.reject(new Error('CANARY scope detail'));h.session.append(msg);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});h.resolveScope=()=>({scopeRef:'scope-A',store:h.a,queue:h.qa,routeRef:'registered-A',generation:h.a.generation(),authorizationVersion:h.version});h.admitMessage=()=>Promise.reject(new Error('CANARY permission'));h.session.append(input('message-2'));await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});
 const wrong={...h.session,id:'session-A/sub'};h.sessions.set(wrong.id,wrong);h.agents.set(wrong.id,{id:wrong.id,session:wrong});h.ctx.emit('session/event',wrong,{type:'user/message',seq:0,data:msg,surfaceOp:'append'});await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:0,budget:0});
});

test('partial installation failure removes every listener and does not reserve the owner',async t=>{
 const h=await setup(t);await h.hooks.dispose();let calls=0;
 assert.throws(()=>h.install({...h.ctx,on(name,fn){if(++calls===2)throw new Error('CANARY registration detail');return h.ctx.on(name,fn);}}),/could not be registered/);
 assert.equal([...h.listeners.values()].reduce((n,set)=>n+set.size,0),0);h.hooks=h.install();const msg=input();h.grant(msg);h.session.append(msg);await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:1,budget:1});
});

test('pending capacity, cumulative body size and expired admission do not create extra jobs',async t=>{
 const h=await setup(t,{limits:{maxPending:1}});for(const id of ['one','two']){const msg=input(id);h.grant(msg);h.session.append(msg);}await h.hooks.drain();assert.deepEqual(h.rows(),{jobs:1,budget:1});
 const small=await setup(t,{limits:{maxPendingChars:5}}),msg=input();small.grant(msg);small.session.append(msg);await small.hooks.drain();assert.deepEqual(small.rows(),{jobs:0,budget:0});
 const expired=await setup(t,{limits:{admissionTtlMs:1}}),late=input();expired.grant(late);expired.session.append(late);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);await expired.hooks.drain();assert.deepEqual(expired.rows(),{jobs:0,budget:0});
});

test('recall bounds skip whole records and never search work summaries or session history',async t=>{
 const h=await setup(t,{limits:{maxRecallChars:30}}),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));h.session.snapshotEvents=()=>assert.fail('History must not be scanned');assert.equal(own(await h.step([msg])).length,0);
 const separate=await setup(t),current=input();separate.grant(current);createWorkSummaryManager(separate.a).save({requestId:'annual-only',draft:draft({title:'DMA completion boundary'}),sources:[{sourceRef:'manual-work',sourceVersion:'v1',fragmentRef:'whole'}]});assert.equal(own(await separate.step([current])).length,0);
});

test('evicted recall metadata does not retain body or reuse a different cached message identity',async t=>{
 const h=await setup(t,{limits:{maxCacheEntries:1}}),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));const first=await h.step([msg]);await h.step([msg],undefined,{step:2});assert.equal(h.hooks.status().cacheEntries,1);const repeat=await h.step([msg]);assert.notEqual(own(first)[0].id,own(repeat)[0].id);assert.equal(h.hooks.status().cacheEntries,1);
});

test('an asynchronous rejected message factory is observed and cannot leak its raw failure',async t=>{
 const h=await setup(t),msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion boundary is established.'}));await h.hooks.dispose();h.hooks=h.install(h.ctx,{...h.options,createUserMessage:()=>Promise.reject(new Error('CANARY factory detail'))});
 const decision=await h.step([msg]);assert.equal(own(decision).length,0);await new Promise(resolve=>setImmediate(resolve));assert.ok(!JSON.stringify(h.diagnostics).includes('CANARY'));
});

test('configuration cannot enlarge the promised recall or admission lifetime bounds',async t=>{
 const h=await setup(t);await h.hooks.dispose();assert.throws(()=>h.install(h.ctx,{...h.options,limits:{maxRecallChars:4001}}),/Invalid/);assert.throws(()=>h.install(h.ctx,{...h.options,limits:{admissionTtlMs:1001}}),/Invalid/);h.hooks=h.install();
 const msg=input();h.grant(msg);h.a.put(memory({text:'DMA completion '+ 'x'.repeat(5000)}));assert.equal(own(await h.step([msg])).length,0);
});
