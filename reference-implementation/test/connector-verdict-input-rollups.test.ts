// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { AttentionAxis, ConnectionHealthSnapshot } from "../runtime/connection-health.ts";
import {
  buildProgressEvidence,
  buildStreamRollups,
  type CollectionReportEntryLike,
  type ManifestStreamLike,
  streamPriority,
} from "../runtime/connector-verdict-input.ts";

// Mutation-killing tests for the PURE per-stream rollup projection helpers in
// `connector-verdict-input.ts`. These map the Collection Report + manifest
// streams + connection health axes onto the synthesizer's per-stream rollups —
// the "worst-wins by priority" input to the connector verdict. The verdict-level
// tests exercise synthesizeConnectorVerdict/progressMode, but streamPriority,
// buildStreamRollups, and buildProgressEvidence have NO direct coverage, so
// their branch logic (priority weighting, unknown→null coercion, retryable
// derivation, the complete-connection gap demotion, attention attribution) is
// otherwise unguarded. checkJs is off, so minimal duck-typed fixtures suffice —
// the helpers read only the fields asserted here. Pure — no DB.

/**
 * A minimal health snapshot: the rollup reads only `axes.attention`/`axes.coverage`.
 * Every other field is a complete, honest default satisfying the full
 * `ConnectionHealthSnapshot` shape (the rollup ignores them, but the type is real).
 */
function snap(
  axes: { attention?: AttentionAxis; coverage?: CollectionReportEntryLike["coverage_condition"] } = {}
): ConnectionHealthSnapshot {
  return {
    axes: {
      attention: axes.attention ?? "none",
      coverage: axes.coverage ?? "complete",
      freshness: "fresh",
      outbox: "idle",
      remote_surface: "none",
    },
    badges: { stale: false, syncing: false },
    collection_rate: null,
    conditions: [],
    coverage_horizons: [],
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

/** A collection-report entry with honest defaults. */
function entry(over: Partial<CollectionReportEntryLike> = {}): CollectionReportEntryLike {
  return {
    collected: 10,
    considered: 10,
    coverage_condition: "complete",
    pending_detail_gaps: 0,
    stream: "s1",
    ...over,
  };
}

// --------------------------------------------------------------------------
// streamPriority — the manifest-weight branch table
// --------------------------------------------------------------------------

test("streamPriority: undefined stream is treated as required", () => {
  assert.equal(streamPriority(undefined), "required");
});

test("streamPriority: required defaults to true when absent; only required===false opts out", () => {
  assert.equal(streamPriority({ name: "s" }), "required", "absent required → required");
  assert.equal(streamPriority({ name: "s", required: true }), "required");
  // required:false with no accepted policy → optional.
  assert.equal(streamPriority({ name: "s", required: false }), "optional");
});

test("streamPriority: non-required stream with an accepted (non-collect) policy is accepted_absence", () => {
  assert.equal(streamPriority({ coverage_policy: "inventory_only", name: "s", required: false }), "accepted_absence");
  assert.equal(streamPriority({ coverage_policy: "unsupported", name: "s", required: false }), "accepted_absence");
  // A "collect" policy is NOT accepted-absence — it is a real collection stream.
  assert.equal(streamPriority({ coverage_policy: "collect", name: "s", required: false }), "optional");
});

test("streamPriority: a required stream that ALSO declares an accepted policy stays required (contradiction resolves to required)", () => {
  // required wins so the stream cannot annotate away its own gap.
  assert.equal(streamPriority({ coverage_policy: "unavailable", name: "s", required: true }), "required");
});

// --------------------------------------------------------------------------
// buildStreamRollups — considered coercion, retryable, attention, gap demotion
// --------------------------------------------------------------------------

test('buildStreamRollups: considered "unknown" becomes null; a number passes through', () => {
  const rows = buildStreamRollups(
    [entry({ considered: "unknown" }), entry({ considered: 42, stream: "s2" })],
    [],
    snap()
  );
  const [row0, row1] = rows;
  assert.ok(row0, "first row exists");
  assert.ok(row1, "second row exists");
  assert.equal(row0.considered, null, "unknown → null");
  assert.equal(row1.considered, 42, "a real denominator is preserved");
});

test("buildStreamRollups: gap_retryable is true for a retryable axis OR any pending detail gaps", () => {
  // retryable coverage axis.
  const retryAxis = buildStreamRollups([entry({ coverage_condition: "retryable_gap" })], [], snap());
  const [retryRow] = retryAxis;
  assert.ok(retryRow, "retry row exists");
  assert.equal(retryRow.gap_retryable, true);
  // pending detail gaps alone, on an otherwise non-retryable axis.
  const pending = buildStreamRollups(
    [entry({ coverage_condition: "terminal_gap", pending_detail_gaps: 2 })],
    [],
    snap({ coverage: "gaps" })
  );
  const [pendingRow] = pending;
  assert.ok(pendingRow, "pending row exists");
  assert.equal(pendingRow.gap_retryable, true, "pending detail gaps make it retryable");
  // neither: complete axis, no pending → not retryable.
  const clean = buildStreamRollups([entry()], [], snap());
  const [cleanRow] = clean;
  assert.ok(cleanRow, "clean row exists");
  assert.equal(cleanRow.gap_retryable, false);
});

test("buildStreamRollups: attention is attributed only to non-complete streams, and only when the axis is open", () => {
  // Attention open at the connection level; a complete stream must NOT inherit it.
  // NOTE: fixed from the invalid literal 'action_required' (not a member of
  // AttentionAxis) to 'open' — the real "owner action requested" member the
  // test's own comment describes, which is what this test's attention-open
  // branch is meant to exercise.
  const withAttention = buildStreamRollups(
    [entry({ coverage_condition: "complete" }), entry({ coverage_condition: "gaps", stream: "s2" })],
    [],
    snap({ attention: "open", coverage: "gaps" })
  );
  const [attnRow0, attnRow1] = withAttention;
  assert.ok(attnRow0, "first attention row exists");
  assert.ok(attnRow1, "second attention row exists");
  assert.equal(attnRow0.attention_open, false, "complete stream never inherits attention");
  assert.equal(attnRow1.attention_open, true, "incomplete stream inherits the open attention");
  // Attention closed: even an incomplete stream is not flagged.
  const noAttention = buildStreamRollups(
    [entry({ coverage_condition: "gaps" })],
    [],
    snap({ attention: "none", coverage: "gaps" })
  );
  const [noAttnRow] = noAttention;
  assert.ok(noAttnRow, "no-attention row exists");
  assert.equal(noAttnRow.attention_open, false);
});

test("buildStreamRollups: a fresh complete connection demotes a required stream with a non-terminal report gap to optional", () => {
  const manifestStreams: ManifestStreamLike[] = [{ name: "s1", required: true }];
  // Connection coverage is complete, no pending gaps, but the stream's own
  // latest-run coverage is a benign non-terminal gap (`partial`) → demote to
  // optional so the complete/fresh connector is not turned amber by a per-run
  // denominator gap.
  const demoted = buildStreamRollups(
    [entry({ coverage_condition: "partial", pending_detail_gaps: 0 })],
    manifestStreams, // manifest says required...
    snap({ coverage: "complete" })
  );
  const [demotedRow] = demoted;
  assert.ok(demotedRow, "demoted row exists");
  assert.equal(demotedRow.priority, "optional", "...but the complete-connection gap override demotes it");

  // A TERMINAL stream gap is load-bearing — the override must NOT demote it.
  const kept = buildStreamRollups(
    [entry({ coverage_condition: "terminal_gap", pending_detail_gaps: 0 })],
    manifestStreams,
    snap({ coverage: "complete" })
  );
  const [keptRow] = kept;
  assert.ok(keptRow, "kept row exists");
  assert.equal(keptRow.priority, "required", "terminal gap keeps its required weight");

  // If the CONNECTION coverage is not complete, the override does not fire even
  // for a non-terminal stream gap → required weight is preserved.
  const notComplete = buildStreamRollups(
    [entry({ coverage_condition: "partial", pending_detail_gaps: 0 })],
    manifestStreams,
    snap({ coverage: "gaps" })
  );
  const [notCompleteRow] = notComplete;
  assert.ok(notCompleteRow, "not-complete row exists");
  assert.equal(notCompleteRow.priority, "required");
});

test("buildStreamRollups: pending detail gaps block the complete-connection demotion", () => {
  // Same non-terminal stream gap, but pending_detail_gaps > 0 → the override's
  // `pending_detail_gaps === 0` clause fails, so the stream stays required.
  const rows = buildStreamRollups(
    [entry({ coverage_condition: "partial", pending_detail_gaps: 1 })],
    [{ name: "s1", required: true }],
    snap({ coverage: "complete" })
  );
  const [row] = rows;
  assert.ok(row, "row exists");
  assert.equal(row.priority, "required");
  assert.equal(row.gap_retryable, true, "pending gaps also make it retryable");
});

test("buildStreamRollups: stream_id, collected, and coverage echo the report entry", () => {
  const rows = buildStreamRollups(
    [entry({ collected: 7, coverage_condition: "gaps", stream: "orders" })],
    [],
    snap({ coverage: "gaps" })
  );
  const [row] = rows;
  assert.ok(row, "row exists");
  assert.equal(row.stream_id, "orders");
  assert.equal(row.collected, 7);
  assert.equal(row.coverage, "gaps");
});

// --------------------------------------------------------------------------
// buildProgressEvidence — nullable pass-through + observed_at default
// --------------------------------------------------------------------------

test("buildProgressEvidence: passes every field through and defaults observed_at to null", () => {
  const ev = buildProgressEvidence({
    gapsDrainedLastRun: 2,
    lastRefreshedAt: "2026-06-29T12:00:00.000Z",
    mode: "scheduled",
    recordsCommittedLastRun: 5,
    retainedRecords: 100,
  });
  assert.deepEqual(ev, {
    coverage_proven_at: null,
    gaps_drained_last_run: 2,
    last_refreshed_at: "2026-06-29T12:00:00.000Z",
    mode: "scheduled",
    observed_at: null,
    records_committed_last_run: 5,
    retained_records: 100,
  });
});

test("buildProgressEvidence: preserves an explicit observed_at and null facts (no fabrication)", () => {
  const ev = buildProgressEvidence({
    gapsDrainedLastRun: null,
    lastRefreshedAt: null,
    mode: "deferred",
    observedAt: "2026-07-01T00:00:00.000Z",
    recordsCommittedLastRun: null,
    retainedRecords: null,
  });
  assert.equal(ev.observed_at, "2026-07-01T00:00:00.000Z");
  assert.equal(ev.retained_records, null);
  assert.equal(ev.records_committed_last_run, null);
  assert.equal(ev.mode, "deferred");
});
