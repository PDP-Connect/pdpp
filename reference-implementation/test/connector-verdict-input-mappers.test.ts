// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit coverage for the pure evidence-mapping helpers in
 * `runtime/connector-verdict-input.ts`. `streamPriority`, `buildStreamRollups`,
 * and `buildProgressEvidence` had no direct test; `progressMode` was invoked
 * once (for the manual case only). These mappers decide the worst-wins rollup
 * priority, per-stream retryability/attention attribution, and the progress
 * model the verdict privileges — a mutant flipping a clause here silently
 * mis-renders connection health.
 *
 * Pure mapping; no grant/auth/token/consent logic (no RED tokens in the
 * module). No source is changed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectionAxes, ConnectionHealthSnapshot, CoverageAxis } from "../runtime/connection-health.ts";
import {
  buildProgressEvidence,
  buildStreamRollups,
  progressMode,
  streamPriority,
} from "../runtime/connector-verdict-input.ts";

// buildStreamRollups only reads snapshot.axes (attention, coverage) — see
// its body in runtime/connector-verdict-input.ts — but its declared param
// type is the full ConnectionHealthSnapshot. This builds a complete, valid
// (if inert) snapshot so the axes override under test is real, not a
// suppressed type mismatch on unrelated fields.
function snapshot(axes: Partial<ConnectionAxes> = {}): ConnectionHealthSnapshot {
  return {
    axes: {
      attention: "none",
      coverage: "complete",
      freshness: "fresh",
      outbox: "idle",
      remote_surface: "none",
      ...axes,
    },
    badges: { stale: false, syncing: false },
    collection_rate: null,
    conditions: [],
    detail_gap_backlog: null,
    dominant_condition_id: null,
    ephemeral_browser_runtime: null,
    forward_disposition: "complete",
    last_success_at: null,
    local_device_outbox_counts: null,
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    remote_surface: null,
    state: "healthy",
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

// ─── streamPriority ──────────────────────────────────────────────────────

test("streamPriority treats an unknown/undefined stream as required", () => {
  assert.equal(streamPriority(undefined), "required");
});

test("streamPriority keeps a required (default or explicit) stream required", () => {
  assert.equal(streamPriority({ name: "a" }), "required");
  assert.equal(streamPriority({ name: "a", required: true }), "required");
});

test("streamPriority marks a non-required stream with an accepted policy accepted_absence", () => {
  assert.equal(streamPriority({ coverage_policy: "deferred", name: "a", required: false }), "accepted_absence");
  assert.equal(streamPriority({ coverage_policy: "unavailable", name: "a", required: false }), "accepted_absence");
});

test("streamPriority marks a non-required collect / no-policy stream optional", () => {
  assert.equal(streamPriority({ coverage_policy: "collect", name: "a", required: false }), "optional");
  assert.equal(streamPriority({ name: "a", required: false }), "optional");
});

test("streamPriority keeps a contradictory required+accepted-policy stream required", () => {
  assert.equal(streamPriority({ coverage_policy: "deferred", name: "a", required: true }), "required");
});

// ─── progressMode ────────────────────────────────────────────────────────

test("progressMode prefers local_device above all other signals", () => {
  assert.equal(
    progressMode({ hasRecoveredDetailGaps: true, localDeviceBacked: true, refresh: null, schedule: { enabled: true } }),
    "local_device"
  );
});

test("progressMode is deferred for a scheduled connector draining recovered detail gaps", () => {
  assert.equal(
    progressMode({
      hasRecoveredDetailGaps: true,
      localDeviceBacked: false,
      refresh: null,
      schedule: { enabled: true },
    }),
    "deferred"
  );
});

test("progressMode is manual for a non-scheduled connection", () => {
  assert.equal(
    progressMode({ hasRecoveredDetailGaps: false, localDeviceBacked: false, refresh: null, schedule: null }),
    "manual"
  );
});

test("progressMode is manual when the refresh contract is manual-only", () => {
  assert.equal(
    progressMode({
      hasRecoveredDetailGaps: false,
      localDeviceBacked: false,
      refresh: { backgroundSafe: null, recommendedMode: "manual" },
      schedule: { enabled: true },
    }),
    "manual"
  );
});

test("progressMode is scheduled for an explicit manual-default background-safe schedule", () => {
  assert.equal(
    progressMode({
      hasRecoveredDetailGaps: false,
      localDeviceBacked: false,
      refresh: { backgroundSafe: true, recommendedMode: "manual" },
      schedule: { enabled: true },
    }),
    "scheduled"
  );
});

test("progressMode is scheduled otherwise", () => {
  assert.equal(
    progressMode({
      hasRecoveredDetailGaps: false,
      localDeviceBacked: false,
      refresh: null,
      schedule: { enabled: true },
    }),
    "scheduled"
  );
});

// ─── buildProgressEvidence ───────────────────────────────────────────────

test("buildProgressEvidence maps every field through and defaults observed_at to null", () => {
  assert.deepEqual(
    buildProgressEvidence({
      gapsDrainedLastRun: 2,
      lastRefreshedAt: "2026-01-01T00:00:00.000Z",
      mode: "scheduled",
      recordsCommittedLastRun: null,
      retainedRecords: 5,
    }),
    {
      gaps_drained_last_run: 2,
      last_refreshed_at: "2026-01-01T00:00:00.000Z",
      mode: "scheduled",
      observed_at: null,
      records_committed_last_run: null,
      retained_records: 5,
    }
  );
});

test("buildProgressEvidence forwards an explicit observed_at", () => {
  assert.equal(
    buildProgressEvidence({
      gapsDrainedLastRun: null,
      lastRefreshedAt: null,
      mode: "manual",
      observedAt: "2026-02-02T00:00:00.000Z",
      recordsCommittedLastRun: null,
      retainedRecords: null,
    }).observed_at,
    "2026-02-02T00:00:00.000Z"
  );
});

// ─── buildStreamRollups ──────────────────────────────────────────────────

test('buildStreamRollups maps considered "unknown" to null and marks retryable coverage', () => {
  const [rollup] = buildStreamRollups(
    [
      {
        collected: 10,
        considered: "unknown",
        coverage_condition: "retryable_gap",
        pending_detail_gaps: 0,
        stream: "messages",
      },
    ],
    [{ name: "messages", required: true }],
    snapshot({ coverage: "partial" })
  );
  assert.ok(rollup, "expected exactly one stream rollup");
  assert.equal(rollup.considered, null);
  assert.equal(rollup.coverage, "retryable_gap");
  assert.equal(rollup.gap_retryable, true);
  assert.equal(rollup.priority, "required");
});

test("buildStreamRollups marks a stream retryable when detail gaps remain even on complete coverage", () => {
  const [rollup] = buildStreamRollups(
    [{ collected: 1, considered: 1, coverage_condition: "complete", pending_detail_gaps: 3, stream: "m" }],
    [{ name: "m" }],
    snapshot({ coverage: "partial" })
  );
  assert.ok(rollup, "expected exactly one stream rollup");
  assert.equal(rollup.gap_retryable, true);
});

test("buildStreamRollups attributes connection attention only to non-complete streams", () => {
  // 'needs_action' is not a real AttentionAxis value; the test only needs
  // ANY non-'none' attention state (buildStreamRollups checks !== 'none').
  const attentive = snapshot({ attention: "open" });
  const [nonComplete] = buildStreamRollups(
    [{ collected: 1, considered: 2, coverage_condition: "partial", pending_detail_gaps: 1, stream: "m" }],
    [{ name: "m" }],
    attentive
  );
  assert.ok(nonComplete, "expected exactly one stream rollup");
  assert.equal(nonComplete.attention_open, true);

  const [complete] = buildStreamRollups(
    [{ collected: 1, considered: 1, coverage_condition: "complete", pending_detail_gaps: 0, stream: "m" }],
    [{ name: "m" }],
    attentive
  );
  assert.ok(complete, "expected exactly one stream rollup");
  assert.equal(complete.attention_open, false);
});

test("buildStreamRollups downgrades a per-run report gap to optional when the connection coverage is complete", () => {
  const [rollup] = buildStreamRollups(
    [{ collected: 1, considered: 1, coverage_condition: "partial", pending_detail_gaps: 0, stream: "m" }],
    [{ name: "m", required: true }],
    snapshot({ coverage: "complete" })
  );
  assert.ok(rollup, "expected exactly one stream rollup");
  // connectionCompleteReportGap: complete coverage + no pending gaps + a
  // non-terminal incomplete per-run condition -> effectivePriority optional.
  assert.equal(rollup.priority, "optional");
});

test("buildStreamRollups keeps a terminal gap load-bearing even under complete connection coverage", () => {
  const terminalConditions: readonly CoverageAxis[] = ["terminal_gap", "unsupported", "unavailable"];
  for (const terminal of terminalConditions) {
    const [rollup] = buildStreamRollups(
      [{ collected: 1, considered: 1, coverage_condition: terminal, pending_detail_gaps: 0, stream: "m" }],
      [{ name: "m", required: true }],
      snapshot({ coverage: "complete" })
    );
    assert.ok(rollup, "expected exactly one stream rollup");
    assert.equal(rollup.priority, "required", terminal);
  }
});
