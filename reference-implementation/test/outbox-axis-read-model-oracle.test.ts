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
  // No trusted evidence exists at all here — the untrusted rows' own
  // unreliability is the only signal available, so it must surface.
  assert.equal(axis.unreliable, true);

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
  // Regression guard (2026-08-01, live vivid-fish Codex incident): a
  // revoked/inactive historical device row must never poison the
  // connection-wide reliability of an active, healthy replacement row's
  // conclusive read. Before the fix, `unreliable` stayed `true` here purely
  // because `revokedStalledRow()`/`inactiveSourceRow()` are always
  // unreliable by construction, even though the trusted `dev_trusted` row
  // alone already fully determines the `idle` axis.
  assert.equal(axis.unreliable, false);

  const progress = projectLocalDeviceProgress(rows);
  assert.equal(progress?.source_count, 1);
  assert.equal(progress?.last_heartbeat_at, FRESH);
  assert.equal(progress?.last_heartbeat_status, "healthy");
  assert.equal(progress?.last_ingest_at, FRESH);
  assert.equal(progress?.records_pending, 0);
  assert.deepEqual(progress?.outbox_counts, { pending: 0 });
});

test("a revoked device row does not poison outbox reliability when order is reversed", () => {
  // Same shape as the live incident, but with the trusted row appearing
  // FIRST in the array — the fix must be order-independent (accumulation
  // happens per-row in array order; `anyTrustedEvidence` is not necessarily
  // true yet when an untrusted row is processed).
  const rows = [
    hbRow({
      deviceId: "dev_trusted",
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: "healthy",
      lastIngestAt: FRESH,
      outboxDiagnostics: { pending: 0 },
      recordsPending: 0,
      sourceInstanceId: "src_trusted",
    }),
    revokedStalledRow(),
  ];

  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, "idle");
  assert.equal(axis.unreliable, false);
});
