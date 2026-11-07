import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { task2,fixture,draft,source } from './helpers.mjs';

test('manual work drafts persist independently with unknown dates and missing proof',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t);let s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s);
 const saved=w.save({requestId:'manual-1',draft:draft(),sources:[source()],expectedGeneration:s.generation()});s.close();
 s=f.track(openStore(f.root,{scopeRef:'A'}));w=createWorkSummaryManager(s);const row=w.get(saved.id);
 assert.equal(row.myContribution.basis,'user_reported');assert.equal(row.myContribution.confirmation,'pending');assert.equal(row.result.support,'missing');assert.equal(row.time.precision,'unknown');assert.ok(row.pendingEvidence.includes('myContribution'));assert.ok(row.pendingConfirmation.includes('time'));assert.deepEqual(s.search('DMA'),[]);
 assert.throws(()=>w.save({requestId:'bad',scopeRef:'B',draft:draft(),sources:[source()]}),/scope/i);
});
test('a model supplied calendar date remains inferred and pending until explicit user confirmation',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s,{authorize:()=>true});
 const saved=w.save({requestId:'dated-model',draft:draft({time:{start:'2026-11-04',precision:'day'}}),sources:[source()],origin:'model'});
 assert.ok(w.get(saved.id).pendingConfirmation.includes('time'));assert.equal(w.get(saved.id).time.basis,'inferred');
 const denied=createWorkSummaryManager(s);assert.throws(()=>denied.confirmTime({id:saved.id,expectedGeneration:s.generation()}),/authoriz/i);
 w.confirmTime({id:saved.id,expectedGeneration:s.generation()});assert.equal(w.get(saved.id).time.confirmation,'user_confirmed');assert.equal(w.get(saved.id).time.basis,'inferred');assert.equal(w.get(saved.id).myContribution.support,'missing');
});
test('contradictory dates remain visible without overwriting a confirmed date and replay is a no-op',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s,{authorize:()=>true});
 const saved=w.save({requestId:'dated',draft:draft({time:{start:'2025',precision:'year'}}),sources:[source()]});w.confirmTime({id:saved.id});
 const change={id:saved.id,draft:draft({time:{start:'2026',precision:'year'}}),sources:[source({sourceVersion:'version-B'})],origin:'model'};
 w.merge(change);const current=w.get(saved.id);assert.equal(current.time.start,'2025');assert.equal(current.time.confirmation,'user_confirmed');assert.ok(current.pendingConfirmation.includes('time'));assert.ok(current.conflicts.some(c=>c.claimRef==='time'));
 const epoch=s.generation(),revision=s.revision();w.merge(change);assert.equal(s.generation(),epoch);assert.equal(s.revision(),revision);
});
test('goal and association changes become explicit candidates instead of disappearing from a merge',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s),saved=w.save({requestId:'a',draft:draft(),sources:[source()]});
 w.merge({id:saved.id,draft:draft({goal:'Another proposed goal',projectRef:'proposed-project'}),sources:[source({sourceVersion:'version-B'})],origin:'model'});
 const row=w.get(saved.id);assert.equal(row.goal,'Find reclamation boundary');assert.equal(row.projectRef,undefined);assert.ok(row.pendingConfirmation.includes('goal'));assert.ok(row.pendingConfirmation.includes('projectRef'));
});
test('evidence registration never certifies claims; explicit review is limited to one claim and version',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),documents=join(f.root,'documents');mkdirSync(documents);
 const path=join(documents,'proof.md');writeFileSync(path,'Alice analysed the descriptor path. The test passed.');
 const w=createWorkSummaryManager(s,{evidenceRoots:[documents],authorize:()=>true}),saved=w.save({requestId:'manual',draft:draft(),sources:[source()]});
 const evidence=w.registerEvidence({id:saved.id,reference:{localPath:path,displayName:'Design note'},claimRefs:['myContribution'],expectedGeneration:s.generation()});
 assert.equal(w.get(saved.id).myContribution.support,'missing');
 w.reviewEvidence({id:saved.id,evidenceRef:evidence.evidenceRef,claimRef:'myContribution',assessment:{support:'supported',quote:'Alice analysed the descriptor path.',note:'This supports the stated analysis contribution only.'},expectedGeneration:s.generation()});
 assert.equal(w.get(saved.id).myContribution.support,'supported');assert.equal(w.get(saved.id).result.support,'missing');
 writeFileSync(path,'Changed document without that claim.');assert.equal(w.get(saved.id).myContribution.support,'unread');
 const denied=createWorkSummaryManager(s,{evidenceRoots:[documents]});assert.throws(()=>denied.reviewEvidence({id:saved.id,evidenceRef:evidence.evidenceRef,claimRef:'myContribution',assessment:{support:'supported',quote:'Changed',note:'Unapproved'},expectedGeneration:s.generation()}),/authoriz/i);
});
test('source replay avoids duplicate items and model merges preserve user confirmation',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s,{authorize:()=>true});
 const input={requestId:'first',itemRef:'requirement-1',draft:draft(),sources:[source()]};const a=w.save(input);
 assert.equal(w.save({...input,requestId:'repeat'}).id,a.id);assert.equal(w.get(a.id).sources.length,1);
 w.confirmClaim({id:a.id,claimRef:'myContribution',expectedGeneration:s.generation()});
 w.merge({id:a.id,draft:draft({myContribution:'The model claimed a different contribution.'}),sources:[source({sourceRef:'session-B/turn-1'})],origin:'model',expectedGeneration:s.generation()});
 const row=w.get(a.id);assert.equal(row.myContribution.text,'I analysed the descriptor path.');assert.equal(row.myContribution.confirmation,'user_confirmed');assert.ok(row.pendingConfirmation.includes('myContribution'));
 assert.throws(()=>w.save({requestId:'forged',draft:{...draft(),evidenceRefs:[{support:'supported'}]},sources:[source()]}),/field|schema/i);
});
test('replaying the same work merge does not advance lifecycle epoch or content revision',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s),saved=w.save({requestId:'a',draft:draft(),sources:[source()]});
 const epoch=s.generation(),revision=s.revision();const again=w.merge({id:saved.id,draft:draft(),sources:[source()],origin:'model',expectedGeneration:epoch});
 assert.equal(s.generation(),epoch);assert.equal(s.revision(),revision);assert.equal(again.generation,saved.generation);assert.equal(w.get(saved.id).supersedes,undefined);
});
test('a new version of the same source anchor requires a revision rather than a new work item',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s),saved=w.save({requestId:'a',draft:draft(),sources:[source()]});
 assert.throws(()=>w.save({requestId:'b',draft:draft(),sources:[source({sourceVersion:'version-B'})]}),/identity|merge|correction/i);
 w.merge({id:saved.id,draft:draft(),sources:[source({sourceVersion:'version-B'})],expectedGeneration:s.generation()});assert.equal(w.list().items.length,1);assert.equal(w.get(saved.id).sources.length,2);
});
test('reviewing a new version for one claim cannot refresh another claims obsolete proof',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),dir=join(f.root,'docs');mkdirSync(dir);const path=join(dir,'proof.md');writeFileSync(path,'Contribution A was analysed.');
 const w=createWorkSummaryManager(s,{evidenceRoots:[dir],authorize:()=>true}),saved=w.save({requestId:'a',draft:draft(),sources:[source()]});const evidence=w.registerEvidence({id:saved.id,reference:{localPath:path},claimRefs:['myContribution','result']});
 w.reviewEvidence({id:saved.id,evidenceRef:evidence.evidenceRef,claimRef:'myContribution',assessment:{support:'supported',quote:'Contribution A was analysed.',note:'Contribution evidence'}});
 writeFileSync(path,'The test result is now confirmed.');
 w.reviewEvidence({id:saved.id,evidenceRef:evidence.evidenceRef,claimRef:'result',assessment:{support:'supported',quote:'The test result is now confirmed.',note:'Result evidence only'}});
 const row=w.get(saved.id);assert.equal(row.myContribution.support,'unread');assert.equal(row.result.support,'supported');
});
test('registering the same document for another claim extends links without increasing proof count',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s,{evidenceRoots:[f.root]}),saved=w.save({requestId:'one',draft:draft(),sources:[source()]});
 const ref={localPath:join(f.root,'proof.md')},a=w.registerEvidence({id:saved.id,reference:ref,claimRefs:['myContribution']}),b=w.registerEvidence({id:saved.id,reference:ref,claimRefs:['result']});
 assert.equal(a.evidenceRef,b.evidenceRef);assert.equal(w.get(saved.id).evidenceRefs.length,1);assert.ok(w.get(saved.id).evidenceRefs[0].claimRefs.includes('result'));assert.equal(w.get(saved.id).result.support,'missing');
});
test('revoked proof read authorization prevents automatic content revalidation',async t=>{
 const {openStore,createWorkSummaryManager}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),dir=join(f.root,'proofs');mkdirSync(dir);const path=join(dir,'proof.md');writeFileSync(path,'Recorded contribution.');
 const allowed=createWorkSummaryManager(s,{evidenceRoots:[dir],authorize:()=>true}),saved=allowed.save({requestId:'one',draft:draft(),sources:[source()]}),ref=allowed.registerEvidence({id:saved.id,reference:{localPath:path},claimRefs:['myContribution']});
 allowed.reviewEvidence({id:saved.id,evidenceRef:ref.evidenceRef,claimRef:'myContribution',assessment:{support:'supported',quote:'Recorded contribution.',note:'Only this statement'}});
 const denied=createWorkSummaryManager(s,{evidenceRoots:[dir]});assert.equal(denied.get(saved.id).myContribution.support,'unread');
});
test('work forget, source invalidation and restore use the same independent authority',async t=>{
 const {openStore,createWorkSummaryManager,consumeCapabilityEvent}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),w=createWorkSummaryManager(s);
 const one=w.save({requestId:'first',draft:draft(),sources:[source()]});const snapshot=s.exportSnapshot();
 s.forget({id:one.id,collection:'work_summaries',expectedGeneration:s.generation()});s.restoreSnapshot(snapshot);assert.equal(w.get(one.id),undefined);assert.deepEqual(w.list().items,[]);
 const two=w.save({requestId:'second',draft:draft(),sources:[source({sourceRef:'session-B/turn-1'})]});
 consumeCapabilityEvent(s,{schema_version:1,event_id:'work-invalidation',kind:'session_removed',source_capability:'03-session-management',scope_ref:'A',session_ref:'session-B',operation_id:'remove-B',generation:1,affected_refs:['session-B'],outcome:'completed',occurred_at:'2026-11-04T00:00:00Z'});
 assert.equal(w.get(two.id),undefined);
});
