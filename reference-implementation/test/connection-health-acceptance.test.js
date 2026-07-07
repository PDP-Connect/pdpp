/**
 * Acceptance suite for the RI operator console connection-health surface.
 *
 * Covers `complete-ri-operator-console-reliability` tasks:
 *
 *   - 7.1: every canonical headline state (healthy, degraded, needs_attention,
 *     cooling_off, blocked, idle, unknown) projects from durable evidence
 *     through the same `projectConnectorSummaryConnectionHealth` function the
 *     dashboard list and `ref.connectors.detail` operations consume.
 *
 *   - 7.2: syncing/activity, stale freshness, coverage gaps, and outbox
 *     backlog all surface as axes or badges. None of them is allowed to
 *     become a headline pill.
 *
 *   - 7.3 (evidence-backed portion): success-with-gaps — whether the gaps
 *     are known_gaps emitted by the run or pending detail-gap rows owned by
 *     the runtime — must not project as `healthy`. The
 *     `unsupported`/`deferred`/`unavailable`/`inventory_only` distinctions
 *     require manifest-declared required-stream policy plus accepted-
 *     coverage tracking that has not landed yet (see task 3.3 residual
 *     note); they are intentionally not asserted here.
 *
 * These tests stay pure and deterministic: they pass synthetic evidence
 * directly into the projection, never read clocks, and never hit a store.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAttention } from '../runtime/attention.ts';
import { BLOCKED_PROMOTION_THRESHOLD } from '../runtime/connection-health-policy.ts';
import { projectConnectorSummaryConnectionHealth } from '../server/ref-control.ts';

const NOW = '2026-05-19T12:00:00.000Z';
const RUN_AT = '2026-05-19T11:59:00.000Z';
const FRESH = { status: 'current', captured_at: NOW };
const STALE_FRESHNESS = { status: 'stale', captured_at: NOW };
const UNKNOWN_FRESHNESS = { status: 'unknown', captured_at: NOW };

const HEADLINE_STATES = Object.freeze([
  'blocked',
  'cooling_off',
  'degraded',
  'healthy',
  'idle',
  'needs_attention',
  'unknown',
]);

function succeededRun(overrides = {}) {
  return {
    event_count: 3,
    failure_reason: null,
    finished_at: NOW,
    first_at: RUN_AT,
    known_gaps: [],
    last_at: NOW,
    run_id: 'run_success',
    started_at: RUN_AT,
    status: 'succeeded',
    ...overrides,
  };
}

function failedRun(overrides = {}) {
  return {
    event_count: 0,
    failure_reason: 'transient_500',
    finished_at: NOW,
    first_at: RUN_AT,
    known_gaps: [],
    last_at: NOW,
    run_id: 'run_failed',
    started_at: RUN_AT,
    status: 'failed',
    ...overrides,
  };
}

function backoffSchedule({ failures = 3, reasonClass = 'failure:rate_limited', backoffApplied = true } = {}) {
  return {
    enabled: true,
    scheduler_backoff: {
      backoff_applied: backoffApplied,
      consecutive_failures: failures,
      next_run_at: '2026-05-19T13:00:00.000Z',
      reason_class: reasonClass,
      recommended_health_state: failures >= BLOCKED_PROMOTION_THRESHOLD ? 'blocked' : 'cooling_off',
    },
  };
}

function openOtpAttention() {
  return createAttention({
    id: 'att_otp',
    dedupe_key: 'codex:otp',
    connection_id: 'codex',
    run_id: 'run_failed',
    reason_code: 'otp_required',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'non_secret',
    action_target: 'dashboard',
    now: '2026-05-19T11:50:00.000Z',
  });
}

function assertAxesPresent(snap) {
  assert.ok(snap.axes, 'axes must be populated');
  for (const key of ['attention', 'coverage', 'freshness', 'outbox']) {
    assert.ok(typeof snap.axes[key] === 'string', `axis ${key} must be a string`);
  }
  assert.ok(snap.badges, 'badges must be populated');
  assert.equal(typeof snap.badges.stale, 'boolean');
  assert.equal(typeof snap.badges.syncing, 'boolean');
}

function assertHeadline(snap, expected) {
  assert.ok(HEADLINE_STATES.includes(snap.state), `state ${snap.state} not in canonical headline set`);
  assert.equal(snap.state, expected);
  assertAxesPresent(snap);
}

// ─── 7.1 Acceptance: every canonical headline state ───────────────────────

test('acceptance 7.1: never-run connection projects idle', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: UNKNOWN_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    schedule: null,
  });
  assertHeadline(snap, 'idle');
  assert.equal(snap.last_success_at, null);
});

test('acceptance 7.1: never-run does not hide a failed managed runtime surface', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: UNKNOWN_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    remoteSurface: {
      axis: 'failed',
      leaseId: null,
      leaseStatus: null,
      profileKey: 'chatgpt:cin_active',
      surfaceHealth: 'unhealthy',
      surfaceId: 'surface_unhealthy',
      waitReason: 'surface_unhealthy',
    },
    schedule: null,
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.remote_surface, 'failed');
  assert.equal(snap.reason_code, 'remote_surface:surface_unhealthy');
});

test('acceptance 7.1: never-run does not hide durable coverage gaps', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: null,
    lastSuccessfulRun: null,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: null,
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'retryable_gap');
  assert.equal(snap.reason_code, 'rate_limited');
});

test('acceptance 7.1: fresh local-device evidence without a terminal collection verdict projects unknown, not idle', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: null,
    lastSuccessfulRun: null,
    outbox: { axis: 'idle' },
    schedule: null,
  });
  assertHeadline(snap, 'unknown');
  assert.deepEqual([...snap.unknown_reasons], ['collection']);
  assert.equal(snap.axes.freshness, 'fresh');
  assert.equal(snap.axes.outbox, 'idle');
});

test('acceptance 7.1: owner-paused schedule projects idle even with failed last run', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    schedule: { enabled: false },
  });
  assertHeadline(snap, 'idle');
  assert.equal(snap.next_attempt_at, null, 'paused schedules emit no next_attempt');
});

// Reddit-shaped raw manifest refresh policy: manual + background-unsafe.
const REDDIT_REFRESH_POLICY = {
  recommended_mode: 'manual',
  maximum_staleness_seconds: 86400,
  background_safe: false,
};
const SCHEDULABLE_REFRESH_POLICY = {
  recommended_mode: 'automatic',
  maximum_staleness_seconds: 86400,
  background_safe: true,
};
const PAUSED_REFRESH_POLICY = {
  recommended_mode: 'paused',
  maximum_staleness_seconds: 86400,
  background_safe: true,
};

test('acceptance 7.1: manual/background-unsafe connector that is complete+succeeded+stale projects idle advisory, not degraded', () => {
  // Reddit-like: the raw manifest refresh_policy declares manual +
  // background_safe:false, so stale data is an owner-action advisory the
  // caller wiring (buildRefreshEvidence) recognizes end-to-end.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    refreshPolicy: REDDIT_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
});

test('acceptance 7.1: schedulable connector with the SAME stale evidence still degrades', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    refreshPolicy: SCHEDULABLE_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.freshness, 'stale');
});

test('acceptance 7.1: paused connector that is complete+succeeded+stale projects idle advisory, not degraded', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    refreshPolicy: PAUSED_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
});

test('acceptance 7.1: a manual connector with no refresh policy still degrades on stale (default = schedulable)', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
});

test('acceptance 7.1: a manual connector with incomplete coverage still degrades even when stale', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'posts' }],
    refreshPolicy: REDDIT_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
});

test('acceptance 7.1: a manual connector whose last run failed still degrades even when stale', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    refreshPolicy: REDDIT_REFRESH_POLICY,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
});

test('acceptance 7.1: succeeded run + complete coverage + fresh + no attention projects healthy', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'healthy');
  assert.equal(snap.reason_code, null);
  assert.equal(snap.next_action, null);
});

test('acceptance 7.1: newer successful run clears stale scheduler backoff evidence', () => {
  const run = succeededRun({
    finished_at: '2026-05-24T23:20:25.909Z',
    last_at: '2026-05-24T23:20:25.909Z',
    run_id: 'run_success_after_backoff',
    started_at: '2026-05-24T23:20:02.398Z',
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: '2026-05-24T23:20:25.909Z' },
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: {
      enabled: true,
      last_error_code: 'schedule.gave_up',
      last_finished_at: '2026-05-21T02:04:39.188Z',
      last_started_at: '2026-05-21T02:03:39.190Z',
      next_due_at: '2026-05-21T18:04:39.188Z',
      scheduler_backoff: {
        backoff_applied: true,
        consecutive_failures: BLOCKED_PROMOTION_THRESHOLD,
        next_run_at: '2026-05-21T18:04:39.188Z',
        reason_class: 'terminal:connector_reported_failed',
        recommended_health_state: 'blocked',
      },
    },
  });
  assertHeadline(snap, 'healthy');
  assert.equal(snap.reason_code, null);
  assert.equal(snap.next_attempt_at, null);
});

test('acceptance 7.1: structured open attention drives needs_attention with structured CTA', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    attentionRecords: [openOtpAttention()],
    freshness: FRESH,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: NOW,
    schedule: null,
  });
  assertHeadline(snap, 'needs_attention');
  assert.equal(snap.reason_code, 'otp_required');
  assert.equal(snap.next_action?.source, 'structured');
  assert.equal(snap.next_action?.attention_id, 'att_otp');
  assert.equal(snap.next_action?.action_target, 'dashboard');
  assert.equal(snap.axes.attention, 'open');
});

test('acceptance 7.1: cooling_off when scheduler backoff is delaying a retry below the give-up threshold', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun({ failure_reason: 'rate_limited' }),
    lastSuccessfulRun: null,
    nowIso: NOW,
    schedule: backoffSchedule({ failures: 3, reasonClass: 'failure:rate_limited' }),
  });
  assertHeadline(snap, 'cooling_off');
  assert.equal(snap.reason_code, 'rate_limited');
  assert.equal(snap.next_attempt_at, '2026-05-19T13:00:00.000Z');
});

test('acceptance 7.1: blocked when the scheduler give-up streak crosses the promotion threshold', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: failedRun({ failure_reason: 'auth_expired' }),
    lastSuccessfulRun: null,
    schedule: backoffSchedule({
      failures: BLOCKED_PROMOTION_THRESHOLD,
      reasonClass: 'connector:auth_expired',
    }),
  });
  assertHeadline(snap, 'blocked');
  assert.equal(snap.reason_code, 'auth_expired');
});

test('acceptance 7.1: failed last run with no backoff/attention/coverage evidence projects degraded', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: failedRun({ failure_reason: 'transient_400' }),
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.reason_code, 'transient_400');
});

test('acceptance 7.1: unreliable evidence sources project unknown and name the source', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
    unreliableSources: ['detail_gaps'],
  });
  assertHeadline(snap, 'unknown');
  assert.deepEqual([...snap.unknown_reasons], ['detail_gaps']);
});

test('acceptance 7.1: succeeded run with unknown coverage and unknown freshness falls through to unknown', () => {
  // The fallback (rule 8) prevents a silent false green when the projection
  // cannot prove coverage or freshness.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: UNKNOWN_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'unknown');
});

test('acceptance 7.1: every canonical headline state is reachable through projectConnectorSummaryConnectionHealth', () => {
  // Exhaustiveness guard: if a new state is ever added to the union, this
  // test must be updated to demonstrate a projection path that reaches it.
  // Conversely, if a current state ever becomes unreachable through the
  // dashboard/CLI projection, this test will catch the regression.
  const observed = new Set();
  const cases = [
    {
      state: 'idle',
      input: {
        freshness: UNKNOWN_FRESHNESS,
        lastRun: null,
        lastSuccessfulRun: null,
        schedule: null,
      },
    },
    {
      state: 'needs_attention',
      input: {
        attentionRecords: [openOtpAttention()],
        freshness: FRESH,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        nowIso: NOW,
        schedule: null,
      },
    },
    {
      state: 'cooling_off',
      input: {
        freshness: STALE_FRESHNESS,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        nowIso: NOW,
        schedule: backoffSchedule({ failures: 2 }),
      },
    },
    {
      state: 'blocked',
      input: {
        freshness: STALE_FRESHNESS,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        nowIso: NOW,
        schedule: backoffSchedule({ failures: BLOCKED_PROMOTION_THRESHOLD }),
      },
    },
    {
      state: 'degraded',
      input: {
        freshness: FRESH,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
        schedule: { enabled: true },
      },
    },
    {
      state: 'healthy',
      input: {
        freshness: FRESH,
        lastRun: succeededRun(),
        lastSuccessfulRun: succeededRun(),
        schedule: { enabled: true },
      },
    },
    {
      state: 'unknown',
      input: {
        freshness: FRESH,
        lastRun: succeededRun(),
        lastSuccessfulRun: succeededRun(),
        schedule: { enabled: true },
        unreliableSources: ['coverage_read_model'],
      },
    },
  ];
  for (const { state, input } of cases) {
    const snap = projectConnectorSummaryConnectionHealth(input);
    assertHeadline(snap, state);
    observed.add(snap.state);
  }
  assert.deepEqual([...observed].sort(), [...HEADLINE_STATES].sort());
});

// ─── 7.2 Acceptance: non-headline signals stay as axes/badges ─────────────

test('acceptance 7.2: active scheduled run surfaces a syncing badge without replacing the healthy headline', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'idle' },
    schedule: { enabled: true, active_run_id: 'run_inflight' },
  });
  // Syncing is a badge: the headline must still be the underlying state.
  assertHeadline(snap, 'healthy');
  assert.equal(snap.badges.syncing, true, 'active_run_id should light up the syncing badge');
  assert.notEqual(snap.state, 'syncing', 'syncing is never a headline state');
});

test('acceptance 7.2: durable active-run row surfaces syncing when schedule metadata is absent', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    activeRun: {
      connector_id: 'chase',
      connector_instance_id: 'cin_chase',
      run_generation: 1,
      run_id: 'run_inflight',
      scenario_id: 'default',
    },
    freshness: UNKNOWN_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    outbox: { axis: 'idle' },
    schedule: null,
  });
  assertHeadline(snap, 'idle');
  assert.equal(snap.badges.syncing, true, 'controller_active_runs should light up the syncing badge');
});

test('acceptance 7.2: active scheduled run does not promote a degraded headline back to healthy', () => {
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: failedRun({ failure_reason: 'transient_500' }),
    lastSuccessfulRun: null,
    schedule: { enabled: true, active_run_id: 'run_inflight' },
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.badges.syncing, true, 'syncing badge sits orthogonal to degraded headline');
});

test('acceptance 7.2: stale freshness surfaces as axis+badge, not a stale headline pill', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  // Stale-but-otherwise-clean degrades while the badge and axis carry the
  // precise freshness signal — the dashboard never invents a "stale" pill.
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  assert.notEqual(snap.state, 'stale');
});

test('acceptance 7.2: known-gap coverage surfaces as terminal_gap axis, headline pill is degraded', () => {
  const run = succeededRun({
    known_gaps: [{ reason: 'auth_expired', severity: 'actionable', stream: 'messages' }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'terminal_gap');
  assert.notEqual(snap.state, 'gaps', 'gaps is never a headline state');
});

test('acceptance 7.2: pending durable detail gaps surface as retryable_gap axis, not a backlog pill', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'retryable_gap');
  assert.equal(snap.reason_code, 'rate_limited');
});

test('acceptance 7.2: stalled outbox surfaces as outbox axis, headline pill is degraded', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'stalled' },
    schedule: { enabled: true },
  });
  // Outbox backlog draining failure must surface as an axis, not as a new
  // "stalled" headline pill — the dashboard's small canonical pill set
  // stays small.
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.outbox, 'stalled');
});

test('acceptance 7.2: active outbox lets healthy stand while the axis carries the signal', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    outbox: { axis: 'active' },
    schedule: { enabled: true },
  });
  // `active` outbox is normal draining work, not a stall — must not
  // degrade the headline.
  assertHeadline(snap, 'healthy');
  assert.equal(snap.axes.outbox, 'active');
});

test('acceptance 7.2: every axis remains populated even when the headline is needs_attention', () => {
  // Axes must not be collapsed into the headline pill: the dashboard
  // wants to render coverage / freshness / outbox / attention precision
  // alongside the headline. This pins that contract.
  const snap = projectConnectorSummaryConnectionHealth({
    attentionRecords: [openOtpAttention()],
    freshness: STALE_FRESHNESS,
    lastRun: failedRun(),
    lastSuccessfulRun: null,
    nowIso: NOW,
    outbox: { axis: 'stalled' },
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: { enabled: true, active_run_id: 'run_inflight' },
  });
  assertHeadline(snap, 'needs_attention');
  assert.equal(snap.axes.attention, 'open');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.axes.outbox, 'stalled');
  assert.ok(
    snap.axes.coverage === 'retryable_gap' || snap.axes.coverage === 'terminal_gap',
    `coverage axis should expose gap evidence, got ${snap.axes.coverage}`,
  );
  assert.equal(snap.badges.syncing, true);
  assert.equal(snap.badges.stale, true);
});

// ─── 7.3 Acceptance: success-with-gaps must not project healthy ───────────

test('acceptance 7.3: succeeded run with actionable known_gap is degraded, never healthy', () => {
  const run = succeededRun({
    known_gaps: [{ reason: 'auth_expired', severity: 'actionable', stream: 'messages' }],
    failure_reason: 'auth_expired',
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'terminal_gap');
});

test('acceptance 7.3: succeeded run with unclassified known_gap conservatively projects terminal_gap', () => {
  // No severity attached — the runtime cannot prove a retry path exists,
  // so the conservative rollup is `terminal_gap`. Health degrades.
  const run = succeededRun({
    known_gaps: [{ reason: 'http_429', stream: 'messages' }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'terminal_gap');
  assert.equal(snap.reason_code, 'http_429');
});

test('acceptance 7.3: succeeded run with transient known_gap projects retryable_gap and is not healthy', () => {
  const run = succeededRun({
    known_gaps: [{ reason: 'http_429', severity: 'transient', stream: 'messages' }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'retryable_gap');
});

test('acceptance 7.3: manual-action known_gap projects retryable_gap, not terminal code-fix coverage', () => {
  const run = failedRun({
    failure_reason: 'connector_reported_failed',
    known_gaps: [
      {
        kind: 'interaction_required',
        reason: 'interaction_timeout',
        severity: 'actionable',
        stream: null,
        message: 'The owner prompt timed out before a code was provided.',
        recovery_hint: { action: 'manual_action_required', retryable: false },
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: null,
  });

  assertHeadline(snap, 'degraded');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'retryable_gap');
  assert.equal(snap.forward_disposition, 'resumable');
});

test('acceptance 7.3: underscore-separated OTP failure text is owner-recoverable even with unknown hint', () => {
  const run = failedRun({
    failure_reason: 'connector_reported_failed',
    known_gaps: [
      {
        kind: 'run_failed',
        reason: 'connector_reported_failed',
        severity: 'actionable',
        stream: null,
        message: 'chase_session_failed: chase_otp_not_provided',
        recovery_hint: { action: 'unknown', retryable: false },
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: null,
  });

  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'retryable_gap');
  assert.equal(snap.forward_disposition, 'resumable');
});

test('acceptance 7.3: live-shaped OTP timeout plus checkpoint retry stays recoverable', () => {
  const run = failedRun({
    failure_reason: 'connector_reported_failed',
    known_gaps: [
      {
        kind: 'interaction_required',
        reason: 'interaction_timeout',
        severity: 'actionable',
        stream: null,
        message: 'Chase sent a 2FA code. Reply with it.',
        recovery_hint: { action: 'manual_action_required', retryable: false },
      },
      {
        kind: 'run_failed',
        reason: 'connector_reported_failed',
        severity: 'actionable',
        stream: null,
        message: 'chase_session_failed: chase_otp_not_provided',
        recovery_hint: { action: 'unknown', retryable: false },
      },
      {
        kind: 'checkpoint_commit',
        reason: 'not_committed',
        severity: 'actionable',
        stream: null,
        message: 'Staged stream state was not committed',
        recovery_hint: { action: 'retry_by_runtime', retryable: true },
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: STALE_FRESHNESS,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: null,
  });

  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'retryable_gap');
  assert.equal(snap.forward_disposition, 'resumable');
});

test('acceptance 7.3: succeeded run with pending durable detail gap is degraded, never healthy', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'retryable_gap');
});

test('acceptance 7.3: succeeded run with both known and pending gaps surfaces the more urgent (terminal) axis', () => {
  // Terminal gaps dominate retryable backlog so the owner sees the
  // owner-action claim rather than a misleading retry-only label.
  const run = succeededRun({
    known_gaps: [{ reason: 'auth_expired', severity: 'actionable', stream: 'inbox' }],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    pendingDetailGaps: [{ reason: 'rate_limited', status: 'pending', stream: 'messages' }],
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'degraded');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'terminal_gap');
});

// ─── 7.3 / 3.3: manifest-declared accepted-coverage and required-stream
// policy must surface in the coverage axis without painting the connection
// healthy when the manifest is contradictory (required + unsupported).

test('acceptance 7.3: required stream marked unsupported in the manifest never projects healthy', () => {
  // A `required: true` + `coverage_policy: "unsupported"` declaration is
  // contradictory: the stream is both load-bearing AND accepted-absent.
  // The projection must refuse healthy and surface the contradiction
  // through the coverage axis so the dashboard can explain why.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'messages', required: true, coverage_policy: 'unsupported' },
    ],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, 'healthy');
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'unsupported');
});

test('acceptance 7.3: required stream marked unavailable in the manifest never projects healthy', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'archive', required: true, coverage_policy: 'unavailable' },
    ],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, 'healthy');
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'unavailable');
});

test('acceptance 7.3: required stream marked deferred in the manifest never projects healthy', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'attachments', required: true, coverage_policy: 'deferred' },
    ],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, 'healthy');
  assertHeadline(snap, 'degraded');
  assert.equal(snap.axes.coverage, 'deferred');
});

test('acceptance 3.3: accepted unsupported coverage on a non-required stream still allows healthy', () => {
  // Inverse of the above: when the manifest declares the absence as
  // accepted AND the stream is NOT required, the connection can still
  // be healthy; the axis just surfaces the most-precise accepted label
  // so the dashboard can render "no `archive` stream by design".
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'conversations', required: true },
      { name: 'archive', required: false, coverage_policy: 'unsupported' },
    ],
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'healthy');
  assert.equal(snap.axes.coverage, 'unsupported');
});

test('acceptance 3.3: accepted-coverage precedence is unsupported > unavailable > deferred > inventory_only', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'inv', required: false, coverage_policy: 'inventory_only' },
      { name: 'def', required: false, coverage_policy: 'deferred' },
      { name: 'avail', required: false, coverage_policy: 'unavailable' },
      { name: 'sup', required: false, coverage_policy: 'unsupported' },
      { name: 'core', required: true },
    ],
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'healthy');
  assert.equal(snap.axes.coverage, 'unsupported');
});

test('acceptance 3.3: inventory_only accepted-coverage labels the axis without degrading health', () => {
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'inventory', required: false, coverage_policy: 'inventory_only' },
    ],
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'healthy');
  assert.equal(snap.axes.coverage, 'inventory_only');
});

test('acceptance 3.3: contradictory required+unsupported beats success path even with otherwise clean evidence', () => {
  // Sanity: no detail gaps, no known_gaps, fresh, succeeded — the only
  // thing keeping this from healthy is the contradictory manifest. The
  // projection must still refuse green.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    manifestStreams: [
      { name: 'messages', required: true, coverage_policy: 'unsupported' },
      { name: 'optional_extras', required: false, coverage_policy: 'inventory_only' },
    ],
    schedule: { enabled: true },
  });
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.axes.coverage, 'unsupported');
});

test('acceptance 7.3: no manifest policy keeps the prior complete behaviour intact', () => {
  // Regression guard: a clean succeeded run with no manifest hints still
  // projects healthy with a `complete` axis. The new manifest-aware
  // rollup must not change behavior for connectors that omit policy.
  const run = succeededRun();
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: run,
    schedule: { enabled: true },
  });
  assertHeadline(snap, 'healthy');
  assert.equal(snap.axes.coverage, 'complete');
});

// ─── §10-C: a flattened auth failure must surface as a credential prompt ──────

test('§10-C: a failed run whose known_gap is an auth 401 (flattened to a generic reason) drives a credential prompt, not a silent failure', () => {
  // The live ChatGPT case: a terminal 401 is reported as the GENERIC
  // `connector_reported_failed`, but the auth signal survives in the gap's
  // `recovery_hint.action` + message. `firstDegradingKnownGapReason` must
  // surface a credential reason so the headline routes to a reconnect path
  // (and the §10-F escalation push) instead of a silent generic failure.
  const run = failedRun({
    failure_reason: 'connector_reported_failed',
    known_gaps: [
      {
        kind: 'run_failed',
        reason: 'connector_reported_failed',
        stream: null,
        severity: 'actionable',
        message: 'apiFetch got 401 on GET /conversation/abc (auth - not retryable)',
        recovery_hint: { action: 'refresh_credentials', retryable: false },
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  // The credential signal is recovered: the connection is NOT silently
  // generic-failed. It surfaces a credentials condition that drives the
  // owner-facing reconnect path (the same `isCredentialReason` gate the
  // dashboard reads for its "Reconnect" CTA).
  assert.notEqual(snap.state, 'healthy');
  const credentialCondition = snap.conditions?.find((c) => c.type === 'CredentialsValid' && c.status === 'false');
  assert.ok(
    credentialCondition,
    `expected a CredentialsValid:false condition (reconnect prompt), got conditions: ${JSON.stringify(snap.conditions?.map((c) => `${c.type}:${c.status}`))}`,
  );
  assert.equal(credentialCondition.remediation?.action, 'refresh_credentials');
});

test('§10-C control: a non-auth generic failure does NOT manufacture a credential prompt', () => {
  // A genuine non-credential failure (e.g. a parser error) must stay generic —
  // the credential-awareness must not over-fire on every failed run.
  const run = failedRun({
    failure_reason: 'connector_reported_failed',
    known_gaps: [
      {
        kind: 'run_failed',
        reason: 'connector_reported_failed',
        stream: null,
        severity: 'actionable',
        message: 'parser error: unexpected token in stream payload',
        recovery_hint: { action: 'retry_on_connector_upgrade', retryable: false },
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  const credentialCondition = snap.conditions?.find((c) => c.type === 'CredentialsValid' && c.status === 'false');
  assert.equal(credentialCondition, undefined, 'a non-auth failure must NOT manufacture a credential/reconnect prompt');
});

test('§10-C control: source_unavailable login outage does NOT manufacture a credential prompt', () => {
  // Live USAA shape: the connector has a stored credential, but the provider
  // login system reported source_unavailable after the username step. The
  // runtime gap may still carry the generic refresh_credentials action because
  // the message is login-shaped; the projection must not turn that source
  // outage into an owner "reconnect credentials" prompt.
  const run = failedRun({
    failure_reason: 'connector_reported_failed',
    known_gaps: [
      {
        kind: 'run_failed',
        reason: 'connector_reported_failed',
        stream: null,
        severity: 'actionable',
        message:
          'usaa_session_failed: source_unavailable: USAA reported its login system is currently unavailable after Next click.',
        recovery_hint: { action: 'refresh_credentials', retryable: false },
      },
    ],
  });
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: FRESH,
    lastRun: run,
    lastSuccessfulRun: null,
    schedule: { enabled: true },
  });
  const credentialCondition = snap.conditions?.find((c) => c.type === 'CredentialsValid' && c.status === 'false');
  assert.equal(credentialCondition, undefined, 'source_unavailable must NOT manufacture a credential/reconnect prompt');
  assert.notEqual(snap.next_action?.kind, 'reauth');
  assert.equal(snap.axes.coverage, 'retryable_gap');
  assert.equal(snap.forward_disposition, 'resumable');
});
