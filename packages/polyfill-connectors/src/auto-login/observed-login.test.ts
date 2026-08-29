// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavior tests for the shared owner-browser-action paved road.
 *
 * The acceptance criterion, in the owner's words: "the owner never clicks
 * Continue for a sign-in the system can observe succeeded." These tests prove
 * the four guarantees that criterion rests on:
 *
 *   1. Observed success resumes the run with NO owner response.
 *   2. An exhausted budget still falls back to the blocking Continue ask, so a
 *      genuinely stuck sign-in is not silently abandoned.
 *   3. The poll checkpoints EVERY iteration, so a long-but-progressing wait does
 *      not trip the session-establishment watchdog's no-progress deadline. The
 *      control case proves the checkpoint is load-bearing rather than decorative.
 *   4. A DECLARED-unobservable site still blocks immediately — the fix is not
 *      over-applied to states no probe can settle.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { type AssistanceRequest, makeSessionEstablishWatchdog } from "../connector-runtime.ts";
import {
  type ObservationBudget,
  observationAttempts,
  pollForObservedLogin,
  requestOwnerBrowserAction,
  resolveObservationBudgetMs,
} from "./observed-login.ts";

// ─── fakes ──────────────────────────────────────────────────────────────────

/** A budget whose `wait` is instant, optionally driving a logical clock. */
function makeBudget(attempts: number, onWait?: (ms: number) => void | Promise<void>): ObservationBudget {
  return {
    attempts,
    intervalMs: 5000,
    wait: async (ms: number) => {
      await onWait?.(ms);
    },
  };
}

function makeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function makeStubPageForWatchdog(): Page {
  const fake: Pick<Page, "isClosed"> = { isClosed: () => false };
  return fake as Page;
}

/** A short real-time yield so the watchdog's interval timer can observe the clock. */
const realTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

// ─── 1. the acceptance criterion ────────────────────────────────────────────

test("ACCEPTANCE: an observed sign-in resumes the run without the owner clicking Continue", async () => {
  const assistanceRequests: AssistanceRequest[] = [];
  const completions: Array<{ id: string; status: string }> = [];
  let blockingAsks = 0;

  // Success becomes observable on the 3rd poll — inside the budget.
  let polls = 0;
  const result = await requestOwnerBrowserAction<string>({
    assist: (req) => {
      assistanceRequests.push(req);
      return Promise.resolve("asst_1");
    },
    blockingAsk: () => {
      blockingAsks += 1;
      return Promise.resolve("blocked");
    },
    completeAssistance: (id, status) => {
      completions.push({ id, status });
      return Promise.resolve();
    },
    message: "Finish the check in the browser.",
    mode: {
      kind: "observable",
      budget: makeBudget(10, () => {
        polls += 1;
      }),
      probe: { observe: () => Promise.resolve(polls >= 3 ? "live" : null) },
      waitingCheckpointLabel: "test-waiting",
    },
  });

  assert.equal(result, "live", "the observed session result is what the caller receives");
  assert.equal(blockingAsks, 0, "THE CRITERION: no blocking Continue ask was ever emitted");
  assert.equal(assistanceRequests.length, 1, "exactly one non-blocking assistance was emitted");
  assert.deepEqual(completions, [{ id: "asst_1", status: "resolved" }], "the assistance resolved, not escalated");
});

test("the non-blocking assistance is shaped so the runtime does not treat it as a blocking ask", async () => {
  const requests: AssistanceRequest[] = [];
  await requestOwnerBrowserAction<string>({
    assist: (req) => {
      requests.push(req);
      return Promise.resolve("asst_1");
    },
    blockingAsk: () => Promise.resolve("blocked"),
    message: "Finish the check in the browser.",
    mode: {
      kind: "observable",
      budget: makeBudget(1),
      probe: { observe: () => Promise.resolve("live") },
      waitingCheckpointLabel: "test-waiting",
    },
  });

  // `assistancePausesWatchdog` in connector-runtime.ts requires BOTH of these.
  assert.equal(requests[0]?.progress_posture, "running");
  assert.equal(requests[0]?.response_contract, "none");
});

// ─── 2. the fallback is preserved ───────────────────────────────────────────

test("an exhausted observation budget falls back to the blocking Continue ask", async () => {
  const completions: Array<{ id: string; status: string }> = [];
  let blockingAsks = 0;

  const result = await requestOwnerBrowserAction<string>({
    assist: () => Promise.resolve("asst_1"),
    blockingAsk: () => {
      blockingAsks += 1;
      return Promise.resolve("owner-confirmed");
    },
    completeAssistance: (id, status) => {
      completions.push({ id, status });
      return Promise.resolve();
    },
    message: "Finish the check in the browser.",
    mode: {
      kind: "observable",
      // Never observable: the budget must expire and the fallback must run.
      budget: makeBudget(3),
      probe: { observe: () => Promise.resolve(null) },
      waitingCheckpointLabel: "test-waiting",
    },
  });

  assert.equal(result, "owner-confirmed", "the fallback's result is returned");
  assert.equal(blockingAsks, 1, "the blocking ask is preserved, not deleted");
  assert.deepEqual(
    completions,
    [{ id: "asst_1", status: "escalated" }],
    "the open assistance is escalated BEFORE the blocking ask, never left live alongside it"
  );
});

// ─── 3. watchdog: the checkpoint is load-bearing ────────────────────────────

test("the observation poll checkpoints each iteration so a long wait does NOT trip the session watchdog", async () => {
  const clock = makeClock();
  let tripped = false;
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "venmo",
    page: makeStubPageForWatchdog(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
    onTrip: () => {
      tripped = true;
    },
  });

  // Success arrives on the 6th poll. Each poll advances the logical clock by
  // 80ms — so by poll 6 the run is 480ms in, far past the 100ms deadline. Only
  // the per-iteration checkpoint keeps the watchdog satisfied.
  let polls = 0;
  let observed: string | null = null;
  await watchdog.run(async () => {
    observed = await pollForObservedLogin<string>({
      budget: makeBudget(20, async () => {
        polls += 1;
        clock.advance(80);
        await realTick();
      }),
      checkpoint: watchdog.checkpoint,
      probe: { observe: () => Promise.resolve(polls >= 6 ? "live" : null) },
      waitingCheckpointLabel: "venmo-handoff-observation-waiting",
    });
  });

  assert.equal(tripped, false, "a checkpointing poll must not trip the session-establishment watchdog");
  assert.equal(observed, "live", "the poll still observes readiness while checkpointing");
});

test("CONTROL: the identical poll WITHOUT the checkpoint hook DOES trip the watchdog", async () => {
  // Proves the checkpoint is what saves the run, not the poll's mere existence.
  // Without this control, the test above would pass even if `checkpoint` were
  // never called — the exact failure mode chatgpt.ts's comment warns about.
  const clock = makeClock();
  const watchdog = makeSessionEstablishWatchdog({
    capture: null,
    name: "venmo",
    page: makeStubPageForWatchdog(),
    deadlineMs: 100,
    pollIntervalMs: 2,
    now: clock.now,
  });

  await assert.rejects(
    watchdog.run(async () => {
      await pollForObservedLogin<string>({
        budget: makeBudget(20, async () => {
          clock.advance(80);
          await realTick();
        }),
        // No checkpoint passed.
        probe: { observe: () => Promise.resolve(null) },
        waitingCheckpointLabel: "venmo-handoff-observation-waiting",
      });
    }),
    /venmo_session_establish_timeout/
  );
});

// ─── 4. the fix is not over-applied ─────────────────────────────────────────

test("REGRESSION: a DECLARED-unobservable site blocks immediately and never polls", async () => {
  let blockingAsks = 0;
  let assistCalls = 0;

  const result = await requestOwnerBrowserAction<string>({
    assist: () => {
      assistCalls += 1;
      return Promise.resolve("asst_1");
    },
    blockingAsk: () => {
      blockingAsks += 1;
      return Promise.resolve("owner-confirmed");
    },
    message: "Clear the bot check.",
    mode: {
      kind: "unobservable",
      justification: {
        evidence:
          "Clearing this challenge reveals the sign-in form; the connector must still submit the saved password, so account liveness cannot become true from the owner's action alone.",
        reason: "success_is_not_session_liveness",
        site: "test:datadome",
      },
    },
  });

  assert.equal(result, "owner-confirmed");
  assert.equal(blockingAsks, 1, "a declared-unobservable state still asks the owner");
  // The `unobservable` mode carries no probe at all, so "never polls" is
  // guaranteed by the type rather than by a counter: there is nothing to call.
  assert.equal(assistCalls, 0, "no non-blocking assistance is emitted for a state nothing can observe");
});

test("with no assist channel wired the owner is asked immediately rather than after the whole budget", async () => {
  // Detect-and-resume needs a non-blocking surface. Without `assist` there is
  // none, so polling first would delay the owner's only prompt by the entire
  // budget while showing them nothing.
  let blockingAsks = 0;
  let probes = 0;
  const progressed: string[] = [];

  const result = await requestOwnerBrowserAction<string>({
    blockingAsk: () => {
      blockingAsks += 1;
      return Promise.resolve("owner-confirmed");
    },
    message: "Finish the check in the browser.",
    mode: {
      kind: "observable",
      budget: makeBudget(1000),
      probe: {
        observe: () => {
          probes += 1;
          return Promise.resolve(null);
        },
      },
      waitingCheckpointLabel: "test-waiting",
    },
    progress: (m) => {
      progressed.push(m);
      return Promise.resolve();
    },
  });

  assert.equal(result, "owner-confirmed");
  assert.equal(blockingAsks, 1);
  assert.equal(probes, 0, "must not burn the budget polling when nothing can show the owner the ask");
  assert.deepEqual(progressed, ["Finish the check in the browser."], "the owner is still told what to do");
});

// ─── budget resolution ──────────────────────────────────────────────────────

test("an unparseable or non-positive budget override is ignored, never honored", () => {
  const D = 900_000;
  assert.equal(resolveObservationBudgetMs({}, "X", D), D, "absent → default");
  assert.equal(resolveObservationBudgetMs({ X: "  " }, "X", D), D, "blank → default");
  assert.equal(resolveObservationBudgetMs({ X: "abc" }, "X", D), D, "unparseable → default");
  // A zero budget would silently disable detect-and-resume and put the owner
  // straight back on the Continue button — the defect this work removes.
  assert.equal(resolveObservationBudgetMs({ X: "0" }, "X", D), D, "zero → default, NOT a disabled poll");
  assert.equal(resolveObservationBudgetMs({ X: "-5" }, "X", D), D, "negative → default");
  assert.equal(resolveObservationBudgetMs({ X: "15000" }, "X", D), 15_000, "a valid override is honored");
});

test("observationAttempts always yields at least one poll", () => {
  assert.equal(observationAttempts(900_000, 5000), 180);
  assert.equal(observationAttempts(1, 5000), 1, "a sub-interval budget still polls once");
});
