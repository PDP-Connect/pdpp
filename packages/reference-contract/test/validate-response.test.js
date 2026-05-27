import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasResponseSchema,
  validateResponse,
} from '../src/index.ts';

// `getRsDiscoveryIndex` is a stable JSON discovery operation whose
// declared 200 response schema does not drift from the reference
// implementation. These tests exercise validateResponse against that
// manifest because it is the canonical "exact-schema" candidate for
// the response-validation canary allowlist in the reference transport.

test('hasResponseSchema reports declared response statuses', () => {
  assert.equal(hasResponseSchema('getRsDiscoveryIndex', 200), true);
  // The discovery operation does not declare a 418 response.
  assert.equal(hasResponseSchema('getRsDiscoveryIndex', 418), false);
  // Unknown operation ids report no schema.
  assert.equal(hasResponseSchema('definitely-not-a-real-op', 200), false);
});

test('validateResponse passes a valid discovery envelope unchanged', () => {
  const payload = {
    object: 'pdpp_discovery_index',
    role: 'resource_server',
    resource_name: 'PDPP Reference',
    links: {
      well_known: '/.well-known/oauth-protected-resource',
      schema: '/v1/schema',
      core_query_base: '/v1',
      connectors: '/v1/connectors',
    },
    reference_revision: 'dev',
  };
  const before = JSON.stringify(payload);
  const result = validateResponse('getRsDiscoveryIndex', {
    status: 200,
    body: payload,
  });
  assert.deepEqual(result, { ok: true, skipped: false });
  // Validation must not mutate the input payload.
  assert.equal(JSON.stringify(payload), before);
});

test('validateResponse reports skip with reason for unknown operation ids', () => {
  const result = validateResponse('definitely-not-a-real-op', {
    status: 200,
    body: {},
  });
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: 'unknown_operation_id',
  });
});

test('validateResponse reports skip when no schema is declared for a status', () => {
  const result = validateResponse('getRsDiscoveryIndex', {
    status: 204,
    body: undefined,
  });
  assert.deepEqual(result, {
    ok: true,
    skipped: true,
    reason: 'no_schema_for_status',
  });
});

test('validateResponse fails closed when payload violates declared response schema', () => {
  // Missing required `links` field.
  const invalidPayload = {
    object: 'pdpp_discovery_index',
    role: 'resource_server',
    resource_name: 'PDPP Reference',
    reference_revision: 'dev',
  };
  const result = validateResponse('getRsDiscoveryIndex', {
    status: 200,
    body: invalidPayload,
  });
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors));
  assert.ok(result.errors.length > 0);
  // Each error carries a structured message — useful for operator logs
  // even though the wire envelope is intentionally opaque.
  for (const err of result.errors) {
    assert.equal(typeof err.message, 'string');
  }
});
