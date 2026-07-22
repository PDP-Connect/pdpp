// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED manifest-validation shaper
 * `validateRefreshPolicyCapability` (`server/connector-manifest-validation.ts`),
 * plus the `invalidConnectorManifest` error factory it throws through.
 *
 * `validateRefreshPolicyCapability(manifest, code)` inspects
 * `capabilities.refresh_policy` and THROWS a typed `invalidConnectorManifest`
 * error (carrying the supplied `code`) for each distinct violation, or returns
 * (void) when the block is absent or valid. Pinned here:
 *
 *   - ACCEPT: no `capabilities`; `capabilities` present but no `refresh_policy`;
 *     a minimal valid policy (recommended_mode + rationale).
 *   - REJECT (each throws with the passed code): capabilities not an object;
 *     refresh_policy not an object; an unsupported key; a bad recommended_mode;
 *     a missing rationale; a non-positive interval; recommended_interval <
 *     minimum_interval; a bad interaction_posture.
 *
 * invalidConnectorManifest(message, code): an Error whose `.code` is the code.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateRefreshPolicyCapability,
  invalidConnectorManifest,
} from '../server/connector-manifest-validation.ts';

const CODE = 'invalid_connector_manifest';

function validPolicy(overrides = {}) {
  return { capabilities: { refresh_policy: { recommended_mode: 'automatic', rationale: 'because', ...overrides } } };
}

// Assert the call throws an invalidConnectorManifest carrying CODE whose message
// includes `messagePart`.
function assertRejects(manifest, messagePart) {
  assert.throws(
    () => validateRefreshPolicyCapability(manifest, CODE),
    (err) => {
      assert.equal(err.code, CODE, `expected code ${CODE}, got ${err.code}`);
      assert.ok(
        String(err.message).includes(messagePart),
        `message ${JSON.stringify(err.message)} must include ${JSON.stringify(messagePart)}`,
      );
      return true;
    },
  );
}

// --- invalidConnectorManifest factory ---------------------------------------

test('invalidConnectorManifest: is an Error carrying the supplied code', () => {
  const err = invalidConnectorManifest('boom', 'my_code');
  assert.ok(err instanceof Error);
  assert.equal(err.message, 'boom');
  assert.equal(err.code, 'my_code');
});

// --- accept paths -----------------------------------------------------------

test('validateRefreshPolicyCapability: returns for a manifest with no capabilities', () => {
  assert.equal(validateRefreshPolicyCapability({}, CODE), undefined);
  assert.equal(validateRefreshPolicyCapability({ capabilities: null }, CODE), undefined);
});

test('validateRefreshPolicyCapability: returns when capabilities has no refresh_policy', () => {
  assert.equal(validateRefreshPolicyCapability({ capabilities: {} }, CODE), undefined);
});

test('validateRefreshPolicyCapability: accepts a minimal valid policy', () => {
  assert.equal(validateRefreshPolicyCapability(validPolicy(), CODE), undefined);
});

test('validateRefreshPolicyCapability: accepts each valid recommended_mode + valid intervals', () => {
  for (const mode of ['automatic', 'manual', 'paused']) {
    assert.equal(validateRefreshPolicyCapability(validPolicy({ recommended_mode: mode }), CODE), undefined, mode);
  }
  assert.equal(
    validateRefreshPolicyCapability(
      validPolicy({ minimum_interval_seconds: 100, recommended_interval_seconds: 200 }),
      CODE,
    ),
    undefined,
    'recommended >= minimum is valid',
  );
});

// --- reject paths -----------------------------------------------------------

test('validateRefreshPolicyCapability: rejects capabilities that is not an object', () => {
  assertRejects({ capabilities: 'x' }, 'capabilities must be an object');
  assertRejects({ capabilities: [] }, 'capabilities must be an object');
});

test('validateRefreshPolicyCapability: rejects refresh_policy that is not an object', () => {
  assertRejects({ capabilities: { refresh_policy: 'x' } }, 'refresh_policy must be an object');
  assertRejects({ capabilities: { refresh_policy: [] } }, 'refresh_policy must be an object');
});

test('validateRefreshPolicyCapability: rejects an unsupported refresh_policy key', () => {
  assertRejects(validPolicy({ bogus_key: 1 }), 'unsupported keys: bogus_key');
});

test('validateRefreshPolicyCapability: rejects a bad recommended_mode', () => {
  assertRejects(validPolicy({ recommended_mode: 'sometimes' }), 'recommended_mode must be one of');
  // recommended_mode is required — omitting it is also a rejection.
  assertRejects({ capabilities: { refresh_policy: { rationale: 'r' } } }, 'recommended_mode must be one of');
});

test('validateRefreshPolicyCapability: rejects a missing/blank rationale', () => {
  assertRejects({ capabilities: { refresh_policy: { recommended_mode: 'automatic' } } }, 'rationale must be a non-empty');
  assertRejects(validPolicy({ rationale: '   ' }), 'rationale must be a non-empty');
});

test('validateRefreshPolicyCapability: rejects a non-positive interval value', () => {
  assertRejects(validPolicy({ minimum_interval_seconds: 0 }), 'minimum_interval_seconds must be a positive integer');
  assertRejects(validPolicy({ recommended_interval_seconds: -5 }), 'recommended_interval_seconds must be a positive integer');
  assertRejects(validPolicy({ session_lifetime_seconds: 1.5 }), 'session_lifetime_seconds must be a positive integer');
});

test('validateRefreshPolicyCapability: rejects recommended_interval below minimum_interval', () => {
  assertRejects(
    validPolicy({ minimum_interval_seconds: 100, recommended_interval_seconds: 50 }),
    'recommended_interval_seconds must be >= minimum_interval_seconds',
  );
});

test('validateRefreshPolicyCapability: rejects a bad interaction_posture', () => {
  assertRejects(validPolicy({ interaction_posture: 'telepathy' }), 'interaction_posture');
});
