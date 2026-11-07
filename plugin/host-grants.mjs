import {randomUUID} from 'node:crypto';
import {checkedText} from '../src/scope.mjs';
import {shape,fingerprint,integer} from '../src/validation.mjs';
import {PURPOSES} from '../src/provider.mjs';
import {routeApproval,routeRefFor} from './configuration.mjs';

const RECEIPT_TTL_MS=24*60*60*1000,CONFIRMATION_TTL_MS=2*60*1000,LEASE_IDLE_MS=15*60*1000;
const RECEIPT_LIMIT=2048,LEASE_LIMIT=1024,CONFIRMATION_LIMIT=128;
const AUTOMATIC_PURPOSES=Object.freeze(['memory_extract','work_summary_extract']);
const MANUAL_PURPOSES=Object.freeze(['work_summary_merge']);
const EXECUTION_PHASES=Object.freeze(['claim','dispatch','commit','commit-complete']);
const EXECUTION_FIELDS=Object.freeze(['jobId','scopeRef','payloadFingerprint','purpose','sessionRef','sourceRef','sourceVersion','fragmentRef','inputClass','inputDigest','generation','route','itemRef','phase']);
const ADMISSION_FIELDS=Object.freeze(['action','scopeRef','sessionId','sessionRef','messageId','rpcId','contentHash','inputDigest','authorizationVersion','eventSeq']);
const SOURCE_PATTERN=/^(.+)\/event\/(\d+)\/message\/([a-f0-9]{64})$/;
const HEX=/^[a-f0-9]{64}$/;
const denied=()=>new Error('Current memory authorization unavailable');
const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;

/**
 * Admission receipts, execution leases, revocation and user-confirmed recovery.
 * Every check is synchronous and fail closed; no secret or scope value is echoed in an error.
 */
export function createHostGrants({config,registry,sessions,agents,onDiagnostic=()=>{},now=()=>new Date()}={}){
 if(!isPlain(config))throw new Error('Normalized memory configuration required');
 if(!registry||['bindingForSession','bindingForScope','preferencesForScope'].some(key=>typeof registry[key]!=='function'))throw new Error('Trusted project registry required');
 if(!sessions||typeof sessions.get!=='function'||!agents||typeof agents.get!=='function')throw new Error('Trusted live session/agent services required');
 if(typeof onDiagnostic!=='function'||typeof now!=='function')throw new Error('Trusted grant services required');
 const approveRoute=typeof config.routeApproval==='function'?config.routeApproval:routeApproval(config);
 const receipts=new Map(),sources=new Map(),leases=new Map(),confirmations=new Map();
 const activation=randomUUID();let state='active',counter=1;
 const version=()=>`grant-v1:${activation}:${counter}`;
 function diagnostic(code){try{const value=onDiagnostic(Object.freeze({code}));if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});}catch{/* diagnostics never alter authorization */}}
 function clock(){const instant=now();if(!(instant instanceof Date)||Number.isNaN(+instant))throw denied();return +instant;}
 function approvalOf(routeRef){
  try{
   const value=approveRoute(checkedText(routeRef,'route reference',512));
   if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});throw denied();}
   shape(value,['routeRef','provider','model','routeVersion'],'approved route');
   const route={routeRef:checkedText(value.routeRef,'route reference',512),provider:checkedText(value.provider,'route provider',512),model:checkedText(value.model,'route model',512),routeVersion:checkedText(value.routeVersion,'route version',512)};
   if(route.routeRef!==routeRef)throw denied();
   return route;
  }catch{throw denied();}
 }
 function expectedRouteRef(purpose){try{const routeRef=routeRefFor(config,purpose);if(typeof routeRef!=='string'||!routeRef)throw denied();return routeRef;}catch{throw denied();}}
 function prune(instant){
  for(const [key,receipt] of receipts)if(instant-receipt.createdAt>RECEIPT_TTL_MS)receipts.delete(key);
  for(const [sourceKey,receiptKey] of sources)if(!receipts.has(receiptKey))sources.delete(sourceKey);
  while(receipts.size>RECEIPT_LIMIT)receipts.delete(receipts.keys().next().value);
  for(const [sourceKey,receiptKey] of sources)if(!receipts.has(receiptKey))sources.delete(sourceKey);
  for(const [ref,entry] of confirmations)if(entry.consumed||instant-entry.createdAt>CONFIRMATION_TTL_MS)confirmations.delete(ref);
  while(confirmations.size>CONFIRMATION_LIMIT)confirmations.delete(confirmations.keys().next().value);
  for(const [key,lease] of leases)if(instant-lease.lastUsedAt>LEASE_IDLE_MS)leases.delete(key);
 }
 function parseSourceRef(sourceRef){const match=SOURCE_PATTERN.exec(sourceRef);return match===null?undefined:Object.freeze({sessionRef:match[1],messageDigest:match[3]});}
 function checkScope(scopeRef){const binding=registry.bindingForScope(scopeRef);if(!binding||binding.projectState!=='active')throw denied();}
 function checkRoute(claim){
  const routeRef=expectedRouteRef(claim.purpose);
  if(claim.route.routeRef!==routeRef)throw denied();
  const approved=approvalOf(routeRef);
  if(approved.provider!==claim.route.provider||approved.model!==claim.route.model)throw denied();
 }
 function claimOf(metadata){
  shape(metadata,EXECUTION_FIELDS,'execution metadata');
  const purpose=metadata.purpose;
  if(!PURPOSES.includes(purpose)||(!AUTOMATIC_PURPOSES.includes(purpose)&&!MANUAL_PURPOSES.includes(purpose)))throw denied();
  const phase=metadata.phase;if(!EXECUTION_PHASES.includes(phase))throw denied();
  const jobId=checkedText(metadata.jobId,'job ID',256),scopeRef=checkedText(metadata.scopeRef,'scope',2048);
  const sessionRef=checkedText(metadata.sessionRef,'session reference',512),sourceRef=checkedText(metadata.sourceRef,'source reference',2048),sourceVersion=checkedText(metadata.sourceVersion,'source version',512),fragmentRef=checkedText(metadata.fragmentRef,'fragment reference',512);
  if(!['conversation_fragment','user_summary'].includes(metadata.inputClass))throw denied();
  const inputDigest=checkedText(metadata.inputDigest,'input digest',64),payloadFingerprint=checkedText(metadata.payloadFingerprint,'payload digest',64);
  if(!HEX.test(inputDigest)||!HEX.test(payloadFingerprint))throw denied();
  integer(metadata.generation,0,Number.MAX_SAFE_INTEGER,'generation');
  shape(metadata.route,['routeRef','provider','model','routeVersion'],'execution route');
  const route=Object.freeze({routeRef:checkedText(metadata.route.routeRef,'route reference',512),provider:checkedText(metadata.route.provider,'route provider',512),model:checkedText(metadata.route.model,'route model',512)});
  const itemRef=metadata.itemRef===undefined||metadata.itemRef===null?null:checkedText(metadata.itemRef,'work item',512);
  const identity=fingerprint({jobId,scopeRef,purpose,sessionRef,sourceRef,sourceVersion,fragmentRef,inputClass:metadata.inputClass,inputDigest,generation:metadata.generation,route,itemRef});
  return {jobId,scopeRef,purpose,sessionRef,sourceRef,sourceVersion,fragmentRef,inputClass:metadata.inputClass,inputDigest,generation:metadata.generation,route,itemRef,leaseKey:identity,identity};
 }
 function findConfirmation(action,predicate,instant){
  for(const entry of confirmations.values())if(entry.action===action&&!entry.consumed&&instant-entry.createdAt<=CONFIRMATION_TTL_MS&&predicate(entry))return entry;
  return undefined;
 }
 function claimReceipt(claim,instant){
  const parsed=parseSourceRef(claim.sourceRef);
  if(!parsed||parsed.sessionRef!==claim.sessionRef)throw denied();
  const receiptKey=sources.get(fingerprint({scopeRef:claim.scopeRef,sessionRef:claim.sessionRef,messageDigest:parsed.messageDigest}));
  const receipt=receiptKey===undefined?undefined:receipts.get(receiptKey);
  if(!receipt||receipt.action!=='extract'||receipt.scopeRef!==claim.scopeRef||receipt.sessionRef!==claim.sessionRef)throw denied();
  if(instant-receipt.createdAt>RECEIPT_TTL_MS||receipt.authorizationVersion!==version())throw denied();
  if(receipt.inputDigest!==undefined&&receipt.inputDigest!==claim.inputDigest)throw denied();
  if(fingerprint({originRef:receipt.originRef,contentHash:receipt.contentHash})!==claim.sourceVersion)throw denied();
  const consumedBy=receipt.consumed.get(claim.purpose);
  if(consumedBy!==undefined&&consumedBy!==claim.leaseKey)throw denied();
  receipt.consumed.set(claim.purpose,claim.leaseKey);
 }
 function claimManual(claim,instant){
  if(claim.purpose==='work_summary_merge'){
   if(!claim.itemRef)throw denied();
   const entry=findConfirmation('work_summary_merge',candidate=>candidate.scopeRef===claim.scopeRef&&candidate.itemRef===claim.itemRef,instant);
   if(!entry)throw denied();
   entry.consumed=true;
  }
 }

 function admitMessage(request){
  if(state!=='active')throw denied();
  try{
   shape(request,ADMISSION_FIELDS,'message admission');
   const instant=clock(),action=request.action;
   if(action!=='extract'&&action!=='recall')throw denied();
   const sessionId=checkedText(request.sessionId,'session ID',200);
   const session=sessions.get(sessionId);
   if(!session||session.id!==sessionId)throw denied();
   const agent=agents.get(sessionId);
   if(!agent||agent.id!==sessionId||agent.session!==session)throw denied();
   const scopeRef=checkedText(request.scopeRef,'scope',2048),sessionRef=checkedText(request.sessionRef,'session reference',512);
   if(!sessionRef.startsWith(`${sessionId}/`))throw denied();
   const binding=registry.bindingForSession(session);
   if(!binding||binding.scopeRef!==scopeRef||binding.projectState!=='active')throw denied();
   const runtime=registry.preferencesForScope(scopeRef);
   if(!runtime||runtime.project?.state!=='active')throw denied();
   const preference=runtime.preferences?.[action];
   if(preference!==undefined&&preference!==true)throw denied();
   const globallyEnabled=action==='extract'?config.extraction?.enabled:config.recall?.enabled;
   if(globallyEnabled!==true)throw denied();
   const messageId=checkedText(request.messageId,'message ID',512),rpcId=checkedText(request.rpcId,'RPC ID',512),contentHash=checkedText(request.contentHash,'content digest',64);
   if(!HEX.test(contentHash))throw denied();
   const authorizationVersion=checkedText(request.authorizationVersion,'authorization version',512);
   if(authorizationVersion!==version())throw denied();
   let inputDigest;
   if(request.inputDigest!==undefined){inputDigest=checkedText(request.inputDigest,'input digest',64);if(!HEX.test(inputDigest))throw denied();}
   if(request.eventSeq!==undefined)integer(request.eventSeq,0,Number.MAX_SAFE_INTEGER,'event sequence');
   approvalOf(expectedRouteRef('memory_extract'));
   const key=fingerprint({scopeRef,messageId,action});
   prune(instant);
   const previous=receipts.get(key);
   let originRef;
   if(previous&&previous.contentHash===contentHash&&previous.sessionRef===sessionRef&&previous.rpcId===rpcId&&instant-previous.createdAt<=RECEIPT_TTL_MS){
    originRef=previous.originRef;previous.authorizationVersion=authorizationVersion;
    if(inputDigest!==undefined)previous.inputDigest=inputDigest;
   }else{
    originRef=`admission-v1:${randomUUID()}`;
    receipts.set(key,{key,scopeRef,sessionRef,sessionId,messageId,rpcId,contentHash,action,originRef,inputDigest,authorizationVersion,createdAt:instant,consumed:new Map()});
    if(action==='extract')sources.set(fingerprint({scopeRef,sessionRef,messageDigest:fingerprint(messageId)}),key);
   }
   return Object.freeze({originRef,contentHash,authorizationVersion:version()});
  }catch{diagnostic('admission_refused');throw denied();}
 }

 function authorizeExecution(metadata){
  if(state!=='active')throw denied();
  try{
   const claim=claimOf(metadata),instant=clock();
   prune(instant);
   const liveVersion=version();
   const existing=leases.get(claim.leaseKey);
   checkScope(claim.scopeRef);
   checkRoute(claim);
   if(existing){
    if(existing.identity!==claim.identity||existing.version!==liveVersion||existing.controller.signal.aborted)throw denied();
    existing.lastUsedAt=instant;
    return Object.freeze({authorizationVersion:existing.version,signal:existing.controller.signal});
   }
   if(MANUAL_PURPOSES.includes(claim.purpose))claimManual(claim,instant);
   else claimReceipt(claim,instant);
   if(leases.size>=LEASE_LIMIT)throw denied();
   const controller=new AbortController(),lease={identity:claim.identity,leaseKey:claim.leaseKey,version:liveVersion,controller,createdAt:instant,lastUsedAt:instant};
   leases.set(claim.leaseKey,lease);
   return Object.freeze({authorizationVersion:liveVersion,signal:controller.signal});
  }catch{diagnostic('execution_refused');throw denied();}
 }

 function noteUserConfirmation(args){
  if(state!=='active')throw denied();
  try{
   shape(args,['action','scopeRef','jobId','status','itemRef'],'user confirmation');
   const instant=clock(),action=args.action;
   if(action==='recovery.confirm'){
    const scopeRef=checkedText(args.scopeRef,'scope',2048),jobId=checkedText(args.jobId,'job ID',256);
    if(!['remote_finished','remote_cancel_confirmed'].includes(args.status))throw denied();
    if(!registry.bindingForScope(scopeRef))throw denied();
    prune(instant);
    const confirmationRef=`confirmation-v1:${randomUUID()}`;
    confirmations.set(confirmationRef,{action:'recovery.confirm',confirmationRef,scopeRef,jobId,status:args.status,createdAt:instant,consumed:false});
    return Object.freeze({confirmationRef,action,expiresAt:new Date(instant+CONFIRMATION_TTL_MS).toISOString()});
   }
   if(action==='work_summary_merge'){
    const scopeRef=checkedText(args.scopeRef,'scope',2048),itemRef=checkedText(args.itemRef,'work item',512);
    const binding=registry.bindingForScope(scopeRef);
    if(!binding||binding.projectState!=='active')throw denied();
    prune(instant);
    const confirmationRef=`confirmation-v1:${randomUUID()}`;
    confirmations.set(confirmationRef,{action:'work_summary_merge',confirmationRef,scopeRef,itemRef,createdAt:instant,consumed:false});
    return Object.freeze({confirmationRef,action,expiresAt:new Date(instant+CONFIRMATION_TTL_MS).toISOString()});
   }
   throw denied();
  }catch{diagnostic('confirmation_refused');throw denied();}
 }

 function authorizeRecovery(args){
  if(state!=='active')return false;
  try{
   shape(args,['action','scopeRef','jobId','status','confirmationRef'],'recovery confirmation');
   if(args.action!=='confirmRemoteQuiescence')return false;
   const scopeRef=checkedText(args.scopeRef,'scope',2048),jobId=checkedText(args.jobId,'job ID',256);
   if(!['remote_finished','remote_cancel_confirmed'].includes(args.status))return false;
   const confirmationRef=checkedText(args.confirmationRef,'confirmation reference',512),entry=confirmations.get(confirmationRef);
   if(!entry||entry.consumed||entry.action!=='recovery.confirm')return false;
   if(entry.scopeRef!==scopeRef||entry.jobId!==jobId||entry.status!==args.status)return false;
   if(clock()-entry.createdAt>CONFIRMATION_TTL_MS)return false;
   entry.consumed=true;
   return true;
  }catch{return false;}
 }

 function revoke(){if(state!=='revoked'){
   state='revoked';counter+=1;
   for(const lease of leases.values()){try{lease.controller.abort();}catch{/* local abort only */}}
   leases.clear();receipts.clear();sources.clear();confirmations.clear();
   diagnostic('authorization_revoked');
  }
  return status();
 }
 function status(){
  let recoveryConfirmations=0,manualConfirmations=0;
  for(const entry of confirmations.values()){if(entry.action==='recovery.confirm')recoveryConfirmations++;else manualConfirmations++;}
  return Object.freeze({state,leases:leases.size,receipts:receipts.size,recoveryConfirmations,manualConfirmations,revoked:state==='revoked',authorizationVersion:version()});
 }
 function currentAuthorizationVersion(){return version();}
 return Object.freeze({admitMessage,authorizeExecution,noteUserConfirmation,authorizeRecovery,revoke,status,currentAuthorizationVersion});
}
