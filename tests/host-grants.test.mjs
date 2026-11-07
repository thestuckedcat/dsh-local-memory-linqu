import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {fixture,extraction} from './helpers.mjs';
import {openStore} from '../src/backend.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {fingerprint} from '../src/validation.mjs';
import {createHostGrants} from '../plugin/host-grants.mjs';

const SCOPE='scope-A',SESSION_ID='session-A',MESSAGE_ID='message-1',RPC_ID='rpc-1';
const CONTENT_HASH='a'.repeat(64),INPUT_DIGEST='b'.repeat(64),PAYLOAD_DIGEST='e'.repeat(64);
const SESSION_REF=`${SESSION_ID}/${'d'.repeat(64)}`;
const SOURCE_REF=`${SESSION_REF}/event/1/message/${fingerprint(MESSAGE_ID)}`;
const INPUT='The user established the completion boundary.';
const EXECUTION_ROUTE=Object.freeze({routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'bridge-1'});
const DENIED='Current memory authorization unavailable';

function makeConfig(overrides={}){
 return {
  configDigest:'config-digest-1',
  routes:[{routeRef:'registered-A',provider:'provider-A',model:'model-A'}],
  extraction:{enabled:true,routeRef:'registered-A'},
  recall:{enabled:true},
  workSummary:{enabled:true,routeRef:'registered-A'},
  scheduler:{pollMs:1000,concurrency:1,jobTimeoutMs:1000,recoverOnStart:true},
  limits:{},
  ...overrides,
 };
}
function liveHost(){
 const sessions=new Map(),agents=new Map();
 const session={id:SESSION_ID,header:{id:SESSION_ID,version:4,createdAt:1,cwd:'C:\\code\\example'}};
 const agent={id:SESSION_ID,session};
 sessions.set(SESSION_ID,session);agents.set(SESSION_ID,agent);
 return {sessions,agents,session,agent,services:{sessions:{get:id=>sessions.get(id)},agents:{get:id=>agents.get(id)}}};
}
function projectState({projectState='active',preferences={extract:true,recall:true}}={}){
 const project={projectId:'project-1',name:'example',state:projectState,revision:2};
 const binding={projectId:'project-1',projectRevision:2,projectState,repoId:'main',canonicalRoot:'C:\\code\\example',worktreeRoot:'C:\\code\\example',revision:'workspace',buildVariant:'win-node26',scopeRef:SCOPE,bindingRevision:1};
 const state={project,binding,preferences};
 const registry={
  bindingForSession:()=>state.binding,
  bindingForScope:scopeRef=>scopeRef===state.binding.scopeRef?state.binding:undefined,
  preferencesForScope:scopeRef=>scopeRef===state.binding.scopeRef?Object.freeze({project:state.project,preferences:Object.freeze({...state.preferences})}):undefined,
 };
 return {state,registry};
}
function setup(t,{config=makeConfig(),project={},clock=Date.parse('2026-11-07T00:00:00Z'),onDiagnostic}={}){
 const host=liveHost(),view=projectState(project),time={now:clock};
 const options={config,registry:view.registry,sessions:host.services.sessions,agents:host.services.agents,now:()=>new Date(time.now)};
 if(onDiagnostic!==undefined)options.onDiagnostic=onDiagnostic;
 const grants=createHostGrants(options);
 return {host,view,config,grants,time};
}
const admission=(grants,extra={})=>({action:'extract',scopeRef:SCOPE,sessionId:SESSION_ID,sessionRef:SESSION_REF,messageId:MESSAGE_ID,rpcId:RPC_ID,contentHash:CONTENT_HASH,authorizationVersion:grants.currentAuthorizationVersion(),...extra});
const executionMetadata=(grant,extra={})=>({jobId:'job-1',scopeRef:SCOPE,payloadFingerprint:PAYLOAD_DIGEST,purpose:'memory_extract',sessionRef:SESSION_REF,sourceRef:SOURCE_REF,sourceVersion:fingerprint({originRef:grant.originRef,contentHash:grant.contentHash}),fragmentRef:'user-text-v1',inputClass:'conversation_fragment',inputDigest:INPUT_DIGEST,generation:0,route:EXECUTION_ROUTE,itemRef:null,phase:'claim',...extra});

test('admission requires a live session, matching agent and active registered scope',t=>{
 const {host,view,grants}=setup(t);
 assert.throws(()=>grants.admitMessage(admission(grants,{sessionId:'missing'})),new RegExp(DENIED));
 host.sessions.delete(SESSION_ID);assert.throws(()=>grants.admitMessage(admission(grants)),new RegExp(DENIED));
 host.sessions.set(SESSION_ID,host.session);host.agents.set(SESSION_ID,{id:SESSION_ID,session:{id:'other'}});assert.throws(()=>grants.admitMessage(admission(grants)),new RegExp(DENIED));
 host.agents.set(SESSION_ID,host.agent);
 view.state.binding={...view.state.binding,scopeRef:'scope-B'};assert.throws(()=>grants.admitMessage(admission(grants)),new RegExp(DENIED));
 view.state.binding={...view.state.binding,scopeRef:SCOPE,projectState:'retired'};view.state.project={...view.state.project,state:'retired'};assert.throws(()=>grants.admitMessage(admission(grants)),new RegExp(DENIED));
});
test('admission honors project preferences and the global enable switch',t=>{
 const off=setup(t,{project:{preferences:{extract:false,recall:true}}});
 assert.throws(()=>off.grants.admitMessage(admission(off.grants)),new RegExp(DENIED));
 off.view.state.preferences={extract:true,recall:false};
 assert.equal(off.grants.admitMessage(admission(off.grants)).authorizationVersion,off.grants.currentAuthorizationVersion());
 assert.throws(()=>off.grants.admitMessage(admission(off.grants,{action:'recall'})),new RegExp(DENIED));
 const noExtract=setup(t,{config:makeConfig({extraction:{enabled:false,routeRef:'registered-A'}})});
 assert.throws(()=>noExtract.grants.admitMessage(admission(noExtract.grants)),new RegExp(DENIED));
 const noRecall=setup(t,{config:makeConfig({recall:{enabled:false}})});
 assert.throws(()=>noRecall.grants.admitMessage(admission(noRecall.grants,{action:'recall'})),new RegExp(DENIED));
});
test('admission refuses an unapproved extraction route and non-canonical session references',t=>{
 const noRoute=setup(t,{config:makeConfig({routes:[]})});
 assert.throws(()=>noRoute.grants.admitMessage(admission(noRoute.grants)),new RegExp(DENIED));
 const h=setup(t);assert.throws(()=>h.grants.admitMessage(admission(h.grants,{sessionRef:'other/abc'})),new RegExp(DENIED));
});
test('admission is idempotent for the same message and rotates on edited content',t=>{
 const {grants}=setup(t),first=grants.admitMessage(admission(grants)),second=grants.admitMessage(admission(grants));
 assert.equal(second.originRef,first.originRef);assert.equal(second.contentHash,first.contentHash);assert.ok(second.originRef.startsWith('admission-v1:'));
 const edited=grants.admitMessage(admission(grants,{contentHash:'f'.repeat(64)}));assert.notEqual(edited.originRef,first.originRef);
});
test('authorizeExecution needs a receipt and returns one stable lease signal across phases',t=>{
 const {grants}=setup(t);
 assert.throws(()=>grants.authorizeExecution(executionMetadata({originRef:'none',contentHash:CONTENT_HASH})),new RegExp(DENIED));
 const grant=grants.admitMessage(admission(grants)),claim=grants.authorizeExecution(executionMetadata(grant));
 assert.equal(claim.authorizationVersion,grants.currentAuthorizationVersion());assert.equal(Object.isFrozen(claim),true);
 assert.equal(typeof claim.signal.addEventListener,'function');assert.equal(claim.signal.aborted,false);
 for(const phase of ['dispatch','commit','commit-complete']){const again=grants.authorizeExecution(executionMetadata(grant,{phase}));assert.equal(again.signal,claim.signal);assert.equal(again.authorizationVersion,claim.authorizationVersion);}
});
test('a receipt cannot be rebound to another scope, session or source version',t=>{
 const {grants}=setup(t),grant=grants.admitMessage(admission(grants));
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{scopeRef:'scope-B'})),new RegExp(DENIED));
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{sessionRef:`${SESSION_ID}/${'9'.repeat(64)}`})),new RegExp(DENIED));
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{sourceVersion:fingerprint({originRef:grant.originRef,contentHash:'0'.repeat(64)})})),new RegExp(DENIED));
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{payloadFingerprint:'not-a-digest'})),new RegExp(DENIED));
});
test('a recorded input digest must equal the execution input digest',t=>{
 const {grants}=setup(t),grant=grants.admitMessage(admission(grants,{inputDigest:INPUT_DIGEST}));
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{inputDigest:'0'.repeat(64)})),new RegExp(DENIED));
 assert.equal(grants.authorizeExecution(executionMetadata(grant)).signal.aborted,false);
});
test('a changed Provider route between admission and execution is refused',t=>{
 let approved={routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'config-v1'};
 const {grants}=setup(t,{config:makeConfig({routeApproval:()=>approved})}),grant=grants.admitMessage(admission(grants));
 assert.equal(grants.authorizeExecution(executionMetadata(grant)).signal.aborted,false);
 approved={routeRef:'registered-A',provider:'provider-B',model:'model-B',routeVersion:'config-v2'};
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{phase:'dispatch'})),new RegExp(DENIED));
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{jobId:'job-2'})),new RegExp(DENIED));
});
test('revocation aborts the live lease and permanently denies new work',t=>{
 const {grants}=setup(t),grant=grants.admitMessage(admission(grants)),lease=grants.authorizeExecution(executionMetadata(grant)),before=grants.currentAuthorizationVersion();
 assert.equal(lease.signal.aborted,false);
 grants.revoke('plugin_disposed');
 assert.equal(lease.signal.aborted,true);assert.notEqual(grants.currentAuthorizationVersion(),before);assert.equal(grants.status().revoked,true);
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant)),new RegExp(DENIED));
 assert.throws(()=>grants.admitMessage(admission(grants)),new RegExp(DENIED));
 grants.revoke('again');assert.equal(grants.currentAuthorizationVersion(),grants.status().authorizationVersion);
});
test('one receipt authorizes one lease per purpose and never a second job identity',t=>{
 const {grants}=setup(t),grant=grants.admitMessage(admission(grants));
 assert.equal(grants.authorizeExecution(executionMetadata(grant,{jobId:'job-1'})).signal.aborted,false);
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{jobId:'job-2'})),new RegExp(DENIED));
 assert.equal(grants.authorizeExecution(executionMetadata(grant,{jobId:'job-1',purpose:'work_summary_extract'})).signal.aborted,false);
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant,{jobId:'job-2',purpose:'work_summary_extract'})),new RegExp(DENIED));
});
test('annual merges require a live user confirmation for the selected item',t=>{
 const {grants}=setup(t);
 const merge=extra=>executionMetadata({originRef:'none',contentHash:'c'.repeat(64)},{purpose:'work_summary_merge',itemRef:'work-item-1',sourceVersion:'manual-source-1',inputDigest:'f'.repeat(64),...extra});
 assert.throws(()=>grants.authorizeExecution(merge()),new RegExp(DENIED));
 grants.noteUserConfirmation({action:'work_summary_merge',scopeRef:SCOPE,itemRef:'work-item-2'});
 assert.throws(()=>grants.authorizeExecution(merge()),new RegExp(DENIED));
 const confirmation=grants.noteUserConfirmation({action:'work_summary_merge',scopeRef:SCOPE,itemRef:'work-item-1'});
 assert.ok(confirmation.confirmationRef.startsWith('confirmation-v1:'));
 assert.equal(grants.authorizeExecution(merge()).signal.aborted,false);
 assert.throws(()=>grants.authorizeExecution(merge({jobId:'job-2'})),new RegExp(DENIED));
});
test('receipts expire after 24 hours and unknown purposes fail closed',t=>{
 const {grants,time}=setup(t),grant=grants.admitMessage(admission(grants));
 time.now+=24*60*60*1000+1;
 assert.throws(()=>grants.authorizeExecution(executionMetadata(grant)),new RegExp(DENIED));
 assert.throws(()=>grants.authorizeExecution(executionMetadata({originRef:'x',contentHash:CONTENT_HASH},{purpose:'arbitrary'})),new RegExp(DENIED));
});
test('authorizeRecovery only accepts a recent user confirmation for the exact unknown job',t=>{
 const {grants,time}=setup(t);
 assert.equal(grants.authorizeRecovery({action:'confirmRemoteQuiescence',scopeRef:SCOPE,jobId:'job-unknown',status:'remote_finished',confirmationRef:'unknown'}),false);
 const {confirmationRef}=grants.noteUserConfirmation({action:'recovery.confirm',scopeRef:SCOPE,jobId:'job-unknown',status:'remote_finished'});
 const valid={action:'confirmRemoteQuiescence',scopeRef:SCOPE,jobId:'job-unknown',status:'remote_finished',confirmationRef};
 assert.equal(grants.authorizeRecovery(valid),true);assert.equal(grants.authorizeRecovery(valid),false);
 const second=grants.noteUserConfirmation({action:'recovery.confirm',scopeRef:SCOPE,jobId:'job-unknown',status:'remote_finished'}).confirmationRef;
 assert.equal(grants.authorizeRecovery({...valid,confirmationRef:second,jobId:'other-job'}),false);
 assert.equal(grants.authorizeRecovery({...valid,confirmationRef:second,status:'remote_cancel_confirmed'}),false);
 const expired=grants.noteUserConfirmation({action:'recovery.confirm',scopeRef:SCOPE,jobId:'job-unknown',status:'remote_finished'}).confirmationRef;
 time.now+=2*60*1000+1;assert.equal(grants.authorizeRecovery({...valid,confirmationRef:expired}),false);
 const merge=grants.noteUserConfirmation({action:'work_summary_merge',scopeRef:SCOPE,itemRef:'work-item-1'}).confirmationRef;
 assert.equal(grants.authorizeRecovery({...valid,confirmationRef:merge}),false);
});
test('status is bounded metadata and callbacks cannot leak secret details',async t=>{
 const rows=[];const {grants}=setup(t,{onDiagnostic:entry=>{rows.push(entry);throw new Error('CANARY diagnostic detail');}});
 assert.throws(()=>grants.admitMessage(admission(grants,{sessionId:'missing'})),error=>error.message===DENIED);
 const status=grants.status();
 assert.deepEqual(Object.keys(status).sort(),['authorizationVersion','leases','manualConfirmations','receipts','recoveryConfirmations','revoked','state'].sort());
 assert.equal(JSON.stringify(status).includes('CANARY'),false);assert.ok(rows.length>=1);assert.equal(JSON.stringify(rows).includes('CANARY'),false);
 await turn();
});
function queueSetup(t,{config=makeConfig()}={}){
 const f=fixture(t),host=liveHost(),view=projectState(),store=f.track(openStore(f.root,{scopeRef:SCOPE})),calls={n:0};
 const grants=createHostGrants({config,registry:view.registry,sessions:host.services.sessions,agents:host.services.agents});
 const provider=createControlledProvider({resolveRoute:()=>EXECUTION_ROUTE,invoke:async()=>{calls.n++;return extraction();}});
 const queue=createJobQueue(store,{provider,authorizeExecution:metadata=>grants.authorizeExecution(metadata),authorizeRecovery:args=>grants.authorizeRecovery(args)});
 return {f,host,view,store,grants,provider,queue,calls,config};
}
function enqueueExtract(queue,store,grant,{sourceVersion=fingerprint({originRef:grant.originRef,contentHash:grant.contentHash}),purpose='memory_extract'}={}){
 return queue.enqueue({requestId:`hook-v1:${fingerprint({session:SESSION_REF,message:MESSAGE_ID,purpose})}`,scopeRef:SCOPE,sessionRef:SESSION_REF,sourceRef:SOURCE_REF,sourceVersion,fragmentRef:'user-text-v1',inputRef:`${SOURCE_REF}/text`,inputClass:'conversation_fragment',input:INPUT,routeRef:'registered-A',generation:store.generation(),purpose});
}
test('end to end: an admitted current message completes one authorized extraction',async t=>{
 const h=queueSetup(t),grant=h.grants.admitMessage(admission(h.grants)),saved=enqueueExtract(h.queue,h.store,grant);
 const result=await h.queue.runJob(saved.jobId);
 assert.equal(result.state,'completed');assert.equal(h.calls.n,1);assert.equal(h.store.list().length,1);assert.equal(h.grants.status().leases,1);
});
test('queue integration: missing receipt, revocation, changed route and wrong source identity keep zero dispatch',async t=>{
 const cases=[
  {name:'missing receipt',prepare:()=>({originRef:'admission-v1:absent',contentHash:CONTENT_HASH})},
  {name:'revoked',prepare:h=>{const grant=h.grants.admitMessage(admission(h.grants));h.grants.revoke('test');return grant;}},
  {name:'changed route',prepare:h=>{const grant=h.grants.admitMessage(admission(h.grants));h.setApproved({routeRef:'registered-A',provider:'provider-B',model:'model-B',routeVersion:'config-v2'});return grant;}},
  {name:'wrong input digest',prepare:h=>h.grants.admitMessage(admission(h.grants,{inputDigest:'0'.repeat(64)}))},
  {name:'wrong source version',prepare:h=>h.grants.admitMessage(admission(h.grants)),sourceVersion:'2'.repeat(64)},
 ];
 for(const item of cases){
  let approved={routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'config-v1'};
  const config=makeConfig({routeApproval:()=>approved});
  const h=queueSetup(t,{config}),setApproved=value=>{approved=value;};
  const grant=item.prepare({grants:h.grants,setApproved});
  const enqueueOptions=item.name==='wrong source version'?{sourceVersion:item.sourceVersion}:{};
  const saved=enqueueExtract(h.queue,h.store,grant,enqueueOptions);
  const result=await h.queue.runJob(saved.jobId);
  assert.equal(h.calls.n,0,item.name);assert.equal(result.costStatus,'not_dispatched',item.name);assert.equal(result.state,'failed',item.name);assert.deepEqual(h.store.list(),[],item.name);
 }
});
