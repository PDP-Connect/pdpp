/**
 * Dispatch C — owner wire forwarding tests.
 *
 * Verifies that `rendered_verdict` is present and structurally valid on both
 * `ConnectorSummary` (via `projectConnectorSummaryForInstance` path) and
 * `ConnectorDetail` (via `getConnectorDetail` path), and that the fields are
 * computed by the synthesizer (not defaulted to null / undefined).
 *
 * These are unit-level tests that exercise the projection directly. They do
 * not require a live DB: they call `synthesizeConnectorVerdict` with
 * representative inputs and assert on the shape of the returned verdict.
 *
 * Grant-scope isolation is covered in grant-scope-verdict.test.js (task 10).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeConnectorVerdict } from '../runtime/connector-verdict-input.ts';
import { toGrantScopedVerdict } from '../runtime/rendered-verdict.ts';

// ─── Minimal evidence builders ────────────────────────────────────────────────

function freshHealthySnapshot() {
  return {
    axes: {
      attention: 'none',
      coverage: 'complete',
      freshness: 'fresh',
      outbox: 'idle',
      remote_surface: 'none',
    },
    badges: { stale: false, syncing: false },
    collection_rate: null,
    conditions: [],
    detail_gap_backlog: null,
    dominant_condition_id: null,
    forward_disposition: 'complete',
    interaction_posture: 'none',
    is_health_relevant: true,
    last_success_at: null,
    next_action: null,
    next_attempt_at: null,
    push_payload: null,
    reason_code: null,
    state: 'healthy',
  };
}

function staleManualSnapshot() {
  return {
    ...freshHealthySnapshot(),
    state: 'idle',
    axes: {
      attention: 'none',
      coverage: 'complete',
      freshness: 'stale',
      outbox: 'idle',
      remote_surface: 'none',
    },
    badges: { stale: true, syncing: false },
    // owner_refresh_due is the forward disposition for stale manual connections —
    // without it, the synthesizer emits no refresh_now action and channel stays calm.
    forward_disposition: 'owner_refresh_due',
    reason_code: 'stale_manual_refresh',
    // A stale-manual verdict implies a prior successful collection whose data has
    // since aged past the freshness window — distinguishing it from a genuinely
    // never-run idle connection, which stays green/grey instead of amber.
    last_success_at: '2026-05-15T00:00:00.000Z',
  };
}

function degradedRetryableSnapshot() {
  return {
    ...freshHealthySnapshot(),
    state: 'degraded',
    axes: {
      attention: 'none',
      coverage: 'retryable_gap',
      freshness: 'stale',
      outbox: 'idle',
      remote_surface: 'none',
    },
    badges: { stale: true, syncing: false },
    // A degraded resumable gap is visible but non-urgent: the owner can ask for
    // another attempt, so the channel is advisory instead of a calm wait.
    forward_disposition: 'resumable',
    reason_code: 'retryable_coverage_gap',
  };
}

function collectionReport(overrides = {}) {
  return [{
    stream: 'transactions',
    collected: 100,
    considered: 100,
    coverage_condition: 'complete',
    pending_detail_gaps: 0,
    ...overrides,
  }];
}

function manifestStreams() {
  return [{ name: 'transactions', required: true }];
}

// ─── 8.1 — rendered_verdict is present and structurally valid ────────────────

test('owner-wire: synthesizeConnectorVerdict returns a verdict with all required top-level fields', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  // Required top-level fields per RenderedVerdict interface
  assert.ok(verdict.pill, 'pill is present');
  assert.ok(typeof verdict.pill.tone === 'string', 'pill.tone is a string');
  assert.ok(typeof verdict.pill.label === 'string', 'pill.label is a string');
  assert.ok(typeof verdict.channel === 'string', 'channel is a string');
  assert.ok(Array.isArray(verdict.annotations), 'annotations is an array');
  assert.ok(typeof verdict.forward_statement === 'string', 'forward_statement is a string');
  assert.ok(Array.isArray(verdict.required_actions), 'required_actions is an array');
  assert.ok(Array.isArray(verdict.streams), 'streams is an array');
  assert.ok(verdict.progress, 'progress is present');
  assert.ok(verdict.detail, 'detail (owner-only) is present');
  assert.ok(verdict.trace, 'trace (owner-only calibration) is present');
});

// ─── 8.1 — fresh healthy connection produces green/calm verdict ───────────────

test('owner-wire: fresh healthy connection → green pill + calm channel', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'green');
  assert.equal(verdict.pill.label, 'Healthy');
  assert.equal(verdict.channel, 'calm');
  assert.equal(verdict.required_actions.length, 0);
});

test('owner-wire: outbox unknown does not downgrade an otherwise complete non-outbox connector', () => {
  const snapshot = {
    ...freshHealthySnapshot(),
    axes: {
      ...freshHealthySnapshot().axes,
      outbox: 'unknown',
    },
  };
  const verdict = synthesizeConnectorVerdict({
    snapshot,
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'green');
  assert.equal(verdict.pill.label, 'Healthy');
  assert.equal(verdict.channel, 'calm');
});

test('owner-wire: active local-device outbox renders Syncing without owner action', () => {
  const snapshot = {
    ...freshHealthySnapshot(),
    state: 'idle',
    axes: {
      ...freshHealthySnapshot().axes,
      outbox: 'active',
    },
  };
  const verdict = synthesizeConnectorVerdict({
    snapshot,
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: {
      mode: 'local_device',
      retained_records: 100,
      last_refreshed_at: '2026-07-07T09:00:00.000Z',
      observed_at: '2026-07-07T10:00:00.000Z',
    },
  });

  assert.equal(verdict.pill.tone, 'green');
  assert.equal(verdict.pill.label, 'Syncing');
  assert.equal(verdict.channel, 'calm');
  assert.equal(verdict.forward_statement, 'The local collector is uploading saved records.');
  assert.equal(verdict.required_actions.length, 0);
});

test('owner-wire: denominator-only unknown stream rows do not override connection-level complete coverage', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: collectionReport({
      collected: 5,
      considered: 'unknown',
      coverage_condition: 'unknown',
      pending_detail_gaps: 0,
    }),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'green');
  assert.equal(verdict.pill.label, 'Healthy');
  assert.equal(verdict.channel, 'calm');
  assert.equal(verdict.streams[0]?.coverage, 'unknown', 'inspection row still carries unknown coverage');
});

test('owner-wire: latest-run partial sample rows do not override connection-level complete coverage', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: collectionReport({
      collected: 1,
      considered: 100,
      coverage_condition: 'partial',
      pending_detail_gaps: 0,
    }),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'green');
  assert.equal(verdict.pill.label, 'Healthy');
  assert.equal(verdict.channel, 'calm');
  assert.equal(verdict.required_actions.length, 0);
  assert.equal(verdict.streams[0]?.coverage, 'partial', 'inspection row still carries partial coverage');
});

// ─── 8.1 — stale manual connection produces healthy/advisory verdict ──────────

test('owner-wire: stale manual-refresh connection → amber/Needs refresh pill + advisory refresh action, not Healthy or Degraded', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: staleManualSnapshot(),
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: { recommendedMode: 'manual', backgroundSafe: false },
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'amber');
  assert.equal(verdict.pill.label, 'Needs refresh');
  assert.equal(verdict.channel, 'advisory');
  // Must carry a freshness annotation
  const freshnessAnnotation = verdict.annotations.find((a) => a.kind === 'freshness');
  assert.ok(freshnessAnnotation, 'stale verdict carries a freshness annotation');
  assert.ok(verdict.required_actions.some((action) => action.kind === 'refresh_now'));
});

// ─── 8.1 — degraded/retryable: advisory retry affordance ─────────────────────
//
// This is the false-reassurance correction: a degraded retryable coverage gap
// with `disposition:resumable` must stay non-urgent, but it is not actionless.
// The owner can explicitly ask for another attempt, so the synthesizer emits a
// `retry_gap` action and raises the channel to `advisory`, not `calm`.

test('owner-wire: degraded retryable with resumable disposition → non-green pill + advisory Retry now', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: degradedRetryableSnapshot(),
    report: collectionReport({ coverage_condition: 'retryable_gap', pending_detail_gaps: 1 }),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  assert.notEqual(verdict.pill.tone, 'green', 'degraded retryable is not green');
  assert.equal(verdict.channel, 'advisory', 'degraded retryable with resumable disposition is advisory');
  const retryAction = verdict.required_actions.find((a) => a.kind === 'retry_gap');
  assert.ok(retryAction, 'a retry_gap action represents the recoverable gap');
  assert.equal(retryAction.audience, 'owner', 'retry_gap action is owner-visible');
  assert.equal(retryAction.cta, 'Retry now');
  assert.deepEqual(retryAction.satisfied_when, { kind: 'gap_recovered' });
});

test('owner-wire: no terminal run but one current stream gap is coherent retryable advisory', () => {
  const snapshot = {
    ...degradedRetryableSnapshot(),
    axes: {
      attention: 'none',
      coverage: 'retryable_gap',
      freshness: 'unknown',
      outbox: 'unknown',
      remote_surface: 'idle',
    },
    last_success_at: null,
    forward_disposition: 'resumable',
    reason_code: 'temporary_unavailable',
  };
  const verdict = synthesizeConnectorVerdict({
    snapshot,
    report: [
      {
        stream: 'accounts',
        collected: 0,
        considered: 'unknown',
        coverage_condition: 'unknown',
        pending_detail_gaps: 0,
      },
      {
        stream: 'transactions',
        collected: 0,
        considered: 'unknown',
        coverage_condition: 'retryable_gap',
        pending_detail_gaps: 1,
      },
    ],
    manifestStreams: [{ name: 'accounts', required: true }, { name: 'transactions', required: true }],
    refresh: null,
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'amber');
  assert.equal(verdict.channel, 'advisory');
  assert.equal(verdict.forward_statement, 'Retry now to give the recoverable gap another run.');
  assert.ok(verdict.required_actions.some((action) => action.kind === 'retry_gap'));
  assert.equal(
    verdict.streams.find((row) => row.stream_id === 'transactions')?.statement,
    'The next run is expected to fill the rest.'
  );
  assert.notEqual(verdict.forward_statement, 'Checking coverage before deciding what the next run should do.');
});

test('owner-wire: timed-out manual action is retryable owner work, not connector-code work', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: degradedRetryableSnapshot(),
    report: collectionReport({
      collected: 0,
      considered: 'unknown',
      coverage_condition: 'unknown',
      pending_detail_gaps: 0,
    }),
    manifestStreams: manifestStreams(),
    refresh: { backgroundSafe: false, interactionPosture: 'otp_likely', recommendedMode: 'manual' },
    progress: null,
  });

  assert.equal(verdict.pill.tone, 'amber');
  assert.equal(verdict.channel, 'advisory');
  assert.equal(verdict.forward_statement, 'Retry now to give the recoverable gap another run.');
  assert.ok(verdict.required_actions.some((action) => action.kind === 'retry_gap'));
  assert.ok(!verdict.required_actions.some((action) => action.kind === 'code_fix'));
});

// ─── grant-scope isolation ────────────────────────────────────────────────────

test('owner-wire: toGrantScopedVerdict strips detail and trace', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  const scoped = toGrantScopedVerdict(verdict);
  assert.ok(!('detail' in scoped), 'detail stripped for grant scope');
  assert.ok(!('trace' in scoped), 'trace stripped for grant scope');
  // Public fields survive
  assert.ok('pill' in scoped);
  assert.ok('channel' in scoped);
  assert.ok('forward_statement' in scoped);
});

// ─── runtime_ok seam — false caps channel at calm ────────────────────────────

test('owner-wire: runtime_ok=false caps channel at calm regardless of snapshot state', () => {
  // Use a needs_attention snapshot that would normally produce channel:attention
  const needsAttentionSnapshot = {
    ...freshHealthySnapshot(),
    state: 'needs_attention',
    axes: {
      attention: 'open',
      coverage: 'retryable_gap',
      freshness: 'stale',
      outbox: 'idle',
      remote_surface: 'none',
    },
    badges: { stale: true, syncing: false },
    forward_disposition: 'complete',
    reason_code: 'credential_rejected',
    conditions: [
      {
        current: true,
        expires_at: null,
        id: 'CredentialsValid:credential_rejected',
        message: 'Credential rejected',
        observed_at: null,
        origin: 'connector',
        reason: 'credential_rejected',
        remediation: null,
        sensitivity: 'owner',
        severity: 'error',
        status: 'false',
        type: 'CredentialsValid',
      },
    ],
  };

  const normal = synthesizeConnectorVerdict({
    snapshot: needsAttentionSnapshot,
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
    runtimeOk: true,
  });
  const faulted = synthesizeConnectorVerdict({
    snapshot: needsAttentionSnapshot,
    report: collectionReport(),
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
    runtimeOk: false,
  });

  // Pill tone is unchanged (honest about the connection state)
  assert.equal(faulted.pill.tone, normal.pill.tone, 'pill tone unchanged under runtime fault');
  // Channel is capped at calm
  assert.equal(faulted.channel, 'calm', 'channel capped at calm when runtime_ok=false');
  assert.equal(faulted.trace.runtime_capped, true, 'trace.runtime_capped is true');
});

// ─── stream rollup forwarding ─────────────────────────────────────────────────

test('owner-wire: per-stream rollup is present on the verdict streams array', () => {
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: [
      { stream: 'transactions', collected: 50, considered: 100, coverage_condition: 'partial', pending_detail_gaps: 0 },
      { stream: 'accounts', collected: 10, considered: 10, coverage_condition: 'complete', pending_detail_gaps: 0 },
    ],
    manifestStreams: [
      { name: 'transactions', required: true },
      { name: 'accounts', required: true },
    ],
    refresh: null,
    progress: null,
  });

  assert.equal(verdict.streams.length, 2);
  const txStream = verdict.streams.find((s) => s.stream_id === 'transactions');
  assert.ok(txStream, 'transactions stream present');
  const acctStream = verdict.streams.find((s) => s.stream_id === 'accounts');
  assert.ok(acctStream, 'accounts stream present');
});

// ─── collected <= considered clamp ───────────────────────────────────────────

test('owner-wire: synthesizer clamps collected to considered (impossible 3/2 cannot escape)', () => {
  // Feed a bad report row with collected > considered; the synthesizer must clamp it.
  const verdict = synthesizeConnectorVerdict({
    snapshot: freshHealthySnapshot(),
    report: [{ stream: 'transactions', collected: 150, considered: 100, coverage_condition: 'complete', pending_detail_gaps: 0 }],
    manifestStreams: manifestStreams(),
    refresh: null,
    progress: null,
  });

  const txStream = verdict.streams.find((s) => s.stream_id === 'transactions');
  assert.ok(txStream, 'stream row present');
  assert.ok(
    txStream.collected <= (txStream.considered ?? Infinity),
    `collected (${txStream.collected}) must be <= considered (${txStream.considered})`
  );
});
