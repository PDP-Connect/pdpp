// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  type HeartbeatRow,
  hasDeviceActivationEvidence,
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

// `hasDeviceActivationEvidence` is the read-time-only signal
// `ref-control.ts`'s `synthesizeConnectorSummary` uses to decide whether a
// `status: "active"` `local_device` connector instance should be judged as
// though it were still `draft` (see waspflow/uat-local-device-orphan-
// lifecycle-0803). It must be a durable, all-time OR across every row's
// `lastHeartbeatAt`/`lastIngestAt` — never gated on the row's current
// `deviceStatus`/`sourceStatus` trust (a revoked device that once genuinely
// checked in still proves activation forever; see the doc comment on the
// function itself).
test("hasDeviceActivationEvidence: no rows at all is never activated", () => {
  assert.equal(hasDeviceActivationEvidence([]), false);
});

test("hasDeviceActivationEvidence: a row with both timestamps null (never checked in) is not activated", () => {
  const neverCheckedIn = hbRow({ lastHeartbeatAt: null, lastIngestAt: null });
  assert.equal(hasDeviceActivationEvidence([neverCheckedIn]), false);
});

test("hasDeviceActivationEvidence: a heartbeat alone (no ingest yet) proves activation", () => {
  const heartbeatOnly = hbRow({ lastHeartbeatAt: FRESH, lastIngestAt: null });
  assert.equal(hasDeviceActivationEvidence([heartbeatOnly]), true);
});

test("hasDeviceActivationEvidence: an ingest alone (no heartbeat recorded) proves activation", () => {
  const ingestOnly = hbRow({ lastHeartbeatAt: null, lastIngestAt: FRESH });
  assert.equal(hasDeviceActivationEvidence([ingestOnly]), true);
});

test("hasDeviceActivationEvidence: a revoked/inactive row that once checked in still proves activation", () => {
  // Mirrors the exact shape a later-revoked device leaves behind: trust
  // flags (`deviceStatus`/`sourceStatus`/`deviceRevokedAt`) are irrelevant to
  // this check by design — activation is a monotonic historical fact, not a
  // current-trust fact (see the function's own doc comment).
  const revokedButOnceActivated = revokedStalledRow({ lastHeartbeatAt: STALE, lastIngestAt: STALE });
  assert.equal(hasDeviceActivationEvidence([revokedButOnceActivated]), true);
});

test("hasDeviceActivationEvidence: one never-activated orphan row plus one genuinely activated sibling row is activated (per-instance scoping is the caller's job)", () => {
  // This function itself has no connector_instance_id filter — callers (see
  // `getConnectorOutboxAxis`'s `connectorInstanceId` scoping) are responsible
  // for passing only the rows for ONE connector instance. This test proves
  // the OR-across-rows semantics the function itself implements, given
  // already-scoped input.
  const neverActivated = hbRow({ lastHeartbeatAt: null, lastIngestAt: null, sourceInstanceId: "src_orphan" });
  const activated = hbRow({ lastHeartbeatAt: FRESH, lastIngestAt: FRESH, sourceInstanceId: "src_healthy" });
  assert.equal(hasDeviceActivationEvidence([neverActivated, activated]), true);
});
