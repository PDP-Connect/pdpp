// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  boundaryClaimGaps,
  COVERAGE_HORIZON_BASES,
  COVERAGE_HORIZON_REASONS,
  isTerminalLossGap,
  isValidAcknowledgedLossRecord,
  LOSS_CAUSES,
  LOSS_SCOPES,
  pendingHorizonConfirmations,
  pendingLossAcknowledgements,
} from "./generic-confirmation-evidence.ts";

const BOUNDARY_GAPS = [
  {
    boundary_claim: "provider_history_boundary",
    earliest_available: "2021-04-03",
    reason_code: "provider_retention_policy",
    stream: "messages",
  },
  { boundary_claim: "provider_history_boundary", horizon_reason: "consent_window", stream: "orders" },
] as const;

const LOSS_GAPS = [
  { recovery_hint: { action: "not_retriable" }, stream: "messages" },
  { recovery_action: "not_retriable", stream: "orders" },
] as const;

const ACK = {
  acknowledgedAt: "2026-08-21T00:00:00.000Z",
  acknowledgedBy: "Owner",
  cause: "provider_deleted_upstream",
  note: "Support case retained in the audit trail.",
  scope: "partial",
  streams: ["messages"],
} as const;

test("boundary evidence carries earliest availability and supported reason", () => {
  assert.deepEqual(boundaryClaimGaps(BOUNDARY_GAPS), [
    {
      basis: null,
      earliestAvailable: "2021-04-03",
      note: null,
      reason: "provider_retention_policy",
      stream: "messages",
    },
    { basis: null, earliestAvailable: null, note: null, reason: "consent_window", stream: "orders" },
  ]);
});

test("only the closed vocabularies are advertised", () => {
  assert.deepEqual(COVERAGE_HORIZON_BASES, ["inferred_from_stable_boundary", "provider_confirmed", "provider_stated"]);
  assert.deepEqual(COVERAGE_HORIZON_REASONS, [
    "consent_window",
    "provider_deleted_history",
    "provider_never_had_data",
    "provider_retention_policy",
  ]);
  assert.deepEqual(LOSS_CAUSES, [
    "provider_access_withdrawn",
    "provider_data_contradictory",
    "provider_deleted_upstream",
  ]);
  assert.deepEqual(LOSS_SCOPES, ["partial", "total"]);
});

test("a structured recovery hint is terminal-loss authority", () => {
  assert.equal(isTerminalLossGap(LOSS_GAPS[0]), true);
  assert.equal(isTerminalLossGap({ recovery_action: "retry_by_runtime", stream: "orders" }), false);
});

test("missing or malformed acknowledgement never suppresses loss evidence", () => {
  assert.equal(isValidAcknowledgedLossRecord(null), false);
  assert.equal(isValidAcknowledgedLossRecord({ ...ACK, cause: "other" }), false);
  assert.equal(isValidAcknowledgedLossRecord({ ...ACK, acknowledgedBy: "" }), false);
  assert.equal(isValidAcknowledgedLossRecord({ ...ACK, streams: [1] }), false);
  assert.equal(pendingLossAcknowledgements(LOSS_GAPS, null).length, 2);
  assert.equal(
    pendingLossAcknowledgements(LOSS_GAPS, { forward_statement: "Everything before 2021 is unavailable." }).length,
    2
  );
});

test("stream-scoped acknowledgement suppresses only that stream", () => {
  assert.deepEqual(pendingLossAcknowledgements(LOSS_GAPS, ACK), [
    { cause: null, note: null, scope: null, stream: "orders" },
  ]);
  assert.deepEqual(pendingLossAcknowledgements(LOSS_GAPS, { ...ACK, streams: [] }), []);
});

test("all supported loss causes and notes remain structured inputs", () => {
  for (const cause of LOSS_CAUSES) {
    const record = { ...ACK, cause, note: `note for ${cause}` };
    assert.equal(isValidAcknowledgedLossRecord(record), true);
    assert.equal(record.note?.startsWith("note for"), true);
  }
  assert.deepEqual(
    pendingLossAcknowledgements([{ recovery_hint: { action: "not_retriable" }, stream: "events" }], {
      ...ACK,
      streams: ["other"],
    }),
    [{ cause: null, note: null, scope: null, stream: "events" }]
  );
});

test("only current horizons suppress boundary confirmation", () => {
  assert.equal(pendingHorizonConfirmations(BOUNDARY_GAPS, []).length, 2);
  assert.equal(pendingHorizonConfirmations(BOUNDARY_GAPS, [{ stream: "messages", supersededAt: null }]).length, 1);
  assert.equal(
    pendingHorizonConfirmations(BOUNDARY_GAPS, [{ stream: "messages", supersededAt: "2026-08-21T00:00:00.000Z" }])
      .length,
    2
  );
  assert.equal(pendingHorizonConfirmations(BOUNDARY_GAPS, [{ stream: "*", supersededAt: null }]).length, 0);
});
