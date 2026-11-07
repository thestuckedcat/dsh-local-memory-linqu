
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE records(id TEXT PRIMARY KEY,scope_ref TEXT NOT NULL,source_ref TEXT NOT NULL,
 source_version TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,cjk TEXT NOT NULL,
 text_hash TEXT NOT NULL,origin TEXT NOT NULL,generation INTEGER NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(source_ref,source_version,text_hash));
CREATE VIRTUAL TABLE memory_fts USING fts5(text,cjk,content='records',content_rowid='rowid');
CREATE TRIGGER memory_ai AFTER INSERT ON records BEGIN INSERT INTO memory_fts(rowid,text,cjk) VALUES(new.rowid,new.text,new.cjk); END;
CREATE TRIGGER memory_ad AFTER DELETE ON records BEGIN INSERT INTO memory_fts(memory_fts,rowid,text,cjk) VALUES('delete',old.rowid,old.text,old.cjk); END;
CREATE TRIGGER memory_au AFTER UPDATE ON records BEGIN
 INSERT INTO memory_fts(memory_fts,rowid,text,cjk) VALUES('delete',old.rowid,old.text,old.cjk);
 INSERT INTO memory_fts(rowid,text,cjk) VALUES(new.rowid,new.text,new.cjk); END;
PRAGMA user_version=1;