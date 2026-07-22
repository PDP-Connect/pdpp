// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the two UNTESTED streaming-progress projection exports of
 * `runtime/connector-verdict-input.ts`:
 *
 *   - `progressMode({localDeviceBacked, refresh, schedule, hasRecoveredDetailGaps})`
 *     — the priority ladder that chooses which "did it work?" model the rendered
 *     verdict privileges (design D9). Exact order:
 *       1. localDeviceBacked            => "local_device"
 *       2. enabled schedule + gaps      => "deferred"
 *       3. no enabled schedule          => "manual"
 *       4. manual-refresh-only refresh  => "manual"
 *       5. otherwise                    => "scheduled"
 *     Manual-refresh-only is decided by `isManualRefreshOnly`:
 *       null refresh => false; else backgroundSafe===false OR
 *       recommendedMode in {"manual","paused"}.
 *
 *   - `buildProgressEvidence({mode, retainedRecords, recordsCommittedLastRun,
 *     gapsDrainedLastRun, lastRefreshedAt, observedAt?})` — a pure camelCase ->
 *     snake_case field map. Every numeric field is nullable and passes through
 *     verbatim (the synthesizer never fabricates a number); `observed_at`
 *     defaults to null when the caller omits it.
 *
 * The sibling `connector-verdict-input.test.js` covers `streamPriority` and
 * `buildStreamRollups`; neither `progressMode` nor `buildProgressEvidence` is
 * referenced by name anywhere in the suite. These are pure — no DB, no server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  progressMode,
  buildProgressEvidence,
} from '../runtime/connector-verdict-input.ts';

// --- progressMode: priority ladder -----------------------------------------

test('progressMode: local_device wins over every other signal', () => {
  const out = progressMode({
    localDeviceBacked: true,
    // Even with scheduled+gaps and a manual refresh set, local_device short-circuits.
    schedule: { enabled: true },
    hasRecoveredDetailGaps: true,
    refresh: { recommendedMode: 'manual', backgroundSafe: false },
  });
  assert.equal(out, 'local_device', `got ${out}`);
});

test('progressMode: scheduled + recovered detail gaps => deferred (below local_device)', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: { enabled: true },
    hasRecoveredDetailGaps: true,
    // manual refresh present but deferred outranks manual in the ladder.
    refresh: { recommendedMode: 'manual', backgroundSafe: false },
  });
  assert.equal(out, 'deferred', `got ${out}`);
});

test('progressMode: scheduled but NO recovered gaps does NOT trigger deferred', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: { enabled: true },
    hasRecoveredDetailGaps: false,
    refresh: null,
  });
  assert.equal(out, 'scheduled', `scheduled+no-gaps must fall through to scheduled, got ${out}`);
});

// NOTE (unify): the original autoquality/w6 draft of this test asserted that a
// non-scheduled connection with recovered gaps (and null refresh) falls through
// to `scheduled`. Harvest's shipped progressMode ladder deliberately maps ANY
// connection without an enabled schedule to `manual` (see the `schedule ===
// null` rule and the harvest-native test "progressMode is manual for a
// non-scheduled connection" in connector-verdict-input-mappers.test.js). The
// two ladders conflict; harvest's is the retained contract, so this superseded
// case is dropped rather than forcing a source change to a contested god-file.

test('progressMode: manual via recommendedMode="manual" when not local/deferred', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: null,
    hasRecoveredDetailGaps: false,
    refresh: { recommendedMode: 'manual', backgroundSafe: true },
  });
  assert.equal(out, 'manual', `got ${out}`);
});

test('progressMode: manual via recommendedMode="paused"', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: null,
    hasRecoveredDetailGaps: false,
    refresh: { recommendedMode: 'paused', backgroundSafe: true },
  });
  assert.equal(out, 'manual', `paused refresh must map to manual, got ${out}`);
});

test('progressMode: manual via backgroundSafe=false even when recommendedMode is auto', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: null,
    hasRecoveredDetailGaps: false,
    refresh: { recommendedMode: 'auto', backgroundSafe: false },
  });
  assert.equal(out, 'manual', `backgroundSafe=false must map to manual, got ${out}`);
});

test('progressMode: null refresh + not local/deferred => scheduled (not manual)', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: { enabled: true },
    hasRecoveredDetailGaps: false,
    refresh: null,
  });
  assert.equal(out, 'scheduled', `null refresh must NOT be manual, got ${out}`);
});

test('progressMode: explicit manual-default background-safe schedule stays scheduled', () => {
  const out = progressMode({
    localDeviceBacked: false,
    schedule: { enabled: true },
    hasRecoveredDetailGaps: false,
    refresh: { recommendedMode: 'manual', backgroundSafe: true },
  });
  assert.equal(out, 'scheduled', `explicit owner schedule must stay scheduled, got ${out}`);
});

// NOTE (unify): the autoquality/w6 draft asserted that a non-scheduled
// connection with a background-safe auto refresh resolves to `scheduled`.
// Harvest's shipped ladder maps connections without an enabled schedule to
// `manual` regardless of the refresh mode (the `schedule?.enabled !== true`
// rule runs before the refresh check). Dropped as a superseded expectation
// against harvest's retained contract.

// --- buildProgressEvidence: field mapping ----------------------------------

test('buildProgressEvidence: maps camelCase input to snake_case evidence verbatim', () => {
  const out = buildProgressEvidence({
    mode: 'deferred',
    retainedRecords: 1200,
    recordsCommittedLastRun: 0,
    gapsDrainedLastRun: 7,
    lastRefreshedAt: '2026-07-02T10:00:00.000Z',
    observedAt: '2026-07-02T11:00:00.000Z',
  });
  assert.deepEqual(
    out,
    {
      mode: 'deferred',
      retained_records: 1200,
      records_committed_last_run: 0,
      gaps_drained_last_run: 7,
      last_refreshed_at: '2026-07-02T10:00:00.000Z',
      observed_at: '2026-07-02T11:00:00.000Z',
    },
    `got ${JSON.stringify(out)}`,
  );
});

test('buildProgressEvidence: preserves null facts (never fabricates a number)', () => {
  const out = buildProgressEvidence({
    mode: 'scheduled',
    retainedRecords: null,
    recordsCommittedLastRun: null,
    gapsDrainedLastRun: null,
    lastRefreshedAt: null,
    observedAt: null,
  });
  assert.deepEqual(
    out,
    {
      mode: 'scheduled',
      retained_records: null,
      records_committed_last_run: null,
      gaps_drained_last_run: null,
      last_refreshed_at: null,
      observed_at: null,
    },
    `got ${JSON.stringify(out)}`,
  );
});

test('buildProgressEvidence: omitted observedAt defaults observed_at to null', () => {
  const out = buildProgressEvidence({
    mode: 'manual',
    retainedRecords: 5,
    recordsCommittedLastRun: 5,
    gapsDrainedLastRun: 0,
    lastRefreshedAt: '2026-07-01T00:00:00.000Z',
    // observedAt intentionally omitted
  });
  assert.equal('observed_at' in out, true, 'observed_at key must be present');
  assert.equal(out.observed_at, null, 'observed_at must default to null');
  assert.equal(out.mode, 'manual');
  assert.equal(out.retained_records, 5);
});

test('buildProgressEvidence: distinguishes 0 from null (does not coerce zero away)', () => {
  const out = buildProgressEvidence({
    mode: 'deferred',
    retainedRecords: 0,
    recordsCommittedLastRun: 0,
    gapsDrainedLastRun: 0,
    lastRefreshedAt: null,
  });
  assert.strictEqual(out.retained_records, 0, 'zero retained must stay 0, not null');
  assert.strictEqual(out.records_committed_last_run, 0);
  assert.strictEqual(out.gaps_drained_last_run, 0);
});
