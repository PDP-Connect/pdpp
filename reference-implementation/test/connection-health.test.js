import test from 'node:test';
import assert from 'node:assert/strict';

import { computeConnectionHealth, deriveOutboxAxisFromHeartbeat } from '../runtime/connection-health.ts';
import { BLOCKED_PROMOTION_THRESHOLD } from '../runtime/connector-health.ts';

const STALE_MS = 30 * 60 * 1000;
const NOW = '2026-05-19T12:00:00.000Z';
const FRESH = '2026-05-19T11:55:00.000Z'; // 5 min ago
const OLD = '2026-05-19T11:00:00.000Z'; // 60 min ago — past 30-min stale threshold

function heartbeat(overrides = {}) {
  return {
    evidenceTrusted: true,
    lastHeartbeatAt: FRESH,
    lastHeartbeatStatus: 'healthy',
    recordsPending: 0,
    ...overrides,
  };
}

// ─── Test helpers ──────────────────────────────────────────────────────────

/** Default input: never-run, enabled schedule, no policy violations. */
function input(overrides = {}) {
  return {
    schedule: { enabled: true },
    run: null,
    backoff: null,
    attention: null,
    coverage: null,
    freshness: null,
    outbox: null,
    projection: null,
    activity: null,
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    latestStatus: 'succeeded',
    hasDegradingGaps: false,
    lastSuccessAt: '2026-05-19T00:00:00.000Z',
    reasonCode: null,
    ...overrides,
  };
}

function backoff(overrides = {}) {
  return {
    backoffApplied: true,
    consecutiveFailures: 3,
    reasonClass: 'connector:reddit_login_unexpected_ui',
    nextRunAt: '2026-05-19T01:00:00.000Z',
    ...overrides,
  };
}

// ─── 1. Projection unreliable → unknown ───────────────────────────────────

test('unknown: any unreliable required projection forces unknown and names the source', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      projection: { unreliableSources: ['dashboard_summary'] },
    })
  );
  assert.equal(snap.state, 'unknown');
  assert.deepEqual([...snap.unknown_reasons], ['dashboard_summary']);
});

test('unknown: takes precedence even over open attention', () => {
  // Spec scenario: projection unreliable beats every other ordered rule.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      attention: { lifecycle: 'open', reasonCode: 'otp_required', actionTarget: 'dashboard', expiresAt: null },
      projection: { unreliableSources: ['coverage_read_model'] },
    })
  );
  assert.equal(snap.state, 'unknown');
});

// ─── 2. Idle (paused & never-run) ─────────────────────────────────────────

test('idle: owner-paused schedule wins over later evidence', () => {
  const snap = computeConnectionHealth(
    input({
      schedule: { enabled: false },
      run: run({ latestStatus: 'failed', lastSuccessAt: '2026-05-01T00:00:00.000Z' }),
      backoff: backoff(),
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.next_attempt_at, null); // paused: no next attempt
});

test('idle: never-run connection with enabled schedule', () => {
  const snap = computeConnectionHealth(input());
  assert.equal(snap.state, 'idle');
  assert.equal(snap.last_success_at, null);
});

// ─── 3. Needs attention ───────────────────────────────────────────────────

test('needs_attention: open required attention beats backoff', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null }),
      attention: { lifecycle: 'open', reasonCode: 'otp_required', actionTarget: 'dashboard', expiresAt: null },
      backoff: backoff({ consecutiveFailures: 2 }),
    })
  );
  assert.equal(snap.state, 'needs_attention');
  assert.equal(snap.reason_code, 'otp_required');
  assert.equal(snap.axes.attention, 'open');
  assert.equal(snap.next_attempt_at, '2026-05-19T01:00:00.000Z');
});

test('needs_attention: attention does NOT override projection-unreliable', () => {
  // Already covered above; documents the precedence boundary explicitly.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      attention: { lifecycle: 'in_progress', reasonCode: null, actionTarget: null, expiresAt: null },
      projection: { unreliableSources: ['runs'] },
    })
  );
  assert.equal(snap.state, 'unknown');
});

// ─── 4. Blocked (give-up streak) ─────────────────────────────────────────

test('blocked: consecutiveFailures at threshold promotes cooling_off to blocked', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: '2026-04-01T00:00:00.000Z' }),
      backoff: backoff({
        backoffApplied: true,
        consecutiveFailures: BLOCKED_PROMOTION_THRESHOLD,
        reasonClass: 'connector:auth_expired',
      }),
    })
  );
  assert.equal(snap.state, 'blocked');
  assert.equal(snap.reason_code, 'auth_expired'); // class prefix stripped
});

// ─── 5. Cooling off ───────────────────────────────────────────────────────

test('cooling_off: backoffApplied with sub-threshold streak', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: '2026-05-10T00:00:00.000Z' }),
      backoff: backoff({ consecutiveFailures: 3, reasonClass: 'failure:network_timeout' }),
    })
  );
  assert.equal(snap.state, 'cooling_off');
  assert.equal(snap.reason_code, 'network_timeout');
  assert.equal(snap.next_attempt_at, '2026-05-19T01:00:00.000Z');
});

// ─── 6. Degraded ──────────────────────────────────────────────────────────

test('degraded: outbox stalled forces degraded even when run succeeded', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(), // succeeded, no gaps
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.axes.outbox, 'stalled');
});

test('degraded: succeeded-with-gaps does not project as healthy', () => {
  // Spec scenario: "Last run succeeded with required gaps".
  const snap = computeConnectionHealth(
    input({
      run: run({ hasDegradingGaps: true, reasonCode: 'reddit_login_unexpected_ui' }),
      coverage: { axis: 'gaps' },
      freshness: { axis: 'fresh' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.reason_code, 'reddit_login_unexpected_ui');
});

test('degraded: failed last run with no backoff applied yet', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', reasonCode: 'transient_400' }),
      coverage: { axis: 'partial' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.reason_code, 'transient_400');
});

test('degraded: coverage gaps without a failed run still degrade', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'gaps' },
      freshness: { axis: 'fresh' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('degraded: retryable_gap coverage axis degrades a succeeded run', () => {
  // Stream/scope-boundary coverage: at least one stream has a pending
  // retryable gap. The headline must degrade so a success-with-gaps run
  // can never project healthy (spec task 3.5).
  const snap = computeConnectionHealth(
    input({
      run: run({ hasDegradingGaps: true }),
      coverage: { axis: 'retryable_gap' },
      freshness: { axis: 'fresh' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.axes.coverage, 'retryable_gap');
});

test('degraded: terminal_gap coverage axis degrades a succeeded run', () => {
  // Stream/scope-boundary coverage: at least one stream has a terminal
  // gap (owner-action required). Must degrade and preserve the axis so
  // the dashboard can surface "owner action needed" precision.
  const snap = computeConnectionHealth(
    input({
      run: run({ hasDegradingGaps: true, reasonCode: 'auth_expired' }),
      coverage: { axis: 'terminal_gap' },
      freshness: { axis: 'fresh' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.axes.coverage, 'terminal_gap');
  assert.equal(snap.reason_code, 'auth_expired');
});

test('healthy is impossible when coverage axis is retryable_gap or terminal_gap', () => {
  // The healthy predicate only accepts `complete`. Any gap-flavored
  // axis — retryable or terminal — must downgrade. This is the
  // success-with-gaps protection at the axis level.
  for (const axis of ['retryable_gap', 'terminal_gap']) {
    const snap = computeConnectionHealth(
      input({
        run: run(),
        coverage: { axis },
        freshness: { axis: 'fresh' },
      })
    );
    assert.notEqual(snap.state, 'healthy', `axis=${axis} must not project healthy`);
  }
});

// ─── Accepted-coverage axis taxonomy ──────────────────────────────────────

test('accepted-coverage axes (unsupported/unavailable/deferred/inventory_only) can project healthy', () => {
  // When the caller emits an accepted-coverage axis it has already
  // determined the absence is acceptable (e.g. non-required stream with
  // declared policy). The projection must accept those as healthy-
  // compatible alongside `complete`.
  for (const axis of ['unsupported', 'unavailable', 'deferred', 'inventory_only']) {
    const snap = computeConnectionHealth(
      input({
        run: run(),
        coverage: { axis },
        freshness: { axis: 'fresh' },
      })
    );
    assert.equal(snap.state, 'healthy', `axis=${axis} should project healthy as accepted-coverage`);
    assert.equal(snap.axes.coverage, axis);
  }
});

test('requiredButAccepted blocks healthy even when the axis is accepted-coverage', () => {
  // Contradictory manifest signal: a required stream declares an
  // accepted-coverage policy. The projection refuses healthy and
  // surfaces degraded, preserving the axis label so the dashboard can
  // explain *why* (the named accepted-coverage label).
  for (const axis of ['unsupported', 'unavailable', 'deferred', 'inventory_only']) {
    const snap = computeConnectionHealth(
      input({
        run: run(),
        coverage: { axis, requiredButAccepted: true },
        freshness: { axis: 'fresh' },
      })
    );
    assert.notEqual(snap.state, 'healthy', `axis=${axis} + requiredButAccepted must not project healthy`);
    assert.equal(snap.state, 'degraded');
    assert.equal(snap.axes.coverage, axis);
  }
});

// ─── 7. Healthy ───────────────────────────────────────────────────────────

test('healthy: success + complete coverage + fresh + no attention/backoff', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'idle' },
    })
  );
  assert.equal(snap.state, 'healthy');
  assert.equal(snap.reason_code, null);
  assert.equal(snap.badges.stale, false);
  assert.equal(snap.badges.syncing, false);
});

test('healthy: complete coverage and fresh evidence can project healthy without outbox evidence', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
    })
  );
  assert.equal(snap.state, 'healthy');
});

// ─── Stale axis (never a headline state) ──────────────────────────────────

test('stale: freshness stale alone surfaces as axis+badge, not a stale headline state', () => {
  // Spec scenario: "Freshness policy is violated" — stale is an axis.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
    })
  );
  // Headline must not be "stale". Stale-but-otherwise-clean degrades
  // while the badge and axis carry the precise freshness signal.
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
});

// ─── Syncing badge (never a headline state) ───────────────────────────────

test('activity: active work surfaces as syncing badge without replacing health pill', () => {
  // Spec scenario: "Active work is running" — syncing is a badge.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      activity: { active: true },
    })
  );
  assert.equal(snap.state, 'healthy'); // unchanged pill
  assert.equal(snap.badges.syncing, true);
});

test('activity: syncing badge sits orthogonal to degraded headline', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ hasDegradingGaps: true }),
      coverage: { axis: 'gaps' },
      freshness: { axis: 'fresh' },
      activity: { active: true },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.badges.syncing, true);
});

// ─── Mixed / fallback ────────────────────────────────────────────────────

test('mixed: succeeded run with unknown coverage and unknown freshness falls back to unknown', () => {
  // Coverage axis is unknown, freshness axis is unknown — we cannot
  // confidently claim healthy. With no degrading evidence either, the
  // fallback (`unknown`) protects against silent false-green.
  const snap = computeConnectionHealth(
    input({
      run: run(),
    })
  );
  assert.equal(snap.state, 'unknown');
  assert.deepEqual([...snap.unknown_reasons], ['unclassified']);
});

test('mixed: succeeded run with complete coverage but unknown freshness is not healthy', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
    })
  );
  assert.equal(snap.state, 'unknown');
  assert.deepEqual([...snap.unknown_reasons], ['unclassified']);
});

test('mixed: stale projection evidence reported as unknown when projection source flagged', () => {
  // Spec scenario: when read-model rebuild fails or is stale beyond
  // policy, the projection evidence is unreliable.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      projection: { unreliableSources: ['dashboard_summary', 'coverage_read_model'] },
    })
  );
  assert.equal(snap.state, 'unknown');
  assert.deepEqual([...snap.unknown_reasons], ['dashboard_summary', 'coverage_read_model']);
});

// ─── Axes always populated regardless of headline ────────────────────────

test('axes: rolled up consistently across all headline states', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed' }),
      coverage: { axis: 'partial' },
      freshness: { axis: 'stale' },
      outbox: { axis: 'active' },
      attention: { lifecycle: 'acknowledged', reasonCode: 'manual_verification', actionTarget: null, expiresAt: null },
    })
  );
  // Attention is open → needs_attention pill; axes still report partial/stale/active.
  assert.equal(snap.state, 'needs_attention');
  assert.equal(snap.axes.attention, 'acknowledged');
  assert.equal(snap.axes.coverage, 'partial');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.axes.outbox, 'active');
  assert.equal(snap.badges.stale, true);
});

// ─── Outbox axis derivation from device heartbeat evidence ───────────────

test('outbox axis: trusted healthy heartbeat with zero pending is idle', () => {
  const r = deriveOutboxAxisFromHeartbeat(heartbeat(), {
    nowIso: NOW,
    staleHeartbeatThresholdMs: STALE_MS,
  });
  assert.deepEqual(r, { axis: 'idle', unreliable: false });
});

test('outbox axis: trusted healthy heartbeat with pending work is active', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ recordsPending: 5 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'active');
});

test('outbox axis: starting/retrying heartbeats are active', () => {
  const starting = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'starting' }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(starting.axis, 'active');
  const retrying = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'retrying' }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(retrying.axis, 'active');
});

test('outbox axis: blocked status is stalled regardless of freshness', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'blocked' }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'stalled');
});

test('outbox axis: pending work + stale heartbeat degrades to stalled', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'healthy', lastHeartbeatAt: OLD, recordsPending: 3 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'stalled');
});

test('outbox axis: idle heartbeat that is stale but has zero pending stays idle', () => {
  // Stale heartbeat with no pending work is not stalled by itself.
  // Freshness axis handles general freshness; the outbox axis only
  // claims stalled when there is durable work that is not draining.
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatAt: OLD, recordsPending: 0 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'idle');
});

test('outbox axis: missing heartbeat is unknown (not unreliable)', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatAt: null, lastHeartbeatStatus: null }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.deepEqual(r, { axis: 'unknown', unreliable: false });
});

test('outbox axis: untrusted evidence flags projection unreliable', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ evidenceTrusted: false }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.deepEqual(r, { axis: 'unknown', unreliable: true });
});

// ─── next_action CTA derivation ──────────────────────────────────────────

test('next_action: structured attention projects a non-secret CTA with source=structured', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null }),
      attention: {
        actionTarget: 'external_app',
        expiresAt: '2026-05-19T13:00:00.000Z',
        id: 'att_1',
        lifecycle: 'open',
        ownerAction: 'act_elsewhere',
        reasonCode: 'push_approval',
        responseContract: 'none',
      },
    })
  );
  assert.equal(snap.state, 'needs_attention');
  assert.deepEqual(snap.next_action, {
    action_target: 'external_app',
    attention_id: 'att_1',
    expires_at: '2026-05-19T13:00:00.000Z',
    owner_action: 'act_elsewhere',
    reason_code: 'push_approval',
    response_contract: 'none',
    source: 'structured',
  });
});

test('next_action: secret-sensitive structured attention suppresses action_target', () => {
  // The runtime owns secret values (OTP digits, raw verification text).
  // The CTA may pin attention_id and a controlled reason code, but
  // must never expose action_target text that could leak which surface
  // holds the secret beyond what reason_code already implies.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed' }),
      attention: {
        actionTarget: 'dashboard:/secrets/x',
        expiresAt: null,
        id: 'att_secret',
        lifecycle: 'in_progress',
        ownerAction: 'provide_value',
        reasonCode: 'otp_required',
        responseContract: 'response_required',
        sensitivity: 'secret',
      },
    })
  );
  assert.equal(snap.next_action?.action_target, null);
  assert.equal(snap.next_action?.attention_id, 'att_secret');
  assert.equal(snap.next_action?.reason_code, 'otp_required');
  assert.equal(snap.next_action?.source, 'structured');
});

test('next_action: schedule-fallback evidence projects source=schedule_fallback', () => {
  // When the caller could not supply a structured record (id/ownerAction
  // null), the CTA is necessarily coarse — the dashboard should render
  // a caveated label rather than invent precision.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed' }),
      attention: {
        actionTarget: null,
        expiresAt: null,
        id: null,
        lifecycle: 'open',
        ownerAction: null,
        reasonCode: 'needs_human_attention',
        responseContract: null,
      },
    })
  );
  assert.equal(snap.next_action?.source, 'schedule_fallback');
  assert.equal(snap.next_action?.attention_id, null);
  assert.equal(snap.next_action?.owner_action, null);
  assert.equal(snap.next_action?.reason_code, 'needs_human_attention');
});

test('next_action: null when no attention is open', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
    })
  );
  assert.equal(snap.state, 'healthy');
  assert.equal(snap.next_action, null);
});

test('next_action: idle and degraded headlines do not synthesize a CTA', () => {
  const idleSnap = computeConnectionHealth(input({ schedule: { enabled: false } }));
  assert.equal(idleSnap.state, 'idle');
  assert.equal(idleSnap.next_action, null);

  const degradedSnap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed' }),
      coverage: { axis: 'partial' },
    })
  );
  assert.equal(degradedSnap.state, 'degraded');
  assert.equal(degradedSnap.next_action, null);
});
