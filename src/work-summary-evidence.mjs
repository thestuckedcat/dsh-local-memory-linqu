import {openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {checkedText,digest} from './scope.mjs';
export function readProof(path){
 if(!/\.(?:md|txt|log|json|csv|c|h|cc|cpp|rst)$/i.test(path))throw new Error('Unsupported evidence format; keep reference unread');
 const fd=openSync(path,'r');try{
  if(!fstatSync(fd).isFile())throw new Error('Evidence must be a regular file');
  const bytes=Buffer.alloc(65537);let size=0;
  while(size<bytes.length){const read=readSync(fd,bytes,size,bytes.length-size,size);if(!read)break;size+=read;}
  if(size>65536)throw new Error('Evidence size limit');const content=bytes.subarray(0,size),text=content.toString('utf8');if(text.includes('\ufffd'))throw new Error('Evidence must be valid UTF-8 text');checkedText(text,'evidence text',65536);
  return {digest:digest(content),text};
 }finally{closeSync(fd);}
}
export function currentProofStatus(reference,localReference){if(!reference.readAuthorized||!reference.digest||!reference.localPath)return 'unread';try{return readProof(localReference(reference.localPath)).digest===reference.digest?'current':'changed';}catch{return 'unavailable';}}
