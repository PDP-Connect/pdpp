import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TERMINAL_LIFECYCLES,
  canTransition,
  classifyAutoDetect,
  createAttention,
  decideDedupe,
  expireIfDue,
  isExpired,
  isHealthRelevant,
  isTerminal,
  pushPayload,
  transition,
} from '../runtime/attention.ts';

const NOW = '2026-05-19T12:00:00.000Z';

function input(overrides = {}) {
  return {
    id: 'att_1',
    dedupe_key: 'conn_a:otp',
    connection_id: 'conn_a',
    run_id: 'run_1',
    reason_code: 'otp',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    sensitivity: 'secret',
    now: NOW,
    ...overrides,
  };
}

test('createAttention validates axes — pure progress is not assistance', () => {
  assert.throws(() =>
    createAttention(
      input({
        progress_posture: 'running',
        owner_action: 'none',
        response_contract: 'none',
        sensitivity: 'none',
      }),
    ),
  );
});

test('createAttention validates axes — response_required requires owner_action', () => {
  assert.throws(() =>
    createAttention(
      input({
        progress_posture: 'blocked',
        owner_action: 'none',
        response_contract: 'response_required',
      }),
    ),
  );
});

test('createAttention accepts nonblocking external approval (act_elsewhere)', () => {
  const rec = createAttention(
    input({
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
    }),
  );
  assert.equal(rec.lifecycle, 'open');
  assert.equal(rec.owner_action, 'act_elsewhere');
});

test('lifecycle transitions are validated', () => {
  const rec = createAttention(input());
  assert.equal(canTransition('open', 'in_progress'), true);
  assert.equal(canTransition('resolved', 'open'), false);
  assert.throws(() => transition(rec, { to: 'open', now: NOW }));

  const acked = transition(rec, { to: 'acknowledged', now: NOW });
  const inProg = transition(acked, { to: 'in_progress', now: NOW });
  const resolved = transition(inProg, { to: 'resolved', now: NOW });
  assert.equal(resolved.lifecycle, 'resolved');
  assert.ok(isTerminal('resolved'));
  assert.deepEqual(
    [...TERMINAL_LIFECYCLES].sort(),
    ['cancelled', 'expired', 'resolved', 'superseded'],
  );
});

test('dedupe — suppress active duplicate when axes match', () => {
  const existing = createAttention(input());
  const out = decideDedupe({
    existing,
    proposed: input({ id: 'att_2', now: '2026-05-19T12:00:10.000Z' }),
    cooldown_seconds: 60,
  });
  assert.deepEqual(out, { kind: 'suppress', reason: 'active_duplicate' });
});

test('dedupe — supersede when axes shift while existing is still open', () => {
  const existing = createAttention(
    input({
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
    }),
  );
  const out = decideDedupe({
    existing,
    proposed: input({
      id: 'att_2',
      // Owner ran out of time on the external app, so now we require a code.
      reason_code: 'otp',
      progress_posture: 'blocked',
      owner_action: 'provide_value',
      response_contract: 'response_required',
      sensitivity: 'secret',
      now: '2026-05-19T12:05:00.000Z',
    }),
    cooldown_seconds: 60,
  });
  assert.deepEqual(out, { kind: 'supersede', existing_id: existing.id });
});

test('dedupe — cooldown blocks rapid re-fire after terminal close', () => {
  const existing = transition(createAttention(input()), {
    to: 'resolved',
    now: '2026-05-19T12:00:30.000Z',
  });
  const out = decideDedupe({
    existing,
    proposed: input({ id: 'att_3', now: '2026-05-19T12:00:40.000Z' }),
    cooldown_seconds: 60,
  });
  assert.deepEqual(out, { kind: 'suppress', reason: 'cooldown' });
});

test('dedupe — creates fresh once cooldown has elapsed', () => {
  const existing = transition(createAttention(input()), {
    to: 'resolved',
    now: '2026-05-19T12:00:30.000Z',
  });
  const out = decideDedupe({
    existing,
    proposed: input({ id: 'att_3', now: '2026-05-19T12:10:00.000Z' }),
    cooldown_seconds: 60,
  });
  assert.deepEqual(out, { kind: 'create' });
});

test('expiry — non-terminal record past expires_at is expired', () => {
  const rec = createAttention(
    input({ expires_at: '2026-05-19T12:01:00.000Z' }),
  );
  assert.equal(isExpired(rec, '2026-05-19T12:00:30.000Z'), false);
  assert.equal(isExpired(rec, '2026-05-19T12:02:00.000Z'), true);

  const expired = expireIfDue(rec, '2026-05-19T12:02:00.000Z');
  assert.equal(expired.lifecycle, 'expired');

  // Idempotent — terminal records never re-expire.
  const again = expireIfDue(expired, '2026-05-19T13:00:00.000Z');
  assert.equal(again, expired);
});

test('push payload — secret records produce no payload (no leak path)', () => {
  const rec = createAttention(
    input({ sensitivity: 'secret', owner_copy: 'Enter your 6-digit code' }),
  );
  const payload = pushPayload(rec, {
    dashboard_origin: 'https://dash.example.com/',
    connection_display: 'Example Bank',
  });
  assert.equal(payload, null);
});

test('push payload — non-secret records produce safe payload, no metadata bleed', () => {
  const rec = createAttention(
    input({
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
      owner_copy: 'Approve the prompt in your phone',
      metadata: {
        // Secret-looking keys must be redacted defensively.
        access_token: 'eyJabc.def',
        cookie: 'sessionid=xxx',
        password: 'hunter2',
        // Non-secret metadata may pass through, but isn't surfaced in payload.
        attempt: 3,
      },
    }),
  );

  assert.equal(rec.metadata.access_token, '[redacted]');
  assert.equal(rec.metadata.cookie, '[redacted]');
  assert.equal(rec.metadata.password, '[redacted]');
  assert.equal(rec.metadata.attempt, 3);

  const payload = pushPayload(rec, {
    dashboard_origin: 'https://dash.example.com/',
    connection_display: 'Example Bank',
  });

  assert.ok(payload);
  assert.equal(payload.title, 'Approve in your other app');
  assert.match(payload.body, /^Example Bank needs/);
  assert.equal(payload.url, 'https://dash.example.com/attention/att_1');
  assert.equal(payload.tag, rec.dedupe_key);
  assert.equal(payload.attention_id, rec.id);
  assert.equal(payload.connection_id, 'conn_a');
  assert.equal(payload.reason_code, 'app_push_approval');

  // Hard guarantees on what's *not* in the payload.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['eyJabc.def', 'sessionid', 'hunter2', 'Approve the prompt in your phone']) {
    assert.equal(serialized.includes(forbidden), false, `payload must not contain ${forbidden}`);
  }
});

test('push payload — privacy mode hides connection name', () => {
  const rec = createAttention(
    input({
      reason_code: 'manual_action',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
    }),
  );
  const payload = pushPayload(rec, {
    dashboard_origin: 'https://dash.example.com',
    connection_display: 'Example Bank',
    hide_source: true,
  });
  assert.ok(payload);
  assert.equal(payload.body.includes('Example Bank'), false);
  assert.match(payload.body, /^A connection needs/);
});

test('push payload — terminal records never notify', () => {
  const rec = transition(createAttention(input({ sensitivity: 'non_secret' })), {
    to: 'resolved',
    now: NOW,
  });
  assert.equal(
    pushPayload(rec, { dashboard_origin: 'https://x', connection_display: null }),
    null,
  );
});

test('health relevance — blocked + response_required is health-relevant', () => {
  const rec = createAttention(input());
  assert.equal(isHealthRelevant(rec, NOW), true);
});

test('health relevance — running + act_elsewhere + no response is NOT health-relevant', () => {
  const rec = createAttention(
    input({
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
    }),
  );
  assert.equal(isHealthRelevant(rec, NOW), false);
});

test('health relevance — expired and terminal records are NOT health-relevant', () => {
  const open = createAttention(input({ expires_at: '2026-05-19T12:00:01.000Z' }));
  assert.equal(isHealthRelevant(open, '2026-05-19T13:00:00.000Z'), false);

  const resolved = transition(open, { to: 'resolved', now: NOW });
  assert.equal(isHealthRelevant(resolved, NOW), false);
});

test('auto-detect — opted-in record with proceeded evidence resolves', () => {
  const rec = createAttention(
    input({
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
      auto_detect: true,
    }),
  );
  const out = classifyAutoDetect({ record: rec, evidence: 'proceeded', now: '2026-05-19T12:05:00.000Z' });
  assert.equal(out.kind, 'resolve');
  assert.equal(out.record.lifecycle, 'resolved');
});

test('auto-detect — still_blocked / unknown leaves record untouched', () => {
  const rec = createAttention(
    input({
      auto_detect: true,
      sensitivity: 'non_secret',
    }),
  );
  assert.deepEqual(
    classifyAutoDetect({ record: rec, evidence: 'still_blocked', now: NOW }),
    { kind: 'no_change', reason: 'still_blocked' },
  );
  assert.deepEqual(
    classifyAutoDetect({ record: rec, evidence: 'unknown', now: NOW }),
    { kind: 'no_change', reason: 'no_evidence' },
  );
});

test('auto-detect — opt-out record never resolves automatically', () => {
  const rec = createAttention(input({ sensitivity: 'non_secret', auto_detect: false }));
  const out = classifyAutoDetect({ record: rec, evidence: 'proceeded', now: NOW });
  assert.deepEqual(out, { kind: 'no_change', reason: 'auto_detect_disabled' });
});

test('auto-detect — terminal records are not re-resolved', () => {
  const rec = transition(
    createAttention(input({ sensitivity: 'non_secret', auto_detect: true })),
    { to: 'resolved', now: NOW },
  );
  const out = classifyAutoDetect({ record: rec, evidence: 'proceeded', now: '2026-05-19T13:00:00.000Z' });
  assert.deepEqual(out, { kind: 'no_change', reason: 'terminal' });
});

// ─── 5.6 scenario coverage: re-consent / manual verification ───────────────

test('re-consent — non-secret blocked + provide_value emits safe push and is health-relevant', () => {
  const rec = createAttention(
    input({
      dedupe_key: 'conn_a:reconsent',
      reason_code: 're_consent',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
      owner_copy: 'Re-grant access at provider.example.com',
      attachments: [{ kind: 'url', ref: 'opaque-1', label: 'provider re-consent' }],
    }),
  );
  assert.equal(isHealthRelevant(rec, NOW), true);

  const payload = pushPayload(rec, {
    dashboard_origin: 'https://dash.example.com',
    connection_display: 'ChatGPT',
  });
  assert.ok(payload, 're-consent must produce a payload');
  assert.equal(payload.reason_code, 're_consent');
  assert.equal(payload.url, 'https://dash.example.com/attention/att_1');
  // Owner-supplied copy and opaque attachment refs must never reach a push payload.
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['Re-grant access', 'provider.example.com', 'opaque-1']) {
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test('manual browser verification — operate_attachment routes by attention id, not attachment ref', () => {
  const rec = createAttention(
    input({
      dedupe_key: 'conn_a:manual_verify',
      reason_code: 'manual_verification',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
      attachments: [
        { kind: 'browser_surface', ref: 'wss://secret-cdp.example/abc?token=xyz', label: 'live browser' },
      ],
    }),
  );
  const payload = pushPayload(rec, {
    dashboard_origin: 'https://dash.example.com',
    connection_display: 'Example Bank',
  });
  assert.ok(payload);
  // The deep-link target is the durable attention surface, never an attachment ref.
  assert.equal(payload.url, 'https://dash.example.com/attention/att_1');
  assert.equal(payload.body.includes('wss://'), false);
  assert.equal(payload.body.includes('xyz'), false);
});

// ─── 5.6 scenario coverage: cancellation ───────────────────────────────────

test('cancellation — cancelled records never notify and never project to health', () => {
  const rec = createAttention(
    input({
      reason_code: 'manual_action',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
    }),
  );
  assert.equal(isHealthRelevant(rec, NOW), true);

  const cancelled = transition(rec, { to: 'cancelled', now: NOW });
  assert.equal(isHealthRelevant(cancelled, NOW), false);
  assert.equal(
    pushPayload(cancelled, { dashboard_origin: 'https://dash.example.com', connection_display: 'Example Bank' }),
    null,
  );
  // Cancellation is terminal; you cannot re-open it.
  assert.throws(() => transition(cancelled, { to: 'open', now: NOW }));
  assert.throws(() => transition(cancelled, { to: 'in_progress', now: NOW }));
});

// ─── 5.6 scenario coverage: OTP secrecy ────────────────────────────────────

test('OTP — provider-prompt copy never reaches push, even via metadata bag', () => {
  const rec = createAttention(
    input({
      dedupe_key: 'conn_a:otp',
      reason_code: 'otp',
      progress_posture: 'blocked',
      owner_action: 'provide_value',
      response_contract: 'response_required',
      sensitivity: 'secret',
      owner_copy: 'Enter the 6-digit code we just texted to +1•••5309',
      metadata: {
        otp_hint: '482913',
        bearer: 'Bearer eyJabc',
        provider_message: 'Your one-time code is 482913',
      },
    }),
  );
  // Secret sensitivity must short-circuit push entirely.
  assert.equal(
    pushPayload(rec, { dashboard_origin: 'https://dash.example.com', connection_display: 'Example Bank' }),
    null,
  );
  // Even on the durable record, secret-looking keys are redacted defensively.
  assert.equal(rec.metadata.bearer, '[redacted]');
});

// ─── 5.6 scenario coverage: app push approval (act_elsewhere) ─────────────

test('push approval — act_elsewhere is push-eligible but NOT health-relevant on its own', () => {
  const rec = createAttention(
    input({
      dedupe_key: 'conn_a:app_push_approval',
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
    }),
  );
  // The runtime distinguishes "owner has work elsewhere" from "the connection
  // is degraded": a running act_elsewhere prompt should ring the PWA but
  // should NOT flip the dashboard pill to needs-attention by itself.
  assert.equal(isHealthRelevant(rec, NOW), false);
  const payload = pushPayload(rec, {
    dashboard_origin: 'https://dash.example.com',
    connection_display: 'ChatGPT',
  });
  assert.ok(payload, 'act_elsewhere should still deliver an attention push');
  assert.equal(payload.title, 'Approve in your other app');
});

// ─── 5.6 scenario coverage: supersession deep-check ────────────────────────

test('supersession — superseded records suppress push and stop projecting to health', () => {
  const original = createAttention(
    input({
      reason_code: 'app_push_approval',
      progress_posture: 'running',
      owner_action: 'act_elsewhere',
      response_contract: 'none',
      sensitivity: 'non_secret',
    }),
  );
  const superseded = transition(original, { to: 'superseded', now: NOW });
  assert.equal(isHealthRelevant(superseded, NOW), false);
  assert.equal(
    pushPayload(superseded, {
      dashboard_origin: 'https://dash.example.com',
      connection_display: 'ChatGPT',
    }),
    null,
  );
});

// ─── Policy guardrail: push is a channel, not state ────────────────────────

test('push channel — failed delivery does not change AttentionRecord state', () => {
  const rec = createAttention(
    input({
      reason_code: 'manual_verification',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
    }),
  );
  const beforeSnapshot = JSON.stringify(rec);
  // Simulate a delivery loop: build payload, fail, retry, fail again.
  for (let i = 0; i < 3; i += 1) {
    const payload = pushPayload(rec, {
      dashboard_origin: 'https://dash.example.com',
      connection_display: 'Example Bank',
    });
    assert.ok(payload);
    // Whatever the transport does, the record is frozen-shape and the runtime
    // never re-routes its lifecycle on the basis of delivery outcome.
  }
  assert.equal(JSON.stringify(rec), beforeSnapshot, 'delivery attempts must not mutate the record');
  assert.equal(rec.lifecycle, 'open');
  assert.equal(isHealthRelevant(rec, NOW), true);
});

test('push channel — owner missing the push still sees the same attention via durable record', () => {
  // The dashboard surface re-derives from the record; this asserts the
  // record itself carries everything the surface needs (id, connection,
  // reason, copy, attachments, lifecycle) regardless of whether any push
  // was ever attempted or delivered.
  const rec = createAttention(
    input({
      reason_code: 'manual_action',
      progress_posture: 'blocked',
      owner_action: 'operate_attachment',
      response_contract: 'response_required',
      sensitivity: 'non_secret',
      owner_copy: 'Click Continue in the open tab',
      attachments: [{ kind: 'browser_surface', ref: 'opaque-ref', label: 'live browser' }],
    }),
  );
  assert.equal(rec.lifecycle, 'open');
  assert.equal(rec.owner_copy, 'Click Continue in the open tab');
  assert.equal(rec.attachments.length, 1);
  assert.equal(rec.attachments[0].kind, 'browser_surface');
  // Same record is health-relevant whether or not push fired.
  assert.equal(isHealthRelevant(rec, NOW), true);
});
