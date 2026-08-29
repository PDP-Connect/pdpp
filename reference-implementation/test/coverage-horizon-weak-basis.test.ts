// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * NO coverage horizon narrows the servable denominator, regardless of basis —
 * proven through the real projection rather than a predicate.
 *
 * This file originally proved a narrower claim: that a WEAK-basis horizon
 * (`inferred_from_stable_boundary`) could not green a retryable gap, while an
 * affirmative basis could. The reasoning for excluding the weak basis was that
 * a walk which consistently stops early because of a bug is indistinguishable
 * from one stopping at a real retention cliff, so "our reader keeps failing at
 * the same place" would render as "the provider has no more data".
 *
 * That reasoning turned out to apply to EVERY basis. No basis established that
 * a particular gap lay outside the interval the provider can still serve:
 * nothing compared the gap to the horizon's edge, and a horizon with an
 * unknown edge (`earliestAvailable: null`) qualified. So the denominator-
 * narrowing path was removed entirely, and the tests below now assert that
 * every basis behaves the way the weak one always did.
 *
 * The route still RECORDS a horizon of any basis and the snapshot still
 * carries it — disclosure is unchanged. Only the completeness authority is
 * gone.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionCoverageHorizon } from "../runtime/coverage-horizon.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const RUN_AT = "2026-08-27T11:59:00.000Z";

function boundedRun(): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: NOW,
    first_at: RUN_AT,
    known_gaps: [
      {
        boundary_claim: "provider_history_boundary",
        kind: "skip_result",
        reason: "history_ended_before_provider_count",
        recovery_action: "retry_by_runtime",
        severity: "transient",
        stream: "group_messages",
      },
    ],
    last_at: NOW,
    recovery_only: false,
    run_id: "run_weak_basis",
    started_at: RUN_AT,
    status: "succeeded",
    terminal_reason: null,
  } as ConnectorRunSummary;
}

function horizon(basis: ConnectionCoverageHorizon["basis"]): ConnectionCoverageHorizon {
  return {
    basis,
    confirmedAt: "2026-08-01T00:00:00.000Z",
    confirmedBy: "owner_subject_abc",
    earliestAvailable: "2013-01-01T00:00:00.000Z",
    horizonId: `h_${basis}`,
    note: null,
    reason: "provider_retention_policy",
    stream: "group_messages",
    supersededAt: null,
    supersededByHorizonId: null,
  } as ConnectionCoverageHorizon;
}

function project(
  basis: ConnectionCoverageHorizon["basis"]
): ReturnType<typeof projectConnectorSummaryConnectionHealth> {
  return projectConnectorSummaryConnectionHealth({
    coverageHorizons: [horizon(basis)],
    freshness: { status: "current" },
    lastRun: boundedRun(),
    lastSuccessfulRun: boundedRun(),
    schedule: { enabled: true },
  } as never);
}

test("WEAK BASIS: an inferred boundary cannot green a retryable gap", () => {
  const snap = project("inferred_from_stable_boundary");
  const coverage = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  // Asserted positively (`status === "false"`, `reason === "retryable_gap"`)
  // rather than as `notEqual` against the deleted `coverage_complete_horizon_
  // accounted` string: once that reason no longer exists, a `notEqual` against
  // it passes vacuously and would keep passing even if some other path greened
  // the gap.
  assert.equal(
    coverage?.status,
    "false",
    "a boundary the owner INFERRED is not the provider saying so; it must not account the gap away"
  );
  assert.equal(coverage?.reason, "retryable_gap");
  assert.notEqual(snap.state, "healthy", "weak evidence must fail closed, never settle the connection green");
});

test("WEAK BASIS is still disclosed on the snapshot, not discarded", () => {
  // Refusing to act on it is not the same as hiding it. The owner's inference
  // remains visible so they can see what PDPP believes and why.
  const snap = project("inferred_from_stable_boundary");
  assert.equal(snap.coverage_horizons.length, 1);
  assert.equal(snap.coverage_horizons[0]?.basis, "inferred_from_stable_boundary");
});

test("AFFIRMATIVE BASES do not qualify either — no basis is a denominator", () => {
  // This was the control proving `provider_confirmed`/`provider_stated`
  // narrowed the denominator where `inferred_from_stable_boundary` did not.
  // The denominator-narrowing path is REMOVED, so the basis distinction no
  // longer decides completeness at all: an affirmative basis is stronger
  // PROVENANCE for the disclosure an owner reads, never authority over
  // coverage. What made the weak basis unsafe (no independent proof that a
  // given gap lies outside the servable interval) was in fact true of every
  // basis — nothing bound a gap to the horizon's edge.
  for (const basis of ["provider_confirmed", "provider_stated"] as const) {
    const snap = project(basis);
    const coverage = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
    assert.equal(coverage?.status, "false", `${basis} must not settle coverage`);
    assert.notEqual(snap.state, "healthy", `${basis} must not green the connection`);
    assert.equal(snap.coverage_horizons[0]?.basis, basis, `${basis} is still disclosed on the snapshot`);
  }
});
