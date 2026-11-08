import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,memory} from './helpers.mjs';
import {openStore} from '../src/backend.mjs';
import {digest} from '../src/scope.mjs';
import {memoryDigest} from '../src/store-internals.mjs';
import {AUTHORITY_SCHEMA,AUTHORITY_V2_SCHEMA,LEGACY_SCHEMA,EXTENSION_SCHEMA,CONTENT_V3_SCHEMA,CONTENT_SIGNATURE,CONTENT_V3_SIGNATURE,AUTHORITY_SIGNATURE,AUTHORITY_V2_SIGNATURE,schemaSignature,migrateConsolidationSchema} from '../src/schema.mjs';

const IDENTITY='11111111-1111-4111-8111-111111111111';
const CONTENT_TABLES=['consolidation_inputs','consolidation_excerpts','consolidation_bodies'];
const AUTHORITY_TABLES=['consolidation_jobs','consolidation_permissions','consolidation_dependencies','consolidation_head','consolidation_versions','consolidation_policy','consolidation_operations','consolidation_audit'];
const tableNames=(db,namespace='main')=>new Set(db.prepare(`SELECT name FROM ${namespace}.sqlite_schema WHERE type='table'`).all().map(row=>row.name));
const userVersion=(db,namespace='main')=>db.prepare(`PRAGMA ${namespace}.user_version`).get().user_version;
const rowDigest=row=>memoryDigest({text:row.text,kind:row.kind,origin:row.origin,created_at:row.created_at??row.createdAt,supersedes:row.supersedes??null});
function entryFor(row,work){
 return {collection:work?'work_summaries':'memories',id:row.id,bodyDigest:work?digest(row.payload):rowDigest(row),sourceRef:row.source_ref??row.sourceRef,sourceVersion:row.source_version??row.sourceVersion,generation:row.generation,sources:[{sourceRef:row.source_ref??row.sourceRef,sourceVersion:row.source_version??row.sourceVersion,fragmentRef:'whole'}]};
}
function insertAuthorityEntries(db,scopeRef,entries){
 const entry=db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)'),source=db.prepare('INSERT INTO entry_sources VALUES(?,?,?,?,?,?)');
 for(const e of entries){entry.run(scopeRef,e.collection,e.id,'active',e.bodyDigest,e.sourceRef,e.sourceVersion,e.generation,null);for(const s of e.sources)source.run(scopeRef,e.collection,e.id,s.sourceRef,s.sourceVersion,s.fragmentRef);}
}
function makeAuthority(root,{version=1,scopeRef='A',revision=4,entries=[]}={}){
 const file=join(root,'authority.sqlite'),db=new DatabaseSync(file);
 db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;');
 db.exec(version===1?AUTHORITY_SCHEMA:AUTHORITY_V2_SCHEMA);
 db.prepare('INSERT INTO metadata VALUES(?,?)').run('identity',IDENTITY);
 if(revision!==undefined)db.prepare('INSERT INTO scope_state VALUES(?,?,?)').run(scopeRef,0,revision);
 insertAuthorityEntries(db,scopeRef,entries);
 db.prepare('INSERT INTO daily_budget VALUES(?,?,?,?)').run('2026-11-08',2,100,50);
 db.close();
 writeFileSync(join(root,'authority.identity.json'),JSON.stringify({schema_version:1,identity:IDENTITY}));
 return file;
}
function makeContent(root,{version=2,scopeRef='A',generation='1',records=[],work=[],authorityId=IDENTITY}={}){
 const file=join(root,`scope-${digest(scopeRef)}.sqlite`),db=new DatabaseSync(file);
 db.exec('PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;');
 db.exec(version===2?LEGACY_SCHEMA+EXTENSION_SCHEMA:CONTENT_V3_SCHEMA);
 const set=db.prepare('INSERT INTO metadata VALUES(?,?)');set.run('scope_ref',scopeRef);set.run('owner','@local/dsh-controlled-memory');set.run('generation',generation);if(authorityId)set.run('authority_id',authorityId);
 for(const r of records)db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,scopeRef,r.sourceRef,r.sourceVersion,r.kind,r.text,'',digest(r.text),r.origin,r.generation,r.createdAt,r.supersedes??null);
 for(const w of work)db.prepare('INSERT INTO work_summaries VALUES(?,?,?,?,?)').run(w.id,scopeRef,w.payload,digest(w.payload),w.generation);
 db.close();
 return file;
}
function legacyMemory(){return {id:'one',sourceRef:'session-A/turn-1',sourceVersion:'version-A',kind:'lesson',text:'Descriptor reclamation waits for completion.',origin:'user',generation:1,createdAt:'2026-11-08T00:00:00Z',supersedes:null};}
function legacyWork(){return {id:'work-1',sourceRef:'session-A/turn-1',sourceVersion:'version-A',payload:JSON.stringify({schema_version:1,id:'work-1',collection:'work_summaries',scopeRef:'A',generation:2}),generation:2};}
function legacyPair(root,{authorityVersion=1,contentVersion=2,revision=4,withData=true}={}){
 const record=legacyMemory(),work=legacyWork();
 const entries=withData?[entryFor(record),entryFor(work,true)]:[];
 makeAuthority(root,{version:authorityVersion,revision,entries});
 makeContent(root,{version:contentVersion,records:withData?[record]:[],work:withData?[work]:[],authorityId:IDENTITY});
 return {contentFile:join(root,`scope-${digest('A')}.sqlite`),authorityFile:join(root,'authority.sqlite')};
}
function assertCurrentSignatures(contentFile,authorityFile){
 const content=new DatabaseSync(contentFile,{readOnly:true}),authority=new DatabaseSync(authorityFile,{readOnly:true});
 try{
  assert.equal(userVersion(content),3);assert.equal(schemaSignature(content),CONTENT_V3_SIGNATURE);
  assert.equal(userVersion(authority),2);assert.equal(schemaSignature(authority),AUTHORITY_V2_SIGNATURE);
 }finally{content.close();authority.close();}
}

test('a new root creates content v3 and authority v2 directly',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'A'}));
 store.put(memory());
 assertCurrentSignatures(join(f.root,`scope-${digest('A')}.sqlite`),join(f.root,'authority.sqlite'));
 const authority=new DatabaseSync(join(f.root,'authority.sqlite'),{readOnly:true});
 try{assert.deepEqual(AUTHORITY_TABLES.filter(name=>!tableNames(authority).has(name)),[]);}finally{authority.close();}
 assert.equal(store.get('one').text,memory().text);
});

test('v3 content and v2 authority additions expose the exact design columns and constraints',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'A'}));store.close();
 const contentFile=join(f.root,`scope-${digest('A')}.sqlite`),authorityFile=join(f.root,'authority.sqlite');
 const columns=(db,namespace,table)=>db.prepare(`PRAGMA ${namespace}.table_info(${table})`).all().map(column=>column.name);
 const content=new DatabaseSync(contentFile);
 try{
  assert.deepEqual(columns(content,'main','consolidation_inputs'),['job_id','payload','digest']);
  assert.deepEqual(columns(content,'main','consolidation_excerpts'),['id','scope_ref','text','digest']);
  assert.deepEqual(columns(content,'main','consolidation_bodies'),['id','scope_ref','body_kind','payload','digest']);
  assert.throws(()=>content.prepare('INSERT INTO consolidation_bodies VALUES(?,?,?,?,?)').run('b','A','not-a-kind','{}','d'),/constraint/i,'body_kind must stay candidate/version');
 }finally{content.close();}
 const authority=new DatabaseSync(authorityFile);
 try{
  assert.deepEqual(columns(authority,'main','consolidation_jobs'),['id','scope_ref','request_id','fingerprint','state','epoch','scope_revision','base_head_revision','manifest_digest','manifest_json','route_json','policy_digest','policy_revision','permission_id','budget_day','input_chars','max_tokens','run_token','cost_status','candidate_id','reason','invalidated_at','created_at','updated_at']);
  assert.deepEqual(columns(authority,'main','consolidation_permissions'),['id','scope_ref','kind','state','subject_id','subject_digest','route_digest','epoch','policy_revision','expires_at','created_at']);
  assert.deepEqual(columns(authority,'main','consolidation_dependencies'),['scope_ref','owner_kind','owner_id','base_kind','base_id','base_generation','base_digest']);
  assert.deepEqual(columns(authority,'main','consolidation_head'),['scope_ref','revision','version_id']);
  assert.deepEqual(columns(authority,'main','consolidation_versions'),['id','scope_ref','revision','candidate_id','digest','manifest_digest','created_at']);
  assert.deepEqual(columns(authority,'main','consolidation_policy'),['scope_ref','revision']);
  assert.deepEqual(columns(authority,'main','consolidation_operations'),['scope_ref','request_id','fingerprint','result_json']);
  assert.deepEqual(columns(authority,'main','consolidation_audit'),['seq','scope_ref','operation_id','kind','object_id','reason','occurred_at']);
  const insertJob=authority.prepare('INSERT INTO consolidation_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  assert.throws(()=>insertJob.run('job-1','A','request-1','fingerprint','not-a-state',0,0,0,'manifest','{}','{}','policy',1,'permission','2026-11-08',0,0,null,'not_dispatched',null,null,null,'t','t'),/constraint/i,'job state must stay in the design enum');
  assert.throws(()=>authority.prepare('INSERT INTO consolidation_permissions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('permission-1','A','batch','active','subject','digest',null,0,1,null,'t'),/constraint/i,'batch/excerpt permissions require an expiry');
  assert.throws(()=>authority.prepare('INSERT INTO consolidation_policy VALUES(?,?)').run('A',0),/constraint/i,'policy revision starts at 1');
 }finally{authority.close();}
});

test('content v2 and authority v1 migrate transactionally while preserving data, identity and revision',async t=>{
 const f=fixture(t),{contentFile,authorityFile}=legacyPair(f.root),anchor=join(f.root,'authority.identity.json'),anchorBytes=readFileSync(anchor);
 let store=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(store.revision(),4);
 assert.equal(store.get('one').text,'Descriptor reclamation waits for completion.');
 assert.deepEqual(store.exportSnapshot().workSummaries.map(w=>w.id),['work-1']);
 const initialRevision=store.revision();
 store.close();
 assertCurrentSignatures(contentFile,authorityFile);
 const content=new DatabaseSync(contentFile,{readOnly:true});
 try{assert.deepEqual(CONTENT_TABLES.filter(name=>!tableNames(content).has(name)),[]);assert.equal(content.prepare("SELECT value FROM metadata WHERE key='generation'").get().value,'1');}finally{content.close();}
 const authority=new DatabaseSync(authorityFile,{readOnly:true});
 try{
  assert.deepEqual(AUTHORITY_TABLES.filter(name=>!tableNames(authority).has(name)),[]);
  assert.equal(authority.prepare("SELECT value FROM metadata WHERE key='identity'").get().value,IDENTITY);
  assert.deepEqual({...authority.prepare('SELECT * FROM daily_budget').get()},{day:'2026-11-08',requests:2,input_chars:100,output_tokens:50});
 }finally{authority.close();}
 assert.deepEqual(readFileSync(anchor),anchorBytes,'identity anchor must not be rewritten by the upgrade');
 const schemaCount=new DatabaseSync(contentFile,{readOnly:true});
 const before={content:tableNames(schemaCount).size,revision:initialRevision};schemaCount.close();
 store=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(store.revision(),4);assert.equal(store.get('one').text,'Descriptor reclamation waits for completion.');
 store.close();
 store=f.track(openStore(f.root,{scopeRef:'A'}));
 assertCurrentSignatures(contentFile,authorityFile);
 const reopened=new DatabaseSync(contentFile,{readOnly:true});
 try{assert.equal(tableNames(reopened).size,before.content);}finally{reopened.close();}
 assert.equal(store.revision(),before.revision);
});

test('legacy content v1 passes through v1→v2→v3 only with the explicit legacy path',async t=>{
 const f=fixture(t),contentFile=join(f.root,`scope-${digest('A')}.sqlite`),db=new DatabaseSync(contentFile);
 db.exec(readFileSync(new URL('./fixtures/task1-schema.sql',import.meta.url),'utf8'));
 const set=db.prepare('INSERT INTO metadata VALUES(?,?)');set.run('scope_ref','A');set.run('owner','@local/dsh-controlled-memory');set.run('generation','5');
 db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('one','A','session-A/turn-1','version-A','lesson','Descriptor reclamation waits for completion.','',digest('Descriptor reclamation waits for completion.'),'user',1,'2026-11-08T00:00:00Z');
 db.close();
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/migration|authority/i);
 assert.equal(existsSync(join(f.root,'authority.sqlite')),false);
 const store=f.track(openStore(f.root,{scopeRef:'A',allowLegacyMigration:true}));
 assert.equal(store.revision(),5);
 assert.equal(store.get('one').text,'Descriptor reclamation waits for completion.');
 assert.equal(store.search('reclamation').length,1);
 store.close();
 assertCurrentSignatures(contentFile,join(f.root,'authority.sqlite'));
});

test('a failure while applying either side rolls both databases back without partial schema or data loss',async t=>{
 const f=fixture(t),{contentFile,authorityFile}=legacyPair(f.root),db=new DatabaseSync(contentFile);
 db.exec('PRAGMA journal_mode=DELETE;');
 db.prepare('ATTACH DATABASE ? AS ledger').run(authorityFile);
 db.exec('PRAGMA ledger.journal_mode=DELETE;');
 try{
  for(const failAt of ['content-v3','authority-v2']){
   assert.throws(()=>migrateConsolidationSchema(db,{contentVersion:2,authorityVersion:1,onStep:step=>{if(step===failAt)throw new Error('INJECTED_MIGRATION_FAILURE');}}),/INJECTED_MIGRATION_FAILURE/);
   assert.equal(userVersion(db),2,'content version must roll back');
   assert.equal(userVersion(db,'ledger'),1,'authority version must roll back');
   assert.equal(schemaSignature(db),CONTENT_SIGNATURE);
   assert.equal(schemaSignature(db,'ledger'),AUTHORITY_SIGNATURE);
   assert.equal(tableNames(db).has('consolidation_excerpts'),false,'content DDL must roll back');
   assert.equal(tableNames(db,'ledger').has('consolidation_jobs'),false,'authority DDL must roll back');
   assert.equal(db.prepare('SELECT count(*) AS n FROM records').get().n,1);
  }
  assert.deepEqual(migrateConsolidationSchema(db,{contentVersion:2,authorityVersion:1}),{migrated:true,contentVersion:3,authorityVersion:2});
  assert.equal(schemaSignature(db),CONTENT_V3_SIGNATURE);
  assert.equal(schemaSignature(db,'ledger'),AUTHORITY_V2_SIGNATURE);
 }finally{db.close();}
 assertCurrentSignatures(contentFile,authorityFile);
 const store=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(store.get('one').text,'Descriptor reclamation waits for completion.');
});

test('unknown or modified schemas are refused before any write',async t=>{
 const f=fixture(t),{contentFile,authorityFile}=legacyPair(f.root),contentBytes=readFileSync(contentFile),authorityBytes=readFileSync(authorityFile);
 const corruptContent=new DatabaseSync(contentFile);
 corruptContent.exec('CREATE TRIGGER sqlitex_unexpected AFTER INSERT ON records BEGIN SELECT 1; END;');
 corruptContent.close();
 const corruptedBytes=readFileSync(contentFile);
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/schema|index|FTS/i);
 assert.deepEqual(readFileSync(contentFile),corruptedBytes,'refused content schema must not be written');
 assert.deepEqual(readFileSync(authorityFile),authorityBytes,'authority must stay untouched when content is unknown');
 writeFileSync(contentFile,contentBytes);
 const corruptAuthority=new DatabaseSync(authorityFile);
 corruptAuthority.exec('DROP TABLE jobs');
 corruptAuthority.close();
 const corruptedAuthorityBytes=readFileSync(authorityFile);
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/authority/i);
 assert.deepEqual(readFileSync(authorityFile),corruptedAuthorityBytes,'refused authority schema must not be rewritten');
 assert.deepEqual(readFileSync(contentFile),contentBytes,'content must stay at v2 when authority is unknown');
 writeFileSync(authorityFile,authorityBytes);
 const mislabeled=new DatabaseSync(authorityFile);
 mislabeled.exec('PRAGMA user_version=2');
 mislabeled.close();
 const mislabeledBytes=readFileSync(authorityFile);
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/authority/i,'a v2 label over a v1 definition must be refused');
 assert.deepEqual(readFileSync(authorityFile),mislabeledBytes);
 writeFileSync(authorityFile,authorityBytes);
 const future=new DatabaseSync(contentFile);
 future.exec('PRAGMA user_version=4');
 future.close();
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/schema/i);
 const after=new DatabaseSync(contentFile,{readOnly:true});
 try{assert.equal(userVersion(after),4);assert.deepEqual(CONTENT_TABLES.filter(name=>tableNames(after).has(name)),[]);assert.equal(schemaSignature(after),CONTENT_SIGNATURE);}finally{after.close();}
});

test('mixed already-migrated and legacy databases advance only through their verified signatures',async t=>{
 const f=fixture(t);
 makeContent(f.root,{version:3});
 makeAuthority(f.root,{version:1,revision:3});
 let store=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(store.revision(),3);
 store.put(memory());
 assert.equal(store.get('one').text,memory().text);
 store.close();
 assertCurrentSignatures(join(f.root,`scope-${digest('A')}.sqlite`),join(f.root,'authority.sqlite'));

 const g=fixture(t),record=legacyMemory();
 makeContent(g.root,{version:2,records:[record]});
 makeAuthority(g.root,{version:2,revision:2,entries:[entryFor(record)]});
 store=g.track(openStore(g.root,{scopeRef:'A'}));
 assert.equal(store.revision(),2);
 assert.equal(store.get('one').text,record.text);
 store.close();
 assertCurrentSignatures(join(g.root,`scope-${digest('A')}.sqlite`),join(g.root,'authority.sqlite'));

 const h=fixture(t),bad=legacyPair(h.root).contentFile,raw=new DatabaseSync(bad);
 raw.exec('PRAGMA user_version=3');
 raw.close();
 const badBytes=readFileSync(bad);
 assert.throws(()=>openStore(h.root,{scopeRef:'A'}),/schema|migration/i);
 assert.deepEqual(readFileSync(bad),badBytes,'a v3 label over a v2 definition must not be migrated');
 const check=new DatabaseSync(bad,{readOnly:true});
 try{assert.deepEqual(CONTENT_TABLES.filter(name=>tableNames(check).has(name)),[]);}finally{check.close();}
});

test('evidence excerpts keep text in content and register every root plus the memory dependency in authority',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'A'}));
 store.put(memory());
 const recordGeneration=store.get('one').generation;
 store.close();
 const authority=new DatabaseSync(join(f.root,'authority.sqlite'));
 authority.prepare('INSERT INTO entry_sources VALUES(?,?,?,?,?,?)').run('A','memories','one','session-A/turn-2','version-A','fragment-9');
 authority.close();
 const reopened=f.track(openStore(f.root,{scopeRef:'A'})),token='EXCERPTUNIQUECANARYWORD';
 const args={requestId:'excerpt-request-1',memoryId:'one',expectedRecordGeneration:recordGeneration,sourceVersion:'version-A',fragmentRef:'fragment-1',text:`The device owns the descriptor until completion. ${token}`};
 const ref=reopened.registerExcerpt(args);
 assert.match(ref.fragmentId,/^mc-excerpt:/);
 assert.equal(ref.sourceRef,'session-A/turn-1');
 assert.equal(ref.sourceVersion,'version-A');
 assert.equal(ref.recordGeneration,recordGeneration);
 assert.equal(ref.digest,digest(args.text));
 assert.equal(ref.state,'active');
 const read=reopened.readExcerpt(ref.fragmentId);
 assert.equal(read.text,args.text);assert.equal(read.digest,ref.digest);assert.equal(read.recordGeneration,recordGeneration);
 const revision=reopened.revision();
 assert.deepEqual(reopened.registerExcerpt(args),ref,'same request/payload is idempotent');
 assert.equal(reopened.revision(),revision,'replay must not advance the revision');
 assert.throws(()=>reopened.registerExcerpt({...args,text:`${args.text}!`}),/identity/i);
 for(const [change,pattern] of [
  [{requestId:'excerpt-request-2',expectedRecordGeneration:9999},/stale/i],
  [{requestId:'excerpt-request-3',sourceVersion:'version-B'},/version/i],
  [{requestId:'excerpt-request-4',text:'x'.repeat(1501)},/excerpt text/i],
  [{requestId:'excerpt-request-5',text:'password=CANARY_PRIVATE_987654321'},/secret/i],
  [{requestId:'excerpt-request-6',memoryId:'missing'},/unavailable/i],
  [{requestId:'excerpt-request-7',scopeRef:'B'},/field/i]
 ])assert.throws(()=>reopened.registerExcerpt({...args,...change}),pattern,JSON.stringify(change));
 reopened.close();
 const content=new DatabaseSync(join(f.root,`scope-${digest('A')}.sqlite`),{readOnly:true});
 try{
  const body=content.prepare('SELECT text,digest FROM consolidation_excerpts WHERE id=?').get(ref.fragmentId);
  assert.equal(body.text,args.text);assert.equal(body.digest,ref.digest);
 }finally{content.close();}
 const ledger=new DatabaseSync(join(f.root,'authority.sqlite'),{readOnly:true});
 try{
  const entry=ledger.prepare("SELECT * FROM entries WHERE scope_ref='A' AND collection='consolidation_excerpts' AND id=?").get(ref.fragmentId);
  assert.equal(entry.state,'active');assert.equal(entry.body_digest,ref.digest);
  assert.equal(entry.source_ref,'session-A/turn-1');assert.equal(entry.source_version,'version-A');
  const roots=ledger.prepare("SELECT source_ref,source_version,fragment_ref FROM entry_sources WHERE scope_ref='A' AND collection='consolidation_excerpts' AND id=?").all(ref.fragmentId);
  assert.deepEqual(roots.map(row=>`${row.source_ref}|${row.source_version}|${row.fragment_ref}`).sort(),['session-A/turn-1|version-A|whole','session-A/turn-2|version-A|fragment-9']);
  const dependency=ledger.prepare("SELECT * FROM consolidation_dependencies WHERE scope_ref='A' AND owner_kind='excerpt' AND owner_id=?").get(ref.fragmentId);
  assert.equal(dependency.base_kind,'memory');assert.equal(dependency.base_id,'one');assert.equal(dependency.base_generation,recordGeneration);
 }finally{ledger.close();}
});

test('forgetting a memory makes its excerpt unreadable, and forgetting the excerpt clears its body bytes',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'A'})),token='EXCERPTFORGETCANARYWORD';
 store.put(memory());
 const recordGeneration=store.get('one').generation;
 const args={requestId:'excerpt-forget',memoryId:'one',expectedRecordGeneration:recordGeneration,sourceVersion:'version-A',fragmentRef:'fragment-1',text:`Excerpt ${token}`};
 const ref=store.registerExcerpt(args);
 assert.equal(store.readExcerpt(ref.fragmentId).text,`Excerpt ${token}`);
 store.forget({id:'one',expectedGeneration:store.generation()});
 assert.equal(store.readExcerpt(ref.fragmentId),undefined,'a dead source never exposes its excerpt');
 const forgotten=store.forgetExcerpt(ref.fragmentId);
 assert.equal(forgotten.deleted,true);assert.equal(forgotten.currentSqliteBodyCleared,true);
 assert.equal(store.readExcerpt(ref.fragmentId),undefined);
 assert.equal(store.forgetExcerpt(ref.fragmentId).alreadyDeleted,true);
 assert.throws(()=>store.registerExcerpt(args),/active/i,'a forgotten registration must not replay as an active ref');
 assert.throws(()=>store.forgetExcerpt('mc-excerpt:unknown'),/unknown/i);
 store.close();
 const contentFile=join(f.root,`scope-${digest('A')}.sqlite`);
 assert.equal(readFileSync(contentFile).includes(Buffer.from(token)),false,'forget must clear the excerpt body from current database bytes');
 const content=new DatabaseSync(contentFile,{readOnly:true});
 try{
  assert.equal(content.prepare('SELECT count(*) AS n FROM consolidation_excerpts WHERE id=?').get(ref.fragmentId).n,0);
 }finally{content.close();}
 const ledger=new DatabaseSync(join(f.root,'authority.sqlite'),{readOnly:true});
 try{assert.equal(ledger.prepare("SELECT state FROM entries WHERE scope_ref='A' AND collection='consolidation_excerpts' AND id=?").get(ref.fragmentId).state,'deleted');}finally{ledger.close();}
});

test('tampered excerpt bodies fail closed instead of returning unverified text',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'A'}));
 store.put(memory());
 const ref=store.registerExcerpt({requestId:'excerpt-tamper',memoryId:'one',expectedRecordGeneration:store.get('one').generation,sourceVersion:'version-A',fragmentRef:'fragment-1',text:'Owner rule until completion.'});
 store.close();
 const raw=new DatabaseSync(join(f.root,`scope-${digest('A')}.sqlite`));
 raw.prepare('UPDATE consolidation_excerpts SET digest=? WHERE id=?').run('0'.repeat(64),ref.fragmentId);
 raw.close();
 const reopened=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.throws(()=>reopened.readExcerpt(ref.fragmentId),/integrity/i);
});

test('source blocks refuse new excerpts and make existing excerpts unreadable without deleting the memory',async t=>{
 const f=fixture(t),store=f.track(openStore(f.root,{scopeRef:'A'}));
 store.put(memory());
 const recordGeneration=store.get('one').generation;
 const ref=store.registerExcerpt({requestId:'blocked-excerpt',memoryId:'one',expectedRecordGeneration:recordGeneration,sourceVersion:'version-A',fragmentRef:'fragment-1',text:'Excerpt recorded before the source block.'});
 store.close();
 const ledger=new DatabaseSync(join(f.root,'authority.sqlite'));
 ledger.prepare('INSERT INTO source_blocks VALUES(?,?,?,?)').run('A','session-A/turn-1','version-A',0);
 ledger.close();
 const reopened=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(reopened.readExcerpt(ref.fragmentId),undefined);
 assert.throws(()=>reopened.registerExcerpt({requestId:'blocked-excerpt-2',memoryId:'one',expectedRecordGeneration:recordGeneration,sourceVersion:'version-A',fragmentRef:'fragment-2',text:'A new excerpt after the source block.'}),/deleted|invalidated/i);
 assert.equal(reopened.get('one').text,memory().text,'a source block does not delete the original memory');
});

test('v3 snapshots export live version metadata/source refs while v2 and v3 restores stay compatible',async t=>{
 const f=fixture(t),contentFile=join(f.root,`scope-${digest('A')}.sqlite`),authorityFile=join(f.root,'authority.sqlite');
 let store=f.track(openStore(f.root,{scopeRef:'A'}));
 store.put(memory());
 const record=store.get('one'),recordGeneration=record.generation,recordDigest=memoryDigest({text:record.text,kind:record.kind,origin:record.origin,created_at:record.createdAt,supersedes:record.supersedes??null}),v2=store.exportSnapshot();
 v2.schema_version=2;delete v2.versions;
 store.close();
 const authority=new DatabaseSync(authorityFile),payload=JSON.stringify({schema_version:1,groups:[],untouched:['one']});
 authority.prepare('INSERT INTO consolidation_versions VALUES(?,?,?,?,?,?,?)').run('mc-version:c1','A',1,'mc-candidate:c1',digest(payload),digest('manifest'),'2026-11-08T01:00:00Z');
 authority.prepare('INSERT INTO consolidation_head VALUES(?,?,?)').run('A',1,'mc-version:c1');
 authority.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)').run('A','consolidation_versions','mc-version:c1','active',digest(payload),'session-A/turn-1','version-A',1,null);
 authority.prepare('INSERT INTO entry_sources VALUES(?,?,?,?,?,?)').run('A','consolidation_versions','mc-version:c1','session-A/turn-1','version-A','whole');
 authority.prepare('INSERT INTO consolidation_dependencies VALUES(?,?,?,?,?,?,?)').run('A','version','mc-version:c1','memory','one',recordGeneration,recordDigest);
 authority.close();
 store=f.track(openStore(f.root,{scopeRef:'A'}));
 const v3=store.exportSnapshot();
 assert.equal(v3.schema_version,3);
 assert.equal(v3.versions.length,1);
 assert.equal(v3.versions[0].versionId,'mc-version:c1');
 assert.equal(v3.versions[0].revision,1);
 assert.equal(v3.versions[0].head,true);
 assert.deepEqual(v3.versions[0].sources,[{sourceRef:'session-A/turn-1',sourceVersion:'version-A',fragmentRef:'whole'}]);
 assert.equal(v3.versions[0].dependencies[0].ownerKind,'version');
 assert.equal(v3.versions[0].dependencies[0].baseId,'one');
 assert.throws(()=>store.restoreSnapshot({...v2,versions:[]}),/schema|version/i);
 assert.throws(()=>store.restoreSnapshot({...v3,versions:[{versionId:'broken'}]}),/snapshot version/i);
 assert.throws(()=>store.restoreSnapshot({...v3,versions:[{...v3.versions[0],digest:'not-a-digest'}]}),/digest/i);
 assert.equal(store.get('one').text,memory().text,'a rejected snapshot must roll back without losing live records');
 store.close();
 const wipeRecord=new DatabaseSync(contentFile);
 wipeRecord.exec("DELETE FROM records WHERE id='one'");
 wipeRecord.close();
 store=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(store.get('one'),undefined);
 const restoredV2=store.restoreSnapshot(v2);
 assert.equal(restoredV2.restored,1);assert.equal(restoredV2.versionsSkipped,0);
 assert.equal(store.get('one').text,memory().text);
 store.close();
 const wipeAgain=new DatabaseSync(contentFile);
 wipeAgain.exec("DELETE FROM records WHERE id='one'");
 wipeAgain.close();
 store=f.track(openStore(f.root,{scopeRef:'A'}));
 const restoredV3=store.restoreSnapshot(v3);
 assert.equal(restoredV3.restored,1);
 assert.equal(restoredV3.versionsRestored,0);
 assert.equal(restoredV3.versionsSkipped,1,'a version without an exported body must be skipped, not fabricated');
 assert.equal(restoredV3.authorityPreserved,true);
 store.close();
 const bodies=new DatabaseSync(contentFile,{readOnly:true});
 try{assert.equal(bodies.prepare('SELECT count(*) AS n FROM consolidation_bodies').get().n,0);}finally{bodies.close();}
});

function memoryRowDigestFrom(store,generation){
 const record=store.get('one');
 assert.equal(record.generation,generation);
 return memoryDigest({text:record.text,kind:record.kind,origin:record.origin,created_at:record.createdAt,supersedes:record.supersedes??null});
}

test('excerpt entries do not consume the bounded snapshot record budget',async t=>{
 const f=fixture(t),records=[],entries=[];
 for(let i=0;i<500;i++){const row={id:`record-${i}`,sourceRef:`source-${i}`,sourceVersion:'version-A',kind:'lesson',text:`Descriptor fact ${i}`,origin:'user',generation:1,createdAt:'2026-11-08T00:00:00Z',supersedes:null};records.push(row);entries.push(entryFor(row));}
 makeContent(f.root,{version:3,records});
 makeAuthority(f.root,{version:2,revision:1,entries});
 const store=f.track(openStore(f.root,{scopeRef:'A'}));
 assert.equal(store.list({limit:500}).length,500);
 store.registerExcerpt({requestId:'bounded-excerpt',memoryId:'record-0',expectedRecordGeneration:store.get('record-0').generation,sourceVersion:'version-A',fragmentRef:'fragment-1',text:'A bounded excerpt for the snapshot budget.'});
 const snapshot=store.exportSnapshot();
 assert.equal(snapshot.schema_version,3);
 assert.equal(snapshot.records.length,500);
 assert.equal(snapshot.versions.length,0);
});
