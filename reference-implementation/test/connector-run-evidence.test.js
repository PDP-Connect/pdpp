// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure connector-run-evidence projections.
 *
 * connector-run-evidence.js has no co-named test. The async
 * getLatestConnectorRunSummary needs the spine store and is out of scope
 * here; these tests pin the three pure, synchronous projections directly:
 *   - getConnectorRunEvidenceSource: connector-source id gating,
 *   - getManifestRefreshPolicy: capabilities shape gating,
 *   - getMaximumStalenessSeconds: positive-finite-number gating.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getConnectorRunEvidenceSource,
  getManifestRefreshPolicy,
  getMaximumStalenessSeconds,
} from '../server/connector-run-evidence.ts';

test('getConnectorRunEvidenceSource returns the id only for a connector source', () => {
  assert.equal(getConnectorRunEvidenceSource({ kind: 'connector', id: 'gmail' }), 'gmail');
  assert.equal(getConnectorRunEvidenceSource({ kind: 'provider_native', id: 'apple' }), null);
  assert.equal(getConnectorRunEvidenceSource({ kind: 'connector', id: '' }), null);
  assert.equal(getConnectorRunEvidenceSource({ kind: 'connector' }), null);
  assert.equal(getConnectorRunEvidenceSource(null), null);
});

test('getManifestRefreshPolicy reads capabilities.refresh_policy or null', () => {
  const policy = { mode: 'automatic' };
  assert.deepEqual(getManifestRefreshPolicy({ capabilities: { refresh_policy: policy } }), policy);
  // No refresh_policy -> null.
  assert.equal(getManifestRefreshPolicy({ capabilities: {} }), null);
  // Non-object / array / missing capabilities -> null.
  assert.equal(getManifestRefreshPolicy({ capabilities: [] }), null);
  assert.equal(getManifestRefreshPolicy({ capabilities: 'x' }), null);
  assert.equal(getManifestRefreshPolicy({}), null);
  assert.equal(getManifestRefreshPolicy(null), null);
});

test('getMaximumStalenessSeconds accepts a positive finite number only', () => {
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 3600 }), 3600);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: 0 }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: -1 }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: Infinity }), null);
  assert.equal(getMaximumStalenessSeconds({ maximum_staleness_seconds: '3600' }), null);
  // Non-object / array / null policy -> null.
  assert.equal(getMaximumStalenessSeconds([]), null);
  assert.equal(getMaximumStalenessSeconds(null), null);
});
