// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { type HeartbeatRow, projectConnectorOutboxAxisFromHeartbeats } from "../server/connector-outbox-axis.ts";

// Mutation-killing tests for the OUTBOX-AXIS rollup's cross-instance
// disagreement resolution — the part of the read-model the existing suite
// leaves thin. `projectConnectorOutboxAxisFromHeartbeats` folds many
// per-instance heartbeats into ONE connector axis + one dominant stalled cause.
// Two escalation rules govern the fold:
//
//   severity: stalled dominates active dominates idle/unknown (a draining or
//     dead instance is never masked by a healthy sibling).
//   cause: when trusted instances stall for DIFFERENT reasons, the most
//     actionable cause wins by rank — dead_letter_backlog (3) > state_read_failed
//     (2) > stale_pending (1).
//
// The existing tests exercise a single stalled cause and severity dominance for
// stalled-vs-idle / active-vs-idle. This file pins the CAUSE RANK tie-break in
// both instance orders (so the comparator, not list position, decides) and the
// active-does-not-overwrite-stalled ordering. Pure — no DB.

const NOW = "2026-05-19T12:00:00.000Z";
const FRESH = "2026-05-19T11:55:00.000Z"; // 5 min old — not stale
const STALE = "2026-05-19T11:00:00.000Z"; // 60 min old — past the 30-min threshold

/** A trusted (active source + active device, not revoked) heartbeat row. */
function hbRow(overrides: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return {
    connectorId: "codex",
    connectorInstanceId: null,
    deviceId: "dev_1",
    deviceRevokedAt: null,
    deviceStatus: "active",
    lastHeartbeatAt: FRESH,
    lastHeartbeatStatus: "healthy",
    lastIngestAt: FRESH,
    manifestGeneration: null,
    outboxDiagnostics: null,
    recordsPending: 0,
    sourceInstanceId: "src_1",
    sourceStatus: "active",
    updatedAt: FRESH,
    ...overrides,
  };
}

/** Blocked + dead letters (no class breakdown) → dead_letter_backlog (rank 3). */
function deadLetterRow(over: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return hbRow({ lastHeartbeatStatus: "blocked", outboxDiagnostics: { dead_letter: 4 }, ...over });
}

/** Blocked + zero dead letters → state_read_failed (rank 2). */
function stateReadFailedRow(over: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return hbRow({ lastHeartbeatStatus: "blocked", outboxDiagnostics: null, ...over });
}

/** Healthy status but pending + stale heartbeat → stale_pending (rank 1). */
function stalePendingRow(over: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return hbRow({ lastHeartbeatAt: STALE, lastHeartbeatStatus: "healthy", recordsPending: 3, ...over });
}

// --------------------------------------------------------------------------
// Each single stalled cause is recognized (guards the derive→cause mapping)
// --------------------------------------------------------------------------

test("single-instance stalled causes map correctly", () => {
  assert.deepEqual(projectConnectorOutboxAxisFromHeartbeats([deadLetterRow()], { nowIso: NOW }), {
    axis: "stalled",
    cause: "dead_letter_backlog",
    hasEvidence: true,
    unreliable: false,
  });
  assert.deepEqual(projectConnectorOutboxAxisFromHeartbeats([stateReadFailedRow()], { nowIso: NOW }), {
    axis: "stalled",
    cause: "state_read_failed",
    hasEvidence: true,
    unreliable: false,
  });
  assert.deepEqual(projectConnectorOutboxAxisFromHeartbeats([stalePendingRow()], { nowIso: NOW }), {
    axis: "stalled",
    cause: "stale_pending",
    hasEvidence: true,
    unreliable: false,
  });
});

// --------------------------------------------------------------------------
// Cause rank tie-break — comparator wins regardless of instance order
// --------------------------------------------------------------------------

test("dead_letter_backlog outranks state_read_failed (both orders)", () => {
  const a = projectConnectorOutboxAxisFromHeartbeats(
    [deadLetterRow({ sourceInstanceId: "s1" }), stateReadFailedRow({ sourceInstanceId: "s2" })],
    { nowIso: NOW }
  );
  const b = projectConnectorOutboxAxisFromHeartbeats(
    [stateReadFailedRow({ sourceInstanceId: "s2" }), deadLetterRow({ sourceInstanceId: "s1" })],
    { nowIso: NOW }
  );
  assert.equal(a.cause, "dead_letter_backlog");
  assert.equal(b.cause, "dead_letter_backlog", "rank, not list order, decides the dominant cause");
  assert.equal(a.axis, "stalled");
});

test("state_read_failed outranks stale_pending (both orders)", () => {
  const a = projectConnectorOutboxAxisFromHeartbeats(
    [stateReadFailedRow({ sourceInstanceId: "s1" }), stalePendingRow({ sourceInstanceId: "s2" })],
    { nowIso: NOW }
  );
  const b = projectConnectorOutboxAxisFromHeartbeats(
    [stalePendingRow({ sourceInstanceId: "s2" }), stateReadFailedRow({ sourceInstanceId: "s1" })],
    { nowIso: NOW }
  );
  assert.equal(a.cause, "state_read_failed");
  assert.equal(b.cause, "state_read_failed");
});

test("dead_letter_backlog is the global maximum across all three causes at once", () => {
  const rows = [
    stalePendingRow({ sourceInstanceId: "s1" }),
    stateReadFailedRow({ sourceInstanceId: "s2" }),
    deadLetterRow({ sourceInstanceId: "s3" }),
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, "stalled");
  assert.equal(r.cause, "dead_letter_backlog", "highest rank wins over both lower causes");
});

// --------------------------------------------------------------------------
// Severity escalation — stalled dominates; active never masks stalled
// --------------------------------------------------------------------------

test("stalled dominates an active sibling and carries the stalled cause", () => {
  const active = hbRow({ recordsPending: 2, sourceInstanceId: "s_active" }); // pending + fresh → active
  const rows = [active, stalePendingRow({ sourceInstanceId: "s_stall" })];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, "stalled", "a stalled instance is never masked by an active sibling");
  assert.equal(r.cause, "stale_pending", "cause travels with the stalled axis");
});

test("an active rollup (no stalled instance) carries a null cause", () => {
  const rows = [
    hbRow({ recordsPending: 5, sourceInstanceId: "s1" }), // active
    hbRow({ sourceInstanceId: "s2" }), // idle
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, "active");
  assert.equal(r.cause, null, "cause only accompanies a stalled axis, never active");
});

// --------------------------------------------------------------------------
// Untrusted rows never contribute a cause (trust gate before escalation)
// --------------------------------------------------------------------------

test("an untrusted (revoked-device) stalled-looking row contributes no cause and marks unreliable", () => {
  const rows = [
    // Revoked device: even though it looks blocked/dead-lettered, it is untrusted
    // and must not drive the axis or cause; it only flips `unreliable`.
    deadLetterRow({ deviceRevokedAt: "2026-05-01T00:00:00.000Z", sourceInstanceId: "revoked" }),
    hbRow({ sourceInstanceId: "idle" }), // one trusted idle row
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, "idle", "only the trusted idle row counts");
  assert.equal(r.cause, null, "the untrusted dead-letter row contributes no cause");
  assert.equal(r.unreliable, true, "the untrusted row still marks the rollup unreliable");
  assert.equal(r.hasEvidence, true);
});
