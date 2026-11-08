import assert from 'node:assert/strict';
import test from 'node:test';
import {validateConsolidationOutput} from '../src/consolidation-output.mjs';
import {fingerprint} from '../src/validation.mjs';

function setup({texts = ['Descriptor reclamation waits for completion.', 'Descriptor reclamation waits for completion.', 'Ownership barrier precedes reclamation.'], excerpts = []} = {}) {
  const memories = texts.map((text, index) => ({ref: `m${index}`, text, kind: 'lesson'}));
  const input = {schema_version: 1, mode: 'memory_only', context: {}, memories, excerpts: []};
  const manifest = {
    schemaVersion: 1,
    manifestDigest: 'manifest-digest',
    inputDigest: fingerprint(input),
    memories: memories.map((memory) => ({ref: memory.ref, id: `memory-${memory.ref}`})),
    excerpts,
    buildVerification: 'unknown',
    route: {routeRef: 'memory-default', provider: 'deepseek-official', model: 'deepseek-flash', routeVersion: 'route-v1'},
  };
  return {input, manifest};
}
function group(overrides = {}) {
  return {
    key: 'g0', type: 'duplicates', memoryRefs: ['m0'], statement: 'Descriptor reclamation waits for completion.',
    status: 'unverified', support: [{memoryRef: 'm0', excerptRefs: []}], applicability: 'same_scope_only',
    freshness: {status: 'unknown', reason: 'no explicit time evidence'}, ...overrides,
  };
}
function output(overrides = {}) {
  return JSON.stringify({schema_version: 1, groups: [], untouched: ['m0', 'm1', 'm2'], ...overrides});
}

test('a complete verbatim duplicate group validates with local candidate metadata', () => {
  const {input, manifest} = setup();
  const value = validateConsolidationOutput(output({
    groups: [group({memoryRefs: ['m0', 'm1'], support: [{memoryRef: 'm0', excerptRefs: []}, {memoryRef: 'm1', excerptRefs: []}]})],
    untouched: ['m2'],
  }), manifest, input);
  assert.equal(value.schema_version, 1);
  assert.equal(value.groups.length, 1);
  assert.equal(value.coverage.completeForSelection, true);
  assert.equal(value.coverage.completeForScope, false);
  assert.equal(value.verification, 'unverified');
  assert.equal(value.semanticValidation, 'not_performed');
  assert.equal(value.generator, 'memory-consolidate-v1');
  assert.equal(value.manifestDigest, 'manifest-digest');
  assert.ok(value.warnings.includes('build_unverified'));
  assert.ok(value.warnings.includes('freshness_unknown'));
  assert.equal(value.warnings.includes('semantic_support_unverified'), false);
});

test('coverage, unknown refs and duplicate refs fail closed', () => {
  const {input, manifest} = setup();
  const calls = [
    [output({untouched: ['m0', 'm1']}), 'MC_COVERAGE_INCOMPLETE'],
    [output({groups: [{...group({memoryRefs: ['m0']})}, {...group({key: 'g1', type: 'related', memoryRefs: ['m0'], support: [{memoryRef: 'm0', excerptRefs: []}]})}], untouched: ['m1', 'm2']}), 'MC_COVERAGE_INCOMPLETE'],
    [output({untouched: ['m0', 'm1', 'm2', 'm9']}), 'MC_REF_UNKNOWN'],
  ];
  for (const [text, code] of calls) assert.throws(() => validateConsolidationOutput(text, manifest, input), (error) => error.code === code, code);
});

test('support and excerpt references are bounded by the manifest', () => {
  const {input, manifest} = setup();
  const badSupport = JSON.stringify({
    schema_version: 1,
    groups: [group({support: []})],
    untouched: ['m1', 'm2'],
  });
  assert.throws(() => validateConsolidationOutput(badSupport, manifest, input), (error) => error.code === 'MC_SUPPORT_COVERAGE');
  const unknownSupport = JSON.stringify({schema_version: 1, groups: [group({support: [{memoryRef: 'm9', excerptRefs: []}]})], untouched: ['m1', 'm2']});
  assert.throws(() => validateConsolidationOutput(unknownSupport, manifest, input), (error) => error.code === 'MC_REF_UNKNOWN');

  const withExcerpt = setup({excerpts: [{ref: 'f0', memoryRef: 'm0', fragmentId: 'excerpt-1'}]});
  const unpermitted = JSON.stringify({schema_version: 1, groups: [group({support: [{memoryRef: 'm0', excerptRefs: ['f9']}]})], untouched: ['m1', 'm2']});
  assert.throws(() => validateConsolidationOutput(unpermitted, withExcerpt.manifest, withExcerpt.input), (error) => error.code === 'MC_EXCERPT_NOT_PERMITTED');
});

test('duplicates require verbatim text and source_correction requires a permitted excerpt', () => {
  const {input, manifest} = setup({
    texts: ['Descriptor reclamation waits for completion.', 'Descriptor  reclamation waits for completion.'],
  });
  const nonVerbatim = JSON.stringify({schema_version: 1, groups: [group({memoryRefs: ['m0', 'm1'], support: [{memoryRef: 'm0', excerptRefs: []}, {memoryRef: 'm1', excerptRefs: []}]})], untouched: []});
  assert.throws(() => validateConsolidationOutput(nonVerbatim, manifest, input), (error) => error.code === 'MC_DUPLICATE_VERBATIM_REQUIRED');

  const correction = JSON.stringify({schema_version: 1, groups: [group({type: 'source_correction', status: 'hypothesis'})], untouched: ['m1', 'm2']});
  assert.throws(() => validateConsolidationOutput(correction, manifest, input), (error) => error.code === 'MC_SOURCE_SUPPORT_REQUIRED');
  const permitted = setup({texts: ['old', 'other', 'third'], excerpts: [{ref: 'f0', memoryRef: 'm0', fragmentId: 'excerpt-1'}]});
  const ok = validateConsolidationOutput(JSON.stringify({
    schema_version: 1,
    groups: [group({type: 'source_correction', status: 'hypothesis', memoryRefs: ['m0'], support: [{memoryRef: 'm0', excerptRefs: ['f0']}]})],
    untouched: ['m1', 'm2'],
  }), permitted.manifest, permitted.input);
  assert.equal(ok.groups[0].type, 'source_correction');
  assert.equal(ok.warnings.includes('user_excerpt_not_host_proof'), true);
});

test('capacity, schema, input digest and warning rules are enforced', () => {
  const {input, manifest} = setup();
  const long = JSON.stringify({schema_version: 1, groups: [group({memoryRefs: ['m0'], statement: 'x'.repeat(385), support: [{memoryRef: 'm0', excerptRefs: []}]})], untouched: ['m1', 'm2']});
  assert.throws(() => validateConsolidationOutput(long, manifest, input), (error) => error.code === 'MC_OUTPUT_INVALID');
  assert.throws(() => validateConsolidationOutput('{not json', manifest, input), (error) => error.code === 'MC_OUTPUT_INVALID');
  assert.throws(() => validateConsolidationOutput(JSON.stringify({schema_version: 1, groups: [], untouched: [], extra: true}), manifest, input), (error) => error.code === 'MC_OUTPUT_INVALID');
  assert.throws(() => validateConsolidationOutput('Bearer ' + 'a'.repeat(20), manifest, input), (error) => error.code === 'MC_SECRET_REJECTED');
  const groups = Array.from({length: 9}, (_, index) => group({key: `g${index}`}));
  assert.throws(() => validateConsolidationOutput(JSON.stringify({schema_version: 1, groups, untouched: ['m0', 'm1', 'm2']}), manifest, input), (error) => error.code === 'MC_OUTPUT_INVALID');

  const related = JSON.stringify({
    schema_version: 1,
    groups: [group({type: 'related', memoryRefs: ['m0'], support: [{memoryRef: 'm0', excerptRefs: []}]})],
    untouched: ['m1', 'm2'],
  });
  assert.equal(validateConsolidationOutput(related, manifest, input).warnings.includes('semantic_support_unverified'), true);
  const mismatched = {...input, memories: input.memories.slice(0, 2)};
  assert.throws(() => validateConsolidationOutput(output(), manifest, mismatched), (error) => error.code === 'MC_INPUT_DIGEST_MISMATCH');
});
