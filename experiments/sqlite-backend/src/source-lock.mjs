import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export function verifySourceLock(root, { hostVersion, verifyRuntime = false } = {}) {
  root = realpathSync(root);
  const lock = JSON.parse(readFileSync(resolve(root, 'source-lock.json'), 'utf8'));
  if (lock.schema_version !== 1 || !lock.host_versions.includes(hostVersion)) throw new Error('Unsupported host version');
  for (const file of lock.files) {
    const path = realpathSync(resolve(root, file.path)), rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../')) throw new Error('Source integrity path escape');
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256) throw new Error('Source integrity digest mismatch');
  }
  if (verifyRuntime && createHash('sha256').update(readFileSync(process.execPath)).digest('hex') !== lock.runtime.sha256) throw new Error('Runtime digest mismatch');
  return { valid: true, upstream: lock.upstream, files: lock.files.length };
}
