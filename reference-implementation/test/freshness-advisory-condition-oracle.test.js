// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONNECTION_CONDITION_REASONS, computeConnectionHealth } from '../runtime/connection-health.ts';

const NOW = '2026-05-19T12:00:00.000Z';

const MANUAL_REFRESH = Object.freeze({
  backgroundSafe: false,
  recommendedMode: 'manual',
});

const ASSISTED_REFRESH = Object.freeze({
  backgroundSafe: true,
  interactionPosture: 'otp_likely',
  recommendedMode: 'automatic',
});

const AUTOMATIC_REFRESH = Object.freeze({
  backgroundSafe: true,
  interactionPosture: 'none',
  recommendedMode: 'automatic',
});

function input(overrides = {}) {
  return {
    schedule: { enabled: true },
    run: succeededRun(),
    backoff: null,
    attention: null,
    coverage: { axis: 'complete' },
    freshness: { axis: 'stale' },
    outbox: { axis: 'idle' },
    projection: null,
    activity: null,
    observedAt: NOW,
    ...overrides,
  };
}

function succeededRun(overrides = {}) {
  return {
    latestStatus: 'succeeded',
    hasDegradingGaps: false,
    lastSuccessAt: '2026-05-19T11:55:00.000Z',
    reasonCode: null,
    ...overrides,
  };
}

function findCondition(snapshot, type) {
  return snapshot.conditions.find((condition) => condition.type === type);
}

test('manual-refresh stale freshness is an info advisory, not a degrading warning', () => {
  const snap = computeConnectionHealth(input({ refresh: MANUAL_REFRESH }));
  const fresh = findCondition(snap, 'Fresh');

  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, CONNECTION_CONDITION_REASONS.STALE_MANUAL_REFRESH);
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  assert.equal(fresh?.status, 'false');
  assert.equal(fresh?.severity, 'info');
  assert.equal(fresh?.reason, CONNECTION_CONDITION_REASONS.STALE_MANUAL_REFRESH);
});

test('assisted-refresh stale freshness is an info advisory, not a degrading warning', () => {
  const snap = computeConnectionHealth(input({ refresh: ASSISTED_REFRESH }));
  const fresh = findCondition(snap, 'Fresh');

  assert.equal(snap.state, 'idle');
  assert.equal(snap.reason_code, CONNECTION_CONDITION_REASONS.STALE_ASSISTED_REFRESH);
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  assert.equal(fresh?.status, 'false');
  assert.equal(fresh?.severity, 'info');
  assert.equal(fresh?.reason, CONNECTION_CONDITION_REASONS.STALE_ASSISTED_REFRESH);
});

test('automatic background-safe stale freshness remains warning and degraded', () => {
  const snap = computeConnectionHealth(input({ refresh: AUTOMATIC_REFRESH }));
  const fresh = findCondition(snap, 'Fresh');

  assert.equal(snap.state, 'degraded');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.badges.stale, true);
  assert.equal(fresh?.status, 'false');
  assert.equal(fresh?.severity, 'warning');
  assert.equal(fresh?.reason, CONNECTION_CONDITION_REASONS.STALE);
});
