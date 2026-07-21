import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareAttentionUrgency,
  pickMostUrgentAttention,
} from '../server/attention-urgency.ts';

console.log('BASELINE: attention urgency oracle active');

function attention(overrides = {}) {
  return {
    response_contract: 'none',
    progress_posture: 'running',
    expires_at: null,
    created_at: '2026-07-06T12:00:00.000Z',
    ...overrides,
  };
}

test('compareAttentionUrgency orders response-required records before optional records', () => {
  const required = attention({ response_contract: 'response_required' });
  const optional = attention({ response_contract: 'none' });

  assert.equal(compareAttentionUrgency(required, optional) < 0, true);
  assert.equal(compareAttentionUrgency(optional, required) > 0, true);
});

test('compareAttentionUrgency orders blocked posture before progressing when response contract ties', () => {
  const blocked = attention({
    response_contract: 'response_required',
    progress_posture: 'blocked',
  });
  const progressing = attention({
    response_contract: 'response_required',
    progress_posture: 'running',
  });

  assert.equal(compareAttentionUrgency(blocked, progressing) < 0, true);
  assert.equal(compareAttentionUrgency(progressing, blocked) > 0, true);
});

test('compareAttentionUrgency orders earlier expiry before later or absent expiry', () => {
  const earlier = attention({ expires_at: '2026-07-06T12:05:00.000Z' });
  const later = attention({ expires_at: '2026-07-06T12:10:00.000Z' });
  const absent = attention({ expires_at: null });

  assert.equal(compareAttentionUrgency(earlier, later) < 0, true);
  assert.equal(compareAttentionUrgency(later, earlier) > 0, true);
  assert.equal(compareAttentionUrgency(earlier, absent) < 0, true);
  assert.equal(compareAttentionUrgency(absent, earlier) > 0, true);
});

test('compareAttentionUrgency uses earlier creation as the final tie-break', () => {
  const earlier = attention({ created_at: '2026-07-06T11:59:00.000Z' });
  const later = attention({ created_at: '2026-07-06T12:01:00.000Z' });

  assert.equal(compareAttentionUrgency(earlier, later) < 0, true);
  assert.equal(compareAttentionUrgency(later, earlier) > 0, true);
});

test('pickMostUrgentAttention returns the comparator winner from an unsorted tuple', () => {
  const optionalSoon = attention({
    expires_at: '2026-07-06T12:01:00.000Z',
    created_at: '2026-07-06T11:58:00.000Z',
  });
  const requiredBlocked = attention({
    response_contract: 'response_required',
    progress_posture: 'blocked',
    expires_at: '2026-07-06T12:30:00.000Z',
    created_at: '2026-07-06T12:02:00.000Z',
  });
  const requiredProgressing = attention({
    response_contract: 'response_required',
    progress_posture: 'running',
    expires_at: '2026-07-06T12:00:30.000Z',
    created_at: '2026-07-06T11:57:00.000Z',
  });

  assert.equal(
    pickMostUrgentAttention([optionalSoon, requiredProgressing, requiredBlocked]),
    requiredBlocked,
  );
});
