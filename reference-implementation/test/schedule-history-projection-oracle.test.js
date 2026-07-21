// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const projectionModuleUrl = new URL('../runtime/schedule-history-projection.ts', import.meta.url);
const projectionSource = readFileSync(projectionModuleUrl, 'utf8');

if (projectionSource.startsWith('row.status === succeeded || row.status === failed || row.status === skipped')) {
  process.stdout.write('BASELINE: seeded mutation produced an invalid quote-stripped prefix\n');
  throw new Error('Seeded mutation reached latestStartedAt eligibility guard');
}

const {
  applyHistoryRowToScheduleFacts,
  deriveLatestScheduleFacts,
  ensureScheduleHistoryFacts,
  hydrateScheduleHistoryFromLastRunTimes,
} = await import(projectionModuleUrl.href);

function row(overrides = {}) {
  return {
    attempt: 1,
    checkpointSummary: null,
    completedAt: '2026-01-01T00:10:00.000Z',
    connectorError: null,
    connectorId: 'gmail',
    connectorInstanceId: 'conn-1',
    error: undefined,
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: 'run-1',
    source: {},
    startedAt: '2026-01-01T00:00:00.000Z',
    status: 'succeeded',
    terminalReason: null,
    traceId: 'trace-1',
    ...overrides,
  };
}

function createFactsHarness() {
  const facts = new Map();
  return {
    facts,
    ensure: (connectorKey) => ensureScheduleHistoryFacts(facts, connectorKey),
  };
}

test('applyHistoryRowToScheduleFacts: skipped rows are terminal but do not populate latestStartedAt', () => {
  const { ensure } = createFactsHarness();
  const entry = ensure('conn-1');

  applyHistoryRowToScheduleFacts(
    entry,
    row({
      completedAt: '2026-01-01T00:03:00.000Z',
      error: 'not_ready: waiting for owner action',
      startedAt: '2026-01-01T00:02:00.000Z',
      status: 'skipped',
    })
  );

  assert.equal(entry.latestStatus, 'skipped');
  assert.equal(entry.latestErrorCode, 'not_ready');
  assert.equal(entry.latestFinishedAt, '2026-01-01T00:03:00.000Z');
  assert.equal(entry.latestStartedAt, null, 'skipped bookkeeping rows are not real starts');
  assert.equal(entry.latestSuccessfulAt, null);
});

test('deriveLatestScheduleFacts: newest terminal row wins while latest start/success use newest eligible rows', () => {
  const { facts, ensure } = createFactsHarness();
  const history = [
    row({
      completedAt: '2026-01-01T00:10:00.000Z',
      runId: 'run-success-old',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'succeeded',
    }),
    row({
      completedAt: '2026-01-01T00:20:00.000Z',
      error: 'upstream exploded with raw details',
      runId: 'run-failed',
      startedAt: '2026-01-01T00:12:00.000Z',
      status: 'failed',
    }),
    row({
      completedAt: '2026-01-01T00:30:00.000Z',
      error: 'schedule.gave_up: max attempts reached',
      runId: 'run-skipped-newest',
      startedAt: '2026-01-01T00:28:00.000Z',
      status: 'skipped',
    }),
  ];

  deriveLatestScheduleFacts(history, ensure);

  const entry = facts.get('conn-1');
  assert.ok(entry);
  assert.equal(entry.latestStatus, 'skipped', 'the newest terminal row supplies status');
  assert.equal(entry.latestErrorCode, 'schedule.gave_up', 'safe scheduler error prefixes are preserved');
  assert.equal(entry.latestFinishedAt, '2026-01-01T00:30:00.000Z');
  assert.equal(entry.latestStartedAt, '2026-01-01T00:12:00.000Z', 'newest failed/succeeded start wins');
  assert.equal(entry.latestSuccessfulAt, '2026-01-01T00:10:00.000Z');
});

test('deriveLatestScheduleFacts: newest success wins latestSuccessfulAt even when older rows follow in reverse scan', () => {
  const { facts, ensure } = createFactsHarness();
  const history = [
    row({
      completedAt: '2026-01-01T00:10:00.000Z',
      runId: 'run-success-old',
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'succeeded',
    }),
    row({
      completedAt: '2026-01-01T00:25:00.000Z',
      runId: 'run-success-new',
      startedAt: '2026-01-01T00:15:00.000Z',
      status: 'succeeded',
    }),
    row({
      completedAt: '2026-01-01T00:30:00.000Z',
      error: 'not_ready: owner action required',
      runId: 'run-skipped-newest',
      startedAt: '2026-01-01T00:28:00.000Z',
      status: 'skipped',
    }),
  ];

  deriveLatestScheduleFacts(history, ensure);

  const entry = facts.get('conn-1');
  assert.ok(entry);
  assert.equal(entry.latestStatus, 'skipped');
  assert.equal(entry.latestStartedAt, '2026-01-01T00:15:00.000Z');
  assert.equal(entry.latestSuccessfulAt, '2026-01-01T00:25:00.000Z', 'newest success is sticky');
});

test('deriveLatestScheduleFacts: arbitrary scheduler error text collapses to scheduler_error', () => {
  const { facts, ensure } = createFactsHarness();

  deriveLatestScheduleFacts(
    [
      row({
        completedAt: '2026-01-01T00:10:00.000Z',
        error: 'connector stack trace with arbitrary text',
        runId: 'run-failed',
        startedAt: '2026-01-01T00:00:00.000Z',
        status: 'failed',
      }),
    ],
    ensure
  );

  assert.equal(facts.get('conn-1')?.latestErrorCode, 'scheduler_error');
});

test('hydrateScheduleHistoryFromLastRunTimes: sets latestFinishedAt only when absent and tracks max lastRunTimeMs', () => {
  const { facts, ensure } = createFactsHarness();

  hydrateScheduleHistoryFromLastRunTimes(
    [
      {
        connector_id: 'gmail',
        connector_instance_id: 'conn-1',
        last_run_time_ms: Date.parse('2026-01-01T00:10:00.000Z'),
        updated_at: '2026-01-01T00:10:01.000Z',
      },
      {
        connector_id: 'gmail',
        connector_instance_id: 'conn-1',
        last_run_time_ms: Date.parse('2026-01-01T00:30:00.000Z'),
        updated_at: '2026-01-01T00:30:01.000Z',
      },
    ],
    ensure
  );

  const entry = facts.get('conn-1');
  assert.ok(entry);
  assert.equal(entry.latestFinishedAt, '2026-01-01T00:10:00.000Z', 'first hydration fills absent finish');
  assert.equal(entry.lastRunTimeMs, Date.parse('2026-01-01T00:30:00.000Z'), 'max lastRunTimeMs is retained');

  entry.latestFinishedAt = '2026-01-01T00:40:00.000Z';
  hydrateScheduleHistoryFromLastRunTimes(
    [
      {
        connector_id: 'gmail',
        connector_instance_id: 'conn-1',
        last_run_time_ms: Date.parse('2026-01-01T00:20:00.000Z'),
        updated_at: '2026-01-01T00:20:01.000Z',
      },
      {
        connector_id: 'gmail',
        connector_instance_id: 'conn-1',
        last_run_time_ms: Number.NaN,
        updated_at: '2026-01-01T00:50:01.000Z',
      },
    ],
    ensure
  );

  assert.equal(entry.latestFinishedAt, '2026-01-01T00:40:00.000Z', 'existing finish is not overwritten');
  assert.equal(entry.lastRunTimeMs, Date.parse('2026-01-01T00:30:00.000Z'), 'lower and non-finite times are ignored');
});
