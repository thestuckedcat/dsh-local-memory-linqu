import {openSync,readSync,closeSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),folder=resolve(root,'evidence/task3-hook-host-api');
const manifest=JSON.parse(readFileSync(resolve(folder,'source-manifest.json'),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const archiveSha256=sha(readFileSync(manifest.archive));
if(archiveSha256!=='e1b6f25fa937da98086c3e77af77aa14791105963c4d337a1c42179d232c6915')throw new Error('Archive differs from pinned Host');
const fd=openSync(manifest.archive,'r');
let report;
try{
 const read=(size,position)=>{const b=Buffer.alloc(size);if(readSync(fd,b,0,size,position)!==size)throw new Error('Incomplete archive read');return b;};
 const prefix=read(16,0),headerSize=prefix.readUInt32LE(4),jsonSize=prefix.readUInt32LE(12);
 if(jsonSize>headerSize-8||headerSize>16000000)throw new Error('Unsupported archive header');
 const header=JSON.parse(read(jsonSize,16).toString('utf8')),dataOffset=8+headerSize;
 const files=manifest.files.map(item=>{
  const parts=item.path.split('/');if(parts.slice(0,3).join('/')!=='dsh/node_modules/@deepseek-ai'||parts.length<5||parts.some(p=>p==='..'||!p))throw new Error('Unexpected source path');
  let entry=header;for(const part of parts)entry=entry.files?.[part];
  if(!entry||entry.unpacked||entry.link||!Number.isSafeInteger(entry.size)||!/^\d+$/.test(entry.offset))throw new Error('Unsupported source entry');
  const bytes=read(entry.size,dataOffset+Number(entry.offset)),copy=readFileSync(resolve(folder,...parts.slice(3)));
  const archiveHash=sha(bytes),copyHash=sha(copy),verified=archiveHash===copyHash&&copyHash===item.sha256&&bytes.length===item.size&&copy.length===item.size;
  return {path:item.path,sha256:archiveHash,size:bytes.length,verified};
 });
 report={schema_version:1,date:'2026-11-06',archive:manifest.archive,archiveSha256,purpose:'Read-only byte comparison; source copies are never imported',files,verified:files.length===7&&files.every(file=>file.verified)};
}finally{closeSync(fd);}
writeFileSync(resolve(root,'evidence/task3-hooks-source-proof.json'),JSON.stringify(report,null,2)+'\n');
process.stdout.write(JSON.stringify({verified:report.verified,files:report.files.length,archiveSha256})+'\n');
process.exitCode=report.verified?0:1;
