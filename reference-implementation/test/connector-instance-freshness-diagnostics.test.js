// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { closeDb, initDb } from '../server/db.js';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-instance-freshness-diagnostics-'));
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('scheduler freshness gates are isolated by connector instance', withTempDb(async () => {
  const store = createSqliteSchedulerStore();
  store.upsertLastRunTime('cin_gmail_work', 1_776_000_001_000, '2026-05-01T00:00:01.000Z', 'gmail');
  store.upsertLastRunTime('cin_gmail_personal', 1_776_000_002_000, '2026-05-01T00:00:02.000Z', 'gmail');

  const rows = store.listLastRunTimes();
  assert.deepEqual(
    rows.map((row) => [row.connector_instance_id, row.connector_id, row.last_run_time_ms]),
    [
      ['cin_gmail_personal', 'gmail', 1_776_000_002_000],
      ['cin_gmail_work', 'gmail', 1_776_000_001_000],
    ],
  );
}));

test('scheduler diagnostic recovery state is isolated by connector instance', withTempDb(async () => {
  const store = createSqliteSchedulerStore();
  store.appendRunHistory({
    connectorId: 'gmail',
    connectorInstanceId: 'cin_gmail_work',
    source: { kind: 'connector', id: 'gmail' },
    status: 'failed',
    recordsEmitted: 0,
    knownGaps: [{ kind: 'detail_gap', stream: 'messages', reason: 'work_rate_limit' }],
    connectorError: { message: 'work failed' },
    runId: 'run_work',
    traceId: 'trace_work',
    failureReason: 'connector_failed',
    terminalReason: 'connector_exit_without_done',
    startedAt: '2026-05-01T00:00:01.000Z',
    completedAt: '2026-05-01T00:00:02.000Z',
    error: 'work failed',
    attempt: 1,
  });
  store.appendRunHistory({
    connectorId: 'gmail',
    connectorInstanceId: 'cin_gmail_personal',
    source: { kind: 'connector', id: 'gmail' },
    status: 'succeeded',
    recordsEmitted: 2,
    knownGaps: [],
    connectorError: null,
    runId: 'run_personal',
    traceId: 'trace_personal',
    startedAt: '2026-05-01T00:00:03.000Z',
    completedAt: '2026-05-01T00:00:04.000Z',
    attempt: 1,
  });

  const byInstance = new Map(store.listRunHistory(10).map((row) => [row.connectorInstanceId, row]));
  assert.equal(byInstance.get('cin_gmail_work')?.connectorError?.message, 'work failed');
  assert.deepEqual(byInstance.get('cin_gmail_work')?.knownGaps.map((gap) => gap.reason), ['work_rate_limit']);
  assert.equal(byInstance.get('cin_gmail_personal')?.connectorError, null);
  assert.deepEqual(byInstance.get('cin_gmail_personal')?.knownGaps, []);
}));
