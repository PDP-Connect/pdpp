// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveReferenceFreshness } from '../server/freshness.ts';

const NOW = '2026-05-01T12:00:00.000Z';

test('deriveReferenceFreshness reports current inside maximum staleness', () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastSuccessfulRunAt: '2026-05-01T11:30:00.000Z',
      lastAttemptedAt: '2026-05-01T11:30:00.000Z',
      lastAttemptStatus: 'succeeded',
      maximumStalenessSeconds: 3600,
      now: NOW,
    }),
    {
      status: 'current',
      captured_at: '2026-05-01T11:30:00.000Z',
      last_attempted_at: '2026-05-01T11:30:00.000Z',
    },
  );
});

test('deriveReferenceFreshness reports stale outside maximum staleness', () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastSuccessfulRunAt: '2026-05-01T09:00:00.000Z',
      lastAttemptedAt: '2026-05-01T09:00:00.000Z',
      lastAttemptStatus: 'succeeded',
      maximumStalenessSeconds: 3600,
      now: NOW,
    }),
    {
      status: 'stale',
      captured_at: '2026-05-01T09:00:00.000Z',
      last_attempted_at: '2026-05-01T09:00:00.000Z',
    },
  );
});

test('deriveReferenceFreshness reports stale for latest failed attempt after success', () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastSuccessfulRunAt: '2026-05-01T11:45:00.000Z',
      lastAttemptedAt: '2026-05-01T11:55:00.000Z',
      lastAttemptStatus: 'failed',
      maximumStalenessSeconds: 3600,
      now: NOW,
    }),
    {
      status: 'stale',
      captured_at: '2026-05-01T11:45:00.000Z',
      last_attempted_at: '2026-05-01T11:55:00.000Z',
    },
  );
});

test('deriveReferenceFreshness does not fabricate attempted time from record timestamps', () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      recordLastUpdatedAt: '2026-05-01T11:45:00.000Z',
      now: NOW,
    }),
    {
      status: 'unknown',
      captured_at: '2026-05-01T11:45:00.000Z',
    },
  );
});

test('deriveReferenceFreshness keeps successful run unknown without maximum staleness policy', () => {
  assert.deepEqual(
    deriveReferenceFreshness({
      lastSuccessfulRunAt: '2026-05-01T11:45:00.000Z',
      lastAttemptedAt: '2026-05-01T11:45:00.000Z',
      lastAttemptStatus: 'succeeded',
      now: NOW,
    }),
    {
      status: 'unknown',
      captured_at: '2026-05-01T11:45:00.000Z',
      last_attempted_at: '2026-05-01T11:45:00.000Z',
    },
  );
});
