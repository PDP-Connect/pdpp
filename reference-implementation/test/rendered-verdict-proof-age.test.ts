// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof age on the owner-facing freshness sentence.
 *
 * The system stores, per required stream, WHEN that stream's coverage was last
 * proven (`evidence_as_of`). Until this suite, none of that reached the owner:
 * a coverage proof measured three days ago rendered exactly like one measured
 * minutes ago ("Fresh today."), because the freshness sentence was anchored to
 * CONNECTION-RECORD recency (`last_refreshed_at`, from `freshness.captured_at`)
 * and never to the coverage proof.
 *
 * These tests pin the four cases that matter to an owner:
 *   1. recent proof            -> sentence unchanged (no date clutter)
 *   2. old-but-in-window proof -> sentence states when coverage was proven
 *   3. absent proof            -> sentence falls back to today's exact wording
 *   4. mismatched anchors      -> a fresh RECORD cannot claim "Fresh today."
 *                                 over a materially older COVERAGE PROOF
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectionHealthSnapshot, ConnectionRefreshEvidence } from "../runtime/connection-health.ts";
import { buildProgressEvidence } from "../runtime/connector-verdict-input.ts";
import { type ProgressEvidence, type StreamRollup, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const OBSERVED_AT = "2026-06-15T12:00:00.000Z";

const THREE_DAYS_AGO_PATTERN = /3 days ago/;
const FIVE_DAYS_AGO_PATTERN = /5 days ago/;
const NAMES_COVERAGE_PATTERN = /cover(age|ed)/i;

const SCHEDULED_REFRESH: ConnectionRefreshEvidence = {
  background_safe: true,
  interaction_posture: "background",
  recommended_mode: "scheduled",
};

/** A green, fresh, fully-covered connection — the shape that renders "Fresh today.". */
function healthySnapshot(): ConnectionHealthSnapshot {
  return {
    axes: {
      coverage: "complete",
      credential: "valid",
      freshness: "fresh",
      runtime: "ok",
    },
    badges: { syncing: false },
    collection_rate: null,
    conditions: [],
    detail_gap_backlog: {
      max_attempt_count: 0,
      next_attempt_at: null,
      pending: 0,
      pending_is_floor: false,
      pending_other: 0,
      pending_other_is_floor: false,
      recovered: 0,
      terminal: null,
    },
    forward_disposition: "complete",
    last_success_at: "2026-06-15T08:00:00.000Z",
    state: "healthy",
  } as unknown as ConnectionHealthSnapshot;
}

function completeStream(): StreamRollup {
  return {
    attention_open: false,
    collected: 10,
    considered: 10,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "messages",
  };
}

function progress(overrides: Partial<ProgressEvidence> = {}): ProgressEvidence {
  return {
    last_refreshed_at: "2026-06-15T08:00:00.000Z",
    mode: "scheduled",
    observed_at: OBSERVED_AT,
    records_committed_last_run: 10,
    retained_records: 100,
    ...overrides,
  };
}

function freshnessText(progressEvidence: ProgressEvidence): string | null {
  const verdict = synthesizeRenderedVerdict(
    healthySnapshot(),
    [completeStream()],
    SCHEDULED_REFRESH,
    true,
    progressEvidence
  );
  return verdict.annotations.find((annotation) => annotation.kind === "freshness")?.text ?? null;
}

// ─── 1. A recent proof stays clean ───────────────────────────────────────────

test("proof age: a proof measured today leaves the fresh sentence unchanged", () => {
  const text = freshnessText(
    progress({
      // Coverage proven the same day the records were refreshed.
      coverage_proven_at: "2026-06-15T08:00:00.000Z",
      last_refreshed_at: "2026-06-15T08:00:00.000Z",
    })
  );
  assert.equal(text, "Fresh today.", "a same-day proof must not bolt a date onto a healthy row");
});

test("proof age: a proof measured yesterday leaves the fresh sentence unchanged", () => {
  const text = freshnessText(
    progress({
      coverage_proven_at: "2026-06-14T08:00:00.000Z",
      last_refreshed_at: "2026-06-15T08:00:00.000Z",
    })
  );
  assert.equal(text, "Fresh today.", "a one-day-old proof is still recent enough to stay uncluttered");
});

// ─── 2. An old-but-in-window proof states its age ────────────────────────────

test("proof age: a three-day-old coverage proof states when coverage was last proven", () => {
  const text = freshnessText(
    progress({
      // Records refreshed today, but the required-stream coverage proof is
      // three days old. Still inside the freshness window, so the connection
      // is legitimately green — but the owner must be told the proof's age.
      coverage_proven_at: "2026-06-12T08:00:00.000Z",
      last_refreshed_at: "2026-06-15T08:00:00.000Z",
    })
  );
  assert.ok(text, "an old proof must still produce a freshness sentence");
  assert.match(
    text as string,
    THREE_DAYS_AGO_PATTERN,
    `expected the sentence to state the proof's age, got: ${JSON.stringify(text)}`
  );
  assert.match(
    text as string,
    NAMES_COVERAGE_PATTERN,
    `expected the sentence to name coverage as the thing proven, got: ${JSON.stringify(text)}`
  );
});

// ─── 3. FAIL CLOSED: an absent proof falls back to today's exact wording ─────

test("proof age: an absent coverage proof falls back to the exact shipped wording", () => {
  const text = freshnessText(progress({ last_refreshed_at: "2026-06-15T08:00:00.000Z" }));
  assert.equal(text, "Fresh today.", "an absent proof must render exactly the shipped sentence");
});

test("proof age: a null coverage proof falls back to the exact shipped wording", () => {
  const text = freshnessText(progress({ coverage_proven_at: null, last_refreshed_at: "2026-06-15T08:00:00.000Z" }));
  assert.equal(text, "Fresh today.");
});

test("proof age: a malformed coverage proof never renders a fabricated date", () => {
  for (const bad of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
    const text = freshnessText(progress({ coverage_proven_at: bad, last_refreshed_at: "2026-06-15T08:00:00.000Z" }));
    assert.equal(text, "Fresh today.", `malformed proof ${JSON.stringify(bad)} must fall back cleanly`);
    for (const forbidden of ["undefined", "Invalid Date", "NaN", "null"]) {
      assert.ok(
        !(text as string).includes(forbidden),
        `sentence must never contain ${forbidden}, got: ${JSON.stringify(text)}`
      );
    }
  }
});

test("proof age: a coverage proof NEWER than the observation instant never renders a negative age", () => {
  const text = freshnessText(
    progress({
      // Clock skew: a proof stamped in the future must not produce
      // "-1 days ago" or any other fabricated age.
      coverage_proven_at: "2026-06-20T08:00:00.000Z",
      last_refreshed_at: "2026-06-15T08:00:00.000Z",
    })
  );
  assert.equal(text, "Fresh today.", "a future-stamped proof must fall back, not render a negative age");
  assert.ok(!(text as string).includes("-"), `no negative age may render, got: ${JSON.stringify(text)}`);
});

// ─── 4. The mismatched-anchor case ───────────────────────────────────────────

test("proof age: a fresh record anchor cannot claim 'Fresh today.' over a materially older proof", () => {
  const text = freshnessText(
    progress({
      // THE DEFECT: `last_refreshed_at` (connection-record recency) says today,
      // while the required-stream coverage proof is five days old. Two
      // different anchors. The owner must not be told the flat "Fresh today."
      // on the strength of the record anchor alone.
      coverage_proven_at: "2026-06-10T08:00:00.000Z",
      last_refreshed_at: "2026-06-15T11:59:00.000Z",
    })
  );
  assert.notEqual(
    text,
    "Fresh today.",
    "record recency must not launder a five-day-old coverage proof into a bare 'Fresh today.'"
  );
  assert.match(text as string, FIVE_DAYS_AGO_PATTERN, `expected the proof's real age, got: ${JSON.stringify(text)}`);
});

// ─── 5. The mapper seam actually carries the anchor ──────────────────────────

/**
 * The renderer tests above prove the SENTENCE. This one proves the WIRING:
 * without it, `coverage_proven_at` could be a well-tested field that no real
 * connection ever populates.
 */
test("proof age: buildProgressEvidence carries the coverage anchor to the renderer", () => {
  const evidence = buildProgressEvidence({
    coverageProvenAt: "2026-06-10T08:00:00.000Z",
    gapsDrainedLastRun: null,
    lastRefreshedAt: "2026-06-15T11:59:00.000Z",
    mode: "scheduled",
    observedAt: OBSERVED_AT,
    recordsCommittedLastRun: 10,
    retainedRecords: 100,
  });
  assert.equal(evidence.coverage_proven_at, "2026-06-10T08:00:00.000Z");
  assert.equal(
    freshnessText(evidence),
    "Fresh today. Coverage last proven 5 days ago.",
    "the mapped evidence must reach the sentence"
  );
});

test("proof age: buildProgressEvidence defaults the coverage anchor to null when omitted", () => {
  const evidence = buildProgressEvidence({
    gapsDrainedLastRun: null,
    lastRefreshedAt: "2026-06-15T11:59:00.000Z",
    mode: "scheduled",
    observedAt: OBSERVED_AT,
    recordsCommittedLastRun: 10,
    retainedRecords: 100,
  });
  assert.equal(evidence.coverage_proven_at, null, "an omitted anchor must be null, never undefined");
  assert.equal(freshnessText(evidence), "Fresh today.", "an omitted anchor keeps the shipped wording");
});
