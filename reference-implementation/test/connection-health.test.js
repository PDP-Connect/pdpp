import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTION_CONDITION_REASONS,
  computeConnectionHealth,
  deriveOutboxAxisFromHeartbeat,
  deriveOutboxStateFromDiagnostics,
  rollupOutboxDiagnosticCounts,
} from '../runtime/connection-health.ts';
import { BLOCKED_PROMOTION_THRESHOLD } from '../runtime/connection-health-policy.ts';

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
  assert.equal(findCondition(snap, 'ProjectionReliable')?.status, 'false');
  assert.equal(snap.dominant_condition_id, 'ProjectionReliable:projection_unreliable');
});

test('shared condition reasons expose canonical reason-code constants', () => {
  assert.equal(CONNECTION_CONDITION_REASONS.PROJECTION_UNRELIABLE, 'projection_unreliable');
  assert.equal(CONNECTION_CONDITION_REASONS.CREDENTIAL_REJECTED, 'credential_rejected');
  assert.equal(CONNECTION_CONDITION_REASONS.REMOTE_SURFACE_FAILED, 'remote_surface_failed');
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

test('needs_attention: open required attention beats never-run idle', () => {
  const snap = computeConnectionHealth(
    input({
      observedAt: NOW,
      run: null,
      attention: {
        lifecycle: 'open',
        reasonCode: 'push_approval',
        actionTarget: 'dashboard',
        expiresAt: '2026-05-19T13:00:00.000Z',
      },
    })
  );
  assert.equal(snap.state, 'needs_attention');
  assert.equal(snap.reason_code, 'push_approval');
  assert.equal(snap.next_action?.action_target, 'dashboard');
  assert.equal(findCondition(snap, 'AttentionClear')?.current, true);
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
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.reason, 'auth_expired');
  assert.equal(credentials?.sensitivity, 'secret_redacted');
  assert.equal(credentials?.remediation?.action, 'refresh_credentials');
});

test('blocked: current credential rejection is readiness evidence without waiting for backoff', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({
        latestStatus: 'failed',
        lastSuccessAt: null,
        reasonCode: 'github_auth_failed',
      }),
      coverage: { axis: 'partial' },
      freshness: { axis: 'stale' },
    })
  );
  assert.equal(snap.state, 'blocked');
  assert.equal(snap.reason_code, 'github_auth_failed');
  assert.equal(snap.dominant_condition_id, 'CredentialsValid:github_auth_failed');
  assert.ok(snap.supporting_condition_ids.includes('CredentialsValid:github_auth_failed'));

  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.origin, 'readiness');
  assert.equal(credentials?.sensitivity, 'secret_redacted');
  assert.equal(credentials?.message.includes('github_auth_failed'), false);
});

// ─── Honest no-usable-credential vs rejected credential (route-credentialless-repair-to-capture) ───

test('credential: no usable stored credential projects credential_required, not rejected', () => {
  const snap = computeConnectionHealth(
    input({
      // A credential-shaped run reason is present, but durable evidence shows the
      // connection has no usable stored credential (never captured). This is
      // "capture a credential", NOT "the source rejected a credential".
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'chatgpt_session_failed' }),
      credential: { capable: true, present: false },
    })
  );
  assert.equal(snap.state, 'blocked');
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(credentials?.message, 'No usable stored credential for this connection.');
  assert.equal(credentials?.remediation?.action, 'refresh_credentials');
  assert.equal(credentials?.remediation?.label, 'Reconnect this account');
  // The dishonest "rejected" copy must not appear when nothing was stored.
  assert.doesNotMatch(credentials?.message ?? '', /rejected/i);
});

test('credential: a rejected stored credential projects credential_rejected', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'auth_expired' }),
      credential: { capable: true, present: true, rejected: true },
    })
  );
  assert.equal(snap.state, 'blocked');
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.message, 'The source rejected the configured credentials.');
  assert.equal(credentials?.remediation?.action, 'refresh_credentials');
});

test('credential: never-run connection with no stored credential still projects credential_required', () => {
  // No run reason at all (never ran) — durable credential evidence alone drives
  // the honest repair need, so setup and health/verdict surfaces agree.
  const snap = computeConnectionHealth(
    input({ run: null, credential: { capable: true, present: false } })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(snap.state, 'blocked');
});

test('credential: repair state does not heal by age — rejection persists after the run reason ages out', () => {
  // The credential-shaped run reason has aged out (no reason code), but durable
  // evidence still says the stored credential was rejected. The connection SHALL
  // keep projecting the unresolved credential condition, not idle/healthy.
  const snap = computeConnectionHealth(
    input({ run: null, credential: { capable: true, present: true, rejected: true } })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REJECTED);
  assert.notEqual(snap.state, 'idle');
  assert.notEqual(snap.state, 'healthy');
});

test('credential: absent credential evidence preserves prior run-reason-derived behavior', () => {
  // No credential evidence supplied (existing callers): a credential-shaped run
  // reason still yields the rejected condition exactly as before.
  const snap = computeConnectionHealth(
    input({ run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'github_auth_failed' }) })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'false');
  assert.equal(credentials?.reason, 'github_auth_failed');
  assert.equal(credentials?.message, 'The source rejected the configured credentials.');
});

// ─── Owner-action surface (complete-connection-repair-action-surfaces) ───────

test('surface: no usable stored credential projects the stored_credential surface', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'auth_expired' }),
      credential: { capable: true, present: false },
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(credentials?.remediation?.surface?.kind, 'stored_credential');
});

test('surface: a rejected stored credential projects the stored_credential surface', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'auth_expired' }),
      credential: { capable: true, present: true, rejected: true },
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.message, 'The source rejected the configured credentials.');
  assert.equal(credentials?.remediation?.surface?.kind, 'stored_credential');
});

test('surface: a free-form session_required reason cannot authorize browser-session repair', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
      remoteSurface: {
        axis: 'idle',
        leaseId: null,
        leaseStatus: null,
        profileKey: 'chatgpt',
        surfaceHealth: null,
        surfaceId: null,
        waitReason: null,
      },
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'unknown');
  assert.equal(credentials?.remediation, null);
  assert.equal(snap.next_action, null);
});

function providerInvalidationProof(overrides = {}) {
  return {
    kind: 'provider_invalidation_proof',
    provider: 'chatgpt',
    connection_id: 'connection_chatgpt',
    evidence_id: 'provider-event-1',
    observed_at: NOW,
    verified: true,
    ...overrides,
  };
}

function managedBrowserSessionInput(overrides = {}) {
  return input({
    run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
    remoteSurface: {
      axis: 'idle',
      leaseId: null,
      leaseStatus: null,
      profileKey: 'chatgpt',
      surfaceHealth: null,
      surfaceId: null,
      waitReason: null,
    },
    ...overrides,
  });
}

test('surface: an exact verified provider proof remains a monotonic one-repair authorization', () => {
  const proof = providerInvalidationProof();
  const valid = computeConnectionHealth(
    managedBrowserSessionInput({
      browserSurfaceRepair: {
        connectionId: proof.connection_id,
        evidence: proof,
        provider: proof.provider,
      },
    })
  );
  assert.equal(findCondition(valid, 'CredentialsValid')?.remediation?.surface?.kind, 'browser_session');

  const deduped = computeConnectionHealth(
    managedBrowserSessionInput({
      browserSurfaceRepair: {
        connectionId: proof.connection_id,
        evidence: proof,
        provider: proof.provider,
        repairedProofKeys: [`${proof.connection_id}\n${proof.provider}\n${proof.evidence_id}`],
      },
    })
  );
  assert.equal(findCondition(deduped, 'CredentialsValid')?.remediation, null);

  for (const context of [
    { connectionId: 'other-connection', evidence: proof, provider: proof.provider },
    { connectionId: proof.connection_id, evidence: proof, provider: 'other-provider' },
    {
      connectionId: proof.connection_id,
      evidence: providerInvalidationProof({ verified: false }),
      provider: proof.provider,
    },
  ]) {
    const unauthorized = computeConnectionHealth(managedBrowserSessionInput({ browserSurfaceRepair: context }));
    assert.equal(findCondition(unauthorized, 'CredentialsValid')?.remediation, null);
    assert.equal(unauthorized.next_action, null);
  }
});

test('surface: structured attention remains the owner-action authority', () => {
  const snap = computeConnectionHealth(
    managedBrowserSessionInput({
      attention: {
        lifecycle: 'open',
        reasonCode: 'otp_required',
        actionTarget: 'dashboard',
        expiresAt: null,
      },
    })
  );
  assert.equal(snap.next_action?.source, 'structured');
  assert.equal(snap.next_action?.action_target, 'dashboard');
  assert.equal(findCondition(snap, 'CredentialsValid')?.remediation, null);
});

test('surface: browser capability routes session_required without a live remote surface', () => {
  // Exact idle-session regression: a static-secret-capable connection has an
  // active, unrejected credential, but its browser session is inactive. Surface
  // occupancy is runtime telemetry, not the repair-capability discriminator.
  for (const axis of ['none', 'idle', 'waiting', 'leased']) {
    const snap = computeConnectionHealth(
      input({
        run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
        credential: { capable: true, present: true, rejected: false },
        browserSessionRepairCapable: true,
        remoteSurface: {
          axis,
          leaseId: null,
          leaseStatus: null,
          profileKey: null,
          surfaceHealth: null,
          surfaceId: null,
          waitReason: null,
        },
      })
    );
    const credentials = findCondition(snap, 'CredentialsValid');
    assert.equal(credentials?.status, 'false', axis);
    assert.equal(credentials?.remediation?.surface?.kind, 'browser_session', axis);
    assert.equal(credentials?.message, 'The authenticated browser session is not active.', axis);
    assert.doesNotMatch(credentials?.message ?? '', /rejected/i, axis);
  }
});

test('surface: session_required yields to stored_credential when durable evidence says the credential was rejected', () => {
  // Even with a managed browser surface and a session-required reason, a durable
  // stored_credential_rejected verdict is stronger evidence: route to capture.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
      credential: { capable: true, present: true, rejected: true },
      browserSessionRepairCapable: true,
      remoteSurface: {
        axis: 'idle',
        leaseId: null,
        leaseStatus: null,
        profileKey: 'chatgpt',
        surfaceHealth: null,
        surfaceId: null,
        waitReason: null,
      },
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.remediation?.surface?.kind, 'stored_credential');
});

test('surface: applicable static-secret absence wins before browser-session repair', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
      credential: { capable: true, present: false },
      browserSessionRepairCapable: true,
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(credentials?.remediation?.surface?.kind, 'stored_credential');
});

test('surface: browser-session repair remains available when stored-credential absence is not applicable', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
      credential: null,
      browserSessionRepairCapable: true,
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.remediation?.surface?.kind, 'browser_session');
});

test('surface: a non-browser connection with no usable credential routes session_required to stored_credential', () => {
  // A reason string alone does not prove a browser repair path. Static-secret
  // capture remains correct only when durable evidence says the credential is
  // actually missing or unusable.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
      credential: { capable: true, present: false },
      browserSessionRepairCapable: false,
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(credentials?.remediation?.surface?.kind, 'stored_credential');
});

test('surface: browser-incapable session_required does not invent a credential rejection', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'session_required' }),
      credential: { capable: true, present: true, rejected: false },
      browserSessionRepairCapable: false,
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'unknown');
  assert.equal(credentials?.reason, 'session_required');
  assert.equal(credentials?.remediation, null);
  assert.doesNotMatch(credentials?.message ?? '', /rejected/i);
});

test('surface: active unrejected credentials do not turn non-definitive auth text into rejection', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'auth_expired' }),
      credential: { capable: true, present: true, rejected: false },
    })
  );
  const credentials = findCondition(snap, 'CredentialsValid');
  assert.equal(credentials?.status, 'unknown');
  assert.equal(credentials?.remediation, null);
  assert.doesNotMatch(credentials?.message ?? '', /rejected/i);
});

test('conditions: credential diagnostics redact token-shaped source details', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
  const snap = computeConnectionHealth(
    input({
      run: run({
        latestStatus: 'failed',
        lastSuccessAt: null,
        reasonCode: `invalid_token token=${secret}`,
      }),
      coverage: { axis: 'partial' },
    })
  );
  const serialized = JSON.stringify(snap);
  assert.equal(snap.state, 'blocked');
  assert.equal(findCondition(snap, 'CredentialsValid')?.reason, 'credential_rejected');
  assert.ok(!serialized.includes(secret), `secret leaked through condition projection: ${serialized}`);
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

test('cooling_off: source-pressure cooldown surfaces reason_code source_pressure (no failures)', () => {
  // Cross-run source-pressure cooldown: the run SUCCEEDED but deferred work
  // under throttling. The merged backoff carries reasonClass "source_pressure"
  // with zero consecutive failures. The health snapshot must surface
  // reason_code: "source_pressure" so the console can render it as catch-up
  // rather than a failure backoff. This is the cross-layer contract the
  // operator console's cooling-off copy depends on.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'succeeded' }),
      backoff: backoff({ consecutiveFailures: 0, reasonClass: 'source_pressure' }),
    })
  );
  assert.equal(snap.state, 'cooling_off');
  assert.equal(snap.reason_code, 'source_pressure');
  assert.equal(snap.next_attempt_at, '2026-05-19T01:00:00.000Z');
});

test('cooling_off: expired retry backoff is not current blocking evidence', () => {
  const snap = computeConnectionHealth(
    input({
      observedAt: NOW,
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      backoff: backoff({
        consecutiveFailures: BLOCKED_PROMOTION_THRESHOLD,
        nextRunAt: OLD,
        reasonClass: 'terminal:rate_limited',
      }),
    })
  );
  assert.equal(snap.state, 'healthy');
  assert.equal(snap.next_attempt_at, null);
  const retryPolicy = findCondition(snap, 'RetryPolicyClear');
  assert.equal(retryPolicy?.status, 'true');
  assert.equal(retryPolicy?.reason, 'backoff_expired');
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
  assert.equal(findCondition(snap, 'BacklogClear')?.reason, 'outbox_stalled');
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

test('retryable_gap coverage remediation is owner-actionable, not a passive wait', () => {
  // The console's connection detail header already offers an owner-runnable
  // Retry/Refresh now button whenever a source is owner-runnable, including
  // for a retryable_gap connection. The condition's remediation label feeds
  // the diagnostics tooltip next to that button, so it must not tell the
  // owner to wait while a clickable retry sits right above it — that read as
  // a contradiction (source-sync-actionability, 2026-07-09).
  const snap = computeConnectionHealth(
    input({
      run: run({ hasDegradingGaps: true }),
      coverage: { axis: 'retryable_gap' },
      freshness: { axis: 'fresh' },
    })
  );
  const coverage = findCondition(snap, 'SourceCoverageComplete');
  assert.equal(coverage?.remediation?.action, 'retry_by_runtime');
  assert.equal(coverage?.remediation?.retryable, true);
  assert.doesNotMatch(coverage?.remediation?.label ?? '', /^wait/i);
  assert.match(coverage?.remediation?.label ?? '', /run the connector/i);
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
  assert.equal(snap.dominant_condition_id, null);
  assert.equal(findCondition(snap, 'CredentialsValid')?.status, 'true');
  assert.equal(findCondition(snap, 'SourceCoverageComplete')?.status, 'true');
  assert.equal(findCondition(snap, 'Fresh')?.status, 'true');
  assert.equal(snap.badges.stale, false);
  assert.equal(snap.badges.syncing, false);
});

// ─── 7b. Local-device collection verdict ──────────────────────────────────
// A local collector writes no spine run, so `run` is null and
// `CollectionSucceeded` would be unknown. The caller establishes the verdict
// only when the device-side evidence is fully green (trusted idle outbox +
// complete coverage + fresh); the classifier then treats it as a terminal
// succeeded collection equivalent to a run.

test('local-device verdict: no run + verdict + complete coverage + fresh + idle → healthy', () => {
  const snap = computeConnectionHealth(
    input({
      run: null,
      localDeviceCollection: { verdict: 'succeeded' },
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'idle' },
    })
  );
  assert.equal(snap.state, 'healthy');
  const collection = findCondition(snap, 'CollectionSucceeded');
  assert.equal(collection?.status, 'true');
  assert.equal(collection?.origin, 'local_device');
  assert.equal(collection?.reason, CONNECTION_CONDITION_REASONS.COLLECTION_SUCCEEDED_LOCAL_DEVICE);
});

test('local-device verdict: absent verdict (no run) is not healthy — the verdict is what flips it', () => {
  // Same green axes as the healthy case above but WITHOUT the verdict: with no
  // run and no verdict, `CollectionSucceeded` is unknown, so fresh evidence
  // without a collection verdict is honestly `unknown` (never silently
  // healthy). The verdict is the only thing that turns this into `healthy`.
  const snap = computeConnectionHealth(
    input({
      run: null,
      localDeviceCollection: null,
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'idle' },
    })
  );
  assert.notEqual(snap.state, 'healthy');
  assert.equal(snap.state, 'unknown');
  assert.equal(findCondition(snap, 'CollectionSucceeded')?.status, 'unknown');
});

test('local-device progress: active outbox with fresh complete evidence is syncing idle, not unknown', () => {
  // Active local-device progress is current work-in-progress evidence. It must
  // not become healthy without the local-device succeeded verdict, but it also
  // must not be grey/unknown while the collector is visibly draining.
  const snap = computeConnectionHealth(
    input({
      run: null,
      localDeviceCollection: null,
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'active' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.notEqual(snap.state, 'healthy');
  assert.equal(findCondition(snap, 'CollectionSucceeded')?.status, 'unknown');
  assert.equal(findCondition(snap, 'LocalExporterAvailable')?.status, 'true');
  assert.equal(findCondition(snap, 'BacklogClear')?.reason, CONNECTION_CONDITION_REASONS.OUTBOX_ACTIVE);
});

test('local-device verdict: no refresh policy (freshness unknown) without verdict stays idle, not unknown', () => {
  // This mirrors the live drained-collector-without-policy case: the caller
  // does NOT establish the verdict when freshness is unknown, so the no-run
  // connection keeps its honest `idle` headline (CollectionSucceeded unknown,
  // Fresh unknown → never-run idle rung). The change is purely additive here.
  const snap = computeConnectionHealth(
    input({
      run: null,
      localDeviceCollection: null,
      coverage: { axis: 'complete' },
      freshness: { axis: 'unknown' },
      outbox: { axis: 'idle' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(findCondition(snap, 'CollectionSucceeded')?.status, 'unknown');
});

test('local-device verdict: a real run verdict is authoritative over the device verdict', () => {
  // A failed run must never be greened by device evidence. The verdict is only
  // consulted when there is no run verdict at all.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', reasonCode: 'connector_error' }),
      localDeviceCollection: { verdict: 'succeeded' },
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'idle' },
    })
  );
  const collection = findCondition(snap, 'CollectionSucceeded');
  assert.equal(collection?.status, 'false');
  assert.notEqual(snap.state, 'healthy');
});

test('local-device verdict: a stalled outbox still degrades even if a verdict is passed', () => {
  // The verdict only sets CollectionSucceeded; degrading axes win via the
  // ordered precedence. (In practice the caller would not pass a verdict for a
  // stalled outbox, but the classifier must be safe even if it does.)
  const snap = computeConnectionHealth(
    input({
      run: null,
      localDeviceCollection: { verdict: 'succeeded' },
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled', cause: 'dead_letter_backlog' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('conditions: remote-surface failure becomes runtime availability evidence', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      remoteSurface: {
        axis: 'failed',
        leaseId: 'bsl_1',
        leaseStatus: 'surface_failed',
        profileKey: 'github',
        surfaceHealth: 'unhealthy',
        surfaceId: 'surf_1',
        waitReason: 'surface_unhealthy',
      },
    })
  );
  assert.equal(snap.state, 'degraded');
  const runtime = findCondition(snap, 'RuntimeAvailable');
  assert.equal(runtime?.status, 'false');
  assert.equal(runtime?.origin, 'remote_surface');
  assert.equal(runtime?.remediation?.action, 'check_runtime');
  assert.equal(snap.dominant_condition_id, runtime?.id);
});

test('conditions: missing runtime binding is a blocked readiness condition', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({
        latestStatus: 'failed',
        lastSuccessAt: null,
        reasonCode: 'browser_runtime_not_configured',
      }),
      coverage: { axis: 'partial' },
      freshness: { axis: 'stale' },
    })
  );
  assert.equal(snap.state, 'blocked');
  const runtime = findCondition(snap, 'RuntimeAvailable');
  assert.equal(runtime?.status, 'false');
  assert.equal(runtime?.severity, 'blocked');
  assert.equal(runtime?.reason, 'browser_runtime_not_configured');
  assert.equal(runtime?.remediation?.action, 'check_runtime');
  assert.equal(snap.dominant_condition_id, runtime?.id);
});

test('conditions: local exporter availability is separate from backlog state', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'active' },
    })
  );
  assert.equal(snap.state, 'healthy');
  assert.equal(findCondition(snap, 'LocalExporterAvailable')?.status, 'true');
  assert.equal(findCondition(snap, 'BacklogClear')?.status, 'false');
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

test('stale: schedulable connector stale alone surfaces as axis+badge and degrades', () => {
  // Spec scenario: "Freshness policy is violated" — stale is an axis.
  // A schedulable / background-safe connector (no refresh evidence, the
  // default) was supposed to auto-refresh and did not, so stale degrades.
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
  const fresh = findCondition(snap, 'Fresh');
  assert.equal(fresh?.status, 'false');
  assert.equal(fresh?.severity, 'warning');
  assert.equal(fresh?.reason, 'stale');
});

// ─── Manual / paused / background-unsafe connector freshness ──────────────
// A connector whose manifest refresh policy declares it manual, paused, or
// background-unsafe cannot auto-refresh. Stale data for such a connector is
// an owner-action / manual-refresh advisory, not a degradation — but only
// when nothing else is wrong. Every real failure still degrades or blocks
// exactly as for a schedulable connector.

test('manual stale: background-unsafe complete+succeeded+stale is idle advisory, not degraded', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
  // The stale axis and badge stay on so the UI still says "stale — run it".
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  const fresh = findCondition(snap, 'Fresh');
  assert.equal(fresh?.status, 'false');
  assert.equal(fresh?.severity, 'info');
  assert.equal(fresh?.reason, 'stale_manual_refresh');
  assert.equal(fresh?.remediation?.action, 'retry_by_runtime');
  assert.equal(fresh?.remediation?.target, 'run');
  // The advisory is the dominant condition so the surface explains why idle.
  assert.equal(snap.dominant_condition_id, fresh?.id);
});

test('manual stale: recommended_mode manual alone (background_safe null) is enough to advisory', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: null, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
});

test('manual stale: recommended_mode paused alone (background_safe null) is enough to advisory', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: null, recommendedMode: 'paused' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
});

test('manual stale: background_safe false alone (mode null) is enough to advisory', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: null },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
});

test('manual stale: a local-device collection verdict also satisfies the advisory', () => {
  // Local collectors write no spine run; the caller-supplied verdict is the
  // collection-succeeded proof. A manual local-device connector that drained
  // cleanly but whose data aged out gets the same idle advisory, not degraded.
  const snap = computeConnectionHealth(
    input({
      run: null,
      localDeviceCollection: { verdict: 'succeeded' },
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      outbox: { axis: 'idle' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
});

test('manual stale: schedulable connector with the SAME stale evidence still degrades', () => {
  // The distinction is purely the refresh policy. An automatic /
  // background-safe connector degrades on the identical stale+complete+
  // succeeded evidence the manual connector treats as an advisory.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(findCondition(snap, 'Fresh')?.severity, 'warning');
});

test('manual stale: incomplete coverage still degrades a manual connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'partial' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(findCondition(snap, 'SourceCoverageComplete')?.status, 'false');
});

test('manual stale: terminal-gap coverage still degrades a manual connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'terminal_gap' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('manual stale: failed last run still degrades a manual connector', () => {
  // A non-credential failure (e.g. a scrape timeout) degrades; the manual
  // advisory must never reclassify a failed run as a benign idle.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'reddit_scrape_timeout' }),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(findCondition(snap, 'CollectionSucceeded')?.status, 'false');
});

test('manual stale: a credential-rejected failure still blocks a manual connector', () => {
  // A login/credential failure is readiness-blocked — even stronger than
  // degraded. The manual advisory must not soften it.
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'reddit_login_failed' }),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'blocked');
  assert.equal(findCondition(snap, 'CredentialsValid')?.status, 'false');
});

test('manual stale: stalled outbox still degrades a manual connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      outbox: { axis: 'stalled', cause: 'stale_pending' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('manual stale: open attention still dominates a manual connector', () => {
  const snap = computeConnectionHealth(
    input({
      observedAt: NOW,
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      attention: { lifecycle: 'open', expiresAt: null, reasonCode: 'needs_login', actionTarget: 'external_app', id: 'att-1', ownerAction: 'act_elsewhere', responseContract: 'response_required' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'needs_attention');
});

test('manual stale: a manual connector that is fresh still projects healthy', () => {
  // The advisory only fires on stale. A manual connector with fresh data
  // and a successful run is fully healthy, exactly as before.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'healthy');
});

test('manual stale: a never-run manual connector that is stale stays idle (not advisory-reclassified)', () => {
  // No collection has ever succeeded, so the advisory must NOT fire — the
  // honest state is the never-run idle, not a "fresh-but-for-staleness"
  // advisory. CollectionSucceeded is unknown, so the advisory guard fails.
  const snap = computeConnectionHealth(
    input({
      run: null,
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
    })
  );
  assert.equal(snap.state, 'idle');
  // It is the never-run idle, NOT the manual-stale advisory.
  assert.notEqual(snap.reason_code, 'stale_manual_refresh');
});

test('manual stale: a background-safe manual connector with an enabled owner schedule is scheduled, not manual-refresh-only', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'manual' },
      schedule: { enabled: true },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(snap.reason_code, null);
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  assert.equal(findCondition(snap, 'Fresh')?.severity, 'warning');
  assert.equal(findCondition(snap, 'Fresh')?.reason, 'stale');
  assert.equal(snap.forward_disposition, 'complete');
  assert.notEqual(snap.forward_disposition, 'owner_refresh_due');
});

test('manual stale: the same manual-default policy stays manual-refresh-only when the owner has not enabled a schedule', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'manual' },
      schedule: { enabled: false },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, null);
  assert.equal(findCondition(snap, 'Fresh')?.reason, 'stale_manual_refresh');
  assert.equal(snap.forward_disposition, 'owner_refresh_due');
});

// ─── Assisted-refresh connector freshness ─────────────────────────────────
// A connector whose manifest refresh policy is schedulable
// (recommended_mode automatic / background_safe true) but whose
// interaction_posture predicts bounded owner help (e.g. ChatGPT:
// interaction_posture "manual_action_likely", assisted_after_owner_auth
// true) refreshes on its own schedule yet may need the owner's bounded
// assistance to complete a refresh. Stale data for such a connector is an
// owner-assistance advisory, NOT a degradation — but only when nothing else
// is wrong. Every real failure still degrades or blocks exactly as for a
// truly unattended connector.

test('assisted stale: schedulable+assistance-posture complete+succeeded+stale is idle advisory, not degraded', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_assisted_refresh');
  // The stale axis and badge stay on so the UI still says "stale — refresh due".
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  const fresh = findCondition(snap, 'Fresh');
  assert.equal(fresh?.status, 'false');
  assert.equal(fresh?.severity, 'info');
  assert.equal(fresh?.reason, 'stale_assisted_refresh');
  assert.equal(fresh?.remediation?.action, 'retry_by_runtime');
  assert.equal(fresh?.remediation?.target, 'run');
  // The advisory is the dominant condition so the surface explains why idle.
  assert.equal(snap.dominant_condition_id, fresh?.id);
  // The forward disposition is owner-refresh-due, not a coverage gap.
  assert.equal(snap.forward_disposition, 'owner_refresh_due');
});

test('assisted stale: otp_likely posture is enough to advisory', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'otp_likely' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_assisted_refresh');
});

test('assisted stale: credentials posture is enough to advisory', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'credentials' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_assisted_refresh');
});

test('assisted stale: posture with recommended_mode absent (null) still advisories', () => {
  // background_safe true + an assistance posture is enough; recommended_mode
  // null is treated as schedulable (not manual-refresh-only).
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: null, interactionPosture: 'credentials' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_assisted_refresh');
});

test('assisted stale: a truly unattended connector (posture none) with the SAME stale evidence still degrades', () => {
  // The distinction is purely the interaction posture. A schedulable
  // connector with NO assistance posture was supposed to refresh on its own
  // and did not, so the identical stale+complete+succeeded evidence degrades.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'none' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(findCondition(snap, 'Fresh')?.severity, 'warning');
  assert.equal(findCondition(snap, 'Fresh')?.reason, 'stale');
});

test('assisted stale: schedulable connector with NO posture evidence still degrades (prior behavior)', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('assisted stale: a manual connector that ALSO declares a posture stays the manual advisory', () => {
  // Manual-refresh-only wins: background_safe false makes it manual, and the
  // assisted predicate excludes any manual-refresh-only connector, so the
  // reason is the manual one, not the assisted one.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'credentials' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, 'stale_manual_refresh');
});

test('assisted stale: incomplete coverage still degrades an assisted connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'partial' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(findCondition(snap, 'SourceCoverageComplete')?.status, 'false');
});

test('assisted stale: terminal-gap coverage still degrades an assisted connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'terminal_gap' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'otp_likely' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('assisted stale: failed last run still degrades an assisted connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'chatgpt_scrape_timeout' }),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'degraded');
  assert.equal(findCondition(snap, 'CollectionSucceeded')?.status, 'false');
});

test('assisted stale: a credential-rejected failure still blocks an assisted connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run({ latestStatus: 'failed', lastSuccessAt: null, reasonCode: 'chatgpt_login_failed' }),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'credentials' },
    })
  );
  assert.equal(snap.state, 'blocked');
  assert.equal(findCondition(snap, 'CredentialsValid')?.status, 'false');
});

test('assisted stale: stalled outbox still degrades an assisted connector', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      outbox: { axis: 'stalled', cause: 'stale_pending' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'degraded');
});

test('assisted stale: open attention still dominates an assisted connector', () => {
  // A real open prompt is more urgent than the freshness advisory and must
  // win — needs_attention, not idle.
  const snap = computeConnectionHealth(
    input({
      observedAt: NOW,
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      attention: { lifecycle: 'open', expiresAt: null, reasonCode: 'needs_login', actionTarget: 'external_app', id: 'att-1', ownerAction: 'act_elsewhere', responseContract: 'response_required' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'needs_attention');
});

test('assisted stale: an assisted connector that is fresh still projects healthy', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'healthy');
});

test('assisted stale: a never-run assisted connector that is stale stays idle (not advisory-reclassified)', () => {
  const snap = computeConnectionHealth(
    input({
      run: null,
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: { backgroundSafe: true, recommendedMode: 'automatic', interactionPosture: 'manual_action_likely' },
    })
  );
  assert.equal(snap.state, 'idle');
  assert.notEqual(snap.reason_code, 'stale_assisted_refresh');
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
  assert.deepEqual(r, { axis: 'idle', cause: null, unreliable: false });
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

test('outbox axis: stale starting/retrying heartbeats degrade to stalled, not stuck active forever', () => {
  // Reproduces the local-collector restart gap: a collector posts
  // "starting"/"retrying" then the host or process dies before any
  // follow-up heartbeat. With zero pending work, the pre-fix code
  // returned `active` unconditionally regardless of heartbeat age -
  // the connection would show as actively collecting forever with no
  // self-healing path, even though no live_active_runs-style controller
  // work backs the claim (local collectors never register there).
  const starting = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'starting', lastHeartbeatAt: OLD, recordsPending: 0 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(starting.axis, 'stalled');
  assert.equal(starting.cause, 'stale_heartbeat');

  const retrying = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'retrying', lastHeartbeatAt: OLD, recordsPending: 0 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(retrying.axis, 'stalled');
  assert.equal(retrying.cause, 'stale_heartbeat');
});

test('outbox axis: fresh starting/retrying heartbeats with no pending work stay active (real pending work is not hidden)', () => {
  // A collector that just started, well within the staleness window,
  // must still read as active - the fix must not make freshly-started
  // work disappear or look stalled.
  const starting = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'starting', lastHeartbeatAt: FRESH, recordsPending: 0 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(starting.axis, 'active');
  assert.equal(starting.cause, null);
});

test('outbox axis: blocked status with no dead letters is a state-read stall', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'blocked' }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'stalled');
  assert.equal(r.cause, 'state_read_failed');
});

test('outbox axis: blocked status with dead letters is a dead-letter backlog', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'blocked', deadLetterCount: 258 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'stalled');
  assert.equal(r.cause, 'dead_letter_backlog');
});

test('outbox axis: blocked status with complete transient 5xx summary is system-handled', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({
      lastHeartbeatStatus: 'blocked',
      deadLetterCount: 251,
      deadLetterErrorClasses: [
        { count: 248, error_class: 'local device request failed: 502' },
        { count: 3, error_class: 'local device request failed: 500' },
      ],
    }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'stalled');
  assert.equal(r.cause, 'transient_upload_failure');
});

test('outbox axis: mixed or incomplete dead-letter summaries remain owner-recoverable', () => {
  const mixed = deriveOutboxAxisFromHeartbeat(
    heartbeat({
      lastHeartbeatStatus: 'blocked',
      deadLetterCount: 2,
      deadLetterErrorClasses: [
        { count: 1, error_class: 'local device request failed: 502' },
        { count: 1, error_class: 'local device request failed: 400 invalid_request' },
      ],
    }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(mixed.cause, 'dead_letter_backlog');

  const incomplete = deriveOutboxAxisFromHeartbeat(
    heartbeat({
      lastHeartbeatStatus: 'blocked',
      deadLetterCount: 2,
      deadLetterErrorClasses: [{ count: 1, error_class: 'local device request failed: 502' }],
    }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(incomplete.cause, 'dead_letter_backlog');
});

test('outbox axis: pending work + stale heartbeat degrades to stale_pending stall', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ lastHeartbeatStatus: 'healthy', lastHeartbeatAt: OLD, recordsPending: 3 }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.equal(r.axis, 'stalled');
  assert.equal(r.cause, 'stale_pending');
});

// ─── Stalled cause drives specific, non-generic projection copy ──────────

test('local exporter: state_read_failed renders re-run copy, not generic stalled', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled', cause: 'state_read_failed' },
    }),
  );
  assert.equal(snap.state, 'degraded');
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.status, 'false');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STATE_READ_FAILED);
  assert.match(exporter?.message ?? '', /cannot read its last saved state/i);
  assert.match(exporter?.message ?? '', /no failed uploads to retry/i);
  // Cause-matched remediation names the host re-run, not a generic "inspect".
  assert.match(exporter?.remediation?.label ?? '', /run the local collector again/i);
  const backlog = findCondition(snap, 'BacklogClear');
  assert.equal(backlog?.reason, CONNECTION_CONDITION_REASONS.OUTBOX_STATE_READ_FAILED);
});

test('local exporter: dead_letter_backlog renders owner-readable failed-upload copy', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled', cause: 'dead_letter_backlog' },
    }),
  );
  assert.equal(snap.state, 'degraded');
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_DEAD_LETTER_BACKLOG);
  assert.match(exporter?.message ?? '', /saved records that failed to upload/i);
  assert.match(exporter?.remediation?.label ?? '', /recover local collector uploads/i);
  assert.doesNotMatch(exporter?.message ?? '', /dead[- ]letter/i);
  assert.doesNotMatch(exporter?.remediation?.label ?? '', /dead[- ]letter/i);
  assert.equal(
    findCondition(snap, 'BacklogClear')?.reason,
    CONNECTION_CONDITION_REASONS.OUTBOX_DEAD_LETTER_BACKLOG,
  );
});

test('local exporter: transient_upload_failure is degraded but system-handled', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled', cause: 'transient_upload_failure' },
    }),
  );
  assert.equal(snap.state, 'degraded');
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_TRANSIENT_UPLOAD_FAILURE);
  assert.equal(exporter?.severity, 'warning');
  assert.equal(exporter?.remediation?.action, 'wait');
  assert.match(exporter?.message ?? '', /temporary server or network errors/i);
  assert.match(exporter?.message ?? '', /without owner action/i);
  assert.equal(
    findCondition(snap, 'BacklogClear')?.reason,
    CONNECTION_CONDITION_REASONS.OUTBOX_TRANSIENT_UPLOAD_FAILURE,
  );
});

test('local exporter: stale_pending names the stopped heartbeat, not a backlog', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled', cause: 'stale_pending' },
    }),
  );
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_PENDING);
  assert.match(exporter?.message ?? '', /queued work but stopped checking in/i);
});

test('local exporter: stale_heartbeat names the stopped starting/retrying check-in', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled', cause: 'stale_heartbeat' },
    }),
  );
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALE_HEARTBEAT);
  assert.match(exporter?.message ?? '', /starting or retrying but stopped checking in/i);
  assert.equal(
    findCondition(snap, 'BacklogClear')?.reason,
    CONNECTION_CONDITION_REASONS.OUTBOX_STALE_HEARTBEAT,
  );
});

test('local exporter: stalled with no cause falls back to generic copy', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'stalled' },
    }),
  );
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_STALLED);
  assert.match(exporter?.message ?? '', /not making progress/i);
});

test('local exporter: a cause is ignored unless the axis is actually stalled', () => {
  // A non-stalled axis must never inherit a stray cause into scary copy.
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      outbox: { axis: 'active', cause: 'dead_letter_backlog' },
    }),
  );
  const exporter = findCondition(snap, 'LocalExporterAvailable');
  assert.equal(exporter?.status, 'true');
  assert.equal(exporter?.reason, CONNECTION_CONDITION_REASONS.LOCAL_EXPORTER_ACTIVE);
  assert.match(exporter?.message ?? '', /draining queued work normally/i);
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
  assert.deepEqual(r, { axis: 'unknown', cause: null, unreliable: false });
});

test('outbox axis: untrusted evidence flags projection unreliable', () => {
  const r = deriveOutboxAxisFromHeartbeat(
    heartbeat({ evidenceTrusted: false }),
    { nowIso: NOW, staleHeartbeatThresholdMs: STALE_MS },
  );
  assert.deepEqual(r, { axis: 'unknown', cause: null, unreliable: true });
});

test('outbox state: granular diagnostics use terminal-first precedence', () => {
  assert.equal(deriveOutboxStateFromDiagnostics(null), 'unknown');
  assert.equal(deriveOutboxStateFromDiagnostics({}), 'drained');
  assert.equal(deriveOutboxStateFromDiagnostics({ total: 3, succeeded: 3 }), 'drained');
  assert.equal(deriveOutboxStateFromDiagnostics({ backlog_open: 1 }), 'backlog');
  assert.equal(deriveOutboxStateFromDiagnostics({ pending: 1, backlog_open: 1 }), 'pending');
  assert.equal(deriveOutboxStateFromDiagnostics({ retrying: 1, pending: 1 }), 'retrying');
  assert.equal(deriveOutboxStateFromDiagnostics({ stale_leases: 1, retrying: 1 }), 'stale');
  assert.equal(deriveOutboxStateFromDiagnostics({ dead_letter: 1, stale_leases: 1 }), 'dead_letter');
});

// ─── outbox diagnostic count rollup ──────────────────────────────────────

test('rollupOutboxDiagnosticCounts: null when no input carries a count', () => {
  assert.equal(rollupOutboxDiagnosticCounts([]), null);
  assert.equal(rollupOutboxDiagnosticCounts([null, undefined]), null);
  assert.equal(rollupOutboxDiagnosticCounts([{}, {}]), null);
});

test('rollupOutboxDiagnosticCounts: sums count fields across sources', () => {
  const r = rollupOutboxDiagnosticCounts([
    { pending: 3, dead_letter: 1, total: 10 },
    { pending: 4, stale_leases: 2, total: 5 },
    null,
  ]);
  assert.deepEqual(r, { pending: 7, dead_letter: 1, total: 15, stale_leases: 2 });
});

test('rollupOutboxDiagnosticCounts: keeps the earliest oldest_pending_at', () => {
  const r = rollupOutboxDiagnosticCounts([
    { pending: 1, oldest_pending_at: '2026-05-19T11:00:00.000Z' },
    { pending: 1, oldest_pending_at: '2026-05-19T10:00:00.000Z' },
  ]);
  assert.equal(r.pending, 2);
  assert.equal(r.oldest_pending_at, '2026-05-19T10:00:00.000Z');
});

test('rollupOutboxDiagnosticCounts: ignores negative / non-finite counts', () => {
  const r = rollupOutboxDiagnosticCounts([
    { pending: 2 },
    { pending: -5, dead_letter: Number.NaN, retrying: Number.POSITIVE_INFINITY },
  ]);
  assert.deepEqual(r, { pending: 2 });
});

test('rollupOutboxDiagnosticCounts: surfaces oldest_pending_at even with no numeric counts', () => {
  const r = rollupOutboxDiagnosticCounts([{ oldest_pending_at: '2026-05-19T09:00:00.000Z' }]);
  assert.deepEqual(r, { oldest_pending_at: '2026-05-19T09:00:00.000Z' });
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
    notification_state: 'pending',
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

test('dynamic browser runtime stays healthy at ordinary scale-to-zero without a replacement boundary', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      ephemeralBrowserRuntime: {
        connection_kind: 'browser-runtime',
        surface_mode: 'dynamic-managed',
        allocator_observation: {
          status: 'available',
          observed_at: NOW,
          expires_at: '2026-05-19T12:05:00.000Z',
        },
        demand: 'none',
        active_lease: null,
        current_compatible_idle_surfaces: 0,
        credential_continuity: 'not_applicable',
        last_successful_runtime_receipt: null,
        current_replacement_receipt: null,
        health_eligible: true,
      },
    })
  );

  assert.equal(snap.state, 'healthy');
  assert.equal(findCondition(snap, 'RuntimeAvailable')?.status, 'true');
  assert.equal(findCondition(snap, 'RemoteSurfaceAvailable')?.reason, 'remote_surface_not_required');
});

test('unknown dynamic allocator capability cannot fall through to a healthy headline', () => {
  const snap = computeConnectionHealth(
    input({
      run: run(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'fresh' },
      ephemeralBrowserRuntime: {
        connection_kind: 'browser-runtime',
        surface_mode: 'dynamic-managed',
        allocator_observation: {
          status: 'unknown',
          reason: 'expired',
          observed_at: NOW,
          expires_at: NOW,
        },
        demand: 'none',
        active_lease: null,
        current_compatible_idle_surfaces: 0,
        credential_continuity: 'not_applicable',
        last_successful_runtime_receipt: null,
        current_replacement_receipt: null,
        health_eligible: false,
      },
    })
  );

  assert.equal(snap.state, 'unknown');
  assert.deepEqual(snap.unknown_reasons, ['runtime']);
  assert.equal(findCondition(snap, 'RuntimeAvailable')?.status, 'unknown');
});

test('current replacement continuity overlays allocator availability without inventing an owner action', async () => {
  const { projectEphemeralBrowserSurfaceHealth } = await import('../runtime/browser-surface/ephemeral-health-projection.ts');
  const base = {
    connection_id: 'heb',
    connection_kind: 'browser-runtime',
    surface_mode: 'dynamic-managed',
    allocator_observation: {
      status: 'available',
      observed_at: NOW,
      expires_at: '2026-05-19T12:05:00.000Z',
    },
    demand: 'none',
    active_lease: null,
    current_compatible_idle_surfaces: 0,
  };
  const ordinary = projectEphemeralBrowserSurfaceHealth(base);
  const replacementPending = projectEphemeralBrowserSurfaceHealth({
    ...base,
    current_replacement_receipt: {
      connection_id: 'heb',
      surface_subject_id: 'heb',
      replacement_id: 'replacement_1',
      phase: 'started',
    },
  });

  const healthInput = (ephemeralBrowserRuntime) => input({
    run: run(),
    coverage: { axis: 'complete' },
    freshness: { axis: 'fresh' },
    ephemeralBrowserRuntime,
  });
  const ordinaryHealth = computeConnectionHealth(healthInput(ordinary));

  assert.equal(ordinary.health_eligible, true, 'ordinary no-demand scale-to-zero remains eligible');
  assert.equal(ordinaryHealth.state, 'healthy');
  assert.equal(replacementPending.health_eligible, true, 'continuity does not rewrite allocator capability');
  for (const continuity of ['replacement_pending', 'rehydration_false', 'indeterminate']) {
    const replacementHealth = computeConnectionHealth(
      healthInput({ ...replacementPending, credential_continuity: continuity })
    );
    assert.equal(replacementHealth.state, 'degraded');
    assert.equal(findCondition(replacementHealth, 'RuntimeAvailable')?.status, 'true');
    assert.equal(findCondition(replacementHealth, 'CredentialContinuity')?.status, 'false');
    assert.equal(replacementHealth.next_action, null, `${continuity} is not repair authority`);
    assert.equal(findCondition(replacementHealth, 'CredentialContinuity')?.remediation, null);
  }
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

// ─── collection_rate passthrough ───────────────────────────────────────────

test('collection_rate: null when not supplied', () => {
  const snap = computeConnectionHealth(input({ run: run(), coverage: { axis: 'complete' }, freshness: { axis: 'fresh' } }));
  assert.equal(snap.collection_rate, null,
    'collection_rate must be null when no rate evidence is passed in (honest unknown, no false zero)');
});

test('collection_rate: threaded through as pure annotation without affecting health state', () => {
  const rate = {
    ceiling_interval_ms: 1000,
    ceiling_rate_per_min: 60,
    current_interval_ms: 1500,
    effective_rate_per_min: 40,
    last_backoff: { at_interval_ms: 2000, reason: 'throttle' },
  };
  const snap = computeConnectionHealth(
    input({ run: run(), coverage: { axis: 'complete' }, freshness: { axis: 'fresh' }, collectionRate: rate })
  );
  // collection_rate is a pure annotation — it must not change the headline state.
  assert.equal(snap.state, 'healthy');
  assert.deepEqual(snap.collection_rate, rate,
    'collection_rate must be surfaced verbatim on the snapshot');
});

test('collection_rate: surfaced on degraded connections too (annotation, not a health gate)', () => {
  const rate = {
    ceiling_interval_ms: 1000,
    ceiling_rate_per_min: 60,
    current_interval_ms: 3000,
    effective_rate_per_min: 20,
    last_backoff: { at_interval_ms: 3000, reason: 'retry_after' },
  };
  const snap = computeConnectionHealth(
    input({ run: run({ latestStatus: 'failed' }), coverage: { axis: 'partial' }, collectionRate: rate })
  );
  assert.equal(snap.state, 'degraded');
  assert.deepEqual(snap.collection_rate, rate,
    'collection_rate is available even when the connection is degraded');
});

function findCondition(snap, type) {
  assert.ok(Array.isArray(snap.conditions), 'conditions must be present on health snapshot');
  return snap.conditions.find((condition) => condition.type === type);
}
