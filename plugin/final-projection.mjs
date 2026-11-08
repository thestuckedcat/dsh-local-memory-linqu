import {checkedText,digest} from '../src/scope.mjs';
import {shape,integer} from '../src/validation.mjs';
import {routeApproval,routeRefFor} from './configuration.mjs';

const PLUGIN='@local/dsh-controlled-memory';
const BLOCK_MESSAGE='Local memory recall projection is stale; this request was not dispatched.';
const SCHEMA_FIELDS=Object.freeze(['sessionId','messageId','textDigest','scopeRef','generation','revision','authorizationVersion','records','createdAt','turn','step']);
const RECORD_FIELDS=Object.freeze(['id','sourceRef','sourceVersion','generation','ref']);
const MAX_PROJECTIONS=1024,MAX_RECORDS=8;
const HEX=/^[a-f0-9]{64}$/;
const denied=()=>new Error('Memory projection is unavailable');
const isPlain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
/** Accept only the contracted fields; explicitly undefined extra keys are tolerated for additive hooks. */
function contracted(value,fields,label){
 if(!isPlain(value))throw denied();
 for(const key of Object.keys(value))if(!fields.includes(key)&&value[key]!==undefined)throw denied();
 return value;
}

function blockChunk(){
 const failure=Object.freeze({code:'memory_projection_stale',message:BLOCK_MESSAGE});
 const chunk=Object.freeze({type:'finish',reason:Object.freeze({kind:'error',failure})});
 return Object.freeze({[Symbol.asyncIterator](){let done=false;return Object.freeze({
  next(){if(done)return Promise.resolve({done:true,value:undefined});done=true;return Promise.resolve({done:false,value:chunk});},
  return(){done=true;return Promise.resolve({done:true,value:undefined});},
 });}});
}
function ownMessage(message){return message?.source?.kind==='memory-recall'&&message.source.plugin===PLUGIN;}

/**
 * Final request gate for messages this plugin injected in the pre-step waterfall. It only
 * withdraws its own recall message, never mutates the (deep frozen) request and never calls
 * `next()` when the projection is stale.
 */
export function createFinalProjection({config,registry,grants,sessions,onDiagnostic=()=>{},now=()=>new Date()}={}){
 if(!isPlain(config))throw new Error('Normalized memory configuration required');
 if(!registry||['bindingForScope','storeFor','preferencesForScope'].some(key=>typeof registry[key]!=='function'))throw new Error('Trusted project registry required');
 if(!grants||typeof grants.currentAuthorizationVersion!=='function')throw new Error('Trusted execution grants required');
 if(!sessions||typeof sessions.get!=='function')throw new Error('Trusted live session service required');
 if(typeof onDiagnostic!=='function'||typeof now!=='function')throw new Error('Trusted projection services required');
 const approveRoute=typeof config.routeApproval==='function'?config.routeApproval:routeApproval(config);
 const projections=new Map();
 let installed=false,removeListener=null;
 function diagnostic(code,extra){try{const value=onDiagnostic(Object.freeze(extra===undefined?{code}:{code,...extra}));if(value&&typeof value.then==='function')Promise.resolve(value).catch(()=>{});}catch{/* diagnostics never alter the request */}}
 function clock(){const instant=now();if(!(instant instanceof Date)||Number.isNaN(+instant))throw denied();return +instant;}
 function projectionKey(sessionId,messageId){return `${sessionId}\u0000${messageId}`;}
 function approve(routeRef){if(typeof routeRef!=='string'||!routeRef)return undefined;try{const value=approveRoute(routeRef);if(value&&typeof value.then==='function'){Promise.resolve(value).catch(()=>{});return undefined;}shape(value,['routeRef','provider','model','routeVersion'],'approved route');return routeVersionOf(value);}catch{return undefined;}}
 function routeVersionOf(value){const routeVersion=checkedText(value.routeVersion,'route version',512);if(value.routeRef!==undefined&&typeof value.routeRef!=='string')throw denied();return routeVersion;}
 function expectedRouteRef(){const routeRef=routeRefFor(config,'memory_extract');if(typeof routeRef!=='string'||!routeRef)throw denied();return routeRef;}
 function expectedRouteVersion(){const routeVersion=approve(expectedRouteRef());if(routeVersion===undefined)throw denied();return routeVersion;}
 function prune(){
  for(const [key,entry] of projections)if(sessions.get(entry.sessionId)===undefined)projections.delete(key);
  if(projections.size<MAX_PROJECTIONS)return;
  for(const [key,entry] of projections)if(entry.state==='dispatched'||entry.state==='invalidated'){projections.delete(key);if(projections.size<MAX_PROJECTIONS)return;}
  while(projections.size>=MAX_PROJECTIONS)projections.delete(projections.keys().next().value);
 }
 function record(projection){
  try{
   contracted(projection,SCHEMA_FIELDS,'recall projection');
   const sessionId=checkedText(projection.sessionId,'session ID',200),messageId=checkedText(projection.messageId,'message ID',512);
   const textDigest=checkedText(projection.textDigest,'text digest',64);
   if(!HEX.test(textDigest))throw denied();
   const scopeRef=checkedText(projection.scopeRef,'scope',2048);
   integer(projection.generation,0,Number.MAX_SAFE_INTEGER,'projection generation');
   integer(projection.revision,0,Number.MAX_SAFE_INTEGER,'projection revision');
   const authorizationVersion=checkedText(projection.authorizationVersion,'authorization version',512);
   const createdAt=checkedText(projection.createdAt,'projection time',64);
   if(Number.isNaN(Date.parse(createdAt)))throw denied();
   if(!Array.isArray(projection.records)||projection.records.length<1||projection.records.length>MAX_RECORDS)throw denied();
   const records=projection.records.map(value=>{
    contracted(value,RECORD_FIELDS,'projection record');
    return Object.freeze({id:checkedText(value.id,'record ID',256),sourceRef:checkedText(value.sourceRef,'source reference',2048),sourceVersion:checkedText(value.sourceVersion,'source version',512),generation:integer(value.generation,0,Number.MAX_SAFE_INTEGER,'record generation')});
   });
   let projectRevision=null,bindingRevision=null;
   try{const binding=registry.bindingForScope(scopeRef);if(binding){projectRevision=Number.isSafeInteger(binding.projectRevision)?binding.projectRevision:null;bindingRevision=Number.isSafeInteger(binding.bindingRevision)?binding.bindingRevision:null;}}catch{/* a missing binding fails verification closed */}
   let routeVersion=null;
   try{routeVersion=expectedRouteVersion();}catch{/* an unavailable route fails verification closed */}
   const instant=clock();
   projections.set(projectionKey(sessionId,messageId),{sessionId,messageId,textDigest,scopeRef,generation:projection.generation,revision:projection.revision,authorizationVersion,records,createdAt,projectRevision,bindingRevision,routeVersion,state:'pending',committed:false,recordedAt:instant});
   prune();
   return Object.freeze({sessionId,messageId,state:'pending'});
  }catch{diagnostic('projection_record_refused');throw denied();}
 }
 function commit(sessionId,messageId){
  try{const entry=projections.get(projectionKey(checkedText(sessionId,'session ID',200),checkedText(messageId,'message ID',512)));if(!entry)return false;entry.committed=true;return true;}catch{return false;}
 }
 function invalidate(sessionId){
  try{const id=checkedText(sessionId,'session ID',200);let count=0;for(const entry of projections.values())if(entry.sessionId===id&&entry.state!=='invalidated'){entry.state='invalidated';count++;}return count;}catch{return 0;}
 }
 function checkRecord(entry,message){
  let text;
  try{
   const content=message.content;
   if(!Array.isArray(content)||content.length!==1||!content[0]||content[0].type!=='text'||typeof content[0].text!=='string')return 'content_unavailable';
   text=content[0].text;
  }catch{return 'content_unavailable';}
  if(digest(text)!==entry.textDigest)return 'content_replaced';
  try{
   const session=sessions.get(entry.sessionId);
   if(!session||session.id!==entry.sessionId)return 'session_unavailable';
   const binding=registry.bindingForScope(entry.scopeRef);
   if(!binding||binding.projectState!=='active')return 'binding_unavailable';
   if(!Number.isSafeInteger(binding.projectRevision)||!Number.isSafeInteger(binding.bindingRevision))return 'binding_unavailable';
   if(entry.projectRevision!==binding.projectRevision||entry.bindingRevision!==binding.bindingRevision)return 'binding_changed';
   const runtime=registry.preferencesForScope(entry.scopeRef);
   if(!runtime||runtime.project?.state!=='active')return 'binding_unavailable';
   if(runtime.preferences?.recall!==true||config.recall?.enabled!==true)return 'recall_disabled';
   const authorizationVersion=grants.currentAuthorizationVersion();
   if(typeof authorizationVersion!=='string'||authorizationVersion!==entry.authorizationVersion)return 'authorization_changed';
   if(entry.routeVersion===null||expectedRouteVersion()!==entry.routeVersion)return 'route_changed';
   const store=registry.storeFor(entry.scopeRef);
   if(!store||typeof store.get!=='function')return 'store_unavailable';
   for(const record of entry.records){
    const live=store.get(record.id);
    if(!live)return 'record_unavailable';
    if(live.scopeRef!==entry.scopeRef||live.sourceRef!==record.sourceRef||live.sourceVersion!==record.sourceVersion||live.generation!==record.generation)return 'record_changed';
   }
   return undefined;
  }catch{return 'verification_unavailable';}
 }
 function fail(entry,reason,alreadyInvalid){if(!alreadyInvalid){try{entry.state='invalidated';}catch{/* bounded metadata */}diagnostic('projection_stale',{reason});}return Object.freeze({action:'block',reason});}
 function verify(options){
  let sessionId,messages;
  try{
   if(!options||typeof options!=='object'||Array.isArray(options))throw denied();
   sessionId=checkedText(options.sessionId,'session ID',200);
   messages=options.messages;
   if(!Array.isArray(messages)||messages.length>2000)throw denied();
  }catch{diagnostic('projection_unmatched_request');return Object.freeze({action:'not_ours'});}
  const matched=[];
  try{
   for(const message of messages){
    if(!message||typeof message!=='object')continue;
    const entry=projections.get(projectionKey(sessionId,String(message.id)));
    if(entry)matched.push({entry,message});
   }
  }catch{return Object.freeze({action:'block',reason:'verification_unavailable'});}
  if(matched.length<1){
   // Fail closed for this plugin's own recall messages even when their projection metadata is
   // missing or was evicted: passing an unverified own message would forward possibly deleted
   // memory text to the model. A stale/unrecorded projection blocks the request instead.
   const unmatchedOwn=messages.some(message=>{try{return ownMessage(message);}catch{return false;}});
   if(unmatchedOwn){diagnostic('projection_unrecorded');return Object.freeze({action:'block',reason:'projection_unrecorded'});}
   return Object.freeze({action:'not_ours'});
  }
  const passed=[];
  for(const {entry,message} of matched){
   if(entry.state==='invalidated')return fail(entry,'projection_invalidated',true);
   const reason=checkRecord(entry,message);
   if(reason!==undefined)return fail(entry,reason,false);
   passed.push(entry);
  }
  // A request may mix verified and unregistered own recall messages (e.g. a mix of current and
  // evicted/legacy projections). Verified entries alone must not let the unregistered ones pass.
  for(const message of messages){
   let own=false;
   try{own=ownMessage(message)&&!projections.has(projectionKey(sessionId,String(message.id)));}catch{own=false;}
   if(own){diagnostic('projection_unrecorded');return Object.freeze({action:'block',reason:'projection_unrecorded'});}
  }
  for(const entry of passed)entry.state='dispatched';
  return Object.freeze({action:'pass'});
 }
 // The Host waterfall returns this value directly to stream consumers.
 // Keep the iterable synchronous: async/await would wrap it in a Promise.
 function listener(options,next){
  if(typeof next!=='function')return blockChunk();
  let verdict;
  try{verdict=verify(options);}catch{verdict=Object.freeze({action:'block',reason:'verification_unavailable'});}
  if(verdict.action==='pass'||verdict.action==='not_ours')return next();
  return blockChunk();
 }
 function install(context){
  if(installed)return dispose;
  if(!context||typeof context.on!=='function')throw new Error('Trusted Host event service required');
  removeListener=context.on('llm/stream',listener);
  installed=true;
  return dispose;
 }
 function dispose(){
  if(installed){
   installed=false;
   const remove=removeListener;removeListener=null;
   try{if(typeof remove==='function')remove();}catch{/* local listener removal */ }
  }
  projections.clear();
 }
 return Object.freeze({record,commit,invalidate,verify,install,dispose});
}
