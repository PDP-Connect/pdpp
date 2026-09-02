// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A run-level `interaction_required` gap with no `stream` records a
 * credential/login prompt raised at the connection level. When the SAME run
 * went on to a proven-successful terminal status with every required stream
 * proven `complete`, that gap is a leftover trace of an interaction the run
 * resolved (or made moot) before finishing — not evidence of a current
 * coverage shortfall. Reproduces the ChatGPT "complete collection report vs
 * terminal_gap health" mismatch: a run whose `collection_facts` prove every
 * required stream complete still carried an unscoped `interaction_cancelled`
 * gap forward into `terminal_gap` health.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { filterRunGapsProvenCompleteByReport } from "../server/continuation-proof.ts";
import type { CollectionReportEntry, ConnectorRunSummary } from "../server/ref-control.ts";

function reportEntry(stream: string, required: boolean, coverage: "complete" | "partial"): CollectionReportEntry {
  return {
    checkpoint: coverage === "complete" ? "committed" : "not_committed",
    collected: 1,
    considered: 1,
    coverage_condition: coverage,
    coverage_strategy: "checkpoint_window",
    covered: coverage === "complete" ? 1 : 0,
    evidence_as_of: "2026-08-27T11:30:43.441Z",
    forward_disposition: coverage === "complete" ? "complete" : "resumable",
    freshness_strategy: "scheduled_window",
    pending_detail_gaps: 0,
    pending_detail_gaps_is_floor: false,
    required,
    skipped: null,
    stream,
  };
}

function runWithGaps(status: string, knownGaps: unknown[]): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-08-27T11:30:43.441Z",
    first_at: "2026-08-27T11:30:25.312Z",
    known_gaps: knownGaps,
    last_at: "2026-08-27T11:30:43.441Z",
    recovery_only: false,
    run_id: "run_unscoped_interaction",
    started_at: "2026-08-27T11:30:25.312Z",
    status,
    terminal_reason: null,
  };
}

const INTERACTION_CANCELLED_GAP = {
  kind: "interaction_required",
  message: "chatgpt needs: CHATGPT_USERNAME, CHATGPT_PASSWORD. Set in .env.local for persistence.",
  reason: "interaction_cancelled",
  recovery_hint: { action: "refresh_credentials", retryable: false },
  severity: "actionable",
  stream: null,
};

test("an unscoped interaction gap does not downgrade a run that proved every required stream complete", () => {
  const run = runWithGaps("succeeded", [INTERACTION_CANCELLED_GAP]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [
    reportEntry("conversations", true, "complete"),
    reportEntry("messages", true, "complete"),
    reportEntry("memories", true, "complete"),
  ]);
  assert.deepEqual(filtered?.known_gaps, []);
});

test("an unscoped interaction gap remains when any required stream is incomplete", () => {
  const run = runWithGaps("succeeded", [INTERACTION_CANCELLED_GAP]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [
    reportEntry("conversations", true, "complete"),
    reportEntry("messages", true, "partial"),
  ]);
  assert.deepEqual(filtered?.known_gaps, [INTERACTION_CANCELLED_GAP]);
});

test("an unscoped interaction gap remains when the run itself did not succeed", () => {
  const run = runWithGaps("failed", [INTERACTION_CANCELLED_GAP]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [
    reportEntry("conversations", true, "complete"),
    reportEntry("messages", true, "complete"),
  ]);
  assert.deepEqual(filtered?.known_gaps, [INTERACTION_CANCELLED_GAP]);
});

test("a stream-scoped interaction gap is untouched even when every required stream is complete", () => {
  const scopedGap = { ...INTERACTION_CANCELLED_GAP, stream: "conversations" };
  const run = runWithGaps("succeeded", [scopedGap]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [reportEntry("conversations", true, "complete")]);
  assert.deepEqual(filtered?.known_gaps, [scopedGap]);
});
