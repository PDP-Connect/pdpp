import assert from "node:assert/strict";
import test from "node:test";
import type { RefCollectionReportEntry, RefCoverageAxis } from "./ref-client.ts";
import {
  classifyKnownGaps,
  connectorHasPartialCoverageFromReport,
  connectorHasPartialCoverageHint,
  extractTerminalKnownGaps,
  formatRecoveryHint,
  type KnownGap,
  normalizeKnownGaps,
  resolvePartialCoverageCue,
} from "./run-gaps.ts";

/** Minimal valid Collection Report entry for the coverage condition under test. */
function reportEntry(stream: string, coverage_condition: RefCoverageAxis): RefCollectionReportEntry {
  return {
    checkpoint: "committed",
    collected: 3,
    considered: "unknown",
    coverage_condition,
    forward_disposition: "resumable",
    pending_detail_gaps: 0,
    skipped: null,
    stream,
  };
}

test("classifyKnownGaps keeps protocol violations distinct from source coverage gaps", () => {
  const gaps: KnownGap[] = [
    {
      kind: "skip_result",
      reason: "http_429",
      recovery_hint: { action: "retry_by_runtime", retryable: true },
      stream: "issues",
    },
    {
      kind: "run_failed",
      reason: "connector_protocol_violation",
      recovery_hint: { action: "not_retriable", retryable: false },
    },
    {
      kind: "skip_result",
      reason: "not_available",
      severity: "informational",
      stream: "stars",
    },
  ];

  const classified = classifyKnownGaps(gaps);

  assert.deepEqual(
    classified.coverageGaps.map((gap) => gap.reason),
    ["http_429"]
  );
  assert.deepEqual(
    classified.protocolViolationGaps.map((gap) => gap.reason),
    ["connector_protocol_violation"]
  );
  assert.deepEqual(
    classified.informationalGaps.map((gap) => gap.reason),
    ["not_available"]
  );
  assert.equal(classified.summary?.count, 3);
});

test("connectorHasPartialCoverageHint requires produced records and a non-protocol coverage gap", () => {
  assert.equal(
    connectorHasPartialCoverageHint({
      totalRecords: 12,
      lastRunKnownGaps: [{ kind: "skip_result", reason: "missing_credentials" }],
    }),
    true
  );
  assert.equal(
    connectorHasPartialCoverageHint({
      totalRecords: 0,
      lastRunKnownGaps: [{ kind: "skip_result", reason: "missing_credentials" }],
    }),
    false
  );
  assert.equal(
    connectorHasPartialCoverageHint({
      totalRecords: 12,
      lastRunKnownGaps: [{ kind: "run_failed", reason: "connector_protocol_violation" }],
    }),
    false
  );
  assert.equal(
    connectorHasPartialCoverageHint({
      totalRecords: 12,
      lastRunKnownGaps: [{ kind: "skip_result", reason: "not_available", severity: "informational" }],
    }),
    false
  );
});

test("extractTerminalKnownGaps reads the latest terminal event payload", () => {
  const terminal = {
    actor_id: "github",
    actor_type: "runtime",
    client_id: null,
    data: {
      known_gaps: [
        {
          kind: "checkpoint_commit",
          reason: "partially_committed",
          recovery_hint: { action: "retry_by_runtime" },
        },
      ],
      known_gaps_summary: { count: 1, truncated: false, by_reason: { partially_committed: 1 } },
    },
    event_id: "evt_1",
    event_type: "run.failed",
    grant_id: null,
    interaction_id: null,
    object_id: "run_1",
    object_type: "run",
    occurred_at: "2026-04-24T10:00:00.000Z",
    provider_id: null,
    recorded_at: "2026-04-24T10:00:00.000Z",
    request_id: null,
    run_id: "run_1",
    scenario_id: null,
    status: "failed",
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trc_1",
    version: "1",
  };

  const result = extractTerminalKnownGaps([terminal]);

  assert.equal(result.gaps[0]?.reason, "partially_committed");
  assert.equal(result.summary?.by_reason?.partially_committed, 1);
  assert.equal(result.terminalEvent?.event_id, "evt_1");
});

test("normalizeKnownGaps and formatRecoveryHint tolerate unknown payloads", () => {
  const gaps = normalizeKnownGaps([
    "bad",
    {
      kind: "interaction_required",
      reason: "manual_login",
      recovery_hint: { action: "manual_action_required" },
      stream: "messages",
    },
  ]);

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.stream, "messages");
  assert.equal(
    normalizeKnownGaps([{ kind: "skip_result", reason: "not_available", severity: "informational" }])[0]?.severity,
    "informational"
  );
  const [gap] = gaps;
  assert.ok(gap);
  assert.equal(formatRecoveryHint(gap), "manual action required");
});

test("normalizeKnownGaps propagates bounded SKIP_RESULT diagnostics object", () => {
  const diagnostics = { phase: "export_artifact_wait_failed", error: "download_empty", dialogs_open: 1 };
  const [gap] = normalizeKnownGaps([{ kind: "skip_result", reason: "export_no_download", diagnostics }]);
  assert.ok(gap);
  assert.deepEqual(gap.diagnostics, diagnostics);
});

test("normalizeKnownGaps drops diagnostics when value is an array or scalar", () => {
  const [gapArray] = normalizeKnownGaps([{ kind: "skip_result", reason: "r", diagnostics: ["a", "b"] }]);
  assert.ok(gapArray);
  assert.equal(gapArray.diagnostics, undefined);

  const [gapString] = normalizeKnownGaps([{ kind: "skip_result", reason: "r", diagnostics: "text" }]);
  assert.ok(gapString);
  assert.equal(gapString.diagnostics, undefined);
});

test("normalizeKnownGaps passes sentinel diagnostics object through unchanged", () => {
  const sentinel = { truncated: true, reason: "size_overflow" };
  const [gap] = normalizeKnownGaps([{ kind: "skip_result", reason: "export_no_download", diagnostics: sentinel }]);
  assert.ok(gap);
  assert.deepEqual(gap.diagnostics, sentinel);
});

test("extractTerminalKnownGaps preserves diagnostics on known gaps", () => {
  const diagnostics = { phase: "export_artifact_wait_failed", url: "https://example.com" };
  const terminal = {
    actor_id: "usaa",
    actor_type: "runtime",
    client_id: null,
    data: {
      known_gaps: [{ kind: "skip_result", reason: "export_no_download", diagnostics }],
      known_gaps_summary: { count: 1, truncated: false, by_reason: { export_no_download: 1 } },
    },
    event_id: "evt_2",
    event_type: "run.completed",
    grant_id: null,
    interaction_id: null,
    object_id: "run_2",
    object_type: "run",
    occurred_at: "2026-05-28T10:00:00.000Z",
    provider_id: null,
    recorded_at: "2026-05-28T10:00:00.000Z",
    request_id: null,
    run_id: "run_2",
    scenario_id: null,
    status: "completed",
    stream_id: null,
    subject_id: null,
    subject_type: null,
    token_id: null,
    trace_id: "trc_2",
    version: "1",
  };

  const result = extractTerminalKnownGaps([terminal]);
  assert.ok(result.gaps[0]);
  assert.deepEqual(result.gaps[0].diagnostics, diagnostics);
});

// Direct consumption of the server-projected Collection Report.

test("connectorHasPartialCoverageFromReport flags partial / gaps / retryable_gap streams", () => {
  for (const condition of ["partial", "gaps", "retryable_gap"] as const) {
    assert.equal(
      connectorHasPartialCoverageFromReport([reportEntry("issues", condition)]),
      true,
      `expected ${condition} to read partial coverage`
    );
  }
});

test("connectorHasPartialCoverageFromReport does not flag complete / unknown / terminal / manifest-accepted conditions", () => {
  for (const condition of [
    "complete",
    "unknown",
    "terminal_gap",
    "unsupported",
    "unavailable",
    "deferred",
    "inventory_only",
  ] as const) {
    assert.equal(
      connectorHasPartialCoverageFromReport([reportEntry("issues", condition)]),
      false,
      `expected ${condition} NOT to read partial coverage`
    );
  }
});

test("connectorHasPartialCoverageFromReport flags when ANY in-scope stream is partial", () => {
  const report = [
    reportEntry("repositories", "complete"),
    reportEntry("issues", "partial"),
    reportEntry("starred", "complete"),
  ];
  assert.equal(connectorHasPartialCoverageFromReport(report), true);
});

test("connectorHasPartialCoverageFromReport treats an empty / absent report as no partial coverage", () => {
  assert.equal(connectorHasPartialCoverageFromReport([]), false);
  assert.equal(connectorHasPartialCoverageFromReport(null), false);
  assert.equal(connectorHasPartialCoverageFromReport(undefined), false);
});

test("resolvePartialCoverageCue prefers the server report over the known_gaps heuristic", () => {
  // The report says complete; the raw known_gaps would (wrongly) reconstruct
  // partial. The authoritative server verdict must win.
  const result = resolvePartialCoverageCue({
    collectionReport: [reportEntry("issues", "complete")],
    lastRunKnownGaps: [{ kind: "skip_result", reason: "http_429" }],
    totalRecords: 42,
  });
  assert.equal(result, false, "server report 'complete' must override the known_gaps heuristic");
});

test("resolvePartialCoverageCue trusts a report that reads partial even with no known_gaps", () => {
  const result = resolvePartialCoverageCue({
    collectionReport: [reportEntry("issues", "partial")],
    lastRunKnownGaps: [],
    totalRecords: 42,
  });
  assert.equal(result, true);
});

test("resolvePartialCoverageCue uses an empty report as an authoritative 'no partial' answer, NOT the heuristic", () => {
  const result = resolvePartialCoverageCue({
    collectionReport: [],
    lastRunKnownGaps: [{ kind: "skip_result", reason: "http_429" }],
    totalRecords: 42,
  });
  assert.equal(result, false, "an empty report must not fall back to the known_gaps heuristic");
});

test("resolvePartialCoverageCue falls back to the known_gaps heuristic only when the report is absent", () => {
  assert.equal(
    resolvePartialCoverageCue({
      collectionReport: null,
      lastRunKnownGaps: [{ kind: "skip_result", reason: "http_429" }],
      totalRecords: 42,
    }),
    true
  );
  assert.equal(
    resolvePartialCoverageCue({
      collectionReport: undefined,
      lastRunKnownGaps: [{ kind: "skip_result", reason: "http_429" }],
      totalRecords: 42,
    }),
    true
  );
  // The legacy floor still holds: no produced records means no partial cue.
  assert.equal(
    resolvePartialCoverageCue({
      collectionReport: null,
      lastRunKnownGaps: [{ kind: "skip_result", reason: "http_429" }],
      totalRecords: 0,
    }),
    false
  );
});
