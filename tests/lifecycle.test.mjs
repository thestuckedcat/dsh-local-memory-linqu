import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { task2,fixture,memory,routeA,job,extraction ,authorizeTestExecution} from './helpers.mjs';

test('forget invalidates warm readers, late generations, snapshots and index reconstruction',async t=>{
 const {openStore}=await task2(),f=fixture(t),a=f.track(openStore(f.root,{scopeRef:'A'})),b=f.track(openStore(f.root,{scopeRef:'A'}));
 a.put(memory());const snapshot=a.exportSnapshot(),generation=a.generation();
 assert.equal(b.search('reclamation').length,1);
 a.forget({id:'one',expectedGeneration:generation});
 assert.deepEqual(b.search('reclamation'),[]);
 assert.throws(()=>b.put(memory({id:'late'}),{expectedGeneration:generation}),/stale/i);
 assert.throws(()=>a.put(memory({id:'rephrased',text:'A rewritten deleted fact.'})),/source|deleted/i);
 assert.equal(a.restoreSnapshot(snapshot).restored,0);a.rebuildIndex();
 assert.deepEqual(a.list(),[]);
});
test('correction supersedes old body and archive is distinct from irreversible forget',async t=>{
 const {openStore}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));
 s.put(memory());const snapshot=s.exportSnapshot();s.search('reclamation');
 const revised=s.correct({id:'one',text:'Reclamation waits for the device completion.',sourceVersion:'version-B',expectedGeneration:s.generation()});
 assert.equal(revised.supersedes,'one');assert.equal(s.get('one'),undefined);
 s.restoreSnapshot(snapshot);assert.match(s.search('reclamation')[0].text,/device/);
 s.archive({id:revised.id,expectedGeneration:s.generation()});assert.deepEqual(s.search('reclamation'),[]);
 s.restoreArchived({id:revised.id,expectedGeneration:s.generation()});assert.equal(s.get(revised.id).state,'active');
 s.forget({id:revised.id,expectedGeneration:s.generation()});assert.throws(()=>s.restoreArchived({id:revised.id,expectedGeneration:s.generation()}),/deleted|archived/i);
});
test('restoring an entire old body file cannot roll back the independent deletion authority',async t=>{
 const {openStore}=await task2(),f=fixture(t);let s=f.track(openStore(f.root,{scopeRef:'A'}));
 s.put(memory());const file=s.databasePath,backup=join(f.root,'body-backup.sqlite');s.close();copyFileSync(file,backup);
 s=f.track(openStore(f.root,{scopeRef:'A'}));s.forget({id:'one',expectedGeneration:s.generation()});s.close();copyFileSync(backup,file);
 s=f.track(openStore(f.root,{scopeRef:'A'}));s.rebuildIndex();assert.deepEqual(s.search('reclamation'),[]);
 const raw=new DatabaseSync(file);assert.equal(raw.prepare('SELECT count(*) AS n FROM records').get().n,0);raw.close();
});
test('missing or corrupt authority refuses opening and warm cache never becomes a fallback',async t=>{
 const {openStore}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));
 s.put(memory());s.search('reclamation');
 const anchor=join(f.root,'authority.identity.json'),content=readFileSync(anchor);
 unlinkSync(anchor);assert.throws(()=>s.search('reclamation'),/authority/i);s.close();
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/authority/i);
 writeFileSync(anchor,content);const ledger=new DatabaseSync(join(f.root,'authority.sqlite'));ledger.exec('PRAGMA user_version=999');ledger.close();
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/authority/i);
});
test('source invalidation is scoped, replay safe and closes warm recall',async t=>{
 const {openStore,consumeCapabilityEvent}=await task2(),f=fixture(t),a=f.track(openStore(f.root,{scopeRef:'A'})),b=f.track(openStore(f.root,{scopeRef:'B'}));
 a.put(memory());b.put(memory());a.search('reclamation');
 const e={schema_version:1,event_id:'event-1',kind:'session_removed',source_capability:'03-session-management',scope_ref:'A',session_ref:'session-A',operation_id:'remove-1',generation:2,affected_refs:['session-A'],outcome:'completed',occurred_at:'2026-11-04T00:00:00Z'};
 consumeCapabilityEvent(a,e);const generation=a.generation();consumeCapabilityEvent(a,e);assert.equal(a.generation(),generation);
 assert.deepEqual(a.search('reclamation'),[]);assert.equal(b.list().length,1);
 assert.throws(()=>consumeCapabilityEvent(b,e),/scope/i);
 assert.throws(()=>consumeCapabilityEvent(a,{...e,affected_refs:['unrelated']}),/event|identity/i);
});
test('DDL damage on an open content database cannot be hidden by a warm recall cache',async t=>{
 const {openStore}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));s.put(memory());assert.equal(s.search('reclamation').length,1);
 const raw=new DatabaseSync(s.databasePath);raw.exec('DROP TABLE memory_fts');raw.close();assert.throws(()=>s.search('reclamation'),/schema|index|FTS/i);
});
test('all lifecycle invalidation and an old body restore purge queued plaintext inputs',async t=>{
 const {openStore,createJobQueue,createControlledProvider}=await task2(),f=fixture(t);let s=f.track(openStore(f.root,{scopeRef:'A'}));s.put(memory());
 const p=createControlledProvider({resolveRoute:()=>routeA,invoke:async()=>extraction()}),q=createJobQueue(s,{authorizeExecution:authorizeTestExecution,provider:p});q.enqueue(job(s,{input:'FORGET_OLD_BACKUP_INPUT_CANARY'}));
 const file=s.databasePath,backup=join(f.root,'old-input.sqlite');s.close();copyFileSync(file,backup);
 s=f.track(openStore(f.root,{scopeRef:'A'}));s.archive({id:'one',expectedGeneration:s.generation()});
 let raw=new DatabaseSync(file);assert.equal(raw.prepare('SELECT count(*) AS n FROM job_inputs').get().n,0);raw.close();s.close();copyFileSync(backup,file);
 s=f.track(openStore(f.root,{scopeRef:'A'}));raw=new DatabaseSync(file);assert.equal(raw.prepare('SELECT count(*) AS n FROM job_inputs').get().n,0);raw.close();
 assert.equal(readFileSync(file).includes(Buffer.from('FORGET_OLD_BACKUP_INPUT_CANARY')),false);
});
test('forget clears unique tokens from current FTS shadow blocks and current database bytes',async t=>{
 const {openStore}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'})),token='UNIQUEPURGECANARYXYZSENTENCE';s.put(memory({text:token}));const file=s.databasePath;
 s.forget({id:'one',expectedGeneration:s.generation()});s.close();
 const raw=new DatabaseSync(file);const remains=raw.prepare('SELECT block FROM memory_fts_data').all().some(v=>Buffer.from(v.block).includes(Buffer.from(token.toLowerCase())));raw.close();
 assert.equal(remains,false);const bytes=readFileSync(file);assert.equal(bytes.includes(Buffer.from(token)),false);assert.equal(bytes.includes(Buffer.from(token.toLowerCase())),false);
});
test('reopening an old insecure FTS index removes already deleted historical segments',async t=>{
 const {openStore}=await task2(),f=fixture(t);let s=f.track(openStore(f.root,{scopeRef:'A'}));const file=s.databasePath;s.close();
 const token='OLDSEGMENTCANARYUNIQUEWORD',raw=new DatabaseSync(file);raw.exec("PRAGMA secure_delete=ON;INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',0)");
 raw.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy','A','old','v1','fact',token,'','unused','user',1,'2026-11-04',null);raw.exec("DELETE FROM records WHERE id='legacy'");raw.close();assert.equal(readFileSync(file).includes(Buffer.from(token.toLowerCase())),true);
 s=f.track(openStore(f.root,{scopeRef:'A'}));s.close();assert.equal(readFileSync(file).includes(Buffer.from(token.toLowerCase())),false);
});
test('a disabled secure-delete policy is unavailable until a verified reopen rebuilds it',async t=>{
 const {openStore}=await task2(),f=fixture(t);let s=f.track(openStore(f.root,{scopeRef:'A'}));s.put(memory());s.search('reclamation');
 const raw=new DatabaseSync(s.databasePath);raw.exec("INSERT INTO memory_fts(memory_fts,rank) VALUES('secure-delete',0)");raw.close();assert.throws(()=>s.search('reclamation'),/FTS.*policy/i);s.close();
 s=f.track(openStore(f.root,{scopeRef:'A'}));assert.equal(s.search('reclamation').length,1);
});
test('session removal always invalidates its registered session even with empty affected refs',async t=>{
 const {openStore,consumeCapabilityEvent}=await task2(),f=fixture(t),s=f.track(openStore(f.root,{scopeRef:'A'}));s.put(memory());
 consumeCapabilityEvent(s,{schema_version:1,event_id:'empty-refs',kind:'session_removed',source_capability:'03-session-management',scope_ref:'A',session_ref:'session-A',operation_id:'remove',generation:1,affected_refs:[],outcome:'completed',occurred_at:'2026-11-04T00:00:00Z'});assert.equal(s.get('one'),undefined);
});
