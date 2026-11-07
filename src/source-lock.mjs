import { readFileSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

const HOSTS = ['0.2.1-rc.5'];
const RUNTIMES = ['24.21.0', '26.13.0'];
const COMMIT = '73e0a3b47fb047cc9fe3cd8269a5f267c6cda45c';
const CJK_SHA256 = '95d0db52226fa4719d679a4a4cc2ed0de7f232cf8e2e0d304c9d752af2b6c8cb';
const APPROVED = ['vendor/kovey/cjk.js', 'licenses/Apache-2.0.txt', 'licenses/kovey-package.json', 'THIRD_PARTY_NOTICES.md'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Verify a closed vendor set before evaluating any vendor JavaScript. Not a general JS security scanner. */
export function verifySourceLock(packageRoot, { hostVersion, runtimeVersion = process.versions.node, verifyRuntime = false } = {}) {
  const root = realpathSync(packageRoot);
  const lock = JSON.parse(readFileSync(join(root, 'source-lock.json'), 'utf8'));
  if (lock.schema_version !== 1 || lock.upstream?.commit !== COMMIT) throw new Error('Unapproved source lock version');
  if (JSON.stringify(lock.host_versions) !== JSON.stringify(HOSTS) || (hostVersion !== undefined && !HOSTS.includes(hostVersion))) throw new Error('Unsupported host version');
  if (JSON.stringify(lock.runtime_versions) !== JSON.stringify(RUNTIMES) || !RUNTIMES.includes(runtimeVersion)) throw new Error('Unsupported runtime version');
  if (!Array.isArray(lock.files) || lock.files.length !== APPROVED.length || new Set(lock.files.map(f => f.path)).size !== APPROVED.length || lock.files.some(f => !APPROVED.includes(f.path))) throw new Error('Unapproved vendor closure');
  for (const file of lock.files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || (file.path === APPROVED[0] && file.sha256 !== CJK_SHA256)) throw new Error('Unapproved source digest');
    try {
      let cursor = root;
      for (const part of file.path.split('/')) { cursor = join(cursor, part); if (lstatSync(cursor).isSymbolicLink()) throw new Error('link'); }
      const full = realpathSync(resolve(root, file.path)), rel = relative(root, full);
      if (rel.startsWith('..') || isAbsolute(rel) || hash(readFileSync(full)) !== file.sha256) throw new Error('digest');
    } catch { throw new Error(`Source integrity/license failure: ${file.path}`); }
  }
  function walk(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Undeclared vendor link');
      if (entry.isDirectory()) walk(join(directory, entry.name), path);
      else if (!APPROVED.includes(path)) throw new Error('Undeclared vendor file');
    }
  }
  walk(join(root, 'vendor'), 'vendor');
  if (verifyRuntime) {
    const accepted = [lock.test_runtime?.sha256, lock.host_baseline?.executable_sha256];
    if (!accepted.includes(hash(readFileSync(process.execPath)))) throw new Error('Runtime executable integrity failure');
  }
  return { valid: true, commit: COMMIT, hostVersion, runtimeVersion, files: lock.files.length };
}
