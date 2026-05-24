/**
 * Operation-level behavior tests for `ref.connectors.list`.
 *
 * Pins the envelope discriminator, that the operation passes through the
 * dependency's order without re-sorting, and that the operation does not
 * mutate the dependency's array.
 *
 * Host-mounted parity (Fastify route returning the same envelope) is
 * covered by the existing connector/control-plane tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefConnectorsList } from '../operations/ref-connectors-list/index.ts';
import { createAttention } from '../runtime/attention.ts';
import {
  isPublicReferenceConnector,
  LIST_CONNECTOR_SUMMARIES_CONCURRENCY,
  mapWithConcurrency,
  projectConnectorOutboxAxisFromHeartbeats,
  projectConnectorSummaryConnectionHealth,
  projectLocalDeviceProgress,
} from '../server/ref-control.ts';

const NOW = '2026-05-19T12:00:00.000Z';
const FRESH = '2026-05-19T11:55:00.000Z';
const OLD = '2026-05-19T11:00:00.000Z';

function hbRow(overrides = {}) {
  return {
    sourceInstanceId: 'src_1',
    deviceId: 'dev_1',
    connectorId: 'codex',
    sourceStatus: 'active',
    deviceStatus: 'active',
    deviceRevokedAt: null,
    lastHeartbeatAt: FRESH,
    lastHeartbeatStatus: 'healthy',
    lastIngestAt: FRESH,
    recordsPending: 0,
    updatedAt: FRESH,
    ...overrides,
  };
}

function makeItem(connectorId, overrides = {}) {
  return {
    connection_id: connectorId,
    connection_health: {
      state: 'idle',
      axes: { attention: 'none', coverage: 'unknown', freshness: 'unknown', outbox: 'unknown' },
      badges: { stale: false, syncing: false },
      last_success_at: null,
      next_attempt_at: null,
      reason_code: null,
      unknown_reasons: [],
    },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_version: '1.0.0',
    streams: [],
    total_records: 0,
    freshness: { status: 'unknown' },
    refresh_policy: null,
    schedule: null,
    last_run: null,
    last_successful_run: null,
    ...overrides,
  };
}

test('ref.connectors.list wraps dependency output in {object: list, data}', async () => {
  const items = [makeItem('a'), makeItem('b')];
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => items,
  });
  assert.equal(envelope.object, 'list');
  assert.deepEqual(envelope.data, items);
});

test('ref.connectors.list preserves dependency order', async () => {
  const items = [makeItem('z'), makeItem('a'), makeItem('m')];
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => items,
  });
  assert.deepEqual(
    envelope.data.map((item) => item.connector_id),
    ['z', 'a', 'm'],
  );
});

test('ref.connectors.list does not mutate the dependency array', async () => {
  const items = [makeItem('a'), makeItem('b')];
  const snapshot = items.slice();
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => items,
  });
  assert.deepEqual(items, snapshot);
  assert.notStrictEqual(envelope.data, items);
});

test('ref.connectors.list awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolved = true;
          resolve([makeItem('async')]);
        }),
      ),
  });
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
});

test('ref.connectors.list yields empty envelope when dependency returns empty', async () => {
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => [],
  });
  assert.deepEqual(envelope, { object: 'list', data: [] });
});

test('reference connector catalog hides manifest opt-outs', () => {
  assert.equal(
    isPublicReferenceConnector(
      { connector_id: 'https://registry.pdpp.dev/connectors/spotify', manifest: '{}' },
      {
        connector_id: 'https://registry.pdpp.dev/connectors/spotify',
        capabilities: {
          public_listing: {
            listed: false,
            status: 'unproven',
          },
        },
      },
    ),
    false,
  );
});

test('reference connector catalog hides unproven connectors by default', () => {
  assert.equal(
    isPublicReferenceConnector(
      { connector_id: 'https://registry.pdpp.dev/connectors/unproven-source', manifest: '{}' },
      {
        connector_id: 'https://registry.pdpp.dev/connectors/unproven-source',
        capabilities: {
          public_listing: {
            status: 'unproven',
          },
        },
      },
    ),
    false,
  );
});

test('reference connector catalog hides local-device connectors unless explicitly listed', () => {
  const imessageManifest = {
    connector_id: 'https://registry.pdpp.dev/connectors/imessage',
    runtime_requirements: {
      bindings: {
        filesystem: {
          required: true,
        },
        local_device: {
          required: true,
        },
      },
    },
  };

  assert.equal(
    isPublicReferenceConnector(
      { connector_id: 'https://registry.pdpp.dev/connectors/imessage', manifest: '{}' },
      imessageManifest,
    ),
    false,
    'iMessage must not appear in the default Docker/public connector catalog',
  );

  assert.equal(
    isPublicReferenceConnector(
      { connector_id: 'https://registry.pdpp.dev/connectors/imessage', manifest: '{}' },
      {
        ...imessageManifest,
        capabilities: {
          public_listing: {
            listed: true,
            status: 'operator_enabled',
          },
        },
      },
    ),
    true,
    'local-device connectors can be surfaced only after an explicit manifest opt-in',
  );
});

test('reference connector catalog hides stub and stream-test connector registrations', () => {
  for (const connectorId of [
    'manual_action_stub',
    'https://registry.pdpp.dev/connectors/manual-action-stub',
    'https://registry.pdpp.dev/connectors/stream-test-stub',
  ]) {
    assert.equal(
      isPublicReferenceConnector({ connector_id: connectorId, manifest: '{}' }, { connector_id: connectorId }),
      false,
      `${connectorId} must not appear in the user-facing reference connector catalog`,
    );
  }
});

test('connector summary connection health projects never-run as idle with unknown axes', () => {
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'unknown' },
    lastRun: null,
    lastSuccessfulRun: null,
    schedule: null,
  });
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.axes.coverage, 'unknown');
  assert.equal(snapshot.axes.freshness, 'unknown');
});

test('connector summary connection health degrades succeeded runs with coverage gaps', () => {
  // Unclassified known_gap (no severity) is treated as terminal because
  // the runtime cannot prove a retry path exists. Conservative > false-green.
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [{ reason: 'http_429', stream: 'messages' }],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_gap',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
  });
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.coverage, 'terminal_gap');
  assert.equal(snapshot.reason_code, 'http_429');
});

test('connector summary connection health surfaces retryable_gap for known transient gaps', () => {
  // `transient` severity means the runtime intends to retry on its own,
  // so the gap is retryable rather than terminal — still degrading, but
  // distinguishable from owner-action territory.
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [{ reason: 'http_429', severity: 'transient', stream: 'messages' }],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_transient',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
  });
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.coverage, 'retryable_gap');
});

test('connector summary connection health surfaces terminal_gap for actionable known gaps', () => {
  // `actionable` severity means owner intervention is required; the
  // coverage axis must surface this as terminal so the dashboard never
  // tells the owner the system will fix itself.
  const run = {
    event_count: 3,
    failure_reason: 'auth_expired',
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [{ reason: 'auth_expired', severity: 'actionable', stream: 'messages' }],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_actionable',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
  });
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.coverage, 'terminal_gap');
});

test('connector summary connection health ignores informational and recoverable known gaps', () => {
  // Informational/recoverable severities do not degrade health — the
  // axis should still report `complete` and the headline stay healthy.
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [
      { reason: 'out_of_scope', severity: 'informational', stream: 'archived' },
      { reason: 'http_500', severity: 'recoverable', stream: 'inbox' },
    ],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_clean',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
  });
  assert.equal(snapshot.state, 'healthy');
  assert.equal(snapshot.axes.coverage, 'complete');
});

test('connector summary connection health degrades successful runs with pending durable detail gaps', () => {
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_success_with_detail_gap',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: null,
  });
  // Pending detail gaps are runtime-retryable: the store surfaces them
  // with `status = 'pending'` and the runtime owns the retry. The axis
  // must say `retryable_gap` so a list row never claims healthy over a
  // pending backlog, but the dashboard can still tell the owner the
  // system intends to recover on its own.
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.coverage, 'retryable_gap');
  assert.equal(snapshot.reason_code, 'rate_limited');
});

test('connector summary connection health: terminal known_gap dominates pending detail gap rollup', () => {
  // When both a retryable pending detail gap AND a terminal known_gap
  // exist, the more urgent claim wins so the owner sees the terminal
  // axis rather than a misleading retry-only label.
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [{ reason: 'auth_expired', severity: 'actionable', stream: 'inbox' }],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_mixed',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: null,
  });
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.coverage, 'terminal_gap');
});

test('connector summary connection health becomes unknown when durable detail-gap evidence cannot be read', () => {
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_success_projection_unreliable',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
    unreliableSources: ['detail_gaps'],
  });
  assert.equal(snapshot.state, 'unknown');
  assert.deepEqual(snapshot.unknown_reasons, ['detail_gaps']);
});

test('connector summary connection health refuses healthy when freshness is unknown', () => {
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_success',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'unknown', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
  });
  assert.equal(snapshot.state, 'unknown');
});

test('connector summary connection health projects durable scheduler backoff as cooling off', () => {
  const run = {
    event_count: 1,
    failure_reason: 'rate_limited',
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_backoff',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'failed',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'stale', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: {
      enabled: true,
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 4,
        next_run_at: '2026-05-19T13:00:00.000Z',
        reason_class: 'failure:rate_limited',
        recommended_health_state: 'cooling_off',
      },
    },
  });
  assert.equal(snapshot.state, 'cooling_off');
  assert.equal(snapshot.next_attempt_at, '2026-05-19T13:00:00.000Z');
  assert.equal(snapshot.reason_code, 'rate_limited');
});

test('connector summary connection health uses scheduler backoff even when run spine summary is absent', () => {
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'unknown', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: null,
    lastSuccessfulRun: null,
    schedule: {
      enabled: true,
      last_error_code: 'rate_limited',
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 3,
        next_run_at: '2026-05-19T13:00:00.000Z',
        reason_class: 'failure:rate_limited',
        recommended_health_state: 'cooling_off',
      },
    },
  });
  assert.equal(snapshot.state, 'cooling_off');
  assert.equal(snapshot.next_attempt_at, '2026-05-19T13:00:00.000Z');
});

test('connector summary connection health promotes durable scheduler backoff streak to blocked', () => {
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'stale', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: {
      event_count: 1,
      failure_reason: 'browser_runtime_not_configured',
      finished_at: '2026-05-19T12:00:00.000Z',
      first_at: '2026-05-19T11:59:00.000Z',
      known_gaps: [],
      last_at: '2026-05-19T12:00:00.000Z',
      run_id: 'run_blocked',
      started_at: '2026-05-19T11:59:00.000Z',
      status: 'failed',
    },
    lastSuccessfulRun: null,
    schedule: {
      enabled: true,
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 7,
        next_run_at: '2026-05-20T12:00:00.000Z',
        reason_class: 'failure:browser_runtime_not_configured',
        recommended_health_state: 'blocked',
      },
    },
  });
  assert.equal(snapshot.state, 'blocked');
  assert.equal(snapshot.reason_code, 'browser_runtime_not_configured');
});

test('connector summary connection health ignores stale scheduler backoff after a newer successful run', () => {
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-24T23:20:25.909Z',
    first_at: '2026-05-24T23:20:02.398Z',
    known_gaps: [],
    last_at: '2026-05-24T23:20:25.909Z',
    run_id: 'run_success_after_backoff',
    started_at: '2026-05-24T23:20:02.398Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-24T23:20:25.909Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: {
      enabled: true,
      last_error_code: 'schedule.gave_up',
      last_finished_at: '2026-05-21T02:04:39.188Z',
      last_started_at: '2026-05-21T02:03:39.190Z',
      next_due_at: '2026-05-21T03:04:39.188Z',
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: 7,
        next_run_at: '2026-05-21T18:04:39.188Z',
        reason_class: 'terminal:connector_reported_failed',
        recommended_health_state: 'blocked',
      },
    },
  });
  assert.equal(snapshot.state, 'healthy');
  assert.equal(snapshot.reason_code, null);
  assert.equal(snapshot.next_attempt_at, null);
});

// ─── Connector outbox axis rollup from per-source heartbeats ──────────────

test('connector outbox rollup: no heartbeats → unknown without unreliable', () => {
  const r = projectConnectorOutboxAxisFromHeartbeats([], { nowIso: NOW });
  assert.deepEqual(r, { axis: 'unknown', unreliable: false, hasEvidence: false });
});

test('connector outbox rollup: single trusted healthy idle heartbeat → idle', () => {
  const r = projectConnectorOutboxAxisFromHeartbeats([hbRow()], { nowIso: NOW });
  assert.equal(r.axis, 'idle');
  assert.equal(r.unreliable, false);
  assert.equal(r.hasEvidence, true);
});

test('connector outbox rollup: any stalled instance dominates rollup', () => {
  const rows = [
    hbRow({ sourceInstanceId: 'src_1', recordsPending: 0 }),
    hbRow({ sourceInstanceId: 'src_2', deviceId: 'dev_2', lastHeartbeatStatus: 'blocked' }),
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'stalled');
});

test('connector outbox rollup: active beats idle when one instance is draining', () => {
  const rows = [
    hbRow({ sourceInstanceId: 'src_1' }), // idle
    hbRow({ sourceInstanceId: 'src_2', deviceId: 'dev_2', recordsPending: 4 }), // active
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'active');
});

test('connector outbox rollup: revoked-only instances yield unknown, not idle', () => {
  // A revoked source must not be read as evidence the connector is idle.
  // The only enrolled device for this connector is revoked → no honest
  // claim can be made.
  const rows = [
    hbRow({ deviceStatus: 'revoked', deviceRevokedAt: FRESH }),
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'unknown');
  assert.equal(r.unreliable, true);
  assert.equal(r.hasEvidence, false);
});

test('connector outbox rollup: pending + stale heartbeat surfaces stalled', () => {
  const rows = [
    hbRow({ lastHeartbeatAt: OLD, recordsPending: 9, lastHeartbeatStatus: 'healthy' }),
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'stalled');
});

// ─── Local-device progress projection ────────────────────────────────────

test('projectLocalDeviceProgress: no rows → null', () => {
  assert.equal(projectLocalDeviceProgress([]), null);
});

test('projectLocalDeviceProgress: only revoked / inactive rows → null', () => {
  // No trusted heartbeat — we must not surface device-side progress
  // derived from a revoked or inactive row.
  const out = projectLocalDeviceProgress([
    hbRow({ deviceStatus: 'revoked', deviceRevokedAt: FRESH }),
    hbRow({ sourceStatus: 'revoked', sourceInstanceId: 'src_x', deviceId: 'dev_x' }),
  ]);
  assert.equal(out, null);
});

test('projectLocalDeviceProgress: surfaces most-recent trusted heartbeat / ingest', () => {
  const out = projectLocalDeviceProgress([
    hbRow({ sourceInstanceId: 'src_a', lastHeartbeatAt: OLD, lastIngestAt: OLD, recordsPending: 1 }),
    hbRow({ sourceInstanceId: 'src_b', deviceId: 'dev_b', lastHeartbeatAt: FRESH, lastIngestAt: FRESH, recordsPending: 3 }),
  ]);
  assert.equal(out?.last_heartbeat_at, FRESH);
  assert.equal(out?.last_ingest_at, FRESH);
  assert.equal(out?.records_pending, 4);
  assert.equal(out?.source_count, 2);
});

test('projectLocalDeviceProgress: scoped rows (single connector_instance_id) do not leak from another instance', () => {
  // The store is expected to scope rows by connector_instance_id before
  // passing them in. The projection just rolls up the rows it receives.
  const out = projectLocalDeviceProgress([
    hbRow({
      sourceInstanceId: 'src_z',
      connectorInstanceId: 'cin_other',
      lastHeartbeatAt: FRESH,
      lastIngestAt: null,
    }),
  ]);
  assert.equal(out?.source_count, 1);
  assert.equal(out?.last_heartbeat_at, FRESH);
  assert.equal(out?.last_ingest_at, null);
});

// ─── projectConnectorSummaryConnectionHealth honors outbox input ──────────

test('connector summary connection health: stalled outbox degrades an otherwise clean run', () => {
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_ok',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'stalled' },
    schedule: null,
  });
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.outbox, 'stalled');
});

test('connector summary connection health: idle outbox does not by itself degrade healthy', () => {
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_ok',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    schedule: null,
  });
  assert.equal(snapshot.state, 'healthy');
  assert.equal(snapshot.axes.outbox, 'idle');
});

test('connector summary connection health: missing outbox evidence stays unknown axis, not false green', () => {
  // No outbox input — axis must remain `unknown` rather than implying idle.
  const run = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_ok',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: null,
  });
  assert.equal(snapshot.axes.outbox, 'unknown');
});

// ─── Trusted-but-silent heartbeat rows must not roll up as idle ───────────

test('connector outbox rollup: trusted row with null heartbeat → unknown, not idle', () => {
  // An enrolled, active source instance that has never produced a
  // heartbeat is honest absence of evidence — claiming `idle` would
  // paint a dead collector green.
  const rows = [hbRow({ lastHeartbeatAt: null, lastHeartbeatStatus: null })];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'unknown');
  assert.equal(r.unreliable, false);
  assert.equal(r.hasEvidence, false);
});

test('connector outbox rollup: trusted idle + trusted silent → unknown, not idle', () => {
  // One instance is genuinely idle, another has never spoken. The
  // honest rollup is `unknown`: we have no evidence about the silent
  // instance's outbox depth, so we cannot promise the connector is
  // drained.
  const rows = [
    hbRow({ sourceInstanceId: 'src_1' }), // healthy idle
    hbRow({ sourceInstanceId: 'src_2', deviceId: 'dev_2', lastHeartbeatAt: null, lastHeartbeatStatus: null }),
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'unknown');
  assert.equal(r.unreliable, false);
});

test('connector outbox rollup: trusted active + trusted silent still surfaces active', () => {
  // An untrustworthy "silent" row never downgrades a positive active
  // signal — the connector is demonstrably working on at least one
  // source, which is the more important fact to surface.
  const rows = [
    hbRow({ sourceInstanceId: 'src_1', recordsPending: 7 }), // active
    hbRow({ sourceInstanceId: 'src_2', deviceId: 'dev_2', lastHeartbeatAt: null, lastHeartbeatStatus: null }),
  ];
  const r = projectConnectorOutboxAxisFromHeartbeats(rows, { nowIso: NOW });
  assert.equal(r.axis, 'active');
});

// ─── mapWithConcurrency: bound parallel projection work ──────────────────

test('mapWithConcurrency: keeps in-flight workers within the configured limit', async () => {
  const items = Array.from({ length: 24 }, (_, i) => i);
  const observed = [];
  let peak = 0;
  let active = 0;
  const results = await mapWithConcurrency(
    items,
    4,
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      observed.push(active);
      // Yield so the runtime interleaves workers and inflight has time to grow.
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return n * 2;
    },
  );
  assert.equal(peak <= 4, true, `peak in-flight ${peak} exceeded limit 4`);
  assert.equal(observed.every((v) => v <= 4), true);
  // Order is preserved regardless of completion order.
  assert.deepEqual(results, items.map((n) => n * 2));
});

test('mapWithConcurrency: onInFlightChange never reports above the limit', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let maxReported = 0;
  await mapWithConcurrency(
    items,
    3,
    async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
    {
      onInFlightChange: (count) => {
        if (count > maxReported) maxReported = count;
      },
    },
  );
  assert.equal(maxReported <= 3, true, `reported peak ${maxReported} exceeded limit 3`);
});

test('mapWithConcurrency: empty input returns empty array without invoking worker', async () => {
  let called = false;
  const out = await mapWithConcurrency([], 5, async () => {
    called = true;
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('mapWithConcurrency: limit larger than input still preserves order', async () => {
  const items = ['a', 'b', 'c'];
  const out = await mapWithConcurrency(items, 50, async (s, i) => `${i}:${s}`);
  assert.deepEqual(out, ['0:a', '1:b', '2:c']);
});

// ─── Structured attention integration ────────────────────────────────────

function failedRun(overrides = {}) {
  return {
    event_count: 1,
    failure_reason: 'auth_expired',
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_failed',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'failed',
    ...overrides,
  };
}

function succeededRun(overrides = {}) {
  return {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_ok',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
    ...overrides,
  };
}

test('summary connection health: structured attention record drives needs_attention with structured CTA', () => {
  // A health-relevant durable attention record beats the schedule's
  // human_attention_needed flag and beats backoff: the projection must
  // use the structured evidence so the dashboard renders a precise CTA.
  const attention = createAttention({
    id: 'att_otp',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    run_id: 'run_1',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    action_target: 'dashboard',
    now: '2026-05-19T11:50:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [attention],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.state, 'needs_attention');
  assert.equal(snapshot.reason_code, 'otp_required');
  assert.equal(snapshot.next_action?.source, 'structured');
  assert.equal(snapshot.next_action?.attention_id, 'att_otp');
  assert.equal(snapshot.next_action?.action_target, 'dashboard');
  assert.equal(snapshot.next_action?.owner_action, 'provide_value');
  assert.equal(snapshot.next_action?.response_contract, 'response_required');
});

test('summary connection health: structured attention beats schedule.human_attention_needed flag', () => {
  // Both the structured record AND the schedule flag are set. The
  // structured record wins, so the CTA is `structured`, not the coarse
  // schedule_fallback shape.
  const attention = createAttention({
    id: 'att_struct',
    dedupe_key: 'codex:manual_verify',
    connection_id: 'codex',
    run_id: 'run_1',
    reason_code: 'manual_verification',
    progress_posture: 'blocked',
    owner_action: 'operate_attachment',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    action_target: 'remote_surface',
    now: '2026-05-19T11:50:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [attention],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: {
      enabled: true,
      human_attention_needed: true,
      last_error_code: 'browser_runtime_not_configured',
    },
  });
  assert.equal(snapshot.state, 'needs_attention');
  assert.equal(snapshot.next_action?.source, 'structured');
  assert.equal(snapshot.reason_code, 'manual_verification');
});

test('summary connection health: nonblocking act_elsewhere attention is filtered by isHealthRelevant', () => {
  // A nonblocking `act_elsewhere` running notice with no
  // response_contract is informational — `isHealthRelevant` rejects it,
  // so the projection must NOT flip the headline pill and must NOT
  // synthesize a CTA. (Spec scenario: "A non-actionable retry occurs".)
  const informational = createAttention({
    id: 'att_info',
    dedupe_key: 'codex:auto_in_progress',
    connection_id: 'codex',
    run_id: 'run_1',
    reason_code: 'app_push_pending_auto',
    progress_posture: 'running',
    owner_action: 'act_elsewhere',
    response_contract: 'none',
    sensitivity: 'non_secret',
    action_target: 'external_app',
    now: '2026-05-19T11:50:00.000Z',
  });
  const succeededRun = {
    event_count: 3,
    failure_reason: null,
    finished_at: '2026-05-19T12:00:00.000Z',
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: '2026-05-19T12:00:00.000Z',
    run_id: 'run_ok',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'succeeded',
  };
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [informational],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: succeededRun,
    lastSuccessfulRun: succeededRun,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.state, 'healthy');
  assert.equal(snapshot.next_action, null);
});

test('summary connection health: expired structured attention does not drive needs_attention', () => {
  // Past-expiry records are not health-relevant; the projection must
  // ignore them and fall through to the run shape.
  const expired = createAttention({
    id: 'att_expired',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    run_id: 'run_old',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    expires_at: '2026-05-19T11:00:00.000Z',
    now: '2026-05-19T10:55:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [expired],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: {
      event_count: 1,
      failure_reason: null,
      finished_at: '2026-05-19T12:00:00.000Z',
      first_at: '2026-05-19T11:59:00.000Z',
      known_gaps: [],
      last_at: '2026-05-19T12:00:00.000Z',
      run_id: 'run_ok',
      started_at: '2026-05-19T11:59:00.000Z',
      status: 'succeeded',
    },
    lastSuccessfulRun: {
      event_count: 1,
      failure_reason: null,
      finished_at: '2026-05-19T12:00:00.000Z',
      first_at: '2026-05-19T11:59:00.000Z',
      known_gaps: [],
      last_at: '2026-05-19T12:00:00.000Z',
      run_id: 'run_ok',
      started_at: '2026-05-19T11:59:00.000Z',
      status: 'succeeded',
    },
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.state, 'healthy');
  assert.equal(snapshot.next_action, null);
});

test('summary connection health: secret-sensitive structured attention suppresses action_target in CTA', () => {
  // OTP-bearing attention is `secret`. The CTA must surface the
  // attention_id and reason_code so the dashboard can deep-link, but
  // never the action_target (which might encode the surface holding
  // the secret).
  const secret = createAttention({
    id: 'att_secret',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    run_id: 'run_1',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'secret',
    action_target: 'dashboard:/secrets/codex',
    now: '2026-05-19T11:55:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [secret],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.next_action?.action_target, null);
  assert.equal(snapshot.next_action?.attention_id, 'att_secret');
  assert.equal(snapshot.next_action?.reason_code, 'otp_required');
});

test('summary connection health: schedule.human_attention_needed projects schedule_fallback CTA when no structured record exists', () => {
  // Controllers that have not yet adopted the durable attention store
  // still get a CTA, but the source is `schedule_fallback` so the
  // dashboard renders a caveated label.
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun({ failure_reason: 'browser_runtime_not_configured' }),
    lastSuccessfulRun: null,
    schedule: {
      enabled: true,
      human_attention_needed: true,
      last_error_code: 'browser_runtime_not_configured',
    },
  });
  assert.equal(snapshot.state, 'needs_attention');
  assert.equal(snapshot.next_action?.source, 'schedule_fallback');
  assert.equal(snapshot.next_action?.attention_id, null);
  assert.equal(snapshot.next_action?.owner_action, null);
  assert.equal(snapshot.next_action?.reason_code, 'browser_runtime_not_configured');
});

test('summary connection health: most-urgent picker prefers response_required over informational', () => {
  // Two open records, both health-relevant. The response_required one
  // wins (it blocks progress until owner responds).
  const blocking = createAttention({
    id: 'att_block',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    run_id: 'run_1',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    now: '2026-05-19T11:50:00.000Z',
  });
  const operating = createAttention({
    id: 'att_operate',
    dedupe_key: 'codex:attachment',
    connection_id: 'codex',
    run_id: 'run_1',
    reason_code: 'attachment_review',
    progress_posture: 'blocked',
    owner_action: 'operate_attachment',
    response_contract: 'none',
    sensitivity: 'non_secret',
    now: '2026-05-19T11:45:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [operating, blocking],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.next_action?.attention_id, 'att_block');
});

test('LIST_CONNECTOR_SUMMARIES_CONCURRENCY exports a sensible bound', () => {
  assert.equal(typeof LIST_CONNECTOR_SUMMARIES_CONCURRENCY, 'number');
  assert.equal(LIST_CONNECTOR_SUMMARIES_CONCURRENCY > 0, true);
  // We never want the dashboard list to fan out unboundedly; pin the
  // upper bound at a clearly conservative number.
  assert.equal(LIST_CONNECTOR_SUMMARIES_CONCURRENCY <= 32, true);
});

// ─── local-device operator-ideal: freshness from heartbeat ───────────────

test('projectLocalDeviceProgress: surfaces last_heartbeat_at and last_ingest_at from trusted rows', () => {
  const rows = [
    hbRow({ lastHeartbeatAt: FRESH, lastHeartbeatStatus: 'healthy', lastIngestAt: FRESH }),
  ];
  const p = projectLocalDeviceProgress(rows);
  assert.ok(p, 'expected non-null progress for trusted row');
  assert.equal(p.last_heartbeat_at, FRESH);
  assert.equal(p.last_ingest_at, FRESH);
  assert.equal(p.source_count, 1);
});

test('projectLocalDeviceProgress: returns null when all rows are revoked or inactive', () => {
  const rows = [
    hbRow({ deviceStatus: 'revoked', deviceRevokedAt: OLD }),
    hbRow({ sourceStatus: 'inactive' }),
  ];
  const p = projectLocalDeviceProgress(rows);
  assert.equal(p, null);
});

test('projectLocalDeviceProgress: records_pending is null when no row reports a count', () => {
  const rows = [hbRow({ recordsPending: undefined })];
  const p = projectLocalDeviceProgress(rows);
  assert.ok(p);
  assert.equal(p.records_pending, null);
});

test('projectLocalDeviceProgress: sums records_pending across multiple trusted rows', () => {
  const rows = [
    hbRow({ sourceInstanceId: 'src_1', recordsPending: 3 }),
    hbRow({ sourceInstanceId: 'src_2', deviceId: 'dev_2', recordsPending: 5 }),
  ];
  const p = projectLocalDeviceProgress(rows);
  assert.ok(p);
  assert.equal(p.records_pending, 8);
  assert.equal(p.source_count, 2);
});

test('connection health idle+outbox=active projects state=idle (label change is UI-side)', () => {
  // The connection-health projection itself doesn't change the headline
  // state when outbox is active — it stays "idle". The UI layer reads
  // axes.outbox==="active" and shows "Syncing" instead of "Idle". This
  // test pins that the projection stays conservative and doesn't invent
  // a new state value.
  const snapshot = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'unknown' },
    lastRun: null,
    lastSuccessfulRun: null,
    outbox: { axis: 'active' },
    schedule: null,
  });
  assert.equal(snapshot.state, 'idle');
  assert.equal(snapshot.axes.outbox, 'active');
});
