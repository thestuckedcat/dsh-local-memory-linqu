import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export async function task2() {
  try {
    const [backend,jobs,provider,work,lifecycle] = await Promise.all(['backend','jobs','provider','work-summary','lifecycle'].map(n => import(`../src/${n}.mjs`)));
    return { ...backend, ...jobs, ...provider, ...work, ...lifecycle };
  } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND') assert.fail('Task 2 modules are not implemented'); throw e; }
}
export function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),'memory-task2-')), stores = [];
  t.after(() => { for(const s of stores) s.close(); rmSync(root,{recursive:true,force:true}); });
  return { root, track(s) { stores.push(s); return s; } };
}
export const memory = (extra={}) => ({id:'one',sourceRef:'session-A/turn-1',sourceVersion:'version-A',kind:'lesson',text:'Descriptor reclamation waits for completion.',...extra});
export const source = (extra={}) => ({sourceRef:'session-A/turn-1',sourceVersion:'version-A',fragmentRef:'fragment-1',...extra});
export const draft = (extra={}) => ({itemType:'requirement',title:'DMA ownership investigation',goal:'Find reclamation boundary',myContribution:'I analysed the descriptor path.',processOrConclusion:'Completion controls ownership.',result:'unknown',time:{precision:'unknown'},...extra});
export const routeA = Object.freeze({routeRef:'registered-A',provider:'provider-A',model:'model-A',routeVersion:'1'});
export const extraction = () => ({text:JSON.stringify({schema_version:1,memories:[{kind:'lesson',text:'Completion precedes reclamation.'}]}),finishReason:'stop'});
export function job(store,extra={}) { return {requestId:'request-1',scopeRef:store.scopeRef,sessionRef:'session-A',sourceRef:'session-A/turn-1',sourceVersion:'version-A',fragmentRef:'fragment-1',inputRef:'session-A/turn-1#fragment-1',inputClass:'conversation_fragment',input:'The user established the completion boundary.',routeRef:'registered-A',generation:store.generation(),purpose:'memory_extract',...extra}; }
export function latch() { let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject}; }
// Synthetic test-only authority; production defaults deny and must consult the real Host grant store.
const executionTestSignal=new AbortController().signal;
export const authorizeTestExecution=()=>({authorizationVersion:'synthetic-execution-1',signal:executionTestSignal});
