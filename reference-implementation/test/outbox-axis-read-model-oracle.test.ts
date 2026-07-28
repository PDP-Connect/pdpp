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
