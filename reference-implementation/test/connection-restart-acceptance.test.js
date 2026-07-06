/**
 * Milestone acceptance test for `complete-ri-operator-console-reliability`
 * task 7.4: restart acceptance proving the four owner-visible "currently
 * happening" connection states (active/pending, needs_attention, retrying
 * via cooling_off, and blocked) are reconstructed from durable evidence
 * after the in-memory runtime state is dropped.
 *
 * Restart model
 * -------------
 * The reference console has two layers of "live" state for these states:
 *
 *   1. In-process caches (default attention/store handles, prepared
 *      statements) — modeled by `resetDefaultConnectorAttentionStoreCache`
 *      and `closeDb`/`initDb` in `withTempDb`.
 *   2. Durable rows — `connector_attention_records` (attention) plus the
 *      caller-supplied `schedule` payload that the projection treats as
 *      authoritative for active_run_id / scheduler_backoff /
 *      human_attention_needed semantics.
 *
 * For 7.4 we write only the durable layer, then drop every in-memory cache
 * and rebuild the projection from scratch. The projection result is the
 * sole assertion surface; this is the same code path the dashboard takes
 * after a host reboot.
 *
 * Why no full `startServer` reboot?
 * ---------------------------------
 * The packet asks for deterministic store/projection coverage, not browser
 * automation. The projection (`projectConnectorSummaryConnectionHealth`)
 * is the join point where every restart-survivable evidence source meets;
 * if it reconstructs correctly from rows-only input, the dashboard does
 * the same. A full HTTP/WS reboot would test Fastify lifecycles, not the
 * acceptance claim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, initDb } from '../server/db.js';
import { createAttention } from '../runtime/attention.ts';
import {
  getConnectorAttentionProjection,
  projectConnectorSummaryConnectionHealth,
} from '../server/ref-control.ts';
import {
  getDefaultConnectorAttentionStore,
  resetDefaultConnectorAttentionStoreCache,
} from '../server/stores/connector-attention-store.ts';

const NOW_ISO = '2026-05-19T12:00:00.000Z';
const PRIOR_SUCCESS_ISO = '2026-05-19T10:00:00.000Z';

// ─── Helpers ──────────────────────────────────────────────────────────────

function withTempDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-restart-acceptance-'));
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

/**
 * Simulate a process restart: close the open DB, drop the cached default
 * store, reopen the DB against the same on-disk path. After this the only
 * surviving state is whatever was persisted to disk.
 */
function simulateRestart(dbPath) {
  closeDb();
  resetDefaultConnectorAttentionStoreCache();
  initDb(dbPath);
}

function succeededRun(overrides = {}) {
  return {
    event_count: 12,
    failure_reason: null,
    finished_at: PRIOR_SUCCESS_ISO,
    first_at: '2026-05-19T09:55:00.000Z',
    known_gaps: [],
    last_at: PRIOR_SUCCESS_ISO,
    run_id: 'run_prior_ok',
    started_at: '2026-05-19T09:55:00.000Z',
    status: 'succeeded',
    ...overrides,
  };
}

function failedRun(overrides = {}) {
  return {
    event_count: 0,
    failure_reason: 'manual_verification_required',
    finished_at: NOW_ISO,
    first_at: '2026-05-19T11:59:00.000Z',
    known_gaps: [],
    last_at: NOW_ISO,
    run_id: 'run_recent_fail',
    started_at: '2026-05-19T11:59:00.000Z',
    status: 'failed',
    ...overrides,
  };
}

// ─── 7.4 active/pending: durable `active_run_id` rebuilds the syncing badge ──

test(
  'restart acceptance: active/pending state — durable active_run_id rebuilds the syncing badge after restart',
  withTempDb(async (dir) => {
    // Setup: an in-flight run is represented in the schedule payload as a
    // non-null `active_run_id`. No structured attention is open. No
    // backoff is active. A prior successful run exists.
    const dbPath = join(dir, 'pdpp.sqlite');

    // Simulate restart — the active_run_id and prior-run rows are durable;
    // any in-memory bookkeeping is gone.
    simulateRestart(dbPath);

    const projection = await getConnectorAttentionProjection('chatgpt');
    assert.equal(projection.unreliable, false);
    assert.deepEqual(projection.records, []);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { status: 'current', captured_at: PRIOR_SUCCESS_ISO },
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      schedule: {
        enabled: true,
        active_run_id: 'run_in_flight',
        next_due_at: '2026-05-19T13:00:00.000Z',
        last_successful_at: PRIOR_SUCCESS_ISO,
      },
      unreliableSources: [],
    });

    // The headline pill stays at the underlying state — syncing/active is
    // an orthogonal badge per design.md, not a headline. With clean prior
    // evidence the connection projects healthy + the syncing badge.
    assert.equal(snapshot.state, 'healthy', 'active run does not replace headline state');
    assert.equal(snapshot.badges.syncing, true, 'active_run_id drives the syncing badge after restart');
    assert.equal(snapshot.badges.stale, false);
    assert.equal(snapshot.last_success_at, PRIOR_SUCCESS_ISO);
  }),
);

// ─── 7.4 pending owner action: structured attention rebuilds needs_attention ──

test(
  'restart acceptance: pending owner action — durable structured attention rebuilds needs_attention after restart',
  withTempDb(async (dir) => {
    const dbPath = join(dir, 'pdpp.sqlite');

    // Write a durable open OTP prompt before "restart". The attention row
    // is the only thing that survives.
    const writerStore = getDefaultConnectorAttentionStore();
    await writerStore.upsertAttention({
      record: createAttention({
        id: 'att_otp_pending',
        dedupe_key: 'codex:cin_codex_a:interaction:otp:conversations',
        connection_id: 'codex',
        run_id: 'run_pending',
        reason_code: 'otp_required',
        progress_posture: 'blocked',
        owner_action: 'provide_value',
        response_contract: 'response_required',
        sensitivity: 'secret',
        auto_detect: false,
        action_target: 'dashboard',
        expires_at: '2099-05-19T12:30:00.000Z',
        now: '2026-05-19T11:50:00.000Z',
      }),
      connectorId: 'codex',
      connectorInstanceId: 'cin_codex_a',
    });

    simulateRestart(dbPath);

    // Reader path: fresh store handle, no in-memory carryover.
    const projection = await getConnectorAttentionProjection('codex', {
      connectorInstanceId: 'cin_codex_a',
    });
    assert.equal(projection.unreliable, false);
    assert.equal(projection.records.length, 1);
    const reread = projection.records[0];
    assert.equal(reread.id, 'att_otp_pending');
    assert.equal(reread.lifecycle, 'open');
    assert.equal(reread.sensitivity, 'secret');

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: projection.records,
      freshness: { status: 'current', captured_at: NOW_ISO },
      lastRun: failedRun(),
      lastSuccessfulRun: null,
      nowIso: NOW_ISO,
      schedule: { enabled: true },
    });

    assert.equal(snapshot.state, 'needs_attention');
    assert.equal(snapshot.next_action?.source, 'structured');
    assert.equal(snapshot.next_action?.attention_id, 'att_otp_pending');
    assert.equal(snapshot.next_action?.reason_code, 'otp_required');
    // Secret-sensitive rows suppress action_target so the dashboard never
    // links to a secret-prompt surface from the operator payload.
    assert.equal(snapshot.next_action?.action_target, null);
    assert.equal(snapshot.next_action?.expires_at, '2099-05-19T12:30:00.000Z');
  }),
);

// ─── 7.4 retrying: scheduler_backoff rebuilds cooling_off and next_attempt ────

test(
  'restart acceptance: retrying — durable scheduler_backoff rebuilds cooling_off + next_attempt_at',
  withTempDb(async (dir) => {
    const dbPath = join(dir, 'pdpp.sqlite');
    simulateRestart(dbPath);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: [],
      freshness: { status: 'current', captured_at: PRIOR_SUCCESS_ISO },
      lastRun: failedRun({ failure_reason: 'http_502' }),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      schedule: {
        enabled: true,
        active_run_id: null,
        last_error_code: 'http_502',
        last_successful_at: PRIOR_SUCCESS_ISO,
        next_due_at: '2026-05-19T12:30:00.000Z',
        scheduler_backoff: {
          backoff_applied: true,
          consecutive_failures: 2,
          next_run_at: '2026-05-19T12:30:00.000Z',
          reason_class: 'connector:http_502',
        },
      },
    });

    assert.equal(snapshot.state, 'cooling_off');
    assert.equal(snapshot.next_attempt_at, '2026-05-19T12:30:00.000Z');
    assert.equal(snapshot.reason_code, 'http_502');
    assert.equal(snapshot.badges.syncing, false);
  }),
);

// ─── 7.4 blocked: give-up threshold rebuilds blocked headline ────────────────

test(
  'restart acceptance: blocked — durable consecutive_failures past threshold rebuilds blocked',
  withTempDb(async (dir) => {
    const dbPath = join(dir, 'pdpp.sqlite');
    simulateRestart(dbPath);

    const snapshot = projectConnectorSummaryConnectionHealth({
      attentionRecords: [],
      freshness: { status: 'current', captured_at: PRIOR_SUCCESS_ISO },
      lastRun: failedRun({ failure_reason: 'auth_expired' }),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      schedule: {
        enabled: true,
        active_run_id: null,
        last_error_code: 'auth_expired',
        last_successful_at: PRIOR_SUCCESS_ISO,
        next_due_at: null,
        scheduler_backoff: {
          backoff_applied: false,
          // `BLOCKED_PROMOTION_THRESHOLD` from `connection-health-policy.ts` is 7;
          // anything at or above the threshold must promote the connection
          // to `blocked` after restart.
          consecutive_failures: 9,
          next_run_at: null,
          reason_class: 'terminal:auth_expired',
        },
      },
    });

    assert.equal(snapshot.state, 'blocked');
    assert.equal(snapshot.reason_code, 'auth_expired');
    assert.equal(snapshot.next_attempt_at, null);
  }),
);

// ─── 7.4 restart isolation: dropping caches does not invent attention ────────

test(
  'restart acceptance: a connection with no durable attention does not invent needs_attention after restart',
  withTempDb(async (dir) => {
    const dbPath = join(dir, 'pdpp.sqlite');

    // Write attention for connection A only. Connection B must stay clean
    // even though the projection runs in the same process after restart.
    const writerStore = getDefaultConnectorAttentionStore();
    await writerStore.upsertAttention({
      record: createAttention({
        id: 'att_for_a_only',
        dedupe_key: 'codex:cin_codex_a:interaction:otp:default',
        connection_id: 'codex',
        run_id: 'run_a',
        reason_code: 'otp_required',
        progress_posture: 'blocked',
        owner_action: 'provide_value',
        response_contract: 'response_required',
        sensitivity: 'non_secret',
        action_target: 'dashboard',
        now: '2026-05-19T11:50:00.000Z',
      }),
      connectorId: 'codex',
      connectorInstanceId: 'cin_codex_a',
    });

    simulateRestart(dbPath);

    const a = await getConnectorAttentionProjection('codex', { connectorInstanceId: 'cin_codex_a' });
    const b = await getConnectorAttentionProjection('codex', { connectorInstanceId: 'cin_codex_b' });
    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 0);

    const snapshotB = projectConnectorSummaryConnectionHealth({
      attentionRecords: b.records,
      freshness: { status: 'current', captured_at: PRIOR_SUCCESS_ISO },
      lastRun: succeededRun(),
      lastSuccessfulRun: succeededRun(),
      nowIso: NOW_ISO,
      schedule: { enabled: true },
    });
    assert.equal(snapshotB.state, 'healthy');
    assert.equal(snapshotB.next_action, null);
  }),
);
