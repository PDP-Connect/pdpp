// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    evidence_as_of: "2026-08-13T00:00:00.000Z",
    forward_disposition: coverage === "complete" ? "complete" : "resumable",
    freshness_strategy: "scheduled_window",
    pending_detail_gaps: 0,
    pending_detail_gaps_is_floor: false,
    required,
    skipped: null,
    stream,
  };
}

function runWithGaps(knownGaps: unknown[]): ConnectorRunSummary {
  return {
    collection_facts: null,
    event_count: 1,
    failure_reason: null,
    finished_at: "2026-08-13T00:00:01.000Z",
    first_at: "2026-08-13T00:00:00.000Z",
    known_gaps: knownGaps,
    last_at: "2026-08-13T00:00:01.000Z",
    recovery_only: false,
    run_id: "run_optional_checkpoint",
    started_at: "2026-08-13T00:00:00.000Z",
    status: "succeeded",
    terminal_reason: null,
  };
}

const CHECKPOINT_GAP = {
  kind: "checkpoint_commit",
  reason: "partially_committed",
  recovery_hint: { action: "retry_by_runtime", retryable: true },
  severity: "actionable",
  stream: null,
};

test("optional checkpoint shortfall does not downgrade fully proven required streams", () => {
  const run = runWithGaps([CHECKPOINT_GAP]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [
    reportEntry("required", true, "complete"),
    reportEntry("optional", false, "partial"),
  ]);
  assert.deepEqual(filtered?.known_gaps, []);
});

test("unscoped checkpoint warning remains when any required stream is incomplete", () => {
  const run = runWithGaps([CHECKPOINT_GAP]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [reportEntry("required", true, "partial")]);
  assert.deepEqual(filtered?.known_gaps, [CHECKPOINT_GAP]);
});

test("complete required streams do not suppress an unrelated unscoped failure", () => {
  const unrelated = { kind: "run_failed", reason: "provider_unavailable", severity: "transient", stream: null };
  const run = runWithGaps([unrelated]);
  const filtered = filterRunGapsProvenCompleteByReport(run, [reportEntry("required", true, "complete")]);
  assert.deepEqual(filtered?.known_gaps, [unrelated]);
});
