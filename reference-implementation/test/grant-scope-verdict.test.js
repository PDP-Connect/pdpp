import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeRenderedVerdict, toGrantScopedVerdict } from '../runtime/rendered-verdict.ts';

// Task 10: grant-scope isolation.
//
// The inspection-layer `detail` (gap backlog, raw disposition, conditions, next-attempt
// floor, collection rate) and the calibration `trace` are owner-only diagnostics —
// identical to the existing `detail_gap_backlog` exposure policy — and SHALL NOT be
// exposed to grant-scoped REST/MCP reads.
//
// `RenderedVerdict` is not yet wired into the RS wire response (that is Dispatch C).
// This is therefore a FORWARD regression at the contract level: it pins the exact
// transform Dispatch C will apply at the wire seam (`toGrantScopedVerdict`) so that a
// grant-scoped projection structurally cannot carry `detail` or `trace`. It will keep
// holding after C wires it IF C routes grant-scoped reads through this projection.

function snapshot() {
  return {
    axes: { attention: 'open', coverage: 'retryable_gap', freshness: 'stale', outbox: 'idle', remote_surface: 'none' },
    badges: { stale: true, syncing: false },
    collection_rate: { ceiling_interval_ms: 1000, ceiling_rate_per_min: 60, current_interval_ms: 2000, effective_rate_per_min: 30, last_backoff: null },
    conditions: [
      {
        current: true,
        expires_at: null,
        id: 'CredentialsValid:credential_rejected',
        message: 'rejected',
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
    detail_gap_backlog: { max_attempt_count: 3, next_attempt_at: '2026-06-15T12:00:00.000Z', pending: 7, pending_is_floor: false, pending_other: 0, pending_other_is_floor: false, recovered: 2532, terminal: null },
    dominant_condition_id: 'CredentialsValid:credential_rejected',
    forward_disposition: 'awaiting_owner',
    last_success_at: null,
    next_action: null,
    next_attempt_at: '2026-06-15T12:00:00.000Z',
    reason_code: 'credential_rejected',
    remote_surface: null,
    state: 'needs_attention',
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

function stream() {
  return { stream_id: 's1', coverage: 'retryable_gap', gap_retryable: true, attention_open: true, collected: 5, considered: 10, priority: 'required' };
}

test('grant-scope: the owner verdict carries detail + trace (owner-only diagnostics)', () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'otp_likely' }, true);
  assert.ok('detail' in v, 'owner verdict carries detail');
  assert.ok('trace' in v, 'owner verdict carries trace');
  // And the suppressed/backlog evidence really lives there.
  assert.equal(v.detail.detail_gap_backlog.recovered, 2532);
});

test('grant-scope: the grant-scoped projection returns NO detail and NO trace', () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'otp_likely' }, true);
  const scoped = toGrantScopedVerdict(v);
  assert.ok(!('detail' in scoped), 'grant-scoped read must not expose detail');
  assert.ok(!('trace' in scoped), 'grant-scoped read must not expose trace');
});

test('grant-scope: no inspection-layer figure leaks through the grant-scoped projection', () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'otp_likely' }, true);
  const scoped = toGrantScopedVerdict(v);
  const serialized = JSON.stringify(scoped);
  // The 2,532-gap backlog scale and the raw next-attempt floor must not reach a
  // grant-scoped client through any public field.
  assert.ok(!serialized.includes('2532'), 'backlog scale must not leak to grant scope');
  assert.ok(!serialized.includes('detail_gap_backlog'), 'no inspection-layer key in grant-scoped output');
  assert.ok(!serialized.includes('collection_rate'), 'no rate snapshot in grant-scoped output');
});

test('grant-scope: public attention-layer fields survive the projection', () => {
  const v = synthesizeRenderedVerdict(snapshot(), [stream()], { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'otp_likely' }, true);
  const scoped = toGrantScopedVerdict(v);
  for (const key of ['pill', 'channel', 'annotations', 'forward_statement', 'required_actions', 'streams', 'progress']) {
    assert.ok(key in scoped, `public field ${key} survives grant-scoped projection`);
  }
});
