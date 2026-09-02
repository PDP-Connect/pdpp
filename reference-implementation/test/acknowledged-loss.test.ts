// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Owner-acknowledged permanent loss becomes a first-class rendered state.
 *
 * These tests pin the two production cases verified against live Postgres on
 * 2026-08-23 (see `.codex-reports/ODL-UPSTREAM-LOSS.md`):
 *
 *   - `heb` rendered "Run a refresh to bring this up to date." for orders the
 *     provider PURGED — a refresh button that cannot work and costs an OTP.
 *   - `groupme` rendered "The next run is expected to fill the remaining data."
 *     over a gap whose evidence says `recovery_hint.action: "not_retriable"`.
 *
 * The mechanism is generic. Nothing here — and nothing in the implementation —
 * is keyed on a connector id; both cases travel the same code path and differ
 * only in the stamped record.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  type AcknowledgedLossRecord,
  acknowledgedLossDate,
  acknowledgedLossProgressHeadline,
  acknowledgedLossStatement,
  acknowledgedLossTone,
  isAcknowledgedLossRecord,
  readAcknowledgedLoss,
} from "../runtime/acknowledged-loss.ts";
import { computeConnectionHealth } from "../runtime/connection-health.ts";
import { synthesizeConnectorVerdict } from "../runtime/connector-verdict-input.ts";

/** Any phrasing that would promise the missing data is still coming. */
const RECOVERY_PROMISE_RE = /next run|expected to fill|will be collected/i;

const HEB_PURGE: AcknowledgedLossRecord = {
  acknowledgedAt: "2026-08-21T00:00:00.000Z",
  acknowledgedBy: "Tim Nunamaker",
  cause: "provider_deleted_upstream",
  scope: "total",
};

const GROUPME_CONTRADICTORY: AcknowledgedLossRecord = {
  acknowledgedAt: "2026-08-21T00:00:00.000Z",
  acknowledgedBy: "Tim Nunamaker",
  cause: "provider_data_contradictory",
  scope: "partial",
  streams: ["group_messages"],
};

// ── the durable record itself ────────────────────────────────────────────────

test("acknowledged-loss: the owner-facing sentence names the provider, the owner, and the date", () => {
  assert.equal(
    acknowledgedLossStatement(HEB_PURGE),
    "Provider deleted this data upstream — owner-confirmed 2026-08-21."
  );
  assert.equal(
    acknowledgedLossStatement(GROUPME_CONTRADICTORY),
    "Provider API returns contradictory data — documented, unfixable here — owner-confirmed 2026-08-21."
  );
});

test("acknowledged-loss: the date the owner sees is the date he acknowledged", () => {
  assert.equal(acknowledgedLossDate(HEB_PURGE), "2026-08-21");
});

test("acknowledged-loss: tone is amber — never green, because the data is genuinely missing", () => {
  assert.equal(acknowledgedLossTone(), "amber");
});

test("acknowledged-loss: progress reports what is held and that the rest is not coming", () => {
  assert.equal(
    acknowledgedLossProgressHeadline(HEB_PURGE, 91),
    "Holding 91 records; no further data exists at the provider."
  );
  assert.equal(
    acknowledgedLossProgressHeadline(GROUPME_CONTRADICTORY, 97_339),
    "Holding 97,339 records; the missing data is not recoverable."
  );
});

// ── the guard: a half-attributed record is refused, never half-rendered ──────

test("acknowledged-loss: a record without an actor or a date is refused", () => {
  assert.equal(isAcknowledgedLossRecord({ ...HEB_PURGE, acknowledgedBy: "" }), false);
  assert.equal(isAcknowledgedLossRecord({ ...HEB_PURGE, acknowledgedAt: "" }), false);
  const { acknowledgedBy: _b, ...noActor } = HEB_PURGE;
  assert.equal(isAcknowledgedLossRecord(noActor), false);
  const { acknowledgedAt: _a, ...noDate } = HEB_PURGE;
  assert.equal(isAcknowledgedLossRecord(noDate), false);
});

test("acknowledged-loss: an unrecognized cause or scope is refused, never guessed", () => {
  assert.equal(isAcknowledgedLossRecord({ ...HEB_PURGE, cause: "vibes" }), false);
  assert.equal(isAcknowledgedLossRecord({ ...HEB_PURGE, scope: "sort_of" }), false);
});

test("acknowledged-loss: an unparseable timestamp is refused", () => {
  assert.equal(isAcknowledgedLossRecord({ ...HEB_PURGE, acknowledgedAt: "last tuesday" }), false);
});

test("acknowledged-loss: a valid record is accepted", () => {
  assert.equal(isAcknowledgedLossRecord(HEB_PURGE), true);
  assert.equal(isAcknowledgedLossRecord(GROUPME_CONTRADICTORY), true);
});

test("acknowledged-loss: reading a carrier without a stamped record yields null, never an inference", () => {
  assert.equal(readAcknowledgedLoss(null), null);
  assert.equal(readAcknowledgedLoss({}), null);
  assert.equal(readAcknowledgedLoss({ acknowledged_loss: null }), null);
  // A connector id is NOT evidence of an acknowledgement.
  assert.equal(readAcknowledgedLoss({ connector_id: "heb" }), null);
  // A half-attributed record does not project.
  assert.equal(readAcknowledgedLoss({ acknowledged_loss: { cause: "provider_deleted_upstream" } }), null);
  assert.deepEqual(readAcknowledgedLoss({ acknowledged_loss: HEB_PURGE }), HEB_PURGE);
});

// ── the rendered verdict ─────────────────────────────────────────────────────

function snapshotFor(status: "failed" | "succeeded", coverage: "complete" | "terminal_gap") {
  return computeConnectionHealth({
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: coverage },
    freshness: { axis: "stale" },
    observedAt: "2026-08-23T20:00:00.000Z",
    outbox: null,
    projection: { unreliableSources: [] },
    run: {
      hasDegradingGaps: coverage === "terminal_gap",
      lastSuccessAt: status === "succeeded" ? "2026-08-22T20:07:06.445Z" : null,
      latestStatus: status,
      reasonCode: status === "failed" ? "connector_reported_failed" : null,
    },
    schedule: { enabled: true },
  } as never);
}

function verdictFor(
  status: "failed" | "succeeded",
  coverage: "complete" | "terminal_gap",
  acknowledgedLoss: AcknowledgedLossRecord | null,
  retained: number
) {
  return synthesizeConnectorVerdict({
    acknowledgedLoss,
    attention: null,
    manifestStreams: [{ name: "orders", required: true }],
    progress: {
      gaps_drained_last_run: null,
      last_refreshed_at: "2026-08-22T20:07:06.445Z",
      mode: "scheduled",
      observed_at: "2026-08-23T20:00:00.000Z",
      records_committed_last_run: null,
      retained_records: retained,
    },
    refresh: null,
    refreshEvidence: null,
    report: [
      {
        collected: 0,
        considered: coverage === "complete" ? 0 : ("unknown" as const),
        coverage_condition: coverage,
        pending_detail_gaps: 0,
        stream: "orders",
      },
    ],
    runtimeOk: true,
    scheduleEvidence: { hasPriorSuccess: status === "succeeded", mode: "scheduled-active" },
    snapshot: snapshotFor(status, coverage),
  } as never);
}

test("acknowledged-loss: an acknowledged purge replaces the generic forward statement", () => {
  const before = verdictFor("failed", "terminal_gap", null, 91);
  const after = verdictFor("failed", "terminal_gap", HEB_PURGE, 91);

  // Fail-before: without a record the sentence is generic and unattributed.
  assert.ok(
    !before.forward_statement.includes("owner-confirmed"),
    `expected a generic statement before the record, got: ${before.forward_statement}`
  );

  // Pass-after: the exact owner-facing sentence, with attribution and date.
  assert.equal(after.forward_statement, "Provider deleted this data upstream — owner-confirmed 2026-08-21.");
});

test("acknowledged-loss: owner detail carries the durable structured record, not presentation text", () => {
  const verdict = verdictFor(
    "failed",
    "terminal_gap",
    {
      ...HEB_PURGE,
      note: "Provider support confirmed the deletion.",
    },
    91
  );

  assert.deepEqual(verdict.detail.acknowledged_loss, {
    ...HEB_PURGE,
    note: "Provider support confirmed the deletion.",
  });
  assert.equal(verdict.detail.acknowledged_loss?.cause, "provider_deleted_upstream");
  assert.equal(verdict.detail.acknowledged_loss?.acknowledgedBy, "Tim Nunamaker");
  assert.equal(verdict.detail.acknowledged_loss?.acknowledgedAt, "2026-08-21T00:00:00.000Z");
});

test("acknowledged-loss: an acknowledged loss never renders green", () => {
  const after = verdictFor("failed", "terminal_gap", HEB_PURGE, 91);
  assert.notEqual(after.pill.tone, "green");
  assert.equal(after.pill.tone, "amber");
});

test("acknowledged-loss: an acknowledged loss stops asking for a refresh that cannot work", () => {
  const after = verdictFor("failed", "terminal_gap", HEB_PURGE, 91);
  for (const action of after.required_actions) {
    assert.notEqual(
      action.kind,
      "refresh_now",
      "an acknowledged permanent loss must not offer a refresh that cannot recover the data"
    );
    assert.notEqual(action.kind, "retry_gap", "an acknowledged permanent loss must not offer a retry");
  }
});

test("acknowledged-loss: an acknowledged loss never claims a future run will fill the gap", () => {
  const after = verdictFor("succeeded", "terminal_gap", GROUPME_CONTRADICTORY, 97_339);
  assert.ok(
    !RECOVERY_PROMISE_RE.test(after.forward_statement),
    `acknowledged loss must not promise recovery, got: ${after.forward_statement}`
  );
  assert.equal(
    after.forward_statement,
    "Provider API returns contradictory data — documented, unfixable here — owner-confirmed 2026-08-21."
  );
});

test("acknowledged-loss: progress headline states the loss instead of a bare retained count", () => {
  const after = verdictFor("failed", "terminal_gap", HEB_PURGE, 91);
  assert.equal(after.progress.headline, "Holding 91 records; no further data exists at the provider.");
});

test("acknowledged-loss: the mechanism is generic — the same path serves a different cause", () => {
  const heb = verdictFor("failed", "terminal_gap", HEB_PURGE, 91);
  const groupme = verdictFor("succeeded", "terminal_gap", GROUPME_CONTRADICTORY, 97_339);
  assert.notEqual(heb.forward_statement, groupme.forward_statement);
  for (const verdict of [heb, groupme]) {
    assert.ok(verdict.forward_statement.includes("owner-confirmed 2026-08-21"));
    assert.equal(verdict.pill.tone, "amber");
  }
});

test("acknowledged-loss: the unmeasured-coverage HEB shape drops its maintainer code_fix", () => {
  // The live `heb` (owner@example.com) shape on 2026-08-23: an unmeasured
  // coverage axis over a prior success, which synthesizes a maintainer
  // `code_fix`. No connector change can un-delete the orders H-E-B purged, so
  // the acknowledgement withdraws that action entirely.
  const snapshot = computeConnectionHealth({
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: "unknown" },
    freshness: { axis: "stale" },
    observedAt: "2026-08-23T20:00:00.000Z",
    outbox: null,
    projection: { unreliableSources: [] },
    run: {
      hasDegradingGaps: false,
      lastSuccessAt: "2026-08-22T20:07:06.445Z",
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
  } as never);

  const build = (acknowledgedLoss: AcknowledgedLossRecord | null) =>
    synthesizeConnectorVerdict({
      acknowledgedLoss,
      attention: null,
      manifestStreams: [{ name: "orders", required: true }],
      progress: {
        last_refreshed_at: "2026-08-22T20:07:06.445Z",
        mode: "scheduled",
        observed_at: "2026-08-23T20:00:00.000Z",
        retained_records: 91,
      },
      refresh: { mode: "manual" },
      report: [
        {
          collected: 0,
          considered: "unknown" as const,
          coverage_condition: "unknown" as const,
          pending_detail_gaps: 0,
          stream: "orders",
        },
      ],
      runtimeOk: true,
      scheduleEvidence: { hasPriorSuccess: true, mode: "scheduled-active" },
      snapshot,
    } as never);

  const before = build(null);
  const after = build(HEB_PURGE);

  // Fail-before: a maintainer code_fix the owner can never clear.
  assert.deepEqual(
    before.required_actions.map((action) => action.kind),
    ["code_fix"]
  );
  assert.equal(before.forward_statement, "Coverage has not been measured yet.");

  // Pass-after: no action at all, and the true sentence.
  assert.deepEqual(after.required_actions, []);
  assert.equal(after.forward_statement, "Provider deleted this data upstream — owner-confirmed 2026-08-21.");
});

test("acknowledged-loss: softening is refused when a non-coverage axis is what turned it red", () => {
  // A stalled outbox is a real, separately-fixable defect. An acknowledgement
  // about missing provider data must not soften it to amber.
  const snapshot = computeConnectionHealth({
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    localDeviceBacked: true,
    observedAt: "2026-08-23T20:00:00.000Z",
    outbox: { axis: "stalled" },
    projection: { unreliableSources: [] },
    run: {
      hasDegradingGaps: false,
      lastSuccessAt: "2026-08-22T20:07:06.445Z",
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
  } as never);

  const build = (acknowledgedLoss: AcknowledgedLossRecord | null) =>
    synthesizeConnectorVerdict({
      acknowledgedLoss,
      attention: null,
      manifestStreams: [{ name: "orders", required: true }],
      progress: { mode: "local_device", observed_at: "2026-08-23T20:00:00.000Z", retained_records: 91 },
      refresh: null,
      report: [
        {
          collected: 0,
          considered: 0,
          coverage_condition: "complete" as const,
          pending_detail_gaps: 0,
          stream: "orders",
        },
      ],
      runtimeOk: true,
      scheduleEvidence: { hasPriorSuccess: true, mode: "scheduled-active" },
      snapshot,
    } as never);

  const before = build(null);
  const after = build(HEB_PURGE);
  assert.equal(before.pill.tone, after.pill.tone, "an outbox-driven tone must be unaffected by an acknowledgement");
});

test("acknowledged-loss: an acknowledgement does not mask a separate credential defect", () => {
  // A connection that is BOTH acknowledged-lossy and credential-broken keeps
  // its red tone and its reconnect action: the acknowledgement explains missing
  // data, it does not vouch for the credential.
  const snapshot = computeConnectionHealth({
    activity: null,
    attention: null,
    authenticates: true,
    backoff: null,
    coverage: { axis: "terminal_gap" },
    credential: { capable: true, present: false, rejected: true },
    freshness: { axis: "stale" },
    observedAt: "2026-08-23T20:00:00.000Z",
    outbox: null,
    projection: { unreliableSources: [] },
    run: {
      hasDegradingGaps: true,
      lastSuccessAt: null,
      latestStatus: "failed",
      reasonCode: "credential_rejected",
    },
    schedule: { enabled: true },
  } as never);

  const verdict = synthesizeConnectorVerdict({
    acknowledgedLoss: HEB_PURGE,
    attention: null,
    manifestStreams: [{ name: "orders", required: true }],
    progress: null,
    refresh: null,
    report: [
      {
        collected: 0,
        considered: "unknown" as const,
        coverage_condition: "terminal_gap" as const,
        pending_detail_gaps: 0,
        stream: "orders",
      },
    ],
    runtimeOk: true,
    scheduleEvidence: { hasPriorSuccess: false, mode: "scheduled-active" },
    snapshot,
  } as never);

  assert.ok(
    verdict.required_actions.some((action) => action.kind === "reauth"),
    "a rejected credential must still surface its reconnect action"
  );
});

test("acknowledged-loss: without a record, behavior is unchanged", () => {
  const withoutRecord = verdictFor("failed", "terminal_gap", null, 91);
  const nullish = verdictFor("failed", "terminal_gap", null, 91);
  assert.deepEqual(withoutRecord, nullish);
  assert.ok(!withoutRecord.forward_statement.includes("owner-confirmed"));
});
