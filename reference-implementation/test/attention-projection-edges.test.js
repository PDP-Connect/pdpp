import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAttention,
  transition,
  canTransition,
  isTerminal,
  recordNotificationOutcome,
  decideDedupe,
  pushPayload,
  isHealthRelevant,
} from '../runtime/attention.ts';

// Mutation-killing complement to attention.test.js for the PURE attention
// read-model projection helpers. The existing suite covers the happy paths and
// the main branches; this file pins the EDGE cases that individual mutations
// slip through: the second arm of the notification-promotion OR, cooldown
// boundary arithmetic, reason-trimming, long-value metadata truncation, the
// exact owner-action copy table, URL shaping, and the transition matrix's
// forbidden edges. No DB, no I/O — every helper is a pure function of plain data.

const NOW = '2026-06-01T00:00:00.000Z';

function baseAttention(overrides = {}) {
  return createAttention({
    id: 'att_1',
    dedupe_key: 'conn:reason:kind',
    connection_id: 'cin_1',
    reason_code: 'needs_input',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    now: NOW,
    ...overrides,
  });
}

// --------------------------------------------------------------------------
// transition — the SECOND arm of the promotion OR (in_progress)
// --------------------------------------------------------------------------

test('transition to in_progress ALSO promotes notification state (not just acknowledged)', () => {
  const rec = baseAttention();
  const later = '2026-06-01T00:05:00.000Z';
  const out = transition(rec, { to: 'in_progress', now: later });
  assert.equal(out.lifecycle, 'in_progress');
  assert.equal(out.notification_state, 'acknowledged', 'in_progress promotes notification to acknowledged');
  assert.equal(out.notification_updated_at, later);
  assert.equal(out.notification_reason, 'owner_acknowledged');
});

test('transition to a terminal state other than acknowledged/in_progress leaves notification untouched', () => {
  // Seed a non-default notification state so we can prove it is preserved.
  const rec = recordNotificationOutcome(baseAttention(), { now: NOW, outcome: 'sent', reason: 'delivered' });
  const out = transition(rec, { to: 'resolved', now: '2026-06-01T01:00:00.000Z' });
  assert.equal(out.lifecycle, 'resolved');
  assert.equal(out.notification_state, 'sent', 'resolved must NOT overwrite notification state');
  assert.equal(out.notification_reason, 'delivered');
  assert.equal(out.notification_updated_at, NOW, 'notification timestamp is preserved, not bumped');
});

// --------------------------------------------------------------------------
// canTransition — forbidden edges the matrix must reject
// --------------------------------------------------------------------------

test('transition matrix rejects self-loops, backward moves, and out-of-terminal moves', () => {
  assert.equal(canTransition('open', 'open'), false, 'no self-loop on open');
  assert.equal(canTransition('acknowledged', 'open'), false, 'no backward to open');
  assert.equal(canTransition('in_progress', 'acknowledged'), false, 'no backward to acknowledged');
  assert.equal(canTransition('resolved', 'open'), false, 'terminal resolved is a dead end');
  assert.equal(canTransition('expired', 'in_progress'), false, 'terminal expired is a dead end');
  // Forward-valid edges still hold (guard against an over-broad "reject all" mutant).
  assert.equal(canTransition('open', 'in_progress'), true);
  assert.equal(canTransition('acknowledged', 'resolved'), true);
  // Every terminal is terminal.
  for (const t of ['resolved', 'expired', 'cancelled', 'superseded']) {
    assert.equal(isTerminal(t), true, `${t} is terminal`);
  }
  assert.equal(isTerminal('open'), false);
});

// --------------------------------------------------------------------------
// recordNotificationOutcome — reason trimming to null
// --------------------------------------------------------------------------

test('recordNotificationOutcome trims the reason and maps blank/whitespace to null', () => {
  const rec = baseAttention();
  const trimmed = recordNotificationOutcome(rec, { now: NOW, outcome: 'suppressed', reason: '  quiet_hours  ' });
  assert.equal(trimmed.notification_reason, 'quiet_hours', 'reason is trimmed');

  const blank = recordNotificationOutcome(rec, { now: NOW, outcome: 'failed', reason: '   ' });
  assert.equal(blank.notification_reason, null, 'whitespace-only reason collapses to null');

  const missing = recordNotificationOutcome(rec, { now: NOW, outcome: 'failed' });
  assert.equal(missing.notification_reason, null, 'omitted reason is null');
});

// --------------------------------------------------------------------------
// decideDedupe — cooldown boundary arithmetic
// --------------------------------------------------------------------------

test('decideDedupe cooldown boundary: strictly-less suppresses, exactly-at creates', () => {
  const terminal = { ...baseAttention(), lifecycle: 'resolved', updated_at: '2026-06-01T00:00:00.000Z' };
  const proposed = {
    id: 'att_2',
    dedupe_key: 'conn:reason:kind',
    connection_id: 'cin_1',
    reason_code: 'needs_input',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    now: '2026-06-01T00:00:30.000Z', // exactly 30s later
  };
  // 30s elapsed < 60s cooldown => suppress.
  assert.deepEqual(
    decideDedupe({ existing: terminal, proposed, cooldown_seconds: 60 }),
    { kind: 'suppress', reason: 'cooldown' }
  );
  // elapsed (30) is NOT < 30 => create at the exact boundary.
  assert.deepEqual(
    decideDedupe({ existing: terminal, proposed, cooldown_seconds: 30 }),
    { kind: 'create' }
  );
});

test('decideDedupe: no existing record always creates', () => {
  assert.deepEqual(decideDedupe({ existing: null, proposed: {}, cooldown_seconds: 999 }), { kind: 'create' });
});

test('decideDedupe: reversed clock (proposed before existing.updated_at) clamps elapsed to 0 => cooldown suppress', () => {
  const terminal = { ...baseAttention(), lifecycle: 'cancelled', updated_at: '2026-06-01T12:00:00.000Z' };
  const proposed = {
    id: 'att_3',
    dedupe_key: 'conn:reason:kind',
    connection_id: 'cin_1',
    reason_code: 'needs_input',
    progress_posture: 'blocked',
    owner_action: 'provide_value',
    response_contract: 'response_required',
    now: '2026-06-01T06:00:00.000Z', // BEFORE updated_at
  };
  // secondsBetween clamps to 0, which is < any positive cooldown => suppress.
  assert.deepEqual(
    decideDedupe({ existing: terminal, proposed, cooldown_seconds: 1 }),
    { kind: 'suppress', reason: 'cooldown' }
  );
});

// --------------------------------------------------------------------------
// redactMetadata — long-value truncation (observed via createAttention)
// --------------------------------------------------------------------------

test('long non-secret metadata strings are truncated to 256 chars with an ellipsis', () => {
  const long = 'x'.repeat(300);
  const short = 'y'.repeat(256); // exactly at the limit — NOT truncated
  const rec = baseAttention({ metadata: { note: long, exact: short } });
  assert.equal(rec.metadata.note.length, 257, '256 chars + the ellipsis character');
  assert.ok(rec.metadata.note.endsWith('…'));
  assert.equal(rec.metadata.note.slice(0, 256), 'x'.repeat(256));
  // A value exactly 256 long is left intact (boundary is length > 256).
  assert.equal(rec.metadata.exact, short);
});

test('secret-looking metadata keys are redacted before the record is frozen', () => {
  const rec = baseAttention({ metadata: { api_key: 'sk-live-123', normal: 'ok' } });
  assert.equal(rec.metadata.api_key, '[redacted]');
  assert.equal(rec.metadata.normal, 'ok');
});

// --------------------------------------------------------------------------
// pushPayload — URL shaping + copy table
// --------------------------------------------------------------------------

test('pushPayload strips a trailing slash from origin and percent-encodes the id', () => {
  const rec = baseAttention({ id: 'att/with space' });
  const payload = pushPayload(rec, { connection_display: 'Chase', dashboard_origin: 'https://dash.example/' });
  assert.equal(payload.url, 'https://dash.example/attention/att%2Fwith%20space');
});

test('pushPayload copy table matches owner_action exactly (provide_value / operate_attachment / act_elsewhere)', () => {
  const opts = { connection_display: 'Chase', dashboard_origin: 'https://d' };
  const provide = pushPayload(baseAttention({ owner_action: 'provide_value' }), opts);
  assert.equal(provide.title, 'Owner input needed');
  assert.equal(provide.body, 'Chase needs a code or value.');

  const operate = pushPayload(
    baseAttention({ owner_action: 'operate_attachment', response_contract: 'none' }),
    opts
  );
  assert.equal(operate.title, 'Owner action needed');
  assert.equal(operate.body, 'Chase needs to complete a step.');

  const elsewhere = pushPayload(
    baseAttention({ owner_action: 'act_elsewhere', response_contract: 'none' }),
    opts
  );
  assert.equal(elsewhere.title, 'Approve in your other app');
  assert.equal(elsewhere.body, 'Chase needs to approve a prompt outside the dashboard.');
});

test('pushPayload uses the generic label when source is hidden or display is null', () => {
  const rec = baseAttention();
  const hidden = pushPayload(rec, { connection_display: 'Chase', dashboard_origin: 'https://d', hide_source: true });
  assert.equal(hidden.body, 'A connection needs a code or value.');
  const noName = pushPayload(rec, { connection_display: null, dashboard_origin: 'https://d' });
  assert.equal(noName.body, 'A connection needs a code or value.');
  // The tag is the dedupe key; assert it survives shaping (tag drives OS coalescing).
  assert.equal(hidden.tag, rec.dedupe_key);
});

// --------------------------------------------------------------------------
// isHealthRelevant — the act_elsewhere carve-out
// --------------------------------------------------------------------------

test('isHealthRelevant: act_elsewhere alone is NOT health-relevant, but response_required flips it', () => {
  // act_elsewhere with no response contract and non-blocked posture: not relevant.
  const elsewhere = baseAttention({
    owner_action: 'act_elsewhere',
    response_contract: 'none',
    progress_posture: 'waiting_retry',
  });
  assert.equal(isHealthRelevant(elsewhere, NOW), false);
  // Same action but response_required: now relevant (first gate wins).
  const withContract = baseAttention({ owner_action: 'act_elsewhere', response_contract: 'response_required' });
  assert.equal(isHealthRelevant(withContract, NOW), true);
});
