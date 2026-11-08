import { canonical, fingerprint, shape } from './validation.mjs';

/**
 * Strict validator for the `mc-output-v1` model answer (MC-API-03).
 *
 * It validates structure, exact coverage of the selected memories, support/excerpt reference
 * bounds, duplicate-verbatim rules and capacity limits. It does NOT prove that a statement is
 * semantically supported: the returned view always carries `semantic_support_unverified` for
 * non-verbatim groups and the caller must persist `semanticValidation:'not_performed'`.
 */
const MAX_GROUPS = 8;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_OUTPUT_BYTES = 48_000;
const STATEMENT_MAX = 384;
const REASON_MAX = 160;
const GROUP_TYPES = Object.freeze(['duplicates', 'related', 'conflict', 'source_correction']);
const STATUSES = Object.freeze(['unverified', 'hypothesis', 'conflict', 'unknown']);
const APPLICABILITY = Object.freeze(['same_scope_only', 'historical_unknown', 'unknown']);
const FRESHNESS = Object.freeze(['unknown', 'review_needed']);
const SECRET_LIKE = /-----BEGIN (?:\w+ )?PRIVATE KEY-----|\bBearer\s+[^\s]{8,}|\bsk-[A-Za-z0-9_-]{16,}/i;

function failure(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
function codePointLength(value) {
  return Array.from(value).length;
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw failure('MC_OUTPUT_INVALID', `${label} must be a plain object`);
  return value;
}
function exact(value, fields, label) {
  try { shape(value, fields, label); } catch { throw failure('MC_OUTPUT_INVALID', `${label} schema mismatch`); }
  return value;
}
function text(value, label, max) {
  if (typeof value !== 'string' || value.length < 1 || codePointLength(value) > max) throw failure('MC_OUTPUT_INVALID', `${label} must be 1..${max} characters`);
  return value;
}
function inputOf(manifest, inputSnapshot) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.manifestDigest !== 'string' || !Array.isArray(manifest.memories)) throw failure('MC_MANIFEST_REQUIRED');
  plain(inputSnapshot, 'input snapshot');
  exact(inputSnapshot, ['schema_version', 'mode', 'context', 'memories', 'excerpts'], 'input snapshot');
  if (inputSnapshot.schema_version !== 1 || inputSnapshot.mode !== 'memory_only') throw failure('MC_OUTPUT_INVALID', 'unexpected input snapshot mode');
  if (!Array.isArray(inputSnapshot.memories)) throw failure('MC_OUTPUT_INVALID', 'input memories must be an array');
  if (typeof inputSnapshot.excerpts !== 'undefined' && !Array.isArray(inputSnapshot.excerpts)) throw failure('MC_OUTPUT_INVALID', 'input excerpts must be an array');
  if (inputSnapshot.excerpts.length > 0) throw failure('MC_OUTPUT_INVALID', 'excerpts are not supported in this increment');
  if (fingerprint(inputSnapshot) !== manifest.inputDigest) throw failure('MC_INPUT_DIGEST_MISMATCH', 'input snapshot does not match the manifest');
  const byRef = new Map();
  for (const memory of inputSnapshot.memories) {
    plain(memory, 'input memory');
    exact(memory, ['ref', 'text', 'kind'], 'input memory');
    const ref = text(memory.ref, 'input memory ref', 8);
    if (byRef.has(ref)) throw failure('MC_OUTPUT_INVALID', `duplicate input ref ${ref}`);
    if (typeof memory.text !== 'string' || memory.text.length < 1) throw failure('MC_OUTPUT_INVALID', `input memory ${ref} has no text`);
    byRef.set(ref, memory);
  }
  const references = manifest.memories.map((memory) => memory.ref);
  if (references.length !== byRef.size || references.some((ref) => !byRef.has(ref))) throw failure('MC_INPUT_DIGEST_MISMATCH', 'input refs differ from manifest refs');
  const excerptAllowance = new Map();
  for (const excerpt of manifest.excerpts ?? []) {
    if (!excerptAllowance.has(excerpt.memoryRef)) excerptAllowance.set(excerpt.memoryRef, new Set());
    excerptAllowance.get(excerpt.memoryRef).add(excerpt.ref);
  }
  return {byRef, references, excerptAllowance};
}
function normalizedGroup(raw, index, context) {
  plain(raw, 'group');
  exact(raw, ['key', 'type', 'memoryRefs', 'statement', 'status', 'support', 'applicability', 'freshness'], 'group');
  const key = text(raw.key, 'group key', 8);
  if (!/^g[0-7]$/.test(key)) throw failure('MC_OUTPUT_INVALID', 'group keys must be g0..g7');
  if (context.keys.has(key)) throw failure('MC_OUTPUT_INVALID', `duplicate group key ${key}`);
  context.keys.add(key);
  if (!GROUP_TYPES.includes(raw.type)) throw failure('MC_OUTPUT_INVALID', `unknown group type ${raw.type}`);
  if (!STATUSES.includes(raw.status)) throw failure('MC_OUTPUT_INVALID', `unknown group status ${raw.status}`);
  if (!APPLICABILITY.includes(raw.applicability)) throw failure('MC_OUTPUT_INVALID', `unknown group applicability ${raw.applicability}`);
  if (!Array.isArray(raw.memoryRefs) || raw.memoryRefs.length < 1) throw failure('MC_OUTPUT_INVALID', 'group memoryRefs must be non-empty');
  const memoryRefs = raw.memoryRefs.map((ref) => text(ref, 'group memory ref', 8));
  if (new Set(memoryRefs).size !== memoryRefs.length) throw failure('MC_OUTPUT_INVALID', `group ${key} repeats a memory ref`);
  for (const ref of memoryRefs) if (!context.byRef.has(ref)) throw failure('MC_REF_UNKNOWN', `group ${key} references unknown ${ref}`);
  const statement = raw.statement;
  if (typeof statement !== 'string' || codePointLength(statement) < 1 || codePointLength(statement) > STATEMENT_MAX) throw failure('MC_OUTPUT_INVALID', `group ${key} statement must be 1..${STATEMENT_MAX} characters`);
  plain(raw.freshness, 'group freshness');
  exact(raw.freshness, ['status', 'reason'], 'group freshness');
  if (!FRESHNESS.includes(raw.freshness.status)) throw failure('MC_OUTPUT_INVALID', `unknown freshness status ${raw.freshness.status}`);
  const reason = text(raw.freshness.reason, 'freshness reason', REASON_MAX);
  if (!Array.isArray(raw.support)) throw failure('MC_OUTPUT_INVALID', `group ${key} support must be an array`);
  const support = raw.support.map((entry) => {
    plain(entry, 'group support');
    exact(entry, ['memoryRef', 'excerptRefs'], 'group support');
    const memoryRef = text(entry.memoryRef, 'support memory ref', 8);
    if (!Array.isArray(entry.excerptRefs)) throw failure('MC_OUTPUT_INVALID', 'support excerptRefs must be an array');
    const excerptRefs = entry.excerptRefs.map((ref) => text(ref, 'support excerpt ref', 8));
    if (!context.byRef.has(memoryRef)) throw failure('MC_REF_UNKNOWN', `support references unknown ${memoryRef}`);
    if (!memoryRefs.includes(memoryRef)) throw failure('MC_SUPPORT_COVERAGE', `support ${memoryRef} is not in group ${key}`);
    const allowed = context.excerptAllowance.get(memoryRef) ?? new Set();
    for (const ref of excerptRefs) if (!allowed.has(ref)) throw failure('MC_EXCERPT_NOT_PERMITTED', `excerpt ${ref} is not permitted for ${memoryRef}`);
    if (new Set(excerptRefs).size !== excerptRefs.length) throw failure('MC_OUTPUT_INVALID', 'support repeats an excerpt ref');
    return Object.freeze({memoryRef, excerptRefs: Object.freeze(excerptRefs)});
  });
  if (new Set(support.map((entry) => entry.memoryRef)).size !== support.length) throw failure('MC_SUPPORT_COVERAGE', `group ${key} repeats support`);
  if (support.length !== memoryRefs.length || memoryRefs.some((ref) => !support.some((entry) => entry.memoryRef === ref))) {
    throw failure('MC_SUPPORT_COVERAGE', `group ${key} support must cover exactly its memoryRefs`);
  }
  if (raw.type === 'duplicates') {
    const texts = memoryRefs.map((ref) => context.byRef.get(ref).text.trim());
    if (texts.some((value) => value !== texts[0])) throw failure('MC_DUPLICATE_VERBATIM_REQUIRED', `group ${key} is not verbatim-equal after trimming`);
  }
  if (raw.type === 'source_correction') {
    if (raw.status !== 'hypothesis' && raw.status !== 'conflict') throw failure('MC_SOURCE_CORRECTION_STATUS', `group ${key} source_correction status must be hypothesis/conflict`);
    for (const ref of memoryRefs) {
      const allowed = context.excerptAllowance.get(ref);
      const cited = support.find((entry) => entry.memoryRef === ref)?.excerptRefs ?? [];
      if (!allowed || allowed.size === 0 || cited.length === 0) throw failure('MC_SOURCE_SUPPORT_REQUIRED', `source_correction ${ref} needs a permitted excerpt`);
    }
  }
  return Object.freeze({
    key, type: raw.type, memoryRefs: Object.freeze(memoryRefs), statement,
    status: raw.status, support: Object.freeze(support), applicability: raw.applicability,
    freshness: Object.freeze({status: raw.freshness.status, reason}),
  });
}
function warningsFor(groups, manifest) {
  const warnings = new Set();
  if (manifest.buildVerification === 'unknown') warnings.add('build_unverified');
  for (const group of groups) {
    if (group.freshness.status === 'unknown') warnings.add('freshness_unknown');
    if (group.type === 'conflict') warnings.add('conflict_unresolved');
    if (group.type !== 'duplicates') warnings.add('semantic_support_unverified');
  }
  if ((manifest.excerpts ?? []).length > 0) warnings.add('user_excerpt_not_host_proof');
  return Object.freeze([...warnings].sort());
}

export function validateConsolidationOutput(textValue, manifest, inputSnapshot) {
  if (typeof textValue !== 'string') throw failure('MC_OUTPUT_INVALID', 'model output must be a string');
  if (codePointLength(textValue) > MAX_OUTPUT_CHARS) throw failure('MC_OUTPUT_TOO_LARGE', 'model output exceeds the character limit');
  if (Buffer.byteLength(textValue, 'utf8') > MAX_OUTPUT_BYTES) throw failure('MC_OUTPUT_TOO_LARGE', 'model output exceeds the byte limit');
  if (SECRET_LIKE.test(textValue)) throw failure('MC_SECRET_REJECTED', 'model output contains a secret-like token');
  let parsed;
  try { parsed = JSON.parse(textValue); } catch { throw failure('MC_OUTPUT_INVALID', 'model output is not valid JSON'); }
  plain(parsed, 'model output');
  exact(parsed, ['schema_version', 'groups', 'untouched'], 'model output');
  if (parsed.schema_version !== 1) throw failure('MC_OUTPUT_INVALID', 'unsupported output schema');
  const input = inputOf(manifest, inputSnapshot);
  if (!Array.isArray(parsed.groups) || parsed.groups.length > MAX_GROUPS) throw failure('MC_OUTPUT_INVALID', `at most ${MAX_GROUPS} groups are allowed`);
  if (!Array.isArray(parsed.untouched)) throw failure('MC_OUTPUT_INVALID', 'untouched must be an array');
  const context = {byRef: input.byRef, excerptAllowance: input.excerptAllowance, keys: new Set()};
  const groups = parsed.groups.map((group, index) => normalizedGroup(group, index, context));
  const covered = new Set();
  for (const group of groups) for (const ref of group.memoryRefs) {
    if (covered.has(ref)) throw failure('MC_COVERAGE_INCOMPLETE', `memory ${ref} appears in more than one group`);
    covered.add(ref);
  }
  const untouched = parsed.untouched.map((ref) => text(ref, 'untouched ref', 8));
  if (new Set(untouched).size !== untouched.length) throw failure('MC_OUTPUT_INVALID', 'untouched repeats a memory ref');
  for (const ref of untouched) {
    if (!input.byRef.has(ref)) throw failure('MC_REF_UNKNOWN', `untouched references unknown ${ref}`);
    if (covered.has(ref)) throw failure('MC_COVERAGE_INCOMPLETE', `memory ${ref} is both grouped and untouched`);
    covered.add(ref);
  }
  for (const ref of input.references) if (!covered.has(ref)) throw failure('MC_COVERAGE_INCOMPLETE', `memory ${ref} is not covered`);
  const warnings = warningsFor(groups, manifest);
  return Object.freeze({
    schema_version: 1,
    groups: Object.freeze(groups),
    untouched: Object.freeze(untouched),
    coverage: Object.freeze({selected: input.references.length, completeForSelection: true, completeForScope: false}),
    warnings,
    verification: 'unverified',
    semanticValidation: 'not_performed',
    generator: 'memory-consolidate-v1',
    manifestDigest: manifest.manifestDigest,
    route: Object.freeze({...manifest.route}),
    canonical: canonical({groups, untouched}),
  });
}
