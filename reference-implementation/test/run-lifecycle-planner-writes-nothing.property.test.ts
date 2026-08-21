// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine.
 *
 * Covers forbidden transition F1: the planner may not write run state.
 * This is the GroupMe 503 expressed as a property.
 *
 * Property: evaluating dispatch eligibility performs ZERO durable writes and
 *   acquires ZERO connector-instance write locks, for an instance in any
 *   state -- including one with a run in flight, and including a run started
 *   by a DIFFERENT process.
 * Generator: planner eligibility evaluations across the full state set, with
 *   and without an in-flight run, with the in-flight run owned by this
 *   process and by a foreign epoch.
 * Invariant: no durable write, no lock acquisition, during a planner read.
 *
 * Why the existing guard is not enough. `runtime/scheduler.ts:636` returns
 * early when `runtime.activeRuns.has(key)`, which fixed the original
 * incident. But `runtime.activeRuns` is an in-process `Set` that dies with
 * the process, so the guard does not suppress the probe for a run started by
 * another process or surviving a restart. The write it guards is real:
 * `server/index.ts:9057` calls `reconcileDirtyConnectorSummaryEvidence`
 * BEFORE its read at :9058, and that reconcile takes
 * `withConnectorInstanceWrite` and issues `withPostgresTransaction({
 * lockConnectorInstanceId })` upserts.
 *
 * A test that only exercises the same-process case would pass today and prove
 * nothing. The foreign-epoch case is the one that must fail before the split
 * lands.
 */

import test from "node:test";

test("run lifecycle: the planner writes nothing", async (t) => {
  await t.test(
    "dispatch eligibility performs no durable write in any run state",
    { todo: "requires the planner/executor split (D4)" },
    () => {
      // Instrument the storage layer and assert zero writes -- do not infer
      // from absence of observable change.
    }
  );

  await t.test(
    "dispatch eligibility acquires no connector-instance write lock",
    { todo: "requires the planner/executor split" },
    () => {
      // The lock acquisition IS the defect: contention on the per-instance
      // mutex with a 2s wait budget turned committed batches into retryable
      // `connector_instance_busy` failures.
    }
  );

  await t.test(
    "the guard holds for a run owned by a foreign epoch",
    { todo: "requires durable admission state, not an in-process Set" },
    () => {
      // Start a run under epoch A; evaluate dispatch from a process holding
      // epoch B with an empty activeRuns Set. Today this probes and writes.
    }
  );

  await t.test(
    "planner-written skip records are never read as run outcomes",
    { todo: "requires the owner module to exclude dispatch outcomes" },
    () => {
      // The scheduler writes `status:"skipped"` rows to run_history
      // (scheduler.ts:432). Those are dispatch outcomes, not run states. The
      // Gmail identity self-poisoning loop was these rows feeding back into
      // health classification.
    }
  );
});
