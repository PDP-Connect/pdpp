/**
 * Falsifiability proof for the blob-store conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver
 * whose blob persistence is non-conformant in two specific ways:
 * (1) it silently overwrites on a duplicate `putBlob` whose bytes
 * differ from the originally stored bytes, falsifying the
 * content-address collision-rejection scenario; (2) it appends every
 * `putBinding` call instead of collapsing identical tuples,
 * falsifying the binding-idempotency scenario.
 *
 * If the harness is sound, at least one scenario MUST fail when
 * exercised against this broken driver. If every scenario passed, the
 * harness would be a green-path wrapper rather than a real conformance
 * gate, and this test would refuse to confirm coverage.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokenBlobStoreDriver } from './helpers/broken-blob-store-driver.js';
import { runBlobStoreConformance } from './helpers/blob-store-conformance.js';

test('harness detects at least one blob-store invariant violation in a broken driver', async () => {
  const scenarios = [];
  const collect = (name, fn) => {
    scenarios.push({ name, fn });
  };

  runBlobStoreConformance({
    label: 'broken-in-memory',
    test: collect,
    makeDriver: () => createBrokenBlobStoreDriver(),
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

  // Specifically expect at least one of: the collision-rejection
  // scenario fails because the broken driver silently overwrote; the
  // binding-idempotency scenario fails because the broken driver
  // appended duplicate bindings.
  const collisionFailed = failures.some((f) => /collision/i.test(f.name));
  const idempotencyFailed = failures.some((f) => /idempot/i.test(f.name));
  assert.ok(
    collisionFailed || idempotencyFailed,
    `expected the collision or idempotency scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
});
