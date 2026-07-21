// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { synthesizeRenderedVerdict } from '../runtime/rendered-verdict.ts';

// Task 9: runtime-vs-connection cascade guard (design D7 / invariant S4).
// A dead runtime must NOT produce N per-connection attention pulls. The synthesizer
// takes `runtime_ok` and, when false, caps every per-connection channel at `calm`
// while keeping each pill.tone honest. A single global runtime indicator is the
// caller's responsibility (Dispatch C); here we pin the per-connection cap + honesty.

function condition(overrides = {}) {
  return {
    current: true,
    expires_at: null,
    id: 'CredentialsValid:credential_rejected',
    message: 'm',
    observed_at: null,
    origin: 'connector',
    reason: 'credential_rejected',
    remediation: null,
    sensitivity: 'owner',
    severity: 'error',
    status: 'false',
    type: 'CredentialsValid',
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    axes: {
      attention: 'none',
      coverage: 'complete',
      freshness: 'fresh',
      outbox: 'idle',
      remote_surface: 'none',
      ...(overrides.axes ?? {}),
    },
    badges: { stale: false, syncing: false },
    collection_rate: null,
    conditions: overrides.conditions ?? [],
    detail_gap_backlog: null,
    dominant_condition_id: null,
    forward_disposition: overrides.forward_disposition ?? 'complete',
    last_success_at: null,
    next_action: null,
    next_attempt_at: null,
    reason_code: null,
    remote_surface: null,
    state: overrides.state ?? 'healthy',
    supporting_condition_ids: [],
    unknown_reasons: [],
  };
}

function stream(overrides = {}) {
  return {
    stream_id: 's1',
    coverage: 'complete',
    gap_retryable: false,
    attention_open: false,
    collected: null,
    considered: null,
    priority: 'required',
    ...overrides,
  };
}

/** A fleet of connections that would each individually surface attention. */
function attentionFleet() {
  return [
    snapshot({ state: 'needs_attention', axes: { attention: 'open' }, forward_disposition: 'awaiting_owner', conditions: [condition()] }),
    snapshot({ state: 'needs_attention', axes: { attention: 'open' }, forward_disposition: 'awaiting_owner', conditions: [condition()] }),
    snapshot({ state: 'needs_attention', axes: { attention: 'open' }, forward_disposition: 'awaiting_owner', conditions: [condition()] }),
  ];
}

test('cascade: a dead runtime produces zero per-connection attention channels (no N-way cascade)', () => {
  const fleet = attentionFleet();
  const verdicts = fleet.map((snap) => synthesizeRenderedVerdict(snap, [stream()], null, false));
  const attentionCount = verdicts.filter((v) => v.channel === 'attention').length;
  assert.equal(attentionCount, 0, 'no connection alarms when the runtime is the fault');
  for (const v of verdicts) {
    assert.equal(v.channel, 'calm');
    assert.equal(v.trace.runtime_capped, true);
    assert.ok(v.detail.suppressed.some((s) => s.kind === 'runtime_fault'));
  }
});

test('cascade: per-connection pills stay honest under a runtime fault (only routing is suppressed)', () => {
  const snap = snapshot({ state: 'needs_attention', axes: { attention: 'open' }, forward_disposition: 'awaiting_owner', conditions: [condition()] });
  const ok = synthesizeRenderedVerdict(snap, [stream()], null, true);
  const faulted = synthesizeRenderedVerdict(snap, [stream()], null, false);
  // Tone is identical — the connection itself is not less broken.
  assert.equal(faulted.pill.tone, ok.pill.tone);
  assert.equal(faulted.pill.label, ok.pill.label);
  // Only the channel routing changed.
  assert.equal(ok.channel, 'attention');
  assert.equal(faulted.channel, 'calm');
});

test('cascade: a healthy fleet under a runtime fault is unchanged (cap never lowers an already-calm channel)', () => {
  const healthy = snapshot();
  const ok = synthesizeRenderedVerdict(healthy, [stream()], null, true);
  const faulted = synthesizeRenderedVerdict(healthy, [stream()], null, false);
  assert.equal(ok.channel, 'calm');
  assert.equal(faulted.channel, 'calm');
  assert.equal(faulted.trace.runtime_capped, false, 'an already-calm verdict was not capped');
});
