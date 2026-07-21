import test from 'node:test';
import assert from 'node:assert/strict';

import {
  projectConnectorOutboxAxisFromHeartbeats,
  projectLocalDeviceProgress,
} from '../server/connector-outbox-axis.ts';

const NOW = '2026-05-19T12:00:00.000Z';
const FRESH = '2026-05-19T11:55:00.000Z';
const STALE = '2026-05-19T11:00:00.000Z';

function hbRow(overrides = {}) {
  return {
    sourceInstanceId: 'src_1',
    deviceId: 'dev_1',
    connectorId: 'codex',
    connectorInstanceId: 'cin_1',
    sourceStatus: 'active',
    deviceStatus: 'active',
    deviceRevokedAt: null,
    lastHeartbeatAt: FRESH,
    lastHeartbeatStatus: 'healthy',
    lastIngestAt: FRESH,
    recordsPending: 0,
    outboxDiagnostics: null,
    updatedAt: FRESH,
    ...overrides,
  };
}

function revokedStalledRow(overrides = {}) {
  return hbRow({
    sourceInstanceId: 'src_revoked',
    deviceId: 'dev_revoked',
    deviceRevokedAt: '2026-05-19T11:30:00.000Z',
    lastHeartbeatAt: STALE,
    lastHeartbeatStatus: 'healthy',
    lastIngestAt: STALE,
    recordsPending: 9,
    outboxDiagnostics: { pending: 9 },
    ...overrides,
  });
}

function inactiveSourceRow(overrides = {}) {
  return hbRow({
    sourceInstanceId: 'src_inactive',
    deviceId: 'dev_inactive_source',
    sourceStatus: 'inactive',
    recordsPending: 4,
    outboxDiagnostics: { pending: 4 },
    ...overrides,
  });
}

test('revoked or inactive source rows are not outbox-axis or local-progress evidence', () => {
  const rows = [
    revokedStalledRow(),
    inactiveSourceRow({ lastHeartbeatAt: FRESH, lastIngestAt: FRESH }),
  ];

  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, 'unknown');
  assert.equal(axis.cause, null);
  assert.equal(axis.hasEvidence, false);

  assert.equal(projectLocalDeviceProgress(rows), null);
});

test('active trusted rows contribute while revoked or inactive rows are ignored', () => {
  const rows = [
    revokedStalledRow(),
    inactiveSourceRow({ sourceInstanceId: 'src_inactive_newer', lastHeartbeatAt: NOW, lastIngestAt: NOW }),
    hbRow({
      sourceInstanceId: 'src_trusted',
      deviceId: 'dev_trusted',
      lastHeartbeatAt: FRESH,
      lastHeartbeatStatus: 'healthy',
      lastIngestAt: FRESH,
      recordsPending: 0,
      outboxDiagnostics: { pending: 0 },
    }),
  ];

  const axis = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(axis.axis, 'idle');
  assert.equal(axis.cause, null);
  assert.equal(axis.hasEvidence, true);

  const progress = projectLocalDeviceProgress(rows);
  assert.equal(progress?.source_count, 1);
  assert.equal(progress?.last_heartbeat_at, FRESH);
  assert.equal(progress?.last_heartbeat_status, 'healthy');
  assert.equal(progress?.last_ingest_at, FRESH);
  assert.equal(progress?.records_pending, 0);
  assert.deepEqual(progress?.outbox_counts, { pending: 0 });
});
