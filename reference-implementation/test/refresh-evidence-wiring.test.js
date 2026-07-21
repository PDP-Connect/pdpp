import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { isAssistedRefresh, isManualRefreshOnly } from '../runtime/connection-health.ts';
import { projectConnectorSummaryConnectionHealth } from '../server/ref-control.ts';
import { synthesizeRenderedVerdict } from '../runtime/rendered-verdict.ts';

// Task 6.3 (Risk 1, highest-leverage): verify ConnectionRefreshEvidence actually
// reaches the projection at RUNTIME for amazon / chase / reddit / usaa — traced
// end-to-end from the real committed manifests, NOT just asserted from a synthetic
// policy — so `isManualRefreshOnly` is true for them and a stale manual account does
// NOT fall through to `complete`; stale surfaces as an amber refresh advisory.
//
// The runtime path is:
//   manifest.capabilities.refresh_policy
//     → extractRefreshPolicy(manifest)            (ref-control)
//     → input.refreshPolicy
//     → buildRefreshEvidence(input.refreshPolicy) (ref-control, inside the projection)
//     → computeConnectionHealth({ refresh })      (connection-health)
//     → isManualRefreshOnly(refresh) === true
//
// `projectConnectorSummaryConnectionHealth` calls `buildRefreshEvidence(input.refreshPolicy)`
// internally, so feeding it the REAL manifest refresh_policy exercises the whole path.

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFEST_DIR = join(__dirname, '..', '..', 'packages', 'polyfill-connectors', 'manifests');

const NOW = '2026-06-15T12:00:00.000Z';
const STALE_FRESHNESS = { status: 'stale', captured_at: NOW };

function readRefreshPolicy(connector) {
  const manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, `${connector}.json`), 'utf8'));
  // Mirror ref-control's extractRefreshPolicy: capabilities.refresh_policy.
  return manifest.capabilities?.refresh_policy ?? null;
}

function succeededRun() {
  return {
    run_id: 'run_1',
    status: 'succeeded',
    failure_reason: null,
    known_gaps: [],
    last_at: '2026-05-15T00:00:00.000Z',
  };
}

const MANUAL_BACKGROUND_UNSAFE_CONNECTORS = ['chase', 'usaa'];
// Owner-opt-in manual-default connectors: manual by default, but
// background_safe:true + assisted_after_owner_auth:true, so they behave
// like Amazon (never auto-enrolled, but explicitly owner-schedulable).
const OWNER_OPT_IN_CONNECTORS = ['amazon', 'reddit'];

test('6.3: the manual/background-unsafe committed manifests stay manual-only', () => {
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const policy = readRefreshPolicy(connector);
    assert.ok(policy, `${connector} manifest has a refresh_policy`);
    assert.equal(policy.recommended_mode, 'manual', `${connector} recommended_mode is manual`);
    assert.equal(policy.background_safe, false, `${connector} background_safe is false`);
  }
});

test('6.3: Amazon and Reddit are manual-by-default but background-safe and owner-opt-in after auth', () => {
  for (const connector of OWNER_OPT_IN_CONNECTORS) {
    const policy = readRefreshPolicy(connector);
    assert.ok(policy, `${connector} manifest has a refresh_policy`);
    assert.equal(policy.recommended_mode, 'manual', `${connector} recommended_mode is manual`);
    assert.equal(policy.background_safe, true, `${connector} background_safe is true`);
    assert.equal(policy.assisted_after_owner_auth, true, `${connector} assisted_after_owner_auth is true`);
  }
});

test('6.3: the projected refresh evidence makes isManualRefreshOnly true for each manual connector', () => {
  // Reproduce buildRefreshEvidence's projection from the raw manifest policy and
  // assert the predicate the projection uses returns true. (buildRefreshEvidence is
  // not exported; this mirrors its exact field mapping and the projection proves the
  // full path below.) Owner-opt-in connectors (Amazon, Reddit) stay manual-refresh-only
  // too: background_safe:true only permits an explicit owner schedule, it does not
  // change the manifest's own recommended_mode.
  for (const connector of [...MANUAL_BACKGROUND_UNSAFE_CONNECTORS, ...OWNER_OPT_IN_CONNECTORS]) {
    const policy = readRefreshPolicy(connector);
    const refresh = {
      backgroundSafe: policy.background_safe ?? null,
      recommendedMode: policy.recommended_mode ?? null,
      interactionPosture: policy.interaction_posture ?? null,
    };
    assert.equal(isManualRefreshOnly(refresh), true, `${connector} is manual-refresh-only`);
  }
});

test('6.3: a stale manual/background-unsafe account projects owner_refresh_due without degrading collection health', () => {
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const run = succeededRun();
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      outbox: { axis: 'idle' },
      refreshPolicy: readRefreshPolicy(connector), // the REAL committed manifest policy
      schedule: { enabled: true },
      nowIso: NOW,
    });
    // The projection routes stale manual to the owner-refresh advisory; the
    // rendered verdict turns that typed disposition into an actionable state.
    assert.equal(snap.state, 'idle', `${connector} projects idle advisory`);
    assert.equal(snap.reason_code, 'stale_manual_refresh', `${connector} reason is stale_manual_refresh`);
    assert.equal(snap.axes.freshness, 'stale');
    assert.equal(snap.badges.stale, true);
    assert.equal(snap.forward_disposition, 'owner_refresh_due', `${connector} disposition is owner_refresh_due`);
  }
});

test('6.3: a stale owner-opt-in connection with an enabled owner schedule is scheduled, not stale_manual_refresh', () => {
  for (const connector of OWNER_OPT_IN_CONNECTORS) {
    const run = succeededRun();
    const policy = readRefreshPolicy(connector);
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      outbox: { axis: 'idle' },
      refreshPolicy: policy,
      schedule: { enabled: true },
      nowIso: NOW,
    });
    assert.equal(snap.state, 'degraded', `${connector} degrades once scheduled`);
    assert.equal(snap.reason_code, null, `${connector} reason_code is null`);
    assert.equal(snap.axes.freshness, 'stale');
    assert.equal(snap.badges.stale, true);
    assert.equal(snap.forward_disposition, 'complete', `${connector} disposition is complete`);
    assert.notEqual(snap.forward_disposition, 'owner_refresh_due');
  }
});

test('6.3: a stale owner-opt-in connection with no enabled schedule stays manual and owner_refresh_due', () => {
  for (const connector of OWNER_OPT_IN_CONNECTORS) {
    const run = succeededRun();
    const policy = readRefreshPolicy(connector);
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      outbox: { axis: 'idle' },
      refreshPolicy: policy,
      schedule: null,
      nowIso: NOW,
    });
    assert.equal(snap.state, 'idle', `${connector} stays idle unscheduled`);
    assert.equal(snap.reason_code, 'stale_manual_refresh');
    assert.equal(snap.axes.freshness, 'stale');
    assert.equal(snap.badges.stale, true);
    assert.equal(snap.forward_disposition, 'owner_refresh_due');
  }
});

test('6.3: the synthesized verdict for a stale manual account is Needs refresh/advisory with Refresh now', () => {
  for (const connector of MANUAL_BACKGROUND_UNSAFE_CONNECTORS) {
    const run = succeededRun();
    const policy = readRefreshPolicy(connector);
    const snap = projectConnectorSummaryConnectionHealth({
      freshness: STALE_FRESHNESS,
      lastRun: run,
      lastSuccessfulRun: run,
      outbox: { axis: 'idle' },
      refreshPolicy: policy,
      schedule: { enabled: true },
      nowIso: NOW,
    });
    const refresh = {
      backgroundSafe: policy.background_safe ?? null,
      recommendedMode: policy.recommended_mode ?? null,
      interactionPosture: policy.interaction_posture ?? null,
    };
    const verdict = synthesizeRenderedVerdict(
      snap,
      [{ stream_id: 's1', coverage: 'complete', gap_retryable: false, attention_open: false, collected: null, considered: null, priority: 'required' }],
      refresh,
      true,
      { mode: 'manual', retained_records: 100, last_refreshed_at: '2026-05-15T00:00:00.000Z' }
    );
    assert.equal(verdict.pill.tone, 'amber', `${connector} is visibly refresh-due while stale`);
    assert.equal(verdict.pill.label, 'Needs refresh');
    assert.equal(verdict.channel, 'advisory');
    assert.ok(
      verdict.required_actions.some((a) => a.kind === 'refresh_now' && a.audience === 'owner'),
      `${connector} offers an owner Refresh now action`
    );
    assert.ok(verdict.annotations.some((a) => a.kind === 'freshness'));
  }
});

test('6.4: ChatGPT — automatic + background-safe + assisted posture is NOT manual-refresh-only (zero-credential account is valid)', () => {
  const policy = readRefreshPolicy('chatgpt');
  const refresh = {
    backgroundSafe: policy.background_safe ?? null,
    recommendedMode: policy.recommended_mode ?? null,
    interactionPosture: policy.interaction_posture ?? null,
  };
  assert.equal(isManualRefreshOnly(refresh), false, 'ChatGPT is not manual-refresh-only');
  assert.equal(isAssistedRefresh(refresh), true, 'ChatGPT is assisted-refresh');
  // A fresh ChatGPT-shaped account with zero credentials is a valid green verdict —
  // no account⇒credential invariant is imposed.
  const snap = projectConnectorSummaryConnectionHealth({
    freshness: { status: 'current', captured_at: NOW },
    lastRun: succeededRun(),
    lastSuccessfulRun: succeededRun(),
    outbox: { axis: 'idle' },
    refreshPolicy: policy,
    schedule: { enabled: true },
    nowIso: NOW,
  });
  const verdict = synthesizeRenderedVerdict(
    snap,
    [{ stream_id: 's1', coverage: 'complete', gap_retryable: false, attention_open: false, collected: null, considered: null, priority: 'required' }],
    refresh,
    true,
    { mode: 'deferred', gaps_drained_last_run: 2532, retained_records: 126000 }
  );
  assert.equal(verdict.pill.tone, 'green');
  assert.ok(!verdict.required_actions.some((a) => a.kind === 'reauth'));
});
