import {checkedText} from './scope.mjs';
import {shape,clean,fingerprint,integer} from './validation.mjs';
export const PURPOSES=Object.freeze(['memory_extract','work_summary_extract','work_summary_merge']);
export const CONSOLIDATION_PURPOSE='memory_consolidate';
export const MODEL_PURPOSES=Object.freeze([...PURPOSES,CONSOLIDATION_PURPOSE]);
function descriptor(value){shape(value,['routeRef','provider','model','routeVersion'],'approved route');const result={};for(const key of ['routeRef','provider','model','routeVersion'])result[key]=checkedText(value[key],key,512);return Object.freeze(result);}
export class RouteUnavailable extends Error{constructor(){super('Approved route unavailable or changed');this.preDispatch=true;}}
export class ProviderResponseError extends Error{constructor(){super('Provider returned a completed but invalid response');}}
/** The only external boundary. Task3 supplies a bridge to Harness's registered Provider service. */
export function createControlledProvider({resolveRoute,invoke}={}){
 if(typeof resolveRoute!=='function'||typeof invoke!=='function')throw new Error('Approved Provider bridge required');
 function bind(routeRef,purpose){if(!MODEL_PURPOSES.includes(purpose))throw new Error('Unsupported model purpose');const value=resolveRoute(checkedText(routeRef,'route reference',512));if(!value||typeof value.then==='function')throw new RouteUnavailable();const bound=descriptor(value);if(bound.routeRef!==routeRef)throw new RouteUnavailable();return bound;}
 function approved(bound,purpose){try{return fingerprint(bind(bound.routeRef,purpose))===fingerprint(bound);}catch{return false;}}
 return Object.freeze({bind,approved,async execute(bound,{purpose,input,requestId,maxTokens,signal,assertExecution}){
  if(!approved(bound,purpose))throw new RouteUnavailable();integer(maxTokens,1,2048,'maximum output tokens');checkedText(input,'model input',8000);
  if(assertExecution!==undefined){try{if(typeof assertExecution!=='function')throw new Error('Invalid execution check');const checked=assertExecution();if(checked&&typeof checked.then==='function'){Promise.resolve(checked).catch(()=>{});throw new Error('Synchronous execution check required');}}catch{throw new RouteUnavailable();}}
  const request=Object.freeze({route:Object.freeze({...bound}),purpose,input,requestId:checkedText(requestId,'request ID',256),maxTokens,signal,assertExecution});
  const result=await invoke(request);
  const complete=result?.finishReason==='stop'||result?.finishReason==='error';
  try{
   shape(result,['text','finishReason','usage'],'model response');
   if(result.finishReason!=='stop')throw new Error('Provider did not confirm a successful response');
   if(typeof result.text!=='string'||result.text.length>32000)throw new Error('Provider response size limit');
   if(result.usage!==undefined){shape(result.usage,['inputTokens','outputTokens'],'usage');integer(result.usage.inputTokens,0,1000000,'input usage');integer(result.usage.outputTokens,0,maxTokens,'output usage');}
   clean(result);return result;
  }catch{if(complete)throw new ProviderResponseError();throw new Error('Provider outcome is unknown');}
 }});
}
