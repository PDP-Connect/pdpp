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
import {
  isPublicReferenceConnector,
  projectConnectorOutboxAxisFromHeartbeats,
  projectConnectorSummaryConnectionHealth,
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
      { connector_id: 'https://registry.pdpp.org/connectors/spotify', manifest: '{}' },
      {
        connector_id: 'https://registry.pdpp.org/connectors/spotify',
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
      { connector_id: 'https://registry.pdpp.org/connectors/unproven-source', manifest: '{}' },
      {
        connector_id: 'https://registry.pdpp.org/connectors/unproven-source',
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
    connector_id: 'https://registry.pdpp.org/connectors/imessage',
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
      { connector_id: 'https://registry.pdpp.org/connectors/imessage', manifest: '{}' },
      imessageManifest,
    ),
    false,
    'iMessage must not appear in the default Docker/public connector catalog',
  );

  assert.equal(
    isPublicReferenceConnector(
      { connector_id: 'https://registry.pdpp.org/connectors/imessage', manifest: '{}' },
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
    'https://registry.pdpp.org/connectors/manual-action-stub',
    'https://registry.pdpp.org/connectors/stream-test-stub',
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
  assert.equal(snapshot.axes.coverage, 'gaps');
  assert.equal(snapshot.reason_code, 'http_429');
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
  assert.equal(snapshot.state, 'degraded');
  assert.equal(snapshot.axes.coverage, 'gaps');
  assert.equal(snapshot.reason_code, 'rate_limited');
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
