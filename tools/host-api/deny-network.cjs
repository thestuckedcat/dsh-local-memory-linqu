// Audit-process guard only. This is not the production Host egress policy.
const {syncBuiltinESMExports}=require('node:module');
const attempts=[];
const deny=surface=>function(){attempts.push(surface);throw new Error('Network disabled in isolated host API audit');};
for(const [moduleName,methods] of [['node:net',['connect','createConnection']],['node:tls',['connect']],['node:http',['request','get']],['node:https',['request','get']],['node:dgram',['createSocket']]]){
 const api=require(moduleName);for(const method of methods)api[method]=deny(moduleName+'.'+method);
}
require('node:net').Socket.prototype.connect=deny('Socket.connect');
globalThis.fetch=async()=>deny('fetch')();
if(globalThis.WebSocket)globalThis.WebSocket=deny('WebSocket');
globalThis[Symbol.for('local-memory.host-audit.network-attempts')]=attempts;
syncBuiltinESMExports();
