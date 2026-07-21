// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Falsifiability proof for the record read conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver whose read
 * path is non-conformant in two specific ways: (1) field projection is a
 * no-op, leaking ungranted/unrequested fields; (2) cursor pagination
 * overlaps page boundaries by one row. These are the failure modes the
 * harness's projection and pagination scenarios pin.
 *
 * If the harness is sound, at least one scenario MUST fail when exercised
 * against this broken driver. If every scenario passed, the harness would be
 * a green-path wrapper rather than a real conformance gate, and this test
 * would refuse to confirm coverage.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokenInMemoryRecordReadDriver } from './helpers/broken-record-read-driver.js';
import { runRecordReadConformance } from './helpers/record-read-conformance.js';

test('harness detects at least one read invariant violation in a broken driver', async () => {
  // Collect (rather than register) the harness scenarios so we can invoke
  // them ourselves and inspect outcomes.
  const scenarios = [];
  const collect = (name, fn) => {
    scenarios.push({ name, fn });
  };

  runRecordReadConformance({
    label: 'broken-in-memory',
    test: collect,
    makeDriver: () => createBrokenInMemoryRecordReadDriver(),
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

  // Specifically expect the projection scenario to fail (the broken driver
  // ignores grantFields), and at least one pagination scenario to fail (the
  // broken driver overlaps pages by one row).
  const projectionFailed = failures.some((f) =>
    /grant field projection/.test(f.name),
  );
  const paginationFailed = failures.some((f) =>
    /paginates the full set|cursor token round-trips/.test(f.name),
  );
  assert.ok(
    projectionFailed,
    `expected the grant-projection scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
  assert.ok(
    paginationFailed,
    `expected at least one pagination scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
});
