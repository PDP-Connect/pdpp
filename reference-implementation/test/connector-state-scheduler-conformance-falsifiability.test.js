// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Falsifiability proof for the connector-state / schedule / active-run
 * conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver whose
 * persistence is non-conformant in three specific ways: (1) state writes
 * ignore `grantId` so grant-scoped state collides with owner-scoped
 * state; (2) `upsertSchedule` always inserts instead of updating, so a
 * second upsert grows the schedule list; (3) the active-run registry
 * accepts duplicate rows for the same connector. `simulateRestart` is a
 * no-op so the reconciliation scenario also fails.
 *
 * If the harness is sound, at least one scenario MUST fail in each of
 * the three areas (state, schedule, active-run) when exercised against
 * this broken driver. If every scenario passed, the harness would be a
 * green-path wrapper rather than a real conformance gate, and this
 * test would refuse to confirm coverage.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-connector-state-scheduler-conformance-harness/
 *       specs/reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokenInMemoryConnectorStateSchedulerDriver } from './helpers/broken-connector-state-scheduler-driver.js';
import { runConnectorStateSchedulerConformance } from './helpers/connector-state-scheduler-conformance.js';

test('harness detects at least one invariant violation in each broken-driver area', async () => {
  // Collect (rather than register) the harness scenarios so we can invoke
  // them ourselves and inspect outcomes.
  const scenarios = [];
  const collect = (name, fn) => {
    scenarios.push({ name, fn });
  };

  runConnectorStateSchedulerConformance({
    label: 'broken-in-memory',
    test: collect,
    makeDriver: () => createBrokenInMemoryConnectorStateSchedulerDriver(),
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

  // Specifically expect at least one failure in each area to prove the
  // harness exercises all three concerns rather than relying on a single
  // overgrown scenario to mask weak coverage.
  const stateFailed = failures.some((f) =>
    /grant-scoped state is isolated|owner-scoped state for connector A is isolated/.test(f.name),
  );
  const scheduleFailed = failures.some((f) =>
    /schedule upsert updates existing row in place|schedule list surfaces all configured connectors|schedule delete removes the row/.test(
      f.name,
    ),
  );
  const activeRunFailed = failures.some((f) =>
    /active-run registry holds at most one row|active-run run_id is unique across connectors|simulated restart reconciles abandoned runs/.test(
      f.name,
    ),
  );

  const summary = JSON.stringify(failures.map((f) => f.name), null, 2);
  assert.ok(stateFailed, `expected a connector-state isolation scenario to fail. failures=${summary}`);
  assert.ok(scheduleFailed, `expected a schedule scenario to fail. failures=${summary}`);
  assert.ok(activeRunFailed, `expected an active-run scenario to fail. failures=${summary}`);
});
