/**
 * Acceptance tests for the durable structured-attention store and its
 * wiring into the reference operator-console connector projections.
 *
 * Covers:
 *   - structured rows drive `needs_attention` with `next_action.source ===
 *     "structured"` in both list and detail surfaces;
 *   - structured attention beats schedule fallback even when both are present;
 *   - secret-sensitive structured attention suppresses `action_target`;
 *   - expired / resolved / superseded rows do not drive health;
 *   - attention-store read failure forces `unknown`, not a false healthy;
 *   - connector instance scoping isolates one connection's attention from
 *     another.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  getConnectorAttentionProjection,
  projectConnectorSummaryConnectionHealth,
} from '../server/ref-control.ts';
import { createAttention, transition } from '../runtime/attention.ts';
import {
  createSqliteConnectorAttentionStore,
  getDefaultConnectorAttentionStore,
  resetDefaultConnectorAttentionStoreCache,
} from '../server/stores/connector-attention-store.js';

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-attention-store-'));
    resetDefaultConnectorAttentionStoreCache();
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      await fn(dir);
    } finally {
      closeDb();
      resetDefaultConnectorAttentionStoreCache();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function failedRun(overrides = {}) {
  return {
    event_count: 1,
    failure_reason: 'manual_verification_required',
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
    event_count: 1,
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

// ─── Store-level behavior ─────────────────────────────────────────────────

test('attention store persists open records and lists them per connector', withTempDb(async () => {
  const store = createSqliteConnectorAttentionStore();
  const record = createAttention({
    id: 'att_otp',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    action_target: 'dashboard',
    now: '2026-05-19T11:50:00.000Z',
  });
  await store.upsertAttention({
    record,
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });

  const open = await store.listOpenAttentionForConnection({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });
  assert.equal(open.length, 1);
  assert.equal(open[0].id, 'att_otp');
  assert.equal(open[0].lifecycle, 'open');
  assert.equal(open[0].action_target, 'dashboard');
}));

test('attention store transitionAttention enforces lifecycle and hides resolved rows from open list', withTempDb(async () => {
  const store = createSqliteConnectorAttentionStore();
  const record = createAttention({
    id: 'att_close',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    now: '2026-05-19T11:50:00.000Z',
  });
  await store.upsertAttention({
    record,
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });

  const resolved = await store.transitionAttention({
    attentionId: 'att_close',
    to: 'resolved',
    now: '2026-05-19T11:55:00.000Z',
  });
  assert.equal(resolved.lifecycle, 'resolved');
  assert.equal(resolved.updated_at, '2026-05-19T11:55:00.000Z');

  const open = await store.listOpenAttentionForConnection({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });
  assert.deepEqual(open, []);

  await assert.rejects(
    store.transitionAttention({ attentionId: 'att_close', to: 'open', now: '2026-05-19T11:56:00.000Z' }),
    /terminal/,
  );
}));

test('attention store scopes reads by connector_instance_id', withTempDb(async () => {
  // Two separate enrolled instances of the same connector. One has an
  // open OTP; the other must NOT see it bleed into its open list. The
  // dashboard renders each configured connection on its own row, so
  // cross-instance leakage would let one owner's OTP push the other
  // instance into needs_attention.
  const store = createSqliteConnectorAttentionStore();
  await store.upsertAttention({
    record: createAttention({
      id: 'att_a',
      dedupe_key: 'codex:a:otp',
      connection_id: 'codex',
      reason_code: 'otp_required',
      progress_posture: 'blocked',
      owner_action: 'provide_value',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
      now: '2026-05-19T11:50:00.000Z',
    }),
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });

  const otherInstance = await store.listOpenAttentionForConnection({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_b',
  });
  assert.deepEqual(otherInstance, []);

  const sameInstance = await store.listOpenAttentionForConnection({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });
  assert.equal(sameInstance.length, 1);
  assert.equal(sameInstance[0].id, 'att_a');
}));

test('attention store recordNotificationOutcomeById updates notification_state without touching lifecycle', withTempDb(async () => {
  const store = createSqliteConnectorAttentionStore();
  const record = createAttention({
    id: 'att_notify_1',
    dedupe_key: 'codex:cin_x:interaction:manual_action:conversations',
    connection_id: 'codex',
    run_id: 'run_n1',
    reason_code: 'manual_action_required',
    progress_posture: 'blocked',
    owner_action: 'operate_attachment',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    auto_detect: false,
    now: '2026-05-19T12:00:00.000Z',
    action_target: 'remote_surface',
  });
  await store.upsertAttention({ record, connectorId: 'codex', connectorInstanceId: 'cin_x' });

  const sent = await store.recordNotificationOutcomeById({
    attentionId: 'att_notify_1',
    outcome: 'sent',
    reason: null,
    now: '2026-05-19T12:01:00.000Z',
  });
  assert.ok(sent);
  assert.equal(sent.notification_state, 'sent');
  assert.equal(sent.lifecycle, 'open');
  assert.equal(sent.notification_updated_at, '2026-05-19T12:01:00.000Z');

  const failed = await store.recordNotificationOutcomeById({
    attentionId: 'att_notify_1',
    outcome: 'failed',
    reason: 'transport: 410 gone',
    now: '2026-05-19T12:02:00.000Z',
  });
  assert.equal(failed.notification_state, 'failed');
  assert.equal(failed.notification_reason, 'transport: 410 gone');
  // The attention SHALL remain visible after delivery failure.
  const stillOpen = await store.listOpenAttentionForConnection({
    connectorId: 'codex',
    connectorInstanceId: 'cin_x',
  });
  assert.equal(stillOpen.length, 1, 'failed delivery does not retire the attention row');
  assert.equal(stillOpen[0].notification_state, 'failed');
}));

test('attention store recordNotificationOutcomeById rejects invalid outcomes', withTempDb(async () => {
  const store = createSqliteConnectorAttentionStore();
  const record = createAttention({
    id: 'att_notify_invalid',
    dedupe_key: 'codex:cin_x:interaction:manual_action:conversations',
    connection_id: 'codex',
    reason_code: 'manual_action_required',
    progress_posture: 'blocked',
    owner_action: 'operate_attachment',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    now: '2026-05-19T12:00:00.000Z',
  });
  await store.upsertAttention({ record, connectorId: 'codex', connectorInstanceId: 'cin_x' });
  await assert.rejects(() =>
    store.recordNotificationOutcomeById({
      attentionId: 'att_notify_invalid',
      outcome: 'maybe',
      reason: null,
      now: '2026-05-19T12:01:00.000Z',
    }),
  );
}));

test('attention store recordNotificationOutcomeById returns null for unknown id', withTempDb(async () => {
  const store = createSqliteConnectorAttentionStore();
  const result = await store.recordNotificationOutcomeById({
    attentionId: 'att_missing',
    outcome: 'sent',
    reason: null,
    now: '2026-05-19T12:00:00.000Z',
  });
  assert.equal(result, null);
}));

test('attention store upsert preserves redaction of secret-y metadata applied by runtime', withTempDb(async () => {
  // The runtime's `createAttention` already redacts secret-keyed metadata
  // before constructing the record. The store must round-trip whatever
  // the runtime decided — never reintroducing the original values, even
  // if the caller hands the store a record they mutated post-creation.
  const store = createSqliteConnectorAttentionStore();
  const record = createAttention({
    id: 'att_secret_meta',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'secret',
    now: '2026-05-19T11:50:00.000Z',
    metadata: { otp: '123456', note: 'fine to show' },
  });
  assert.equal(record.metadata.otp, '[redacted]');

  await store.upsertAttention({
    record,
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });
  const [open] = await store.listOpenAttentionForConnection({
    connectorId: 'codex',
    connectorInstanceId: 'cin_codex_a',
  });
  assert.equal(open.metadata.otp, '[redacted]');
  assert.equal(open.metadata.note, 'fine to show');
}));

// ─── Projection wiring: attention → connection health ──────────────────────

test('connection health surfaces structured attention as needs_attention with structured CTA', () => {
  const record = createAttention({
    id: 'att_otp',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    action_target: 'dashboard',
    now: '2026-05-19T11:50:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [record],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.state, 'needs_attention');
  assert.equal(snapshot.next_action?.source, 'structured');
  assert.equal(snapshot.next_action?.attention_id, 'att_otp');
});

test('structured attention beats schedule.human_attention_needed fallback', () => {
  const record = createAttention({
    id: 'att_struct',
    dedupe_key: 'codex:verify',
    connection_id: 'codex',
    reason_code: 'manual_verification',
    progress_posture: 'blocked',
    owner_action: 'operate_attachment',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    action_target: 'remote_surface',
    now: '2026-05-19T11:50:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [record],
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

test('secret-sensitive structured attention suppresses action_target', () => {
  const record = createAttention({
    id: 'att_secret',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'secret',
    action_target: 'dashboard:/secrets/codex',
    now: '2026-05-19T11:50:00.000Z',
  });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [record],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.next_action?.action_target, null);
  assert.equal(snapshot.next_action?.attention_id, 'att_secret');
});

test('resolved structured attention does not drive needs_attention', () => {
  const open = createAttention({
    id: 'att_resolved',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    now: '2026-05-19T11:50:00.000Z',
  });
  const resolved = transition(open, { to: 'resolved', now: '2026-05-19T11:55:00.000Z' });
  const snapshot = projectConnectorSummaryConnectionHealth({
    // Caller is expected to filter terminal records via store-side WHERE,
    // but the projection is also expected to be honest if a terminal
    // record leaks in.
    attentionRecords: [resolved],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.state, 'healthy');
  assert.equal(snapshot.next_action, null);
});

test('superseded structured attention does not drive needs_attention', () => {
  const open = createAttention({
    id: 'att_superseded',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    now: '2026-05-19T11:50:00.000Z',
  });
  const superseded = transition(open, { to: 'superseded', now: '2026-05-19T11:55:00.000Z' });
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [superseded],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
  });
  assert.equal(snapshot.state, 'healthy');
});

// ─── Attention-store read failure → unknown, not false healthy ─────────────

test('attention-store read failure flips snapshot to unknown via attention_store unreliable source', () => {
  // The projection takes an `unreliableSources` array. The list/detail
  // wiring must propagate `attention_store` into that array when the
  // store read throws, so the headline becomes `unknown` rather than
  // silently rendering a clean run as healthy.
  const snapshot = projectConnectorSummaryConnectionHealth({
    attentionRecords: [],
    freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    nowIso: '2026-05-19T12:00:00.000Z',
    schedule: null,
    unreliableSources: ['attention_store'],
  });
  assert.equal(snapshot.state, 'unknown');
  assert.deepEqual(snapshot.unknown_reasons, ['attention_store']);
});

// ─── End-to-end: store + helper + projection ───────────────────────────────

test(
  'getConnectorAttentionProjection reads durable rows for use in connector summary',
  withTempDb(async () => {
    const store = getDefaultConnectorAttentionStore();
    const instanceId = 'cin_codex_a';
    await store.upsertAttention({
      record: createAttention({
        id: 'att_live',
        dedupe_key: 'codex:otp',
        connection_id: 'codex',
        reason_code: 'otp_required',
        progress_posture: 'blocked',
        owner_action: 'provide_value',
        response_contract: 'response_required',
        sensitivity: 'non_secret',
        action_target: 'dashboard',
        now: '2026-05-19T11:50:00.000Z',
      }),
      connectorId: 'codex',
      connectorInstanceId: instanceId,
    });

    const projection = await getConnectorAttentionProjection('codex', {
      connectorInstanceId: instanceId,
    });
    assert.equal(projection.unreliable, false);
    assert.equal(projection.records.length, 1);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
      lastRun: failedRun(),
      lastSuccessfulRun: null,
      nowIso: '2026-05-19T12:00:00.000Z',
      schedule: null,
    });
    assert.equal(snapshot.state, 'needs_attention');
    assert.equal(snapshot.next_action?.source, 'structured');
    assert.equal(snapshot.next_action?.attention_id, 'att_live');
  }),
);

test(
  'getConnectorAttentionProjection isolates connector instances',
  withTempDb(async () => {
    const store = getDefaultConnectorAttentionStore();
    await store.upsertAttention({
      record: createAttention({
        id: 'att_a_only',
        dedupe_key: 'codex:a:otp',
        connection_id: 'codex',
        reason_code: 'otp_required',
        progress_posture: 'blocked',
        owner_action: 'provide_value',
        response_contract: 'response_required',
        sensitivity: 'non_secret',
        now: '2026-05-19T11:50:00.000Z',
      }),
      connectorId: 'codex',
      connectorInstanceId: 'cin_codex_a',
    });

    const a = await getConnectorAttentionProjection('codex', { connectorInstanceId: 'cin_codex_a' });
    const b = await getConnectorAttentionProjection('codex', { connectorInstanceId: 'cin_codex_b' });

    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 0);
  }),
);

test(
  'getConnectorAttentionProjection surfaces unreliable when store throws',
  withTempDb(async () => {
    // We exercise the catch path by closing the DB underneath the store
    // before the projection runs. The helper must NOT throw; it must
    // return `unreliable: true` so the projection becomes `unknown`
    // rather than silently false-green.
    closeDb();
    resetDefaultConnectorAttentionStoreCache();
    const projection = await getConnectorAttentionProjection('codex');
    assert.equal(projection.unreliable, true);
    assert.equal(projection.records.length, 0);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { status: 'current', captured_at: '2026-05-19T12:00:00.000Z' },
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: '2026-05-19T12:00:00.000Z',
      schedule: null,
      unreliableSources: projection.unreliable ? ['attention_store'] : [],
    });
    assert.equal(snapshot.state, 'unknown');
    assert.deepEqual(snapshot.unknown_reasons, ['attention_store']);
    // initDb expected by withTempDb's finally — reopen so closeDb cleans up cleanly.
    // The withTempDb helper relies on closeDb being safe to call after an
    // already-closed handle; better-sqlite3 tolerates double-close.
  }),
);
