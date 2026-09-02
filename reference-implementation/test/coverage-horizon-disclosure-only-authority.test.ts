// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * MODEL A: a coverage horizon is DISCLOSURE, never a completeness authority.
 *
 * This file pins the one authority that was ever explicitly designed and
 * accepted for coverage horizons — the normative spec delta in
 * `openspec/changes/add-coverage-horizon-and-actionability-banner/specs/
 * reference-connection-health/spec.md`:
 *
 *   "A coverage horizon SHALL carry no ConnectionHealthState, no health axis,
 *    and no forward disposition, and SHALL participate in NO classification
 *    step. ... it SHALL NOT by itself mark a connection unhealthy or a
 *    stream's coverage complete."
 *
 * and that change's `design.md`, which REJECTS making a horizon a
 * classification input outright ("it would make the horizon a classification
 * input, which the whole design commits to NEVER doing (a horizon is
 * disclosure, not a verdict)").
 *
 * The removed `horizonAccountedRetryableGap` path contradicted both. Its proof
 * predicate was `connector claim` AND `some current horizon exists for this
 * stream` — with NO per-gap temporal or cursor comparison against the horizon's
 * edge. A horizon whose `earliestAvailable` is `null` (the edge is unknown)
 * satisfied it, so ANY retryable gap carrying the broad typed claim could be
 * accounted away, including a gap wholly INSIDE the interval the provider can
 * still serve. That is a false green: the connection reads healthy while data
 * the provider WOULD serve is missing and no longer counted as owed.
 *
 * Model A is strictly the safe direction — it can only make a verdict less
 * green, never more, so it cannot introduce a false green. Binding a specific
 * gap to a specific horizon edge (Model B) remains a legitimate product
 * direction, but it needs a normative Collection Profile definition of
 * `boundary_claim` plus real per-gap edge binding; a broad typed string plus
 * "some horizon exists" is not that proof.
 *
 * DISCLOSURE IS PRESERVED, and this file proves it: the horizon is still
 * recorded, still carried verbatim onto the snapshot, still surfaced in the
 * owner-facing `RenderedVerdict.detail`, and the connector's `boundary_claim`
 * is still persisted on the gap. Model A is about AUTHORITY, not removal.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeConnectionHealth } from "../runtime/connection-health.ts";
import type { ConnectionCoverageHorizon } from "../runtime/coverage-horizon.ts";
import { synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";
import { projectConnectorSummaryConnectionHealth } from "../server/ref-control.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const RUN_AT = "2026-08-27T11:59:00.000Z";

/**
 * The GroupMe/USAA production shape: a retryable, retry-forever skip carrying
 * the connector's typed `provider_history_boundary` claim.
 */
function claimingRun(overrides: Partial<ConnectorRunSummary> = {}): ConnectorRunSummary {
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
    run_id: "run_model_a",
    started_at: RUN_AT,
    status: "succeeded",
    terminal_reason: null,
    ...overrides,
  } as ConnectorRunSummary;
}

function horizon(overrides: Partial<ConnectionCoverageHorizon> = {}): ConnectionCoverageHorizon {
  return {
    basis: "provider_stated",
    confirmedAt: "2026-08-20T00:00:00.000Z",
    confirmedBy: "owner:test-owner",
    connectorInstanceId: "cin_model_a",
    earliestAvailable: "2013-01-01T00:00:00.000Z",
    horizonId: "covhz_model_a",
    note: null,
    reason: "provider_retention_policy",
    stream: "group_messages",
    supersededAt: null,
    supersededByHorizonId: null,
    ...overrides,
  } as ConnectionCoverageHorizon;
}

/**
 * `nowIso` is pinned rather than left to default to wall-clock time: the
 * byte-identity test below projects the same input twice and compares every
 * condition, and conditions carry an `observed_at` stamp. Two unpinned calls
 * straddling a millisecond boundary differ on that stamp alone, which is a
 * clock artifact, not a classification difference.
 */
function project(
  horizons: readonly ConnectionCoverageHorizon[],
  run: ConnectorRunSummary = claimingRun()
): ReturnType<typeof projectConnectorSummaryConnectionHealth> {
  return projectConnectorSummaryConnectionHealth({
    coverageHorizons: horizons,
    freshness: { status: "current" },
    lastRun: run,
    lastSuccessfulRun: run,
    nowIso: NOW,
    schedule: { enabled: true },
  } as never);
}

function coverageCondition(snap: ReturnType<typeof projectConnectorSummaryConnectionHealth>) {
  return snap.conditions.find((c) => c.type === "SourceCoverageComplete");
}

// ─── The exact false green the review names ────────────────────────────────

test("FALSE GREEN CLOSED: a claim + a horizon whose earliestAvailable is null does NOT produce complete coverage", () => {
  // `earliestAvailable: null` means "a boundary exists but its exact edge is
  // UNKNOWN". An unknown edge cannot prove any particular gap lies outside the
  // servable interval — there is no edge to compare the gap against. The old
  // predicate accepted this outright.
  const snap = project([horizon({ earliestAvailable: null })]);
  assert.equal(
    coverageCondition(snap)?.status,
    "false",
    "a horizon with an unknown edge proves nothing about where this gap falls"
  );
  assert.notEqual(
    coverageCondition(snap)?.reason,
    "coverage_complete_horizon_accounted",
    "the horizon-accounted completeness path must no longer exist"
  );
  assert.notEqual(snap.state, "healthy");
});

test("FALSE GREEN CLOSED: a claim + a fully-specified, current, provider-stated horizon still does NOT green the connection", () => {
  // The strongest possible form of the old proof — affirmative basis, current,
  // exact stream, exact edge date. Under Model A even this cannot settle
  // completeness, because the horizon is not a classification input at all and
  // nothing binds THIS gap to that edge.
  const snap = project([horizon()]);
  assert.equal(coverageCondition(snap)?.status, "false");
  assert.equal(snap.axes.coverage, "retryable_gap", "the raw axis is unchanged — the gap is still a gap");
  assert.notEqual(snap.state, "healthy");
});

test("GROUPME/USAA ACCEPTANCE BAR: claim + any-horizon is not green, for either connection shape", () => {
  // The owner's stated bar. Both production shapes carry the same broad typed
  // claim; neither may go green on claim + "some horizon exists".
  const groupMe = project([horizon()], claimingRun());
  const usaa = project(
    [horizon({ connectorInstanceId: "cin_usaa", stream: "transactions" })],
    claimingRun({
      known_gaps: [
        {
          boundary_claim: "provider_history_boundary",
          kind: "skip_result",
          reason: "history_ended_before_provider_count",
          recovery_action: "retry_by_runtime",
          severity: "transient",
          stream: "transactions",
        },
      ],
      run_id: "run_usaa",
    })
  );
  for (const [name, snap] of [
    ["groupme", groupMe],
    ["usaa", usaa],
  ] as const) {
    assert.equal(coverageCondition(snap)?.status, "false", `${name} must not read coverage-complete`);
    assert.notEqual(snap.state, "healthy", `${name} must not read healthy on claim + any-horizon alone`);
  }
});

test("IN-INTERVAL GAP: a gap INSIDE the still-servable interval is not softened by the same claim", () => {
  // The horizon says the provider serves everything from 2013 onward. This gap
  // is scoped to 2026 — squarely inside what the provider CAN still serve, so
  // it is genuinely owed data. It carries the same broad claim, which is
  // exactly why the claim alone was never sufficient proof.
  const inIntervalRun = claimingRun({
    known_gaps: [
      {
        boundary_claim: "provider_history_boundary",
        kind: "skip_result",
        reason: "history_ended_before_provider_count",
        recovery_action: "retry_by_runtime",
        scope: { time_range: { since: "2026-01-01T00:00:00.000Z", until: "2026-06-01T00:00:00.000Z" } },
        severity: "transient",
        stream: "group_messages",
      },
    ],
    run_id: "run_in_interval",
  });
  const snap = project([horizon({ earliestAvailable: "2013-01-01T00:00:00.000Z" })], inIntervalRun);
  assert.equal(
    coverageCondition(snap)?.status,
    "false",
    "a 2026 gap is inside the interval a 2013 horizon says is servable — it is owed, not accounted"
  );
  assert.notEqual(snap.state, "healthy");
});

test("MULTI-GAP: several gaps each carrying the claim do not collectively account themselves away", () => {
  const multiGapRun = claimingRun({
    known_gaps: ["group_messages", "groups", "memberships"].map((stream) => ({
      boundary_claim: "provider_history_boundary",
      kind: "skip_result",
      reason: "history_ended_before_provider_count",
      recovery_action: "retry_by_runtime",
      severity: "transient",
      stream,
    })),
    run_id: "run_multi_gap",
  });
  const snap = project([horizon({ stream: "*" })], multiGapRun);
  assert.equal(
    coverageCondition(snap)?.status,
    "false",
    "three unproven gaps under one connection-wide horizon are still three unproven gaps"
  );
  assert.notEqual(snap.state, "healthy");
});

// ─── Disclosure survives: Model A removes authority, not the feature ───────

test("DISCLOSURE KEPT: the horizon is still recorded verbatim on the snapshot", () => {
  const h = horizon();
  const snap = project([h]);
  assert.equal(snap.coverage_horizons.length, 1, "the horizon is still carried, not dropped");
  assert.deepEqual(snap.coverage_horizons[0], h, "carried verbatim — provenance intact");
});

test("DISCLOSURE KEPT: the horizon is still readable by an owner in RenderedVerdict.detail", () => {
  const snap = project([horizon()]);
  const verdict = synthesizeRenderedVerdict(snap, [], null, true);
  assert.equal(verdict.detail.coverage_horizons.length, 1, "the owner can still read the disclosure");
  assert.equal(verdict.detail.coverage_horizons[0]?.horizonId, "covhz_model_a");
});

test("DISCLOSURE KEPT: the connector's boundary_claim still survives onto the gap", () => {
  const snap = project([horizon()]);
  const claims = JSON.stringify(snap);
  assert.match(claims, /retryable_gap/, "the gap is still reported");
  // The claim itself is persisted by `buildKnownGap`; see
  // known-gap-boundary-claim-persistence.test.ts. Here we only assert the
  // health path did not have to strip it to stop honoring it.
  assert.equal(
    project([horizon()], claimingRun()).axes.coverage,
    "retryable_gap",
    "a claim-carrying gap still classifies as a gap, exactly as it did before any horizon existed"
  );
});

// ─── The horizon changes NOTHING about classification (the spec's words) ───

test("NO CLASSIFICATION AUTHORITY: every classified field is byte-identical with and without the horizon", () => {
  // The normative requirement is that a horizon "SHALL participate in NO
  // classification step". The strongest possible form of that assertion: run
  // the identical input twice, differing only by the horizon's presence, and
  // require every classified output to match.
  const run = claimingRun();
  const without = project([], run);
  const with_ = project([horizon()], run);
  assert.equal(with_.state, without.state);
  assert.equal(with_.reason_code, without.reason_code);
  assert.equal(with_.forward_disposition, without.forward_disposition);
  assert.deepEqual(with_.axes, without.axes);
  assert.deepEqual(with_.conditions, without.conditions);
  assert.equal(with_.next_action, without.next_action);
  // ...and only the disclosure differs.
  assert.deepEqual(without.coverage_horizons, []);
  assert.equal(with_.coverage_horizons.length, 1);
});

test("NO CLASSIFICATION AUTHORITY: no basis can green the gap — an affirmative basis is not a denominator", () => {
  // The old rule let `provider_confirmed`/`provider_stated` (but not
  // `inferred_from_stable_boundary`) narrow the denominator. Under Model A the
  // basis distinction no longer decides anything about completeness; it is
  // provenance an owner reads, not authority the projection honors.
  for (const basis of ["provider_confirmed", "provider_stated", "inferred_from_stable_boundary"] as const) {
    const snap = project([horizon({ basis })]);
    assert.equal(coverageCondition(snap)?.status, "false", `${basis} must not settle coverage`);
    assert.notEqual(snap.state, "healthy", `${basis} must not green the connection`);
    assert.equal(snap.coverage_horizons[0]?.basis, basis, `${basis} is still disclosed`);
  }
});

test("SAFE DIRECTION: removing the softening can only make a verdict less green, never more", () => {
  // Model A's safety argument, asserted rather than narrated. A horizon-free
  // baseline is the floor; adding a horizon must never produce a MORE
  // favourable coverage condition than that floor.
  const run = claimingRun();
  const floor = coverageCondition(project([], run))?.status;
  for (const h of [
    horizon(),
    horizon({ earliestAvailable: null }),
    horizon({ stream: "*" }),
    horizon({ basis: "provider_confirmed" }),
    horizon({ supersededAt: "2026-08-25T00:00:00.000Z", supersededByHorizonId: "covhz_newer" }),
  ]) {
    assert.equal(
      coverageCondition(project([h], run))?.status,
      floor,
      "no horizon shape may improve the coverage condition over the no-horizon floor"
    );
  }
});

// ─── The health-layer flag is gone from the evidence contract ──────────────

test("EVIDENCE CONTRACT: no coverage-evidence field can unlock completeness for a retryable_gap axis", () => {
  // Belt-and-braces at the layer below the projection: even a caller that
  // hand-builds coverage evidence and tries to set the removed flag cannot
  // reach a complete verdict, because the branch that honored it is gone.
  const snap = computeConnectionHealth({
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: "retryable_gap", horizonAccountedRetryableGap: true } as never,
    coverageHorizons: [horizon()],
    freshness: { axis: "fresh" },
    observedAt: NOW,
    outbox: null,
    projection: null,
    run: {
      hasDegradingGaps: true,
      lastSuccessAt: "2026-08-27T00:00:00.000Z",
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
  });
  const condition = snap.conditions.find((c) => c.type === "SourceCoverageComplete");
  assert.equal(condition?.status, "false", "a stale caller setting the removed flag gets no completeness from it");
  assert.equal(condition?.reason, "retryable_gap");
  assert.equal(snap.coverage_horizons.length, 1, "and the horizon is still disclosed");
});
