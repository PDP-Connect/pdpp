/**
 * Supplementary mutation-killing coverage for the input-normalization and
 * precedence branches of `resolveActivationRefreshContract` in
 * `server/connection-activation-schedules.ts` that the main 6.1 suite leaves
 * open:
 *
 *   - getRefreshPolicy's null-returning guards: manifest null / non-object /
 *     array, capabilities missing / non-object / array, refresh_policy
 *     missing / non-object / array — all default to a background-safe
 *     automatic contract with a 3600s interval and null recommendedMode.
 *   - positiveIntegerOrDefault fallback: zero / negative / float / non-number
 *     recommended_interval_seconds -> the 3600s default.
 *   - recommendedMode normalization: an unknown recommended_mode string -> null
 *     (and still automatic).
 *   - backgroundSafe normalization: a non-boolean background_safe -> null.
 *   - precedence: recommended_mode manual / paused wins over a
 *     background_safe:false (background_unsafe) reason.
 *
 * Schedule/refresh-policy resolution only; no auth/grant logic; no source change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveActivationRefreshContract } from '../server/connection-activation-schedules.ts';

const DEFAULT_AUTOMATIC = {
  backgroundSafe: null,
  intervalSeconds: 3600,
  mode: 'automatic',
  reason: 'automatic',
  recommendedMode: null,
};

function policyManifest(refreshPolicy) {
  return { capabilities: { refresh_policy: refreshPolicy } };
}

test('resolveActivationRefreshContract defaults when the manifest is not a usable object', () => {
  assert.deepEqual(resolveActivationRefreshContract(null), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract(undefined), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract('manifest'), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract([]), DEFAULT_AUTOMATIC);
});

test('resolveActivationRefreshContract defaults when capabilities are missing or not an object', () => {
  assert.deepEqual(resolveActivationRefreshContract({}), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract({ capabilities: 'x' }), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract({ capabilities: [] }), DEFAULT_AUTOMATIC);
});

test('resolveActivationRefreshContract defaults when refresh_policy is missing or not an object', () => {
  assert.deepEqual(resolveActivationRefreshContract({ capabilities: {} }), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract(policyManifest([])), DEFAULT_AUTOMATIC);
  assert.deepEqual(resolveActivationRefreshContract(policyManifest('policy')), DEFAULT_AUTOMATIC);
});

test('resolveActivationRefreshContract falls back to the 3600s default for a non-positive-integer interval', () => {
  for (const bad of [0, -5, 1.5, '900', null, undefined]) {
    assert.equal(
      resolveActivationRefreshContract(policyManifest({ recommended_interval_seconds: bad })).intervalSeconds,
      3600,
      `interval ${JSON.stringify(bad)} should default`,
    );
  }
});

test('resolveActivationRefreshContract keeps a valid positive-integer interval', () => {
  assert.equal(
    resolveActivationRefreshContract(policyManifest({ recommended_interval_seconds: 900 })).intervalSeconds,
    900,
  );
});

test('resolveActivationRefreshContract maps an unknown recommended_mode to null (still automatic)', () => {
  const contract = resolveActivationRefreshContract(
    policyManifest({ recommended_mode: 'weird', background_safe: true }),
  );
  assert.equal(contract.recommendedMode, null);
  assert.equal(contract.mode, 'automatic');
  assert.equal(contract.reason, 'automatic');
});

test('resolveActivationRefreshContract maps a non-boolean background_safe to null', () => {
  const contract = resolveActivationRefreshContract(policyManifest({ background_safe: 'yes' }));
  assert.equal(contract.backgroundSafe, null);
  assert.equal(contract.mode, 'automatic');
});

test('resolveActivationRefreshContract lets recommended_mode manual win over a background-unsafe policy', () => {
  const contract = resolveActivationRefreshContract(
    policyManifest({ recommended_mode: 'manual', background_safe: false }),
  );
  assert.equal(contract.mode, 'manual');
  assert.equal(contract.reason, 'manual');
  assert.equal(contract.backgroundSafe, false);
});

test('resolveActivationRefreshContract lets recommended_mode paused win over a background-unsafe policy', () => {
  const contract = resolveActivationRefreshContract(
    policyManifest({ recommended_mode: 'paused', background_safe: false }),
  );
  assert.equal(contract.mode, 'manual');
  assert.equal(contract.reason, 'paused');
});
