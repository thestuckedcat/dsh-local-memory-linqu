import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,normalize,parse,resolve} from 'node:path';

/**
 * Local data-root / layout validation for the cold-tier boundary (MEM-301 subset).
 *
 * This module only validates and plans paths; it never creates the production data root and never
 * moves memory data. Cold transfer, recall and deletion cleanup remain later increments.
 */
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

export function planLayout(root) {
  if (typeof root !== 'string' || root.trim() === '') throw new Error('Local data root required');
  const resolved = resolve(root);
  return Object.freeze({
    root: resolved,
    hot: join(resolved, 'hot'),
    cold: join(resolved, 'cold'),
    authority: join(resolved, 'authority'),
    staging: join(resolved, 'staging'),
    reports: join(resolved, 'reports'),
    coldJournal: join(resolved, 'cold', 'journal'),
  });
}

function reject(message) {
  const error = new Error(message);
  error.code = 'MEM_LAYOUT_REJECTED';
  throw error;
}

/**
 * Validate an already-provisioned local, fixed-volume data root.
 * `allowC` exists only for isolated test fixtures on the system drive; production must pass false.
 * `volumeProbe` is an injected OS probe returning {type:'fixed'|'network'|'removable'|'unknown'}.
 */
export function validateLocalRoot(root, {
  sourceRoot,
  allowC = false,
  platform = process.platform,
  volumeProbe,
  lstat = lstatSync,
  realpath = realpathSync,
  requireVolumeType = false,
} = {}) {
  if (typeof root !== 'string' || root.trim() === '') reject('Local data root required');
  if (!isAbsolute(root)) reject('Local data root must be absolute');
  if (root.startsWith('\\\\') || root.startsWith('//')) reject('UNC/network data roots are not allowed');
  const resolved = normalize(resolve(root));
  if (resolved.split(/[\\/]+/).includes('..')) reject('Data root must not contain parent traversal');
  if (sourceRoot !== undefined) {
    const source = normalize(resolve(sourceRoot));
    const withSeparator = source.endsWith('\\') || source.endsWith('/') ? source : `${source}${platform === 'win32' ? '\\' : '/'}`;
    if (resolved === source || resolved.startsWith(withSeparator)) reject('Data root must be independent from the plugin/source tree');
  }
  const parsed = parse(resolved);
  let drive;
  if (platform === 'win32') {
    drive = parsed.root.replace(/[\\/]+$/, '');
    if (!WINDOWS_DRIVE.test(drive)) reject('Data root must be on a local drive');
    if (!allowC && drive.toUpperCase() === 'C:') reject('Production data root must not be on the C: system drive');
  }
  let stat;
  try { stat = lstat(resolved); } catch { reject('Local data root must already exist'); }
  if (!stat.isDirectory()) reject('Local data root must be a directory');
  if (stat.isSymbolicLink()) reject('Data root must not be a symlink/junction');
  let current = parsed.root || resolved[0];
  const separator = platform === 'win32' ? '\\' : '/';
  for (const part of resolved.slice(current.length).split(/[\\/]+/).filter(Boolean)) {
    current = `${current}${current.endsWith('\\') || current.endsWith('/') ? '' : separator}${part}`;
    const info = lstat(current);
    if (info.isSymbolicLink()) reject('Data root path must not contain symlinks/junctions');
  }
  let real;
  try { real = realpath(resolved); } catch { reject('Data root real path unavailable'); }
  if ((platform === 'win32' ? normalize(real).toLowerCase() : normalize(real)) !== (platform === 'win32' ? resolved.toLowerCase() : resolved)) reject('Data root real path changed or is linked');
  let volumeType = 'unknown';
  if (typeof volumeProbe === 'function') {
    const value = volumeProbe(platform === 'win32' ? drive : parsed.root);
    if (!value || typeof value !== 'object' || !['fixed', 'network', 'removable', 'unknown'].includes(value.type)) reject('Volume type probe failed');
    volumeType = value.type;
    if (volumeType === 'network' || volumeType === 'removable') reject('Data root must be on a fixed local volume');
  }
  if (requireVolumeType && volumeType !== 'fixed') reject('Fixed local volume required for the cold tier');
  return Object.freeze({root: resolved, drive: drive ?? parsed.root, volumeType, layout: planLayout(resolved)});
}
