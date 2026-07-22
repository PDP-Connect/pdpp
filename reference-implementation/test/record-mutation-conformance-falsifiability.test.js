// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Falsifiability proof for the record mutation conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver whose
 * durable mutation is non-atomic (live row is mutated before record_changes
 * is appended, with no surrounding transaction). This is the same failure
 * mode the SQLite atomicity fix pins.
 *
 * If the harness is sound, at least one rollback scenario MUST fail when
 * exercised against this broken driver. If every scenario passed, the
 * harness would be a green-path wrapper rather than a real conformance
 * gate, and this test would refuse to confirm coverage.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-record-mutation-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokenInMemoryRecordMutationDriver } from './helpers/broken-record-mutation-driver.js';
import { runRecordMutationConformance } from './helpers/record-mutation-conformance.js';

test('harness detects at least one durable-mutation invariant violation in a broken driver', async () => {
  // Collect (rather than register) the harness scenarios so we can invoke
  // them ourselves and inspect outcomes.
  const scenarios = [];
  const collect = (name, fn) => {
    scenarios.push({ name, fn });
  };

  runRecordMutationConformance({
    label: 'broken-in-memory',
    test: collect,
    makeDriver: () => createBrokenInMemoryRecordMutationDriver(),
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

  // The specific failure we expect to see is one of the rollback scenarios:
  // the broken driver mutates the live row before the change-log append, so
  // a fault between those two steps leaves the three tables drifted.
  const rollbackFailed = failures.some((f) =>
    /rolls back the durable unit/.test(f.name),
  );
  assert.ok(
    rollbackFailed,
    `expected at least one rollback scenario to fail on the broken driver. failures=${JSON.stringify(failures, null, 2)}`,
  );
});
