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
import { BLOCKED_PROMOTION_THRESHOLD } from '../runtime/connector-health.ts';
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
        schedule: backoffSchedule({ failures: 2 }),
      },
    },
    {
      state: 'blocked',
      input: {
        freshness: STALE_FRESHNESS,
        lastRun: failedRun(),
        lastSuccessfulRun: null,
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
