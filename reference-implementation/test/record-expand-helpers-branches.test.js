/**
 * Mutation-killing unit coverage for the pure helpers in
 * `server/record-expand-helpers.js`, excluding `assertRecordIdentity`
 * (already covered directly by `record-identity-validation.test.js`).
 *
 * `normalizeExpandRequest` is exercised only indirectly through the
 * DB-backed expand-hydration integration tests, which hit a handful of its
 * error codes but leave most of the parser's branch matrix — nested-path
 * rejection, empty/whitespace relation names, expand shape guards, the
 * expand_limit shape/positivity/max/cardinality guards, dangling
 * expand_limit relations, duplicate-name dedup, and the insufficient_scope
 * child-grant gate — unpinned. `buildEffectiveFilter`, `normalizePrimaryKey`,
 * `parseIntegerValue`, and `assertSafeJsonField` have no direct coverage at
 * all.
 *
 * A mutant that flips a `<=`/`<` boundary, drops a shape guard, mis-labels an
 * error code (`invalid_expand` vs `insufficient_scope`), or breaks the
 * required-field / request-intersection projection math would survive today.
 *
 * Observation-only: no source logic is changed, including the grant-scope
 * gates (`insufficient_scope`, request∩grant field intersection).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertSafeJsonField,
  buildEffectiveFilter,
  invalidQueryError,
  normalizeExpandRequest,
  normalizePrimaryKey,
  parseIntegerValue,
  SAFE_JSON_FIELD,
} from '../server/record-expand-helpers.js';

// ─── invalidQueryError ───────────────────────────────────────────────────

test('invalidQueryError defaults to invalid_request', () => {
  const err = invalidQueryError('x');
  assert.equal(err.code, 'invalid_request');
  assert.equal(err.message, 'x');
});

test('invalidQueryError honors an explicit code', () => {
  assert.equal(invalidQueryError('x', 'invalid_expand').code, 'invalid_expand');
});

// ─── normalizePrimaryKey ─────────────────────────────────────────────────

test('normalizePrimaryKey filters non-string / empty entries from an array', () => {
  assert.deepEqual(normalizePrimaryKey(['a', '', 2, 'b']), ['a', 'b']);
});

test('normalizePrimaryKey wraps a non-empty string as a single-field key', () => {
  assert.deepEqual(normalizePrimaryKey('id'), ['id']);
});

test('normalizePrimaryKey returns [] for an empty string', () => {
  assert.deepEqual(normalizePrimaryKey(''), []);
});

test('normalizePrimaryKey returns [] for null / undefined / non-string scalars', () => {
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(undefined), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

// ─── parseIntegerValue ───────────────────────────────────────────────────

test('parseIntegerValue accepts an integer number', () => {
  assert.equal(parseIntegerValue(5), 5);
  assert.equal(parseIntegerValue(-3), -3);
  assert.equal(parseIntegerValue(0), 0);
});

test('parseIntegerValue rejects a non-integer number', () => {
  assert.equal(parseIntegerValue(1.5), null);
});

test('parseIntegerValue parses a trimmed integer string', () => {
  assert.equal(parseIntegerValue(' 7 '), 7);
  assert.equal(parseIntegerValue('-42'), -42);
});

test('parseIntegerValue rejects a non-integer / non-numeric string', () => {
  assert.equal(parseIntegerValue('1.5'), null);
  assert.equal(parseIntegerValue('x'), null);
  assert.equal(parseIntegerValue(''), null);
});

test('parseIntegerValue rejects non-string, non-number inputs', () => {
  assert.equal(parseIntegerValue(null), null);
  assert.equal(parseIntegerValue(undefined), null);
  assert.equal(parseIntegerValue({}), null);
});

// ─── assertSafeJsonField / SAFE_JSON_FIELD ───────────────────────────────

test('SAFE_JSON_FIELD matches an identifier and rejects structural chars', () => {
  assert.ok(SAFE_JSON_FIELD.test('good_field_1'));
  assert.ok(!SAFE_JSON_FIELD.test('1bad'));
  assert.ok(!SAFE_JSON_FIELD.test('a.b'));
  assert.ok(!SAFE_JSON_FIELD.test('a b'));
});

test('assertSafeJsonField accepts a valid identifier', () => {
  assert.doesNotThrow(() => assertSafeJsonField('subject_id', 'sort'));
});

test('assertSafeJsonField rejects an identifier starting with a digit', () => {
  assert.throws(
    () => assertSafeJsonField('1bad', 'sort'),
    (err) => /Unsafe JSON field sort/.test(err.message),
  );
});

test('assertSafeJsonField rejects a dotted / injection path', () => {
  assert.throws(
    () => assertSafeJsonField('a.b', 'filter'),
    (err) => /Unsafe JSON field filter/.test(err.message),
  );
});

test('assertSafeJsonField rejects a non-string field', () => {
  assert.throws(
    () => assertSafeJsonField(5, 'sort'),
    (err) => /Unsafe JSON field/.test(err.message),
  );
});

// ─── buildEffectiveFilter ────────────────────────────────────────────────

test('buildEffectiveFilter carries grant scopes through when no request fields', () => {
  const eff = buildEffectiveFilter(
    { fields: ['a', 'b'], time_range: { since: 'x' }, resources: ['r1'] },
    {},
    [],
  );
  assert.deepEqual(eff, {
    fields: ['a', 'b'],
    timeRange: { since: 'x' },
    resources: ['r1'],
    consentTimeField: null,
  });
});

test('buildEffectiveFilter intersects request fields with a scoped grant and adds required', () => {
  const eff = buildEffectiveFilter(
    { fields: ['a', 'b', 'c'] },
    { fields: ['b', 'c', 'z'] }, // z is not in grant -> dropped
    ['a'], // required -> unioned back in
  );
  assert.deepEqual(eff.fields, ['a', 'b', 'c']);
});

test('buildEffectiveFilter uses request fields verbatim when grant is unscoped', () => {
  const eff = buildEffectiveFilter({}, { fields: ['x', 'y'] }, ['k']);
  assert.deepEqual(eff.fields, ['k', 'x', 'y']);
});

test('buildEffectiveFilter leaves fields null (and injects no required) when nothing scopes them', () => {
  const eff = buildEffectiveFilter({}, {}, ['k']);
  assert.equal(eff.fields, null);
});

test('buildEffectiveFilter dedupes required fields already present', () => {
  const eff = buildEffectiveFilter({ fields: ['a', 'b'] }, {}, ['a']);
  assert.deepEqual(eff.fields, ['a', 'b']);
});

// ─── normalizeExpandRequest ──────────────────────────────────────────────

const MANIFEST_STREAM = {
  relationships: [
    { name: 'attachments', stream: 'files', cardinality: 'has_many' },
    { name: 'author', stream: 'people', cardinality: 'has_one' },
  ],
  query: {
    expand: [
      { name: 'attachments', default_limit: 10, max_limit: 25 },
      { name: 'author', default_limit: 1, max_limit: 1 },
    ],
  },
};

const GRANT = { streams: [{ name: 'files' }, { name: 'people' }] };
const GRANT_NO_FILES = { streams: [{ name: 'people' }] };

function expandThrows(fn, code) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

test('normalizeExpandRequest returns [] when expand is absent or empty', () => {
  assert.deepEqual(normalizeExpandRequest({}, 'messages', GRANT, MANIFEST_STREAM), []);
  assert.deepEqual(normalizeExpandRequest({ expand: '' }, 'messages', GRANT, MANIFEST_STREAM), []);
  assert.deepEqual(normalizeExpandRequest({ expand: null }, 'messages', GRANT, MANIFEST_STREAM), []);
});

test('normalizeExpandRequest compiles a has_many relation with its default limit and order', () => {
  const out = normalizeExpandRequest(
    { expand: 'attachments' },
    'messages',
    GRANT,
    MANIFEST_STREAM,
    'desc',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'attachments');
  assert.equal(out[0].limit, 10);
  assert.equal(out[0].order, 'desc');
  assert.equal(out[0].childGrant.name, 'files');
});

test('normalizeExpandRequest applies a valid custom expand_limit', () => {
  const out = normalizeExpandRequest(
    { expand: 'attachments', expand_limit: { attachments: 5 } },
    'messages',
    GRANT,
    MANIFEST_STREAM,
  );
  assert.equal(out[0].limit, 5);
});

test('normalizeExpandRequest dedupes repeated relation names', () => {
  const out = normalizeExpandRequest(
    { expand: ['attachments', 'attachments'] },
    'messages',
    GRANT,
    MANIFEST_STREAM,
  );
  assert.equal(out.length, 1);
});

test('normalizeExpandRequest rejects expand_limit without expand (both nullish-expand paths)', () => {
  expandThrows(
    () => normalizeExpandRequest({ expand_limit: { attachments: 5 } }, 'messages', GRANT, MANIFEST_STREAM),
    'invalid_expand',
  );
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: '', expand_limit: { attachments: 5 } },
        'messages',
        GRANT,
        MANIFEST_STREAM,
      ),
    'invalid_expand',
  );
});

test('normalizeExpandRequest rejects an object-shaped expand', () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: { x: 1 } }, 'messages', GRANT, MANIFEST_STREAM),
    'invalid_expand',
  );
});

test('normalizeExpandRequest rejects an expand list that trims to nothing', () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: ['  ', ''] }, 'messages', GRANT, MANIFEST_STREAM),
    'invalid_expand',
  );
});

test('normalizeExpandRequest rejects a non-object expand_limit', () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: 'attachments', expand_limit: '5' },
        'messages',
        GRANT,
        MANIFEST_STREAM,
      ),
    'invalid_expand',
  );
});

test('normalizeExpandRequest rejects a nested (dotted) expansion', () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: 'a.b' }, 'messages', GRANT, MANIFEST_STREAM),
    'invalid_expand',
  );
});

test('normalizeExpandRequest rejects an unsupported relation name', () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: 'nope' }, 'messages', GRANT, MANIFEST_STREAM),
    'invalid_expand',
  );
});

test('normalizeExpandRequest fails closed (insufficient_scope) without a child grant', () => {
  expandThrows(
    () => normalizeExpandRequest({ expand: 'attachments' }, 'messages', GRANT_NO_FILES, MANIFEST_STREAM),
    'insufficient_scope',
  );
});

test('normalizeExpandRequest rejects expand_limit on a non-has_many relation', () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: 'author', expand_limit: { author: 1 } },
        'messages',
        GRANT,
        MANIFEST_STREAM,
      ),
    'invalid_expand',
  );
});

test('normalizeExpandRequest rejects a non-positive expand_limit', () => {
  for (const bad of [0, -1, '0', 'x', 2.5]) {
    expandThrows(
      () =>
        normalizeExpandRequest(
          { expand: 'attachments', expand_limit: { attachments: bad } },
          'messages',
          GRANT,
          MANIFEST_STREAM,
        ),
      'invalid_expand',
    );
  }
});

test('normalizeExpandRequest rejects an expand_limit above the relation max_limit', () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: 'attachments', expand_limit: { attachments: 26 } }, // max is 25
        'messages',
        GRANT,
        MANIFEST_STREAM,
      ),
    'invalid_expand',
  );
});

test('normalizeExpandRequest accepts an expand_limit exactly at max_limit', () => {
  const out = normalizeExpandRequest(
    { expand: 'attachments', expand_limit: { attachments: 25 } },
    'messages',
    GRANT,
    MANIFEST_STREAM,
  );
  assert.equal(out[0].limit, 25);
});

test('normalizeExpandRequest rejects an expand_limit for a relation not being expanded', () => {
  expandThrows(
    () =>
      normalizeExpandRequest(
        { expand: 'attachments', expand_limit: { author: 1 } },
        'messages',
        GRANT,
        MANIFEST_STREAM,
      ),
    'invalid_expand',
  );
});

test('normalizeExpandRequest falls back to default_limit=10 / max_limit=50 when capability omits them', () => {
  const stream = {
    relationships: [{ name: 'notes', stream: 'notes_stream', cardinality: 'has_many' }],
    query: { expand: [{ name: 'notes' }] },
  };
  const grant = { streams: [{ name: 'notes_stream' }] };
  const def = normalizeExpandRequest({ expand: 'notes' }, 'messages', grant, stream);
  assert.equal(def[0].limit, 10);
  // 50 is the default ceiling; 50 accepted, 51 rejected.
  assert.equal(
    normalizeExpandRequest({ expand: 'notes', expand_limit: { notes: 50 } }, 'm', grant, stream)[0].limit,
    50,
  );
  expandThrows(
    () => normalizeExpandRequest({ expand: 'notes', expand_limit: { notes: 51 } }, 'm', grant, stream),
    'invalid_expand',
  );
});
