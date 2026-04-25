import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyKnownGaps,
  connectorHasPartialCoverageHint,
  extractTerminalKnownGaps,
  formatRecoveryHint,
  type KnownGap,
  normalizeKnownGaps,
} from "./run-gaps.ts";

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
  assert.equal(classified.summary?.count, 2);
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
  const [gap] = gaps;
  assert.ok(gap);
  assert.equal(formatRecoveryHint(gap), "manual action required");
});
