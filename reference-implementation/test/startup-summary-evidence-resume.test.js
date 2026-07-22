// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Startup actually SCHEDULES a follow-up sweep using the cursor it returns
 * (Sol third-verdict P2.1 / minimum-closure item 3): "startup exposes a
 * resume cursor but does not resume — the cursor is exposed but startup
 * never actually reschedules using it." `runBoundedSummaryEvidenceSweep`'s
 * own resumability contract (afterId/resumeAfterId, complete-set pruning
 * gating) is already exhaustively proven at the function level by
 * `connector-summary-evidence-bounded-sweep.test.js`; this file proves the
 * NEW piece — `runStartupSummaryEvidenceSweepToCompletion` (extracted from
 * `startServer`'s startup block in server/index.js) genuinely walks a
 * multi-round incomplete sweep to completion by re-passing the returned
 * cursor, and stops at the round cap rather than looping forever.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { runStartupSummaryEvidenceSweepToCompletion } from '../server/index.js';

function fakeSweep(pages) {
  // `pages` is the exact sequence of summaries this fake sweep function
  // returns, one per call, regardless of the (maxDurationMs, pageSize,
  // afterId) it's actually invoked with — the calls themselves are
  // recorded so the test can assert the cursor was genuinely threaded
  // through.
  const calls = [];
  let i = 0;
  return {
    calls,
    async runSweep(args) {
      calls.push(args);
      const page = pages[Math.min(i, pages.length - 1)];
      i += 1;
      return page;
    },
  };
}

test('a genuinely complete sweep (incomplete: false on round 1) runs exactly once and never resumes', async () => {
  const { calls, runSweep } = fakeSweep([{ incomplete: false, resumeAfterId: null, discovered: 5, repaired: 0, skipped: 0 }]);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    runSweep,
    maxDurationMs: 5000,
    pageSize: 25,
    maxRounds: 20,
  });
  assert.equal(rounds.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].afterId, null, 'the first round starts from the beginning (no cursor yet)');
});

test('an incomplete sweep genuinely resumes: round 2 is called with round 1\'s resumeAfterId, not from the beginning', async () => {
  const { calls, runSweep } = fakeSweep([
    { incomplete: true, resumeAfterId: 'cin_page1_last', discovered: 25, repaired: 0, skipped: 0 },
    { incomplete: false, resumeAfterId: null, discovered: 10, repaired: 0, skipped: 0 },
  ]);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    runSweep,
    maxDurationMs: 5000,
    pageSize: 25,
    maxRounds: 20,
  });
  assert.equal(rounds.length, 2, 'the resumed round genuinely ran — this is the exact gap Sol found: before this fix, only round 1 ever ran');
  assert.equal(calls[0].afterId, null);
  assert.equal(
    calls[1].afterId,
    'cin_page1_last',
    'round 2 must start from round 1\'s cursor, proving the resume is genuine rather than restarting from scratch',
  );
  assert.equal(rounds[1].incomplete, false, 'the walk reaches genuine completion once the resumed round covers the rest');
});

test('a sweep that never converges stops at the round cap rather than looping forever', async () => {
  // Every round reports incomplete with a DIFFERENT cursor each time
  // (simulating genuine progress that never quite catches up within a
  // single call's deadline) — without a cap this would loop forever.
  const pages = Array.from({ length: 50 }, (_, i) => ({
    incomplete: true,
    resumeAfterId: `cin_page_${i}`,
    discovered: 25,
    repaired: 0,
    skipped: 0,
  }));
  const { calls, runSweep } = fakeSweep(pages);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    runSweep,
    maxDurationMs: 5000,
    pageSize: 25,
    maxRounds: 5,
  });
  assert.equal(rounds.length, 5, 'the walk stops at exactly maxRounds, never fewer (genuine progress every round) and never more (the cap is real)');
  assert.equal(calls.length, 5);
  assert.equal(rounds.at(-1).incomplete, true, 'the final round is still genuinely incomplete — the cap stopped it, not natural completion');
});

test('onRound is invoked once per round with the round number, in order', async () => {
  const { runSweep } = fakeSweep([
    { incomplete: true, resumeAfterId: 'cin_a', discovered: 25, repaired: 3, skipped: 0 },
    { incomplete: false, resumeAfterId: null, discovered: 5, repaired: 0, skipped: 0 },
  ]);
  const observed = [];
  await runStartupSummaryEvidenceSweepToCompletion({
    runSweep,
    maxDurationMs: 5000,
    pageSize: 25,
    maxRounds: 20,
    onRound: (summary, round) => observed.push({ round, incomplete: summary.incomplete }),
  });
  assert.deepEqual(observed, [
    { round: 1, incomplete: true },
    { round: 2, incomplete: false },
  ]);
});

test('a resumeAfterId of null on an incomplete result (no further cursor available) still stops the walk rather than looping with a null cursor', async () => {
  // Defensive case: an incomplete result with no cursor at all (should not
  // happen in practice, but must not spin forever if it did).
  const { calls, runSweep } = fakeSweep([{ incomplete: true, resumeAfterId: null, discovered: 25, repaired: 0, skipped: 0 }]);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    runSweep,
    maxDurationMs: 5000,
    pageSize: 25,
    maxRounds: 20,
  });
  assert.equal(rounds.length, 1);
  assert.equal(calls.length, 1, 'no resume is attempted without a genuine cursor to resume from');
});

test('every round\'s maxDurationMs/pageSize are passed through unchanged across the whole walk', async () => {
  const { calls, runSweep } = fakeSweep([
    { incomplete: true, resumeAfterId: 'cin_a', discovered: 25, repaired: 0, skipped: 0 },
    { incomplete: false, resumeAfterId: null, discovered: 25, repaired: 0, skipped: 0 },
  ]);
  await runStartupSummaryEvidenceSweepToCompletion({
    runSweep,
    maxDurationMs: 1234,
    pageSize: 7,
    maxRounds: 20,
  });
  for (const call of calls) {
    assert.equal(call.maxDurationMs, 1234);
    assert.equal(call.pageSize, 7);
  }
});
