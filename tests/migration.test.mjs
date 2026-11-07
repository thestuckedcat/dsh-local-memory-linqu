import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {task2,fixture,memory} from './helpers.mjs';
import {digest} from '../src/scope.mjs';
test('valid Task1 databases require explicit migration and retain their scoped records',async t=>{
 const {openStore}=await task2(),f=fixture(t),file=join(f.root,`scope-${digest('A')}.sqlite`),db=new DatabaseSync(file);
 db.exec(readFileSync(new URL('./fixtures/task1-schema.sql',import.meta.url),'utf8'));
 const set=db.prepare('INSERT INTO metadata VALUES(?,?)');set.run('scope_ref','A');set.run('owner','@local/dsh-controlled-memory');set.run('generation','0');db.close();
 assert.throws(()=>openStore(f.root,{scopeRef:'A'}),/migration|authority/i);
 assert.equal(existsSync(join(f.root,'authority.sqlite')),false);
 const s=f.track(openStore(f.root,{scopeRef:'A',allowLegacyMigration:true}));s.put(memory());assert.equal(s.search('reclamation').length,1);
});
test('explicit Task1 migration clears legacy deleted FTS segments before serving reads',async t=>{
 const {openStore}=await task2(),f=fixture(t),file=join(f.root,`scope-${digest('A')}.sqlite`),db=new DatabaseSync(file),token='MIGRATIONPURGECANARYUNIQUE';
 db.exec(readFileSync(new URL('./fixtures/task1-schema.sql',import.meta.url),'utf8'));db.exec('PRAGMA secure_delete=ON');
 const set=db.prepare('INSERT INTO metadata VALUES(?,?)');set.run('scope_ref','A');set.run('owner','@local/dsh-controlled-memory');set.run('generation','1');
 db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('old','A','old','v1','fact',token,'','unused','user',1,'2026-11-04');db.exec("DELETE FROM records WHERE id='old'");db.close();
 assert.equal(readFileSync(file).includes(Buffer.from(token.toLowerCase())),true);
 const s=f.track(openStore(f.root,{scopeRef:'A',allowLegacyMigration:true}));s.close();assert.equal(readFileSync(file).includes(Buffer.from(token.toLowerCase())),false);
});
