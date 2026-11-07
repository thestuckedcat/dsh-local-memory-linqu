import { realpathSync, lstatSync } from 'node:fs';
import { resolve, parse, join } from 'node:path';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
const SECRET = /-----BEGIN (?:\w+ )?PRIVATE KEY-----|\bBearer\s+[^\s]{8,}|\bsk-[A-Za-z0-9_-]{16,}|https?:\/\/[^\s/@]+:[^\s/@]+@/i;
function hasCredentialAssignment(text) {
  // Consume only assignment heads; a benign value must not swallow a later secret key.
  const assignments = text.matchAll(/(?<![A-Za-z0-9_])["']?([A-Za-z_][A-Za-z0-9_.-]{0,127})["']?\s*[:=]\s*["']?(?=[^\s"']{4,})/g);
  for (const [, label] of assignments) {
    const normalized = label.replace(/([A-Z]+)([A-Z][a-z])/g,'$1_$2').replace(/([a-z0-9])([A-Z])/g,'$1_$2').replace(/[.-]/g,'_').toLowerCase();
    if (/(?:api_?key|password|passwd|secret|token|access_?key|private_?key|authorization|cookie)(?:_?\d+)?$/.test(normalized)) return true;
  }
  return false;
}
export function checkedText(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${label}`);
  if (SECRET.test(value) || hasCredentialAssignment(value)) throw new Error(`Secret-like ${label} rejected`);
  return value.trim();
}
// Current deployment's trusted volume snapshot, checked with GetDriveTypeW (DRIVE_FIXED=3).
// Host activation must revalidate it; unknown drives are never probed as candidate paths.
const APPROVED_FIXED_DRIVES = Object.freeze(['C:', 'E:', 'H:']);
/** Reject nonlocal syntax before I/O, then walk from a proven local root downwards. */
export function checkedPath(path) {
  path = checkedText(path, 'path', 4096);
  if (process.platform !== 'win32' || !/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}/.test(path) || path.includes(':', 2)) throw new Error('Only local absolute drive paths are admitted');
  const drive = path.slice(0,2).toUpperCase();
  if (!APPROVED_FIXED_DRIVES.includes(drive)) throw new Error('Drive has no approved local-volume proof');
  path = resolve(path);
  const root = parse(path).root;
  let cursor = root;
  for (const part of ['', ...path.slice(root.length).split(/[\\/]/).filter(Boolean)]) {
    if (part) cursor = join(cursor, part);
    let stat;
    try { stat = lstatSync(cursor); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Memory path cannot contain a link');
  }
  return path;
}
export function createScope({ projectRoot, worktreeRoot, revision, buildVariant } = {}) {
  const canonical = input => {
    const path = realpathSync(checkedPath(input));
    if (!lstatSync(path).isDirectory()) throw new Error('Scope root must be a directory');
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  const identity = { projectRoot: canonical(projectRoot), worktreeRoot: canonical(worktreeRoot), revision: checkedText(revision, 'revision', 512), buildVariant: checkedText(buildVariant, 'build variant', 2048) };
  return `workspace-v1:${digest(JSON.stringify(identity))}`;
}
