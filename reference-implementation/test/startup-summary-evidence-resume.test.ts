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

import assert from "node:assert/strict";
import test from "node:test";

import { runStartupSummaryEvidenceSweepToCompletion as runStartupSummaryEvidenceSweepToCompletionUntyped } from "../server/index.ts";

interface SweepPage {
  discovered: number;
  incomplete: boolean;
  repaired: number;
  resumeAfterId: string | null;
  skipped: number;
  [key: string]: unknown;
}

interface RunSweepArgs {
  afterId?: string | null;
  maxDurationMs?: number;
  maxEventsPerFold?: number;
  pageSize?: number;
}

// `server/index.js` is plain JS: the destructured params with no defaults
// make TS infer `maxEventsPerFold`/`onRound` as required, even though the
// function body defensively `typeof`-checks both before using them (see the
// ...(typeof maxEventsPerFold === 'number' ? ... : {}) spread and the
// typeof onRound === 'function' guard). Re-typed here via the same
// documented pattern used elsewhere in this cohort for unchecked-JS
// signature gaps: import the real export and cast it to a signature
// matching how it is actually called.
function sweepPage(value: Record<string, unknown>): SweepPage {
  assert.ok(typeof value.discovered === "number");
  assert.ok(typeof value.incomplete === "boolean");
  assert.ok(typeof value.repaired === "number");
  assert.ok(typeof value.skipped === "number");
  assert.ok(value.resumeAfterId === null || typeof value.resumeAfterId === "string");
  return {
    discovered: value.discovered,
    incomplete: value.incomplete,
    repaired: value.repaired,
    resumeAfterId: value.resumeAfterId,
    skipped: value.skipped,
  };
}

async function runStartupSummaryEvidenceSweepToCompletion(args: {
  maxDurationMs: number;
  maxEventsPerFold?: number;
  maxRounds: number;
  onRound?: (summary: SweepPage, round: number) => void;
  pageSize: number;
  runSweep: (args: RunSweepArgs) => Promise<SweepPage>;
}): Promise<SweepPage[]> {
  const { maxDurationMs, maxEventsPerFold, maxRounds, onRound, pageSize, runSweep } = args;
  const callback = onRound
    ? (summary: Record<string, unknown>, round: number) => onRound(sweepPage(summary), round)
    : null;
  const rounds = await runStartupSummaryEvidenceSweepToCompletionUntyped({
    maxDurationMs,
    maxRounds,
    pageSize,
    runSweep: async ({
      afterId,
      maxDurationMs: sweepMaxDurationMs,
      maxEventsPerFold: sweepMaxEventsPerFold,
      pageSize: sweepPageSize,
    }) =>
      runSweep({
        ...(afterId === undefined ? {} : { afterId }),
        ...(sweepMaxDurationMs === undefined ? {} : { maxDurationMs: sweepMaxDurationMs }),
        ...(sweepMaxEventsPerFold === undefined ? {} : { maxEventsPerFold: sweepMaxEventsPerFold }),
        ...(sweepPageSize === undefined ? {} : { pageSize: sweepPageSize }),
      }),
    ...(maxEventsPerFold === undefined ? {} : { maxEventsPerFold }),
    onRound: callback,
  });
  return rounds.map(sweepPage);
}

function fakeSweep(pages: SweepPage[]) {
  // `pages` is the exact sequence of summaries this fake sweep function
  // returns, one per call, regardless of the (maxDurationMs, pageSize,
  // afterId) it's actually invoked with — the calls themselves are
  // recorded so the test can assert the cursor was genuinely threaded
  // through.
  const calls: RunSweepArgs[] = [];
  let i = 0;
  return {
    calls,
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    async runSweep(args: RunSweepArgs): Promise<SweepPage> {
      calls.push(args);
      const page = pages[Math.min(i, pages.length - 1)];
      i += 1;
      if (!page) {
        throw new Error("fakeSweep called with no pages configured");
      }
      return page;
    },
  };
}

test("a genuinely complete sweep (incomplete: false on round 1) runs exactly once and never resumes", async () => {
  const { calls, runSweep } = fakeSweep([
    { discovered: 5, incomplete: false, repaired: 0, resumeAfterId: null, skipped: 0 },
  ]);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    maxDurationMs: 5000,
    maxRounds: 20,
    pageSize: 25,
    runSweep,
  });
  assert.equal(rounds.length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0], "expected exactly one recorded call");
  assert.equal(calls[0].afterId, null, "the first round starts from the beginning (no cursor yet)");
});

test("an incomplete sweep genuinely resumes: round 2 is called with round 1's resumeAfterId, not from the beginning", async () => {
  const { calls, runSweep } = fakeSweep([
    { discovered: 25, incomplete: true, repaired: 0, resumeAfterId: "cin_page1_last", skipped: 0 },
    { discovered: 10, incomplete: false, repaired: 0, resumeAfterId: null, skipped: 0 },
  ]);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    maxDurationMs: 5000,
    maxRounds: 20,
    pageSize: 25,
    runSweep,
  });
  assert.equal(
    rounds.length,
    2,
    "the resumed round genuinely ran — this is the exact gap Sol found: before this fix, only round 1 ever ran"
  );
  assert.ok(calls[0] && calls[1], "expected two recorded calls");
  assert.equal(calls[0].afterId, null);
  assert.equal(
    calls[1].afterId,
    "cin_page1_last",
    "round 2 must start from round 1's cursor, proving the resume is genuine rather than restarting from scratch"
  );
  assert.ok(rounds[1], "expected two recorded rounds");
  assert.equal(
    rounds[1].incomplete,
    false,
    "the walk reaches genuine completion once the resumed round covers the rest"
  );
});

test("a sweep that never converges stops at the round cap rather than looping forever", async () => {
  // Every round reports incomplete with a DIFFERENT cursor each time
  // (simulating genuine progress that never quite catches up within a
  // single call's deadline) — without a cap this would loop forever.
  const pages = Array.from({ length: 50 }, (_, i) => ({
    discovered: 25,
    incomplete: true,
    repaired: 0,
    resumeAfterId: `cin_page_${i}`,
    skipped: 0,
  }));
  const { calls, runSweep } = fakeSweep(pages);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    maxDurationMs: 5000,
    maxRounds: 5,
    pageSize: 25,
    runSweep,
  });
  assert.equal(
    rounds.length,
    5,
    "the walk stops at exactly maxRounds, never fewer (genuine progress every round) and never more (the cap is real)"
  );
  assert.equal(calls.length, 5);
  const lastRound = rounds.at(-1);
  assert.ok(lastRound, "expected at least one recorded round");
  assert.equal(
    lastRound.incomplete,
    true,
    "the final round is still genuinely incomplete — the cap stopped it, not natural completion"
  );
});

test("onRound is invoked once per round with the round number, in order", async () => {
  const { runSweep } = fakeSweep([
    { discovered: 25, incomplete: true, repaired: 3, resumeAfterId: "cin_a", skipped: 0 },
    { discovered: 5, incomplete: false, repaired: 0, resumeAfterId: null, skipped: 0 },
  ]);
  const observed: Array<{ incomplete: boolean; round: number }> = [];
  await runStartupSummaryEvidenceSweepToCompletion({
    maxDurationMs: 5000,
    maxRounds: 20,
    onRound: (summary, round) => observed.push({ incomplete: summary.incomplete, round }),
    pageSize: 25,
    runSweep,
  });
  assert.deepEqual(observed, [
    { incomplete: true, round: 1 },
    { incomplete: false, round: 2 },
  ]);
});

test("a resumeAfterId of null on an incomplete result (no further cursor available) still stops the walk rather than looping with a null cursor", async () => {
  // Defensive case: an incomplete result with no cursor at all (should not
  // happen in practice, but must not spin forever if it did).
  const { calls, runSweep } = fakeSweep([
    { discovered: 25, incomplete: true, repaired: 0, resumeAfterId: null, skipped: 0 },
  ]);
  const rounds = await runStartupSummaryEvidenceSweepToCompletion({
    maxDurationMs: 5000,
    maxRounds: 20,
    pageSize: 25,
    runSweep,
  });
  assert.equal(rounds.length, 1);
  assert.equal(calls.length, 1, "no resume is attempted without a genuine cursor to resume from");
});

test("every round's maxDurationMs/pageSize are passed through unchanged across the whole walk", async () => {
  const { calls, runSweep } = fakeSweep([
    { discovered: 25, incomplete: true, repaired: 0, resumeAfterId: "cin_a", skipped: 0 },
    { discovered: 25, incomplete: false, repaired: 0, resumeAfterId: null, skipped: 0 },
  ]);
  await runStartupSummaryEvidenceSweepToCompletion({
    maxDurationMs: 1234,
    maxRounds: 20,
    pageSize: 7,
    runSweep,
  });
  for (const call of calls) {
    assert.equal(call.maxDurationMs, 1234);
    assert.equal(call.pageSize, 7);
  }
});
