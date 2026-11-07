import { createHash } from 'node:crypto';

const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|password|passwd|secret|access[_-]?token|authorization|cookie)\s*["']?\s*[:=]\s*["']?\S{4,}|\bBearer\s+\S{8,}|\bsk-[A-Za-z0-9_-]{16,}|https?:\/\/[^\s/@]+:[^\s/@]+@)/i;
export const digest = value => createHash('sha256').update(value).digest('hex');
export function checkedText(value, label = 'text', max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`Invalid ${label}`);
  if (SECRET.test(value)) throw new Error('Secret-bearing input rejected');
  return value.trim();
}
export function checkedScope(value) { return checkedText(value, 'scope', 2048); }
export function assertClean(value) { checkedText(JSON.stringify(value), 'payload', 100000); }
