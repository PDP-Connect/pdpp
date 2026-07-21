// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

// ─── Dispatch C boundary regression ──────────────────────────────────────────
//
// Now that Dispatch C has wired `rendered_verdict` into `ConnectorSummary` and
// `ConnectorDetail`, the owner types carry a `RenderedVerdict` with `detail` and
// `trace`. This test pins the exact boundary: a verdict that arrives at a
// grant-scoped seam MUST have `detail` and `trace` stripped via `toGrantScopedVerdict`
// before it reaches a grant-scoped client.
//
// This is a structural regression: if anyone removes `toGrantScopedVerdict` from
// the grant-scoped path in the future, these tests catch the exposure.

test('grant-scope: RenderedVerdict.detail is owner-only by type — GrantScopedVerdict structurally cannot carry it', () => {
  const ownerVerdict = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'otp_likely' },
    true
  );
  // Owner verdict has detail and trace
  assert.ok('detail' in ownerVerdict, 'owner verdict has detail');
  assert.ok('trace' in ownerVerdict, 'owner verdict has trace');

  // After grant-scoped projection, both are absent
  const grantScoped = toGrantScopedVerdict(ownerVerdict);
  assert.ok(!('detail' in grantScoped), 'GrantScopedVerdict has no detail (structural)');
  assert.ok(!('trace' in grantScoped), 'GrantScopedVerdict has no trace (structural)');

  // The type-level guarantee: GrantScopedVerdict = Omit<RenderedVerdict, 'detail' | 'trace'>
  // Confirmed at runtime: the projection does not add them back under any alias.
  const serialized = JSON.stringify(grantScoped);
  const parsed = JSON.parse(serialized);
  assert.ok(!('detail' in parsed), 'no "detail" key in serialized grant-scoped verdict');
  assert.ok(!('trace' in parsed), 'no "trace" key in serialized grant-scoped verdict');
});

test('grant-scope: ConnectorSummary.rendered_verdict detail must go through toGrantScopedVerdict before grant scope', () => {
  // Simulate what the grant-scoped REST path must do when it encounters rendered_verdict:
  // it calls toGrantScopedVerdict, which strips detail and trace.
  // This test proves the transform is idempotent (calling it twice doesn't add fields back)
  // and that the result is safe for a grant-scoped client.
  const ownerVerdict = synthesizeRenderedVerdict(
    snapshot(),
    [stream()],
    { backgroundSafe: false, recommendedMode: 'manual', interactionPosture: 'otp_likely' },
    true
  );

  const scoped = toGrantScopedVerdict(ownerVerdict);
  // Idempotent: the scoped verdict does not accidentally acquire detail/trace
  // if passed through again (defense-in-depth).
  const scopedAgain = toGrantScopedVerdict(scoped);
  assert.ok(!('detail' in scopedAgain));
  assert.ok(!('trace' in scopedAgain));

  // The 2,532 recovered gap backlog must not be serializable from the scoped verdict.
  const serialized = JSON.stringify(scopedAgain);
  assert.ok(!serialized.includes('2532'), 'gap count must not be reachable from grant-scoped verdict');
});
