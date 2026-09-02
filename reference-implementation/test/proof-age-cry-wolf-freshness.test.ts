// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The cry-wolf freshness defect: a source that COLLECTED SUCCESSFULLY TODAY
 * must not render as needing something from the owner.
 *
 * THE LIVE SHAPE (production, 2026-08-26). `apple_contacts`
 * (`cin_d344ba53d6d95c7dd343393d`) ran SUCCEEDED four times that day — 03:41,
 * 09:42, 15:42, 21:42 — and rendered:
 *
 *     Needs refresh · Last refreshed yesterday. Refreshes on schedule.
 *
 * Nothing was wrong with it. It had collected hours earlier, its coverage was
 * complete, its attention was clear and its outbox was clean. The owner had
 * nothing to do, and the pill said otherwise.
 *
 * THE CAUSE is one signal counted twice. `apple_contacts` collects contacts by
 * incremental CardDAV sync, so a no-change run legitimately commits its
 * checkpoint while carrying no `covered`/`considered` keys. The stream-fact
 * fold's measured-boundary guard (`mergeEventStreamFacts`,
 * `server/connector-summary-read-model.ts`) therefore KEEPS the older, fully
 * enumerated `contacts` fact rather than letting an unmeasured pass destroy a
 * real proof — correct behavior, and the proof keeps its original provenance.
 * `proofAgeFreshnessOverride` (`server/ref-control.ts`) then read that
 * deliberately-frozen `evidence_as_of` back in as a FRESHNESS clock, which
 * re-reads "we chose not to overwrite this proof" as "this source has not
 * collected". Freshness flipped to `stale`, and from there the cascade is
 * mechanical: the `Fresh` condition goes false at `warning` severity ->
 * `state: degraded` -> amber tone -> `staleFreshnessIsSoleDegradation`
 * (`runtime/rendered-verdict.ts`) -> the "Needs refresh" pill.
 *
 * THE RULE these tests pin: "Needs refresh" must mean the owner has something
 * to do. A clock advancing past a proof the system deliberately preserved is
 * not an owner action and must not be worded as one. Proof age is still
 * reported, through the `coverage_proven_at` annotation ("Coverage last proven
 * N days ago.", 80872b1fc) — a truthful qualifier beside a green pill.
 *
 * AND THE LIMIT, which matters more than the fix: a source that genuinely IS
 * stale — no successful collection inside its own staleness window — must
 * STILL be reported. Silencing a real problem would be a worse defect than the
 * false alarm being removed. The negative cases below are the load-bearing
 * half of this suite.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { CollectionReportEntry, ConnectorRunSummary } from "../server/ref-control.ts";
import {
  projectConnectorSummaryConnectionHealth,
  refineConnectionHealthWithCollectionReport,
} from "../server/ref-control.ts";

// ─── Real production anchors ────────────────────────────────────────────────

/** Observation instant, injected — these tests never read a clock. */
const NOW = "2026-08-27T02:20:00.000Z";

/**
 * `apple_contacts`: `capabilities.refresh_policy.maximum_staleness_seconds`
 * is 172800 (48h) and its schedule interval is 21600s (6h).
 */
const APPLE_CONTACTS_REFRESH_POLICY = { maximum_staleness_seconds: 172_800 };

/** The 2026-08-26 21:42 run — SUCCEEDED, ~4.6 hours before `NOW`. */
const APPLE_CONTACTS_LAST_SUCCESS = "2026-08-26T21:42:58.502Z";

/**
 * The `contacts` stream's frozen proof, from run `run_1787521717092` on
 * 2026-08-23 — ~76 hours before `NOW`, i.e. PAST the 48h window. This is the
 * exact timestamp that produced the false "Needs refresh".
 */
const APPLE_CONTACTS_FROZEN_PROOF = "2026-08-23T21:48:39.164Z";

/**
 * `chase`: `maximum_staleness_seconds` is 86400 (24h). Its 2026-08-26 run
 * SUCCEEDED 17:15 -> 17:21 and emitted 17 records.
 */
const CHASE_REFRESH_POLICY = { maximum_staleness_seconds: 86_400 };
const CHASE_LAST_SUCCESS = "2026-08-26T17:21:34.450Z";

/** An older chase proof, past its own 24h window. */
const CHASE_OLD_PROOF = "2026-08-21T20:26:20.010Z";

// ─── Fixtures ───────────────────────────────────────────────────────────────

function succeededRunAt(at: string): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 3,
    failure_reason: null,
    finished_at: at,
    first_at: at,
    known_gaps: [],
    last_at: at,
    recovery_only: false,
    run_id: `run_${at}`,
    started_at: at,
    status: "succeeded",
    terminal_reason: null,
  };
}

function completeEntry(stream: string, evidenceAsOf: string | null): CollectionReportEntry {
  return {
    checkpoint: "committed",
    collected: 10,
    considered: 10,
    coverage_condition: "complete",
    coverage_strategy: null,
    covered: "unknown",
    evidence_as_of: evidenceAsOf,
    forward_disposition: "complete",
    freshness_strategy: null,
    pending_detail_gaps: 0,
    pending_detail_gaps_is_floor: false,
    required: true,
    skipped: null,
    stream,
    ...{},
  };
}

/**
 * Build the health input for a scheduled connection whose newest run
 * succeeded at `lastSuccessAt`, then refine it against `report`.
 *
 * Mirrors the production wiring: `freshness.captured_at` is the successful
 * run's own instant (what `deriveReferenceFreshness` derives from the run
 * evidence), and the report carries the per-stream proofs.
 */
function refine(input: {
  readonly lastSuccessAt: string;
  readonly refreshPolicy: { maximum_staleness_seconds: number };
  readonly report: readonly CollectionReportEntry[];
}) {
  const run = succeededRunAt(input.lastSuccessAt);
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    freshness: { captured_at: input.lastSuccessAt, last_attempted_at: input.lastSuccessAt, status: "current" },
    lastRun: run,
    lastSuccessfulRun: run,
    nowIso: NOW,
    outbox: { axis: "idle" },
    refreshPolicy: input.refreshPolicy,
    schedule: { enabled: true },
  };
  const initial = projectConnectorSummaryConnectionHealth(healthInput);
  return {
    initial,
    refined: refineConnectionHealthWithCollectionReport(healthInput, initial, input.report),
  };
}

// ─── 1. apple_contacts: the live cry-wolf shape ─────────────────────────────

test("cry-wolf: apple_contacts — a run that succeeded today is not stale on the strength of a frozen proof", () => {
  const { initial, refined } = refine({
    lastSuccessAt: APPLE_CONTACTS_LAST_SUCCESS,
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    report: [
      // `contacts`: the incremental pass carried no measurement, so the fold
      // preserved the 2026-08-23 proof. Older than the 48h window.
      completeEntry("contacts", APPLE_CONTACTS_FROZEN_PROOF),
      // `address_books` / `contact_groups` were re-measured by the 08-26 run.
      completeEntry("address_books", APPLE_CONTACTS_LAST_SUCCESS),
      completeEntry("contact_groups", APPLE_CONTACTS_LAST_SUCCESS),
    ],
  });

  assert.equal(initial.axes.freshness, "fresh", "premise: the run-only projection is fresh — the run DID succeed");
  assert.equal(
    refined.axes.freshness,
    "fresh",
    "a source that collected successfully ~4.6h ago must stay fresh; a frozen coverage proof is not an owner action"
  );
  assert.equal(refined.axes.coverage, "complete", "coverage was complete and stays complete");
  assert.equal(refined.state, "healthy", "nothing is wrong with this source, so it must not read degraded");
});

test("cry-wolf: apple_contacts — the frozen proof does not degrade the headline state", () => {
  const { refined } = refine({
    lastSuccessAt: APPLE_CONTACTS_LAST_SUCCESS,
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    report: [completeEntry("contacts", APPLE_CONTACTS_FROZEN_PROOF)],
  });

  assert.notEqual(refined.state, "degraded", "a successful recent collection must not project a degraded headline");
  assert.equal(
    refined.conditions.some((condition) => condition.current && condition.status === "false"),
    false,
    "no condition may read false on a source that just collected successfully"
  );
});

// ─── 2. chase: the same shape at a different cadence ────────────────────────

/**
 * Separate from `apple_contacts` deliberately. `chase` refreshes daily
 * (`maximum_staleness_seconds: 86400`) against `apple_contacts`' 48h, so a
 * single hard-coded threshold would be right for one and wrong for the other.
 * The guard reads each connection's OWN declared window, so both hold.
 */
test("cry-wolf: chase — a same-day success is not stale under a 24h window and an older proof", () => {
  const { refined } = refine({
    lastSuccessAt: CHASE_LAST_SUCCESS,
    refreshPolicy: CHASE_REFRESH_POLICY,
    report: [completeEntry("transactions", CHASE_OLD_PROOF), completeEntry("accounts", CHASE_LAST_SUCCESS)],
  });

  assert.equal(refined.axes.freshness, "fresh", "chase collected successfully within its own 24h window");
  assert.equal(refined.state, "healthy");
});

test("cry-wolf: chase — the SAME proof age DOES stale it once its own window has elapsed", () => {
  // The proof and the run are identical to the passing case above in shape;
  // only the elapsed time differs. This is what proves the guard reads the
  // connection's real window rather than blanket-suppressing staleness.
  const longAgo = "2026-08-20T17:21:34.450Z"; // ~6.4 days before NOW, past 24h
  const { refined } = refine({
    lastSuccessAt: longAgo,
    refreshPolicy: CHASE_REFRESH_POLICY,
    report: [completeEntry("transactions", longAgo)],
  });

  assert.equal(refined.axes.freshness, "stale", "no success inside the 24h window means genuinely stale");
  assert.notEqual(refined.state, "healthy", "a genuinely stale source must not read Healthy");
});

// ─── 3. NEGATIVE CASES: real staleness must still be reported ───────────────

/**
 * The load-bearing half. Silencing a genuine problem is a worse defect than
 * the false alarm this change removes, so each of these must keep failing
 * loudly.
 */

test("negative: a source with NO successful run inside its window still stales against the proof anchor", () => {
  // Last success ~76h ago, window 48h. Nothing affirms current collection.
  const { refined } = refine({
    lastSuccessAt: APPLE_CONTACTS_FROZEN_PROOF,
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    report: [completeEntry("contacts", APPLE_CONTACTS_FROZEN_PROOF)],
  });

  assert.equal(refined.axes.freshness, "stale", "a source that has not collected in 76h is stale and must say so");
  assert.notEqual(refined.state, "healthy");
});

test("negative: a source that has not collected in months is still reported as stale", () => {
  const monthsAgo = "2026-04-01T00:00:00.000Z";
  const { refined } = refine({
    lastSuccessAt: monthsAgo,
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    report: [completeEntry("contacts", monthsAgo)],
  });

  assert.equal(refined.axes.freshness, "stale", "a months-dormant source must never be greened by this guard");
  assert.notEqual(refined.state, "healthy");
});

test("negative: a FAILED newest attempt after an old success is still stale (the guard reads success, not attempts)", () => {
  // The guard is anchored to `lastSuccessfulRun`, never `lastRun`. A brand-new
  // FAILED attempt must not be able to buy freshness.
  const oldSuccess = "2026-08-20T00:00:00.000Z"; // outside the 48h window
  const failedNow: ConnectorRunSummary = {
    ...succeededRunAt(NOW),
    failure_reason: "transient_500",
    run_id: "run_failed",
    status: "failed",
  };
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    freshness: { captured_at: oldSuccess, last_attempted_at: NOW, status: "stale" },
    lastRun: failedNow,
    lastSuccessfulRun: succeededRunAt(oldSuccess),
    nowIso: NOW,
    outbox: { axis: "idle" },
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    schedule: { enabled: true },
  };
  const initial = projectConnectorSummaryConnectionHealth(healthInput);
  const refined = refineConnectionHealthWithCollectionReport(healthInput, initial, [
    completeEntry("contacts", oldSuccess),
  ]);

  assert.equal(refined.axes.freshness, "stale", "a failed newest attempt over an old success stays stale");
  assert.notEqual(refined.state, "healthy");
});

/**
 * The discriminator between `lastSuccessfulRun` and `lastRun`. An IN-PROGRESS
 * attempt is recent but has collected nothing yet, and unlike a failed attempt
 * it does not trip `deriveReferenceFreshness`' own failed-after-success rule —
 * so it is the one shape where reading the wrong field silently buys freshness
 * a connection has not earned. A run currently trying is not a run that
 * succeeded.
 */
test("negative: an in-flight attempt over an old success does NOT buy freshness (guard reads successes only)", () => {
  const oldSuccess = "2026-08-20T00:00:00.000Z"; // outside the 48h window
  const runningNow: ConnectorRunSummary = {
    ...succeededRunAt("2026-08-27T02:00:00.000Z"),
    finished_at: null,
    run_id: "run_in_flight",
    status: "running",
  };
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    freshness: { captured_at: oldSuccess, last_attempted_at: "2026-08-27T02:00:00.000Z", status: "stale" },
    lastRun: runningNow,
    lastSuccessfulRun: succeededRunAt(oldSuccess),
    nowIso: NOW,
    outbox: { axis: "idle" },
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    schedule: { enabled: true },
  };
  const initial = projectConnectorSummaryConnectionHealth(healthInput);
  const refined = refineConnectionHealthWithCollectionReport(healthInput, initial, [
    completeEntry("contacts", oldSuccess),
  ]);

  assert.equal(refined.axes.freshness, "stale", "an attempt in flight is not a successful collection");
});

test("negative: a connection with NO successful run at all is never greened by the guard", () => {
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    freshness: { captured_at: APPLE_CONTACTS_FROZEN_PROOF, status: "stale" },
    lastRun: null,
    lastSuccessfulRun: null,
    nowIso: NOW,
    outbox: { axis: "idle" },
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    schedule: { enabled: true },
  };
  const initial = projectConnectorSummaryConnectionHealth(healthInput);
  const refined = refineConnectionHealthWithCollectionReport(healthInput, initial, [
    completeEntry("contacts", APPLE_CONTACTS_FROZEN_PROOF),
  ]);

  assert.notEqual(refined.axes.freshness, "fresh", "no successful run means no affirmative evidence to green on");
  assert.notEqual(refined.state, "healthy");
});

// ─── 4. The guard cannot fabricate freshness ────────────────────────────────

test("guard hygiene: an unparseable success anchor withholds the guard rather than greening", () => {
  const run: ConnectorRunSummary = { ...succeededRunAt(NOW), last_at: "not-a-date" };
  const healthInput: Parameters<typeof projectConnectorSummaryConnectionHealth>[0] = {
    freshness: { captured_at: APPLE_CONTACTS_FROZEN_PROOF, status: "stale" },
    lastRun: run,
    lastSuccessfulRun: run,
    nowIso: NOW,
    outbox: { axis: "idle" },
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    schedule: { enabled: true },
  };
  const initial = projectConnectorSummaryConnectionHealth(healthInput);
  const refined = refineConnectionHealthWithCollectionReport(healthInput, initial, [
    completeEntry("contacts", APPLE_CONTACTS_FROZEN_PROOF),
  ]);

  assert.notEqual(refined.axes.freshness, "fresh", "a malformed anchor must fail closed, never green a connection");
});

test("guard hygiene: a real coverage gap is untouched — the guard only ever speaks to freshness", () => {
  const { refined } = refine({
    lastSuccessAt: APPLE_CONTACTS_LAST_SUCCESS,
    refreshPolicy: APPLE_CONTACTS_REFRESH_POLICY,
    report: [
      {
        ...completeEntry("contacts", APPLE_CONTACTS_LAST_SUCCESS),
        coverage_condition: "retryable_gap",
        forward_disposition: "resumable",
      },
    ],
  });

  assert.notEqual(refined.axes.coverage, "complete", "a recent success must not launder a real coverage gap");
  assert.notEqual(refined.state, "healthy", "a gappy source stays non-Healthy regardless of freshness");
});
