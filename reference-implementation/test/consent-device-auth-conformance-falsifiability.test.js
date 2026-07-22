// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Falsifiability proof for the consent + owner-device-auth conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver whose
 * lifecycle is non-conformant in three specific ways:
 *
 *   1. Pending consent re-approval is allowed (terminal-state violation).
 *   2. Owner-device denial does not transition the row to `denied`, so
 *      the polling exchange never reports `access_denied`.
 *   3. Owner-device polling-rate enforcement is missing, so a back-to-back
 *      poll returns `authorization_pending` instead of `slow_down`.
 *
 * If the harness is sound, at least one scenario MUST fail when exercised
 * against this broken driver. If every scenario passed, the harness would
 * be a green-path wrapper rather than a real conformance gate, and this
 * test would refuse to confirm coverage.
 *
 * Specifically, this test asserts:
 *   - the pending-consent terminal-approval scenario fails (break 1),
 *   - the owner-device denial scenario fails (break 2),
 *   - the owner-device polling-rate scenario fails (break 3).
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-consent-device-auth-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokenInMemoryConsentDeviceAuthDriver } from './helpers/broken-consent-device-auth-driver.js';
import { runConsentDeviceAuthConformance } from './helpers/consent-device-auth-conformance.js';

test('harness detects at least one consent/device-auth invariant violation in a broken driver', async () => {
  const scenarios = [];
  const collect = (name, fn) => {
    scenarios.push({ name, fn });
  };

  runConsentDeviceAuthConformance({
    label: 'broken-in-memory',
    test: collect,
    makeDriver: () => createBrokenInMemoryConsentDeviceAuthDriver(),
  });

  assert.ok(scenarios.length > 0, 'harness must register at least one scenario');

  const outcomes = [];
  for (const scenario of scenarios) {
    try {
      await scenario.fn();
      outcomes.push({ name: scenario.name, ok: true });
    } catch (err) {
      outcomes.push({
        name: scenario.name,
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failures = outcomes.filter((o) => !o.ok);
  assert.ok(
    failures.length > 0,
    `harness did not catch any broken-driver invariant — coverage may be theater. outcomes=${JSON.stringify(outcomes, null, 2)}`,
  );

  // BREAK 1: pending-consent re-approval slips through.
  const terminalApproveFailed = failures.some((f) =>
    /pending consent: approval is terminal/.test(f.name),
  );
  assert.ok(
    terminalApproveFailed,
    `expected the pending-consent terminal-approval scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );

  // BREAK 2: owner-device denial does not flip status, so exchange never
  // reports access_denied.
  const denialTerminalFailed = failures.some((f) =>
    /owner device auth: denial is terminal/.test(f.name),
  );
  assert.ok(
    denialTerminalFailed,
    `expected the owner-device denial-terminal scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );

  // BREAK 3: polling-rate enforcement is missing.
  const slowDownFailed = failures.some((f) =>
    /owner device auth: polling faster than the interval/.test(f.name),
  );
  assert.ok(
    slowDownFailed,
    `expected the owner-device polling-rate scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
});
