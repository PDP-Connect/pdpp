// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A weak-basis coverage horizon is DISCLOSED but cannot narrow the servable
 * denominator, proven through the real projection rather than the predicate.
 *
 * `inferred_from_stable_boundary` is the shape a broken connector produces: a
 * walk that consistently stops early because of a bug is indistinguishable
 * from one stopping at a real retention cliff. If that could green a retryable
 * gap, "our reader keeps failing at the same place" would render as "the
 * provider has no more data" — the exact false green this axis exists to
 * prevent. BANNER-ZERO-PLAN.md: a horizon "requires positive evidence and must
 * fail closed to unknown when evidence is weak."
 *
 * The route still RECORDS a weak horizon and the snapshot still carries it —
 * the owner's inference is not discarded, it just cannot settle the question
 * by itself. Re-confirming the same boundary with a provider-backed basis
 * promotes it.
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

function project(basis: ConnectionCoverageHorizon["basis"]): ReturnType<typeof projectConnectorSummaryConnectionHealth> {
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
  assert.notEqual(
    coverage?.reason,
    "coverage_complete_horizon_accounted",
    "a boundary the owner INFERRED is not the provider saying so; it must not account the gap away"
  );
  assert.notEqual(snap.state, "healthy", "weak evidence must fail closed, never settle the connection green");
});

test("WEAK BASIS is still disclosed on the snapshot, not discarded", () => {
  // Refusing to act on it is not the same as hiding it. The owner's inference
  // remains visible so they can see what PDPP believes and why.
  const snap = project("inferred_from_stable_boundary");
  assert.equal(snap.coverage_horizons.length, 1);
  assert.equal(snap.coverage_horizons[0]?.basis, "inferred_from_stable_boundary");
});

test("AFFIRMATIVE BASES: provider_confirmed and provider_stated both qualify", () => {
  // The control for the negatives above: the same run, the same gap, the same
  // stream — only the basis differs, and that alone decides the outcome.
  for (const basis of ["provider_confirmed", "provider_stated"] as const) {
    const snap = project(basis);
    const coverage = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
    assert.equal(
      coverage?.reason,
      "coverage_complete_horizon_accounted",
      `${basis} is the provider's own word and must account the pre-horizon gap`
    );
    assert.equal(snap.state, "healthy", `${basis} should reach healthy for the in-horizon scope`);
  }
});
