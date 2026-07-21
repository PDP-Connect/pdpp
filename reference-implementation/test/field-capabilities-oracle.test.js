// Pure-logic oracle for buildFieldCapabilities (server/schema-capabilities.js),
// the field_capabilities read-model the MCP schema tool advertises. It is a pure
// per-field projection (its six lookup structures were decomplected into an
// explicit ctx) yet has ZERO by-name coverage. It emits the per-field grant
// decision, the declared type/role passthrough, the exact/range/lexical/semantic/
// aggregation capability flags (usable = declared AND granted), and the public
// field_not_granted reason on a declared-but-ungranted flag. Observation-only of
// the grant read; no behavior change. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFieldCapabilities } from '../server/schema-capabilities.js';

const MANIFEST_STREAM = {
  schema: {
    properties: {
      amount: { type: 'number', x_pdpp_type: 'currency', x_pdpp_role: 'metric' },
      body: { type: 'string' },
      secret: { type: 'string' },
    },
  },
  query: {
    range_filters: { amount: ['gte', 'lte'] },
    search: { lexical_fields: ['body'], semantic_fields: ['body'] },
    aggregations: { sum: ['amount'], group_by: ['amount'] },
  },
};

test('buildFieldCapabilities projects a granted field with declared type/role and capability flags', () => {
  const caps = buildFieldCapabilities(MANIFEST_STREAM, { fields: ['amount', 'body'] });
  const amount = caps.amount;
  assert.equal(amount.type, 'currency'); // from x_pdpp_type
  assert.equal(amount.role, 'metric'); // from x_pdpp_role
  assert.equal(amount.granted, true);
  assert.deepEqual(amount.exact_filter, { declared: true, usable: true });
  assert.deepEqual(amount.range_filter, { declared: true, usable: true, operators: ['gte', 'lte'] });
  assert.deepEqual(amount.aggregation.sum, { declared: true, usable: true });
  assert.deepEqual(amount.aggregation.group_by, { declared: true, usable: true });
  // Undeclared aggregations are declared:false/usable:false.
  assert.deepEqual(amount.aggregation.min, { declared: false, usable: false });
});

test('buildFieldCapabilities marks an ungranted field with field_not_granted on its declared flags', () => {
  const caps = buildFieldCapabilities(MANIFEST_STREAM, { fields: ['amount', 'body'] });
  const secret = caps.secret; // not in the grant
  assert.equal(secret.granted, false);
  // exact_filter is declared (string field) but ungranted => not usable, with reason.
  assert.equal(secret.exact_filter.declared, true);
  assert.equal(secret.exact_filter.usable, false);
  assert.equal(secret.exact_filter.reason, 'field_not_granted');
});

test('buildFieldCapabilities reflects lexical/semantic search declarations per field', () => {
  const caps = buildFieldCapabilities(MANIFEST_STREAM, { fields: ['amount', 'body'] });
  assert.deepEqual(caps.body.lexical_search, { declared: true, usable: true });
  assert.deepEqual(caps.body.semantic_search, { declared: true, usable: true });
  // amount is neither a lexical nor a semantic field.
  assert.deepEqual(caps.amount.lexical_search, { declared: false, usable: false });
  assert.deepEqual(caps.amount.semantic_search, { declared: false, usable: false });
});

test('buildFieldCapabilities: a null grant (owner/unfiltered) marks every field granted', () => {
  const caps = buildFieldCapabilities(MANIFEST_STREAM, null);
  assert.equal(caps.secret.granted, true);
  assert.equal(caps.secret.exact_filter.usable, true);
  assert.ok(!('reason' in caps.secret.exact_filter), 'a granted flag carries no field_not_granted reason');
});
