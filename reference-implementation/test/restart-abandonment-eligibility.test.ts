// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  eligibleRestartAbandonmentStreams,
  isControllerLifecycleAbandonment,
} from "../runtime/restart-abandonment-eligibility.ts";

const CLEAN = {
  declaredDetailParentStreams: new Set<string>(),
  streamsWithPendingDetailGaps: new Set<string>(),
  streamsWithUnprovenCoverage: new Set<string>(),
};

test("an eligible stream resumes after a controller restart", () => {
  const eligible = eligibleRestartAbandonmentStreams(["messages"], {
    ...CLEAN,
    terminalReason: "controller_terminated_before_run_finished",
  });
  assert.deepEqual([...eligible], ["messages"], "a parentless, gap-free staged stream must commit");
});

test("both controller-lifecycle reasons qualify, keyed on reason not status", () => {
  // Restart-killed runs are stored under TWO statuses; a status-based check
  // misses 17 of 45 on the owner's instance. Both reasons must qualify.
  assert.equal(isControllerLifecycleAbandonment("controller_terminated_before_run_finished"), true);
  assert.equal(isControllerLifecycleAbandonment("controller_restarted"), true);
});

test("SAFETY: a declared detail-coverage parent commits NOTHING", () => {
  // The invariant: a cursor must never advance past records whose coverage was
  // not proven. A detail parent can face a DONE-time verdict, so it is excluded
  // outright. If this assertion can be made to pass with the guard removed, the
  // guard is theater.
  const eligible = eligibleRestartAbandonmentStreams(["orders"], {
    ...CLEAN,
    declaredDetailParentStreams: new Set(["orders"]),
    terminalReason: "controller_terminated_before_run_finished",
  });
  assert.deepEqual([...eligible], [], "a detail parent must never commit on restart abandonment");
});

test("SAFETY: a stream with a pending detail gap commits nothing", () => {
  const eligible = eligibleRestartAbandonmentStreams(["messages"], {
    ...CLEAN,
    streamsWithPendingDetailGaps: new Set(["messages"]),
    terminalReason: "controller_restarted",
  });
  assert.deepEqual([...eligible], [], "a pending gap means the prefix is unproven");
});

test("SAFETY: unproven coverage for the completed prefix commits nothing", () => {
  const eligible = eligibleRestartAbandonmentStreams(["messages"], {
    ...CLEAN,
    streamsWithUnprovenCoverage: new Set(["messages"]),
    terminalReason: "controller_restarted",
  });
  assert.deepEqual([...eligible], [], "unproven coverage must fail closed");
});

test("SAFETY: a connector-reported failure is NOT covered", () => {
  // Only a CONTROLLER death qualifies. A connector that reported its own
  // failure has an unproven state map by definition.
  for (const reason of ["connector_reported_failed", "run_timed_out", "owner_cancelled", null, undefined]) {
    const eligible = eligibleRestartAbandonmentStreams(["messages"], { ...CLEAN, terminalReason: reason });
    assert.deepEqual([...eligible], [], `must not commit for terminal reason ${String(reason)}`);
  }
});

test("a mixed set commits only the provably safe streams", () => {
  const eligible = eligibleRestartAbandonmentStreams(["messages", "orders", "files"], {
    declaredDetailParentStreams: new Set(["orders"]),
    streamsWithPendingDetailGaps: new Set(["files"]),
    streamsWithUnprovenCoverage: new Set(),
    terminalReason: "controller_terminated_before_run_finished",
  });
  assert.deepEqual([...eligible].sort(), ["messages"], "each exclusion applies independently");
});
