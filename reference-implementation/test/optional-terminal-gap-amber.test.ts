// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The four-case truth table for the owner's 2026-08-23 policy decision on
 * non-required stream shortfalls.
 *
 * Before this policy, `required: false` was overloaded: it meant BOTH "the
 * connector does not intend to collect this" AND "the connector intends to
 * collect this, but the source is allowed to be missing it". The rollup
 * collapsed both into "does not count", so a stream the connector genuinely
 * INTENDS to collect (`coverage_policy: collect`, or no policy at all) could
 * sit in a permanent terminal gap forever while the source pill read "Healthy".
 * iMessage participants/attachments on older macOS is the live shape of that.
 *
 * The owner's decision: a source may be green with a non-required shortfall
 * ONLY when the stream carries an explicit accepted-absence policy. A
 * collect-intent stream that is lost forever makes the source at least AMBER,
 * labeled "Missing optional data".
 *
 * The three-way distinction is preserved deliberately — `optional` is NOT
 * folded into `required`:
 *
 *   required          + terminal_gap  -> red   ("Can't collect")
 *   optional          + terminal_gap  -> amber ("Missing optional data")   <- NEW
 *   optional          + retryable_gap -> unchanged (green; the next ordinary
 *                                       run still fills it, so ambering it
 *                                       would be exactly the alert fatigue
 *                                       this policy is trying to avoid)
 *   accepted_absence  + terminal_gap  -> green (unchanged; the manifest
 *                                       declared the absence as accepted)
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type ComputeConnectionHealthInput,
  type ConnectionRefreshEvidence,
  computeConnectionHealth,
} from "../runtime/connection-health.ts";
import { type StreamRollup, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const OBSERVED_AT = "2026-08-12T12:00:00.000Z";
const SUCCESS_AT = "2026-08-12T11:55:00.000Z";

const AUTOMATIC_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: true,
  interactionPosture: "none",
  recommendedMode: "automatic",
};

/** A clean, healthy connection: every axis green, so the ONLY variable is the stream rollup. */
function healthyInput(): ComputeConnectionHealthInput {
  return {
    activity: { active: false },
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    outbox: { axis: "idle" },
    projection: { unreliableSources: [] },
    refresh: AUTOMATIC_REFRESH,
    run: {
      hasDegradingGaps: false,
      lastSuccessAt: SUCCESS_AT,
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
  };
}

function stream(overrides: Partial<StreamRollup> = {}): StreamRollup {
  return {
    attention_open: false,
    collected: null,
    considered: null,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "records",
    ...overrides,
  };
}

/** Synthesize a verdict over an otherwise-healthy connection with the given stream rollups. */
function verdictFor(streams: readonly StreamRollup[]) {
  const snapshot = computeConnectionHealth(healthyInput());
  return synthesizeRenderedVerdict(snapshot, streams, AUTOMATIC_REFRESH, true, {
    last_refreshed_at: SUCCESS_AT,
    mode: "scheduled",
    observed_at: OBSERVED_AT,
    records_committed_last_run: 1,
    retained_records: 1,
  });
}

// ─── Case 1: required + terminal -> red (unchanged) ─────────────────────────

test("required stream with a terminal gap stays red", () => {
  const v = verdictFor([
    stream({ coverage: "complete", stream_id: "messages" }),
    stream({ coverage: "terminal_gap", priority: "required", stream_id: "attachments" }),
  ]);
  assert.equal(v.pill.tone, "red", "a load-bearing stream lost forever is a red source");
  assert.equal(v.pill.label, "Can't collect");
});

// ─── Case 2: optional + terminal -> amber "Missing optional data" (NEW) ─────

test("optional (collect-intent) stream with a terminal gap ambers as Missing optional data", () => {
  const v = verdictFor([
    stream({ coverage: "complete", stream_id: "messages" }),
    stream({ coverage: "terminal_gap", priority: "optional", stream_id: "attachments" }),
  ]);
  assert.equal(
    v.pill.tone,
    "amber",
    "owner decision 2026-08-23: a stream the connector INTENDS to collect, lost forever, is not Healthy"
  );
  assert.equal(v.pill.label, "Missing optional data");
});

test("an optional terminal gap does not escalate the source to red", () => {
  const v = verdictFor([stream({ coverage: "terminal_gap", priority: "optional", stream_id: "attachments" })]);
  assert.equal(v.pill.tone, "amber", "optional is still NOT required — it ambers, it does not go red");
  assert.notEqual(v.pill.label, "Can't collect");
});

test("a required terminal gap dominates an optional one (worst-wins is preserved)", () => {
  const v = verdictFor([
    stream({ coverage: "terminal_gap", priority: "optional", stream_id: "attachments" }),
    stream({ coverage: "terminal_gap", priority: "required", stream_id: "messages" }),
  ]);
  assert.equal(v.pill.tone, "red");
  assert.equal(v.pill.label, "Can't collect");
});

// ─── Case 3: optional + RETRYABLE -> unchanged (must NOT amber) ─────────────

test("optional stream with a RETRYABLE gap does not amber", () => {
  const v = verdictFor([
    stream({ coverage: "complete", stream_id: "messages" }),
    stream({
      coverage: "retryable_gap",
      gap_retryable: true,
      priority: "optional",
      stream_id: "attachments",
    }),
  ]);
  assert.equal(
    v.pill.tone,
    "green",
    "a retryable optional gap resolves itself on the next ordinary run; ambering it is alert fatigue"
  );
  assert.equal(v.pill.label, "Healthy");
});

test("optional stream with a partial/gaps coverage axis does not amber", () => {
  for (const coverage of ["partial", "gaps"] as const) {
    const v = verdictFor([
      stream({ coverage: "complete", stream_id: "messages" }),
      stream({ coverage, gap_retryable: true, priority: "optional", stream_id: "attachments" }),
    ]);
    assert.equal(v.pill.tone, "green", `optional ${coverage} is non-terminal and must not downgrade the source`);
  }
});

// ─── Case 4: accepted_absence + terminal -> green (unchanged) ───────────────

test("accepted_absence stream with a terminal gap stays green", () => {
  const v = verdictFor([
    stream({ coverage: "complete", stream_id: "messages" }),
    stream({ coverage: "terminal_gap", priority: "accepted_absence", stream_id: "attachments" }),
  ]);
  assert.equal(
    v.pill.tone,
    "green",
    "the manifest explicitly declared this absence accepted — that is the whole point of the policy"
  );
  assert.equal(v.pill.label, "Healthy");
});

// ─── The distinction itself ─────────────────────────────────────────────────

test("optional and accepted_absence are NOT the same verdict under a terminal gap", () => {
  const optional = verdictFor([stream({ coverage: "terminal_gap", priority: "optional", stream_id: "s" })]);
  const accepted = verdictFor([stream({ coverage: "terminal_gap", priority: "accepted_absence", stream_id: "s" })]);
  assert.notEqual(
    optional.pill.tone,
    accepted.pill.tone,
    "collapsing these two is the exact defect this policy fixes: `required: false` was overloaded"
  );
});

test("an optional terminal gap that is fully unfillable-accounted stays green", () => {
  // Durable per-item proof that the shortfall is permanently uncollectable is
  // the same evidence an accepted-absence policy asserts, just proven per-item
  // rather than declared in the manifest. It already tones green for required
  // streams; the new optional path must read the same proof, not ignore it.
  const v = verdictFor([
    stream({
      coverage: "terminal_gap",
      priority: "optional",
      stream_id: "attachments",
      unfillable_accounted: true,
    }),
  ]);
  assert.equal(v.pill.tone, "green");
});
