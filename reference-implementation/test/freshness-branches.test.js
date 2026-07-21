// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing coverage for the branches of `server/freshness.ts`
 * (`deriveReferenceFreshness`) the existing freshness.test.js leaves open:
 *
 *   - the `<=` staleness boundary (exactly at max -> current; one ms past ->
 *     stale) — a `<=`→`<` mutant would survive today.
 *   - `cancelled` as a failure status (existing test only uses `failed`).
 *   - a failed attempt OLDER than the last success (does NOT force stale;
 *     falls through to the staleness window) — the `lastAttemptedTime >=
 *     lastSuccessfulTime` clause.
 *   - a failed attempt with no attempt timestamp (lastAttemptedTime null ->
 *     not failure-stale).
 *   - malformed / empty timestamps normalize to null (status unknown, no
 *     captured_at) rather than throwing or fabricating a value.
 *   - the recordLastUpdatedAt fallback DRIVING status under a staleness
 *     policy (existing test only reaches it in the no-policy unknown case).
 *   - `now` accepted as an epoch number.
 *
 * Pure timing derivation; no grant/auth logic touched.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveReferenceFreshness } from '../server/freshness.ts';

const NOW = '2026-05-16T12:00:00.000Z';

// ─── staleness boundary ──────────────────────────────────────────────────

test('deriveReferenceFreshness is current when captured exactly at the staleness boundary', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '2026-05-16T11:00:00.000Z', // exactly 3600s before NOW
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'current');
});

test('deriveReferenceFreshness is stale one second past the staleness boundary', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '2026-05-16T10:59:59.000Z',
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'stale');
});

// ─── failure-status handling ─────────────────────────────────────────────

test('deriveReferenceFreshness treats a cancelled latest attempt after success as stale', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '2026-05-16T11:00:00.000Z',
    lastAttemptedAt: '2026-05-16T11:30:00.000Z',
    lastAttemptStatus: 'cancelled',
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'stale');
});

test('deriveReferenceFreshness does not force stale when the failed attempt predates the last success', () => {
  // Attempt older than success -> the failure clause is false; status is
  // then decided by the (fresh) staleness window on the success.
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '2026-05-16T11:30:00.000Z',
    lastAttemptedAt: '2026-05-16T10:00:00.000Z',
    lastAttemptStatus: 'failed',
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'current');
  assert.equal(result.captured_at, '2026-05-16T11:30:00.000Z');
});

test('deriveReferenceFreshness reports stale for a failed attempt with no prior success', () => {
  const result = deriveReferenceFreshness({
    lastAttemptedAt: '2026-05-16T11:30:00.000Z',
    lastAttemptStatus: 'failed',
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'stale');
  assert.equal(result.captured_at, undefined);
  assert.equal(result.last_attempted_at, '2026-05-16T11:30:00.000Z');
});

test('deriveReferenceFreshness does not fail-stale when there is no attempt timestamp', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '2026-05-16T11:00:00.000Z',
    lastAttemptStatus: 'failed', // but lastAttemptedAt absent -> clause false
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'current');
});

// ─── malformed / empty timestamps ────────────────────────────────────────

test('deriveReferenceFreshness normalizes an unparseable success timestamp to unknown', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: 'not-a-date',
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.deepEqual(result, { status: 'unknown' });
});

test('deriveReferenceFreshness treats an empty-string success as absent and uses the record fallback', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '',
    recordLastUpdatedAt: '2026-05-16T11:00:00.000Z',
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(result.status, 'current');
  assert.equal(result.captured_at, '2026-05-16T11:00:00.000Z');
});

// ─── recordLastUpdatedAt fallback drives status under a policy ────────────

test('deriveReferenceFreshness uses recordLastUpdatedAt as captured_at when no successful run is known', () => {
  const stale = deriveReferenceFreshness({
    recordLastUpdatedAt: '2026-05-16T09:00:00.000Z', // 3h old, over the 1h window
    maximumStalenessSeconds: 3600,
    now: NOW,
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.captured_at, '2026-05-16T09:00:00.000Z');
});

// ─── now accepted as an epoch number ─────────────────────────────────────

test('deriveReferenceFreshness accepts an epoch-number now', () => {
  const result = deriveReferenceFreshness({
    lastSuccessfulRunAt: '2026-05-16T11:00:00.000Z',
    maximumStalenessSeconds: 3600,
    now: Date.parse(NOW),
  });
  assert.equal(result.status, 'current');
});
