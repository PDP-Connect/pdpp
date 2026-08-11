// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type HeartbeatRow,
  projectConnectorOutboxAxisFromHeartbeats,
  projectLocalDeviceProgress,
} from "../server/connector-outbox-axis.ts";

const NOW = "2026-05-19T12:00:00.000Z";
const FRESH = "2026-05-19T11:55:00.000Z";
const STALE = "2026-05-19T11:00:00.000Z";
const BACKLOG_FRESH = "2026-05-19T10:00:00.000Z"; // 2h ago — under the 24h backlog-age threshold
const BACKLOG_OLD = "2026-05-18T11:59:00.000Z"; // ~24h01m ago — past the 24h backlog-age threshold

function hbRow(overrides: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return {
    connectorId: "codex",
    connectorInstanceId: "cin_1",
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

function revokedStalledRow(overrides: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return hbRow({
    deviceId: "dev_revoked",
    deviceRevokedAt: "2026-05-19T11:30:00.000Z",
    lastHeartbeatAt: STALE,
    lastHeartbeatStatus: "healthy",
    lastIngestAt: STALE,
    outboxDiagnostics: { pending: 9 },
    recordsPending: 9,
    sourceInstanceId: "src_revoked",
    ...overrides,
  });
}

function inactiveSourceRow(overrides: Partial<HeartbeatRow> = {}): HeartbeatRow {
  return hbRow({
    deviceId: "dev_inactive_source",
    outboxDiagnostics: { pending: 4 },
    recordsPending: 4,
    sourceInstanceId: "src_inactive",
    sourceStatus: "inactive",
    ...overrides,
  });
}

test("revoked or inactive source rows are not outbox-axis or local-progress evidence", () => {
  const rows = [revokedStalledRow(), inactiveSourceRow({ lastHeartbeatAt: FRESH, lastIngestAt: FRESH })];

  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "unknown");
  assert.equal(axis.cause, null);
  assert.equal(axis.hasEvidence, false);

  assert.equal(projectLocalDeviceProgress(rows), null);
});

test("active trusted rows contribute while revoked or inactive rows are ignored", () => {
  const rows = [
    revokedStalledRow(),
    inactiveSourceRow({ lastHeartbeatAt: NOW, lastIngestAt: NOW, sourceInstanceId: "src_inactive_newer" }),
    hbRow({
      deviceId: "dev_trusted",
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "healthy",
      lastIngestAt: FRESH,
      outboxDiagnostics: { pending: 0 },
      recordsPending: 0,
      sourceInstanceId: "src_trusted",
    }),
  ];

  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "idle");
  assert.equal(axis.cause, null);
  assert.equal(axis.hasEvidence, true);

  const progress = projectLocalDeviceProgress(rows);
  assert.equal(progress?.source_count, 1);
  assert.equal(progress?.last_heartbeat_at, FRESH);
  assert.equal(progress?.last_heartbeat_status, "healthy");
  assert.equal(progress?.last_ingest_at, FRESH);
  assert.equal(progress?.records_pending, 0);
  assert.deepEqual(progress?.outbox_counts, { pending: 0 });
});

// ─── Old-but-fresh-heartbeat backlog: server-side heartbeat-row projection ──
//
// End-to-end proof that `HeartbeatRow.outboxDiagnostics.oldest_retrying_at`
// (already computed device-side from rows with real retry evidence —
// attempt_count > 0 — already sent on every heartbeat, already persisted
// server-side — see `device-exporter-store.ts`) reaches the connection
// outbox axis through `accumulateOutboxAxisRow`'s `deriveOutboxAxisFromHeartbeat`
// call. This is the wiring the P2 follow-up found missing: the field existed
// at every layer except this one. Deliberately keyed on `oldest_retrying_at`,
// NOT `oldest_pending_at` — the latter also ages with a freshly-enqueued,
// never-failed row (e.g. a large healthy first drain) and using it here
// would fabricate failure evidence.

test("a retrying row whose oldest_retrying_at is stale-by-age projects as a stalled, system-handled backlog", () => {
  const rows = [
    hbRow({
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "retrying",
      outboxDiagnostics: { oldest_retrying_at: BACKLOG_OLD, pending: 1, retrying: 1 },
      recordsPending: 1,
    }),
  ];
  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "stalled");
  assert.equal(axis.cause, "transient_upload_failure");
  assert.equal(axis.hasEvidence, true);
});

test("a retrying row with a fresh oldest_retrying_at stays active — live retries are not false-flagged", () => {
  const rows = [
    hbRow({
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "retrying",
      outboxDiagnostics: { oldest_retrying_at: BACKLOG_FRESH, pending: 1, retrying: 1 },
      recordsPending: 1,
    }),
  ];
  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "active");
  assert.equal(axis.cause, null);
});

test("a retrying row with no oldest_retrying_at evidence stays active — missing timestamp fails conservatively", () => {
  const rows = [
    hbRow({
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "retrying",
      outboxDiagnostics: { pending: 1, retrying: 1 },
      recordsPending: 1,
    }),
  ];
  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "active");
  assert.equal(axis.cause, null);
});

test("a retrying row with an old oldest_pending_at but NO oldest_retrying_at stays active — a large healthy never-failed backlog is not false-red", () => {
  // The exact counterexample the reviewer raised: a large multi-GB import's
  // oldest queued row can be old under oldest_pending_at (it has been
  // sitting ready, never having failed) while oldest_retrying_at is absent
  // because attempt_count is still 0 for every row. Only the latter may
  // drive the age policy.
  const rows = [
    hbRow({
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "retrying",
      outboxDiagnostics: { oldest_pending_at: BACKLOG_OLD, pending: 5000, retrying: 0 },
      recordsPending: 5000,
    }),
  ];
  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "active");
  assert.equal(axis.cause, null);
});

test("a revoked device's stale-by-age backlog is not evidence — untrusted rows never drive the axis", () => {
  const rows = [
    revokedStalledRow({
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "retrying",
      outboxDiagnostics: { oldest_retrying_at: BACKLOG_OLD, pending: 1, retrying: 1 },
      recordsPending: 1,
    }),
  ];
  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "unknown");
  assert.equal(axis.hasEvidence, false);
});
