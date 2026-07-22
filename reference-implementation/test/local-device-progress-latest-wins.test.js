// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectLocalDeviceProgress } from '../server/connector-outbox-axis.ts';

// Mutation-killing complement for `projectLocalDeviceProgress` — the local-
// device read-model that folds many trusted per-source heartbeat rows into one
// connection-level progress snapshot. The existing suite pins the trust filter,
// the outbox rollup, and a same-row "most recent" case. This file isolates the
// three fold rules that a same-row fixture leaves ambiguous:
//
//   1. last_heartbeat_STATUS follows the row with the newest last_heartbeat_at
//      (not the last-iterated row, not a different newest-ingest row).
//   2. last_heartbeat_at and last_ingest_at are picked INDEPENDENTLY — the
//      newest heartbeat and newest ingest may live on different rows.
//   3. records_pending SUMS numeric contributions and is null ONLY when no row
//      reported a number — a reported 0 stays 0, not null.
//
// Pure — no DB.

const OLDER = '2026-05-19T10:00:00.000Z';
const MID = '2026-05-19T11:00:00.000Z';
const NEWER = '2026-05-19T11:55:00.000Z';

function hbRow(overrides = {}) {
  return {
    sourceInstanceId: 'src_1',
    deviceId: 'dev_1',
    connectorId: 'codex',
    sourceStatus: 'active',
    deviceStatus: 'active',
    deviceRevokedAt: null,
    lastHeartbeatAt: NEWER,
    lastHeartbeatStatus: 'healthy',
    lastIngestAt: NEWER,
    recordsPending: 0,
    outboxDiagnostics: null,
    updatedAt: NEWER,
    ...overrides,
  };
}

test('last_heartbeat_status is the status of the NEWEST-heartbeat row, regardless of iteration order', () => {
  // Newest heartbeat is on the SECOND row here...
  const a = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 's1', lastHeartbeatAt: MID, lastHeartbeatStatus: 'blocked' }),
    hbRow({ sourceInstanceId: 's2', lastHeartbeatAt: NEWER, lastHeartbeatStatus: 'retrying' }),
  ]);
  assert.equal(a.last_heartbeat_at, NEWER);
  assert.equal(a.last_heartbeat_status, 'retrying', 'status tracks the newest heartbeat');

  // ...and here the newest heartbeat is on the FIRST row. Status must still
  // follow the max heartbeat, not the last row visited.
  const b = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 's1', lastHeartbeatAt: NEWER, lastHeartbeatStatus: 'starting' }),
    hbRow({ sourceInstanceId: 's2', lastHeartbeatAt: MID, lastHeartbeatStatus: 'healthy' }),
  ]);
  assert.equal(b.last_heartbeat_at, NEWER);
  assert.equal(b.last_heartbeat_status, 'starting', 'a later idle row must not overwrite the newer status');
});

test('last_heartbeat_at and last_ingest_at are chosen independently across rows', () => {
  // Row A has the newest HEARTBEAT but an old ingest; row B has the newest
  // INGEST but an old heartbeat. The projection must cross-pick.
  const out = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 'A', lastHeartbeatAt: NEWER, lastHeartbeatStatus: 'starting', lastIngestAt: OLDER }),
    hbRow({ sourceInstanceId: 'B', lastHeartbeatAt: MID, lastHeartbeatStatus: 'healthy', lastIngestAt: NEWER }),
  ]);
  assert.equal(out.last_heartbeat_at, NEWER, 'heartbeat from row A');
  assert.equal(out.last_heartbeat_status, 'starting', 'status from row A (the heartbeat winner)');
  assert.equal(out.last_ingest_at, NEWER, 'ingest from row B — independent of the heartbeat pick');
});

test('a null-heartbeat row is skipped for the heartbeat pick but still contributes ingest and pending', () => {
  const out = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 'silent', lastHeartbeatAt: null, lastHeartbeatStatus: 'never', lastIngestAt: NEWER, recordsPending: 4 }),
    hbRow({ sourceInstanceId: 'beating', lastHeartbeatAt: MID, lastHeartbeatStatus: 'healthy', lastIngestAt: OLDER, recordsPending: 1 }),
  ]);
  // The null-heartbeat row cannot win the heartbeat pick, so the beating row's
  // heartbeat+status win even though it is older in absolute terms.
  assert.equal(out.last_heartbeat_at, MID);
  assert.equal(out.last_heartbeat_status, 'healthy', 'the null-heartbeat row never sets the status');
  // But the silent row's newer ingest and its pending count still fold in.
  assert.equal(out.last_ingest_at, NEWER);
  assert.equal(out.records_pending, 5);
  assert.equal(out.source_count, 2, 'both trusted rows count toward source_count');
});

test('records_pending distinguishes a reported 0 from an unreported (null) count', () => {
  // Every row reports a numeric 0 → the sum is 0, NOT null.
  const zero = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 's1', recordsPending: 0 }),
    hbRow({ sourceInstanceId: 's2', recordsPending: 0 }),
  ]);
  assert.equal(zero.records_pending, 0, 'reported zero is a real 0, not null');

  // No row reports a number (all non-numeric) → null.
  const none = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 's1', recordsPending: null }),
    hbRow({ sourceInstanceId: 's2', recordsPending: undefined }),
  ]);
  assert.equal(none.records_pending, null, 'no numeric contribution → null');

  // Mixed: a non-numeric row is skipped but the numeric ones still sum (and the
  // presence of at least one number keeps the result non-null).
  const mixed = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 's1', recordsPending: null }),
    hbRow({ sourceInstanceId: 's2', recordsPending: 7 }),
    hbRow({ sourceInstanceId: 's3', recordsPending: 2 }),
  ]);
  assert.equal(mixed.records_pending, 9, 'non-numeric row skipped; numeric rows summed');
});
