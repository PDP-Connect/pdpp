// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit test for the AS cold-start discovery-index operation in
// operations/as-discovery-index/index.ts. No test imports this module by name.
// It builds the wire envelope returned at the AS root (GET /) — a stable
// discovery contract clients rely on to find the authorization-server metadata.
//
// Mutation surface: fixed object/role tags, the canonical well-known link, and
// the passthrough of providerName -> resource_name and referenceRevision.

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeAsDiscoveryIndex } from '../operations/as-discovery-index/index.ts';

test('executeAsDiscoveryIndex: builds the canonical discovery-index envelope', () => {
  const out = executeAsDiscoveryIndex({ providerName: 'Acme PDPP', referenceRevision: 'v0.1.0-abc123' });
  assert.equal(out.object, 'pdpp_discovery_index', 'stable object tag');
  assert.equal(out.role, 'authorization_server', 'AS role');
  assert.equal(out.resource_name, 'Acme PDPP', 'provider name -> resource_name');
  assert.equal(out.reference_revision, 'v0.1.0-abc123', 'revision passed through');
  assert.equal(
    out.links.well_known_authorization_server,
    '/.well-known/oauth-authorization-server',
    'canonical AS metadata discovery link',
  );
});

test('executeAsDiscoveryIndex: distinct inputs are reflected in the envelope (no hard-coding of dynamic fields)', () => {
  const a = executeAsDiscoveryIndex({ providerName: 'A', referenceRevision: 'r1' });
  const b = executeAsDiscoveryIndex({ providerName: 'B', referenceRevision: 'r2' });
  assert.notEqual(a.resource_name, b.resource_name, 'resource_name tracks providerName');
  assert.notEqual(a.reference_revision, b.reference_revision, 'reference_revision tracks input');
});
