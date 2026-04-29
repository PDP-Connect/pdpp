/**
 * Operation-level behavior tests for `rs.discovery.index`.
 *
 * Pins the cold-start RS discovery envelope shape: object discriminator,
 * resource_server role, fixed link block (well_known, schema,
 * core_query_base, connectors), provider name pass-through, and reference
 * revision pass-through (including the null case).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRsDiscoveryIndex } from '../operations/rs-discovery-index/index.ts';

test('rs.discovery.index returns the canonical pdpp_discovery_index envelope', () => {
  const { envelope } = executeRsDiscoveryIndex({
    providerName: 'Acme Provider',
    referenceRevision: 'rev-001',
  });
  assert.equal(envelope.object, 'pdpp_discovery_index');
  assert.equal(envelope.role, 'resource_server');
  assert.equal(envelope.resource_name, 'Acme Provider');
  assert.equal(envelope.reference_revision, 'rev-001');
});

test('rs.discovery.index emits the fixed pointer block', () => {
  const { envelope } = executeRsDiscoveryIndex({
    providerName: 'X',
    referenceRevision: null,
  });
  assert.deepEqual(envelope.links, {
    well_known: '/.well-known/oauth-protected-resource',
    schema: '/v1/schema',
    core_query_base: '/v1',
    connectors: '/v1/connectors',
  });
});

test('rs.discovery.index passes a null reference_revision through verbatim', () => {
  const { envelope } = executeRsDiscoveryIndex({
    providerName: 'X',
    referenceRevision: null,
  });
  assert.equal(envelope.reference_revision, null);
});
