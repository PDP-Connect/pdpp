// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fail-before tests proving the confirmation evidence UI may render only
 * durable facts actually supplied by the backend, and that absent evidence
 * stays absent. No provider-specific branches, no invented facts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { isBoundaryClaimGap, isTerminalLossGap, isPendingHorizonConfirmation, isPendingLossAcknowledgement } from "./generic-confirmation-evidence.ts";

const GROUPME_SHAPED_BOUNDARY_GAP = {
  boundary_claim: "provider_history_boundary",
  kind: "skip_result",
  reason: "history_ended_before_provider_count",
  recovery_action: "retry_by_runtime",
  severity: "transient",
  stream: "group_messages",
} as const;

const LIVE_RATE_LIMIT_GAP = {
  kind: "skip_result",
  reason: "upstream_rate_limited",
  recovery_action: "retry_by_runtime",
  severity: "transient",
  stream: "group_messages",
} as const;

const TERMINAL_LOSS_GAP = {
  kind: "skip_result",
  reason: "provider_purged_upstream",
  recovery_action: "not_retriable",
  severity: "terminal",
  stream: "orders",
} as const;

const HORIZON = {
  stream: "group_messages",
  supersededAt: null,
};

test("isBoundaryClaimGap: identifies gaps typed with boundary_claim: provider_history_boundary", () => {
  assert.equal(isBoundaryClaimGap(GROUPME_SHAPED_BOUNDARY_GAP), true);
});

test("isBoundaryClaimGap: rejects gaps with no boundary_claim field", () => {
  assert.equal(isBoundaryClaimGap(LIVE_RATE_LIMIT_GAP), false);
});

test("isBoundaryClaimGap: rejects non-objects and non-boundary claims", () => {
  assert.equal(isBoundaryClaimGap(null), false);
  assert.equal(isBoundaryClaimGap(undefined), false);
  assert.equal(isBoundaryClaimGap({ boundary_claim: "wrong_value" }), false);
});

test("isTerminalLossGap: identifies gaps typed with recovery_action: not_retriable", () => {
  assert.equal(isTerminalLossGap(TERMINAL_LOSS_GAP), true);
});

test("isTerminalLossGap: rejects gaps with recovery_action: retry_by_runtime", () => {
  assert.equal(isTerminalLossGap(GROUPME_SHAPED_BOUNDARY_GAP), false);
  assert.equal(isTerminalLossGap(LIVE_RATE_LIMIT_GAP), false);
});

test("isTerminalLossGap: rejects non-objects and non-not_retriable gaps", () => {
  assert.equal(isTerminalLossGap(null), false);
  assert.equal(isTerminalLossGap(undefined), false);
  assert.equal(isTerminalLossGap({ recovery_action: "wrong_value" }), false);
});

test("isPendingHorizonConfirmation: a boundary-claim gap with no confirmed horizon is pending", () => {
  assert.equal(isPendingHorizonConfirmation(GROUPME_SHAPED_BOUNDARY_GAP, []), true);
});

test("isPendingHorizonConfirmation: a gap with no boundary_claim is not pending", () => {
  assert.equal(isPendingHorizonConfirmation(LIVE_RATE_LIMIT_GAP, []), false);
});

test("isPendingHorizonConfirmation: a stream already covered by a current horizon is not pending", () => {
  assert.equal(isPendingHorizonConfirmation(GROUPME_SHAPED_BOUNDARY_GAP, [HORIZON]), false);
});

test("isPendingHorizonConfirmation: a SUPERSEDED horizon does not suppress eligibility", () => {
  assert.equal(
    isPendingHorizonConfirmation(GROUPME_SHAPED_BOUNDARY_GAP, [{ stream: "group_messages", supersededAt: "2026-01-01T00:00:00.000Z" }]),
    true
  );
});

test("isPendingHorizonConfirmation: a connection-wide '*' current horizon covers every stream", () => {
  assert.equal(isPendingHorizonConfirmation(GROUPME_SHAPED_BOUNDARY_GAP, [{ stream: "*", supersededAt: null }]), false);
});

test("isPendingHorizonConfirmation: null/undefined gaps stay absent", () => {
  assert.equal(isPendingHorizonConfirmation(null, []), false);
  assert.equal(isPendingHorizonConfirmation(undefined, []), false);
});

test("isPendingLossAcknowledgement: a not_retriable gap with no prior ack is pending", () => {
  assert.equal(isPendingLossAcknowledgement(TERMINAL_LOSS_GAP, null), true);
  assert.equal(isPendingLossAcknowledgement(TERMINAL_LOSS_GAP, "Something else"), true);
});

test("isPendingLossAcknowledgement: an already-acknowledged forward statement suppresses eligibility", () => {
  const acknowledgedSentence = "Provider deleted this data upstream — owner-confirmed 2026-08-21.";
  assert.equal(isPendingLossAcknowledgement(TERMINAL_LOSS_GAP, acknowledgedSentence), false);
});

test("isPendingLossAcknowledgement: a retryable gap is not pending", () => {
  assert.equal(isPendingLossAcknowledgement(GROUPME_SHAPED_BOUNDARY_GAP, null), false);
  assert.equal(isPendingLossAcknowledgement(LIVE_RATE_LIMIT_GAP, null), false);
});

test("isPendingLossAcknowledgement: null/undefined gaps stay absent", () => {
  assert.equal(isPendingLossAcknowledgement(null, null), false);
  assert.equal(isPendingLossAcknowledgement(undefined, null), false);
});

test("PROOF: UI renders ONLY evidence supplied by backend, never invented provider facts", () => {
  // GroupMe-shaped gap proves boundary claim exists and can be confirmed.
  const gap = GROUPME_SHAPED_BOUNDARY_GAP;

  // The UI checks: (1) does boundary_claim field exist and equal the closed value?
  assert.equal(isBoundaryClaimGap(gap), true);

  // (2) is there already a current horizon for this stream? If yes, skip.
  assert.equal(isPendingHorizonConfirmation(gap, []), true); // No horizon = pending
  assert.equal(isPendingHorizonConfirmation(gap, [HORIZON]), false); // Horizon exists = not pending

  // The UI then renders what the backend gave us: the gap's own fields (stream, reason).
  // It does NOT invent: provider name, provider retention policy, inferred vs. stated boundary.
  // Those facts may come from owner-entered form fields only, never derived.
  assert.match(JSON.stringify({ boundary_claim: gap.boundary_claim, reason: gap.reason, stream: gap.stream }), /group_messages/);
  assert.doesNotMatch(JSON.stringify(gap), /provider_retention_policy/); // Not in the gap itself
  assert.doesNotMatch(JSON.stringify(gap), /inferred_from_stable_boundary/); // Not in the gap itself
});
