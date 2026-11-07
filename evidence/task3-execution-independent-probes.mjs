import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/backend.mjs';
import {createJobQueue} from '../src/jobs.mjs';
import {createControlledProvider} from '../src/provider.mjs';
import {job,routeA,extraction,memory} from '../tests/helpers.mjs';

// Independent review probes: report observations, do not alter production sources.
async function probe(kind,depth=0){
 const root=mkdtempSync(join(tmpdir(),'exec-independent-')),store=openStore(root,{scopeRef:'review'}),grant=new AbortController(),caller=new AbortController();
 let queue,route=routeA;const phases=[];
 const later=(n,fn)=>n?queueMicrotask(()=>later(n-1,fn)):fn();
 const provider=createControlledProvider({resolveRoute:()=>route,invoke:async()=>{if(kind==='caller-race')later(depth,()=>caller.abort());return extraction();}});
 const authorizeExecution=metadata=>{
  phases.push({phase:metadata.phase,callerAborted:caller.signal.aborted});
  if(metadata.phase==='commit-complete'){
   if(kind==='recover-in-final-approval')queue.recoverInterrupted();
   if(kind==='route-change-in-final-approval')route={...routeA,routeVersion:'2'};
   if(kind==='epoch-change-in-final-approval')store.forget({id:'existing',expectedGeneration:store.generation()});
  }
  return {authorizationVersion:'v1',signal:grant.signal};
 };
 try{
  if(kind==='epoch-change-in-final-approval')store.put(memory({id:'existing',sourceRef:'other-source'}));
  queue=createJobQueue(store,{provider,authorizeExecution});
  const saved=queue.enqueue(job(store));const result=await queue.runJob(saved.jobId,{signal:caller.signal,timeoutMs:100});
  await new Promise(resolve=>setImmediate(resolve));
  const next=queue.enqueue(job(store,{requestId:'next',sourceRef:'next-source'}));
  const snapshot={kind,depth,result,phases,callerAborted:caller.signal.aborted,records:store.list().length,nextResult:await queue.runJob(next.jobId,{timeoutMs:100})};
  console.log(JSON.stringify(snapshot));
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
}
for(let depth=0;depth<=10;depth++)await probe('caller-race',depth);
for(const kind of ['recover-in-final-approval','route-change-in-final-approval','epoch-change-in-final-approval'])await probe(kind);
