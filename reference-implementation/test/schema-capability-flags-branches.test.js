/**
 * Branch coverage for `formatFieldCapabilityFlags`
 * (`operations/rs-schema-get/compact-view.ts`) — the terse per-field capability
 * flag string used by the compact REST schema view.
 *
 * The sibling `rs-schema-compact-view.test.js` pins two cases (all-usable, and
 * `g=false` + `eq=unusable:reason`). This file pins the flag-vocabulary branches
 * those two don't reach:
 *   - non-object / empty input => the literal "declared";
 *   - declared type resolved from `schema.type` (string AND array-joined) when
 *     no top-level `type`;
 *   - range: usable WITHOUT operators => bare `r`; unusable => `r=unusable:reason`;
 *   - exact/lexical/semantic unusable => `<flag>=unusable` (with `:reason` only
 *     when a reason is present);
 *   - aggregation with multiple usable ops => `a=op1|op2` (usable-only, joined);
 *   - a field whose only capability is `{declared:true}` (not usable) => just its
 *     type (or "declared" when there is nothing at all).
 *
 * Pure — no DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatFieldCapabilityFlags } from '../operations/rs-schema-get/compact-view.ts';

test('formatFieldCapabilityFlags: non-object or empty input yields the literal "declared"', () => {
  assert.equal(formatFieldCapabilityFlags(null), 'declared', 'null');
  assert.equal(formatFieldCapabilityFlags(undefined), 'declared', 'undefined');
  assert.equal(formatFieldCapabilityFlags('string'), 'declared', 'non-object string');
  assert.equal(formatFieldCapabilityFlags(42), 'declared', 'number');
  assert.equal(formatFieldCapabilityFlags([]), 'declared', 'array is not a plain object');
  assert.equal(formatFieldCapabilityFlags({}), 'declared', 'empty object => no flags => declared');
});

test('formatFieldCapabilityFlags: declared type is read from schema.type when no top-level type', () => {
  assert.equal(formatFieldCapabilityFlags({ schema: { type: 'integer' } }), 't=integer', 'string schema type');
  assert.equal(
    formatFieldCapabilityFlags({ schema: { type: ['string', 'null'] } }),
    't=string|null',
    'array schema type is pipe-joined',
  );
});

test('formatFieldCapabilityFlags: top-level type wins over schema.type', () => {
  assert.equal(
    formatFieldCapabilityFlags({ type: 'string', schema: { type: 'integer' } }),
    't=string',
    'explicit type takes precedence',
  );
});

test('formatFieldCapabilityFlags: range usable without operators emits a bare "r"', () => {
  assert.equal(
    formatFieldCapabilityFlags({ type: 'number', range_filter: { declared: true, usable: true } }),
    't=number,r',
  );
});

test('formatFieldCapabilityFlags: range unusable emits r=unusable with the reason suffix', () => {
  assert.equal(
    formatFieldCapabilityFlags({ type: 'number', range_filter: { declared: true, usable: false, reason: 'no_index' } }),
    't=number,r=unusable:no_index',
  );
});

test('formatFieldCapabilityFlags: eq unusable WITHOUT a reason has no suffix', () => {
  assert.equal(
    formatFieldCapabilityFlags({ type: 'string', exact_filter: { declared: true, usable: false } }),
    't=string,eq=unusable',
  );
});

test('formatFieldCapabilityFlags: a usable eq/lex/sem emits the bare flag (no =unusable)', () => {
  // The usable branch of addCapabilityFlag emits just the flag name.
  assert.equal(
    formatFieldCapabilityFlags({
      type: 'string',
      exact_filter: { declared: true, usable: true },
      lexical_search: { declared: true, usable: true },
      semantic_search: { declared: true, usable: true },
    }),
    't=string,eq,lex,sem',
  );
});

test('formatFieldCapabilityFlags: lexical/semantic unusable flags carry a reason only when present', () => {
  assert.equal(
    formatFieldCapabilityFlags({
      type: 'string',
      lexical_search: { declared: true, usable: false, reason: 'not_indexed' },
      semantic_search: { declared: true, usable: false },
    }),
    't=string,lex=unusable:not_indexed,sem=unusable',
  );
});

test('formatFieldCapabilityFlags: aggregation lists only USABLE ops, pipe-joined', () => {
  assert.equal(
    formatFieldCapabilityFlags({
      type: 'number',
      aggregation: {
        count: { declared: true, usable: true },
        sum: { declared: true, usable: true },
        avg: { declared: true, usable: false, reason: 'x' },
      },
    }),
    't=number,a=count|sum',
    'avg (unusable) is excluded; count+sum joined',
  );
});

test('formatFieldCapabilityFlags: a declared-but-not-usable capability contributes no flag', () => {
  // exact_filter is declared but neither usable nor declared+usable:false, so it
  // adds nothing — only the type remains.
  assert.equal(
    formatFieldCapabilityFlags({ type: 'string', exact_filter: { declared: true } }),
    't=string',
  );
  // And with no type either, the whole thing collapses to "declared".
  assert.equal(formatFieldCapabilityFlags({ exact_filter: { declared: true } }), 'declared');
});
