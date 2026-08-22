// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * D4/F1: a dispatch-eligibility probe may not have side effects.
 *
 * The contract this file enforces is deliberately stronger than "the planner
 * issues no UPDATE". `runtime/run-lifecycle.ts` states it as forbidding
 * SIDE-EFFECTING READS, because the GroupMe 503 (live UAT incident
 * run_1786410860909_1) was not a direct write at all: it was a read-only-
 * LOOKING eligibility probe that called
 * `reconcileDirtyConnectorSummaryEvidence` first, which takes
 * `withConnectorInstanceWrite` — the same per-instance mutex the in-flight
 * run holds — and turned committed batches into retryable
 * `connector_instance_busy` / `ingest_batch_storage_error` failures.
 *
 * Why the pre-existing coverage did not catch this, which is the whole
 * reason this file exists
 * -----------------------------------------------------------------------
 * Two suites already cover the neighbourhood and BOTH are vacuous with
 * respect to the probe's own body:
 *
 *   - `scheduler-active-run-suppresses-dispatch-probes.test.ts` and
 *     `...-lock-contention.test.ts` inject a STUB `getForwardEvidenceDebt`.
 *     They prove the scheduler's `runtime.activeRuns` guard suppresses the
 *     CALL. They never execute the real callback, so the reconcile inside it
 *     is invisible to them.
 *   - `run-lifecycle-planner-writes-nothing.property.test.ts` asserts against
 *     a synthetic `evaluateDispatchEligibility` helper defined inside the
 *     test file — a SELECT the test itself wrote. It proves the machine's
 *     contract, not the production probe's compliance with it.
 *
 * So the guard was tested, and the contract was tested, and the thing the
 * guard defends — the probe body — was tested by neither. Worse, the guard
 * is `runtime.activeRuns`, an in-process `Set`: it cannot suppress the probe
 * for a run owned by another process or surviving a restart, which the
 * property test's own docblock already concedes. Suppressing a side effect
 * most of the time is not the same as not having one.
 *
 * This test therefore asserts the STRUCTURAL property — the probe bodies
 * contain no reconcile call — rather than trying to observe contention,
 * which is timing-dependent and was exactly the flake shape another lane is
 * already fighting in `test/scheduler.test.ts`. A structural oracle cannot
 * go green by getting lucky with a scheduler tick.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REFERENCE_IMPL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Extract a function body by brace matching from its declaration line.
 *
 * Reading the source rather than importing is deliberate: both probes are
 * closures created inside `startServer`/`createController`, so neither is
 * reachable as an exported symbol without standing up a whole server, and
 * standing up a server to ask a structural question would reintroduce the
 * timing dependence this oracle exists to avoid.
 */
function extractFunctionBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `could not find the probe declaration: ${declaration}`);
  const open = source.indexOf("{", start);
  assert.notEqual(open, -1, `no opening brace after: ${declaration}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces while extracting: ${declaration}`);
}

/**
 * Every dispatch-eligibility probe in the tree, by the declaration that
 * opens it. Both are listed because they are the SAME defect in two places
 * and only one of them was ever guarded:
 *
 *   - `server/index.ts` — the scheduler's probe. Suppressed (partially) by
 *     `runtime.activeRuns`.
 *   - `runtime/controller.ts` — the `runNow` path's probe, reached from
 *     `resolveEffectiveRecoveryOnly`. Never guarded at all: the
 *     `activeRuns` check lives in `runtime/scheduler.ts` and has no analogue
 *     here.
 */
const PROBES: readonly { declaration: string; file: string; label: string }[] = [
  {
    declaration: "getForwardEvidenceDebt: async (connectorId, connectorInstanceId, scheduleIntervalMs)",
    file: "server/index.ts",
    label: "scheduler dispatch-eligibility probe",
  },
  {
    declaration:
      "async function probeForwardEvidenceDebt(connectorId: string, connectorInstanceId: string): Promise<boolean>",
    file: "runtime/controller.ts",
    label: "runNow recovery-mode probe",
  },
];

/**
 * Calls that mutate durable state or take the per-instance write mutex.
 * `reconcileDirtyConnectorSummaryEvidence` is the specific mechanism of the
 * live incident; the others are listed so a future edit cannot reintroduce
 * the same hazard through a differently-named door.
 */
const SIDE_EFFECTING_CALLS: readonly string[] = [
  "reconcileDirtyConnectorSummaryEvidence",
  "rebuildConnectorSummaryEvidence",
  "withConnectorInstanceWrite",
  "markConnectorSummaryEvidenceDirty",
  "runBoundedSummaryEvidenceSweep",
];

for (const probe of PROBES) {
  test(`dispatch eligibility is side-effect free: ${probe.label} (${probe.file})`, () => {
    const source = readFileSync(join(REFERENCE_IMPL_DIR, probe.file), "utf8");
    const body = extractFunctionBody(source, probe.declaration);

    for (const call of SIDE_EFFECTING_CALLS) {
      assert.ok(
        !body.includes(`${call}(`),
        `${probe.label} calls ${call}() — a dispatch-eligibility probe must not write, ` +
          "reconcile, or take the per-instance write mutex (D4/F1). This is the " +
          "GroupMe 503 mechanism: the probe contended with the in-flight run's own " +
          "writes and turned committed batches into connector_instance_busy failures."
      );
    }
  });
}

/**
 * The probe must still ANSWER the question — a probe that returns a constant
 * would satisfy the assertions above trivially. This is the load-bearing
 * companion check, in the same shape as the canary manifest's
 * `transition-throughput-is-non-zero`: every other assertion here is an
 * absence, and a fully-gutted probe would satisfy all of them by doing
 * nothing.
 */
test("dispatch eligibility still reads evidence and evaluates the debt predicate", () => {
  for (const probe of PROBES) {
    const source = readFileSync(join(REFERENCE_IMPL_DIR, probe.file), "utf8");
    const body = extractFunctionBody(source, probe.declaration);
    assert.ok(
      body.includes("getConnectorSummaryEvidence("),
      `${probe.label} must still READ the evidence row — removing the side effect ` +
        "must not turn the probe into a stub"
    );
    assert.ok(body.includes("hasForwardEvidenceDebt("), `${probe.label} must still evaluate the debt predicate`);
  }
});
