import {checkedText,digest} from './scope.mjs';
export function shape(value,fields,label='object') {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).some(k=>!fields.includes(k)))throw new Error(`Invalid ${label} field/schema`);
 return value;
}
export function clean(value,depth=0) {
 if(depth>12)throw new Error('Input nesting limit');
 if(typeof value==='string'){if(value)checkedText(value,'payload',100000);return;}
 if(value===null||typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))return;
 if(Array.isArray(value)){if(value.length>1000)throw new Error('Input size limit');for(const item of value)clean(item,depth+1);return;}
 if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype){if(Object.keys(value).length>100)throw new Error('Input size limit');for(const [k,v]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(k))throw new Error('Invalid object key');clean(k,depth+1);if(v!==undefined)clean(v,depth+1);}return;}
 throw new Error('Invalid payload type');
}
export function canonical(value) {
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
 return JSON.stringify(value);
}
export const fingerprint=value=>digest(canonical(value));
export function sourceIdentity(value){shape(value,['sourceRef','sourceVersion','fragmentRef'],'source');return {sourceRef:checkedText(value.sourceRef,'source reference',2048),sourceVersion:checkedText(value.sourceVersion,'source version',512),fragmentRef:checkedText(value.fragmentRef??'whole','fragment reference',512)};}
export function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`Invalid ${label}`);return value;}
