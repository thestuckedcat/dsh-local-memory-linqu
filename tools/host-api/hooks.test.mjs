import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {fixture,memory,authorizeTestExecution} from '../../tests/helpers.mjs';
import {fingerprint} from '../../src/validation.mjs';
import {openStore} from '../../src/backend.mjs';
import {createJobQueue} from '../../src/jobs.mjs';
import {createHarnessProviderBridge} from '../../plugin/harness-provider.mjs';
import {installSessionHooks} from '../../plugin/session-hooks.mjs';

const root=process.env.DSH_AUDIT_APP_ROOT;assert.equal(root,'E:/dsh/resources/app.asar/dsh');
const host=name=>import(pathToFileURL(`${root}/node_modules/@deepseek-ai/${name}/lib/index.js`).href);
const {Context}=await host('cordis'),sdk=await host('dsh-llm'),{SessionStore}=await host('dsh-session'),{AgentRegistry,agentEvents}=await host('dsh-agent');
const hash=m=>fingerprint({id:m.id,role:m.role,rpcId:m.source.rpcId,content:m.content});

async function setup(t){
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'native-hooks-A'})),other=f.track(openStore(f.root,{scopeRef:'native-hooks-B'})),ctx=new Context();
 await ctx.plugin(SessionStore);await ctx.plugin(AgentRegistry);await ctx.plugin(sdk.LlmRuntime);
 let calls=0;class Adapter extends sdk.LlmAdapter{async *stream(){calls++;yield {type:'text-delta',index:0,text:JSON.stringify({schema_version:1,memories:[{kind:'lesson',text:'DMA completion precedes ownership reclamation.'}]})};yield {type:'finish',reason:{kind:'stop'}};}}
 ctx.llm.registerAdapter(['provider-A'],new Adapter());
 const providerBridge=createHarnessProviderBridge({ctx,sdk,readApprovedRoute:()=>({routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'native-approval'}),cleanupBudgetMs:5});
 const queue=createJobQueue(store,{authorizeExecution:authorizeTestExecution,provider:providerBridge.provider}),otherQueue=createJobQueue(other,{authorizeExecution:authorizeTestExecution,provider:providerBridge.provider});
 const session=ctx.sessions.create('native-hooks-session',{meta:{cwd:'E:/dsh/plugin'}}),agent={id:session.id,session};const detach=ctx.agents.enter(agent);ctx.effect(()=>detach,'native hook fixture agent');
 const grants=new Map(),h={ctx,store,other,queue,session,agent,calls:()=>calls,allowed:true,selected:store,authorizationVersion:'grant-1'};
 h.message=(text='DMA completion boundary')=>sdk.createUserMessage({content:[{type:'text',text}],source:{kind:'user',rpcId:`native-rpc-${grants.size}`}});
 h.grant=m=>grants.set(m.id,{scopeRef:h.selected.scopeRef,hash:hash(m),rpcId:m.source.rpcId});
 h.options={createUserMessage:sdk.createUserMessage,resolveScope:()=>({scopeRef:h.selected.scopeRef,store:h.selected,queue:h.selected===store?queue:otherQueue,routeRef:'registered-A',generation:h.selected.generation(),authorizationVersion:h.authorizationVersion}),admitMessage:args=>{const grant=grants.get(args.messageId);return h.allowed&&grant?.scopeRef===args.scopeRef&&grant.hash===args.contentHash&&grant.rpcId===args.rpcId?{originRef:`native-rpc:${args.rpcId}`,contentHash:grant.hash,authorizationVersion:h.authorizationVersion}:undefined;},limits:{cleanupBudgetMs:5}};
 let hooks;const fiber=ctx.plugin({inject:['sessions','agents'],apply(c){hooks=installSessionHooks(c,h.options);}});await fiber;h.hooks=hooks;h.fiber=fiber;
 h.step=(messages,next=()=>Promise.resolve({kind:'enter',messages,custom:'native-preserved'}))=>agentEvents(ctx,agent).waterfall('agent/pre-step',{messages,turn:1,step:1,signal:new AbortController().signal},next);
 h.ids=()=>{const db=new DatabaseSync(join(f.root,'authority.sqlite'),{readOnly:true});try{return db.prepare('SELECT id FROM jobs ORDER BY created_at,id').all().map(row=>row.id);}finally{db.close();}};
 t.after(()=>ctx.fiber.dispose());return h;
}
const own=decision=>decision.messages.filter(m=>m.source?.kind==='memory-recall'&&m.source.plugin==='@local/dsh-controlled-memory');

test('real accepted Session events enqueue once and the hook never dispatches a Provider by itself',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);const event=h.session.append('user/message',msg,{surfaceOp:'append'});assert.equal(h.session.eventAt(event.seq),event);h.ctx.emit('session/event',h.session,event);await h.hooks.drain();assert.equal(h.ids().length,1);assert.equal(h.calls(),0);
 // A separate trusted test driver executes the observed job; this is not hook auto-scheduling.
 assert.equal((await h.queue.runJob(h.ids()[0])).state,'completed');assert.equal(h.store.list().length,1);assert.equal(h.calls(),1);
});

test('real pre-step rejection or removal preserves its decision and produces no queued job',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);h.store.put(memory({text:'DMA completion boundary is established.'}));const rejected={kind:'reject'};assert.equal(await h.step([msg],()=>Promise.resolve(rejected)),rejected);assert.equal(own(await h.step([msg],()=>Promise.resolve({kind:'enter',messages:[]}))).length,0);await h.hooks.drain();assert.equal(h.ids().length,0);
});

test('real SDK recall source is separate from loop runtime context and self-commit is never extracted',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);h.store.put(memory({text:'DMA completion boundary is established.'}));const result=await h.step([msg]);assert.equal(result.custom,'native-preserved');const recalled=own(result)[0];assert.equal(recalled.source.kind,'memory-recall');assert.ok(Object.isFrozen(recalled));assert.ok(recalled.content[0].text.includes('is established'));
 const event=h.session.append('user/message',recalled,{surfaceOp:'append'});await h.hooks.drain();assert.equal(h.ids().length,0);assert.equal(own(await h.step([msg])).length,0);assert.equal(h.session.surface.nodes.length,1);
 const reentered=await h.step([msg],()=>Promise.resolve({kind:'enter',messages:[msg,recalled]}));assert.deepEqual(reentered.messages,[msg]);assert.equal(h.session.surface.nodes.length,1);assert.equal(h.session.surface.deriveEventMessage(event).id,recalled.id);assert.equal(h.calls(),0);
});

test('live scope changes before deferred admission do not write into the other scope',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);h.session.append('user/message',msg,{surfaceOp:'append'});h.selected=h.other;await h.hooks.drain();assert.equal(h.ids().length,0);assert.equal(h.store.list().length,0);assert.equal(h.other.list().length,0);
});

test('actual fiber teardown drops deferred events and leaves no duplicate owner after replacement',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);h.session.append('user/message',msg,{surfaceOp:'append'});await h.hooks.dispose();await h.fiber.dispose();assert.equal(h.ids().length,0);
 let current;const fiber=h.ctx.plugin({inject:['sessions','agents'],apply(c){current=installSessionHooks(c,h.options);}});await fiber;await h.hooks.dispose();const next=h.message();h.grant(next);h.session.append('user/message',next,{surfaceOp:'append'});await current.drain();assert.equal(h.ids().length,1);
});

test('actual warm recall is removed from the next returned decision after forget',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);h.store.put(memory({text:'DMA completion boundary is established.'}));const first=await h.step([msg]);h.store.forget({id:'one',expectedGeneration:h.store.generation()});const next=await h.step([msg],()=>Promise.resolve({kind:'enter',messages:[msg,...own(first)]}));assert.equal(own(next).length,0);assert.ok(!JSON.stringify(next).includes('is established'));
});

test('native same-ID edited appends cannot create an additional extraction reservation',async t=>{
 const h=await setup(t),msg=h.message();h.grant(msg);h.session.append('user/message',msg,{surfaceOp:'append'});await h.hooks.drain();const edited=sdk.freezeMessage({...msg,content:[{type:'text',text:'DMA completion changed'}]});h.grant(edited);h.session.append('user/message',edited,{surfaceOp:'append'});await h.hooks.drain();assert.equal(h.ids().length,1);assert.equal(h.calls(),0);
});

test('the hook installed-library cases never invoke the covered network API sinks',()=>{
 assert.deepEqual(globalThis[Symbol.for('local-memory.host-audit.network-attempts')],[]);
});
