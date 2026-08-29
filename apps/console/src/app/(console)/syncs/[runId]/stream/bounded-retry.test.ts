// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle tests for the stream page's shared bounded-retry primitive.
 *
 * These drive the primitive the way the page does — a loop that asks for a
 * decision, makes an attempt, and repeats — and COUNT the attempts a fake
 * transport actually received. Counting is the point: the owner's acceptance
 * criterion is "zero further network attempts after terminal entry", and a
 * test that only asserted a boolean flag had flipped would not have caught the
 * original defect, which was a live `setInterval` nobody cleared.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { BoundedRetryPolicy, BoundedRetryState } from "./bounded-retry.ts";
import {
  createBoundedRetryState,
  enterTerminalLifecycle,
  isTerminalLifecycle,
  nextRetryDecision,
  RESOLUTION_POLL_POLICY,
  recordRetryAttempt,
  terminalRetryMessage,
} from "./bounded-retry.ts";

const CONTINUING_COPY_RE = /continuing/i;
const CLOSE_PAGE_COPY_RE = /close this page/i;
/** Protocol vocabulary the owner must never be shown. */
const PROTOCOL_VOCABULARY_RE = /reap|EventSource|SSE|poll|token/i;
const COLLECTION_CONTINUING_RE = /Collection is continuing/;
const CLOSE_PAGE_EXACT_RE = /close this page/;
/** The exact unbounded shape that froze the owner's machine. */
const RAW_REFRESH_INTERVAL_RE = /setInterval\(\s*\(\)\s*=>\s*router\.refresh\(\)/;
const BOUNDED_RETRY_CALL_RE = /nextRetryDecision\(/;

/**
 * A counting stand-in for every network-touching call the page can make
 * (`router.refresh()`, the timeline `fetch`, an SSE attach). The page's freeze
 * was a refresh storm, so the unit under observation is "how many times did we
 * touch the network", not "what did we render".
 */
function createTransportCounter() {
  let attempts = 0;
  const delays: number[] = [];
  return {
    get attempts() {
      return attempts;
    },
    get delays(): readonly number[] {
      return delays;
    },
    record(delayMs: number) {
      attempts += 1;
      delays.push(delayMs);
    },
  };
}

/**
 * Run the retry loop to a stop, exactly as the page's scheduler does: ask,
 * attempt, record, repeat. `onAttempt` can flip the world to terminal to model
 * a resolution arriving mid-flight.
 */
function driveUntilStopped({
  onAttempt,
  policy = RESOLUTION_POLL_POLICY,
  safetyLimit = 1000,
}: {
  onAttempt?: (attemptNumber: number) => "reaped" | "resolved" | null;
  policy?: BoundedRetryPolicy;
  safetyLimit?: number;
} = {}) {
  const transport = createTransportCounter();
  let state: BoundedRetryState = createBoundedRetryState();
  let iterations = 0;

  for (;;) {
    iterations += 1;
    // A real infinite loop must fail the test, not hang CI forever. The
    // original defect was unbounded, so an unbounded test loop would have
    // reproduced the freeze rather than reporting it.
    assert.ok(iterations <= safetyLimit, `retry loop did not stop within ${safetyLimit} iterations`);

    const decision = nextRetryDecision(state, policy);
    if (!decision.shouldRetry) {
      return { finalState: state, reason: decision.reason, transport };
    }
    transport.record(decision.delayMs);
    state = recordRetryAttempt(state, policy);
    const terminal = onAttempt?.(transport.attempts) ?? null;
    if (terminal) {
      state = enterTerminalLifecycle(state, terminal);
    }
  }
}

// ── Test 2: the freeze itself ────────────────────────────────────────────────

test("dead session does not storm: attempts are capped and delays grow, then a hard stop", () => {
  // A dead/reaped session never publishes a resolution, so nothing ever flips
  // the loop terminal from outside. This is the exact scenario that froze the
  // owner's PC; before the fix it ran forever at a fixed 2.5s.
  const { finalState, reason, transport } = driveUntilStopped();

  assert.equal(reason, "exhausted");
  assert.equal(transport.attempts, RESOLUTION_POLL_POLICY.maxAttempts);
  assert.equal(finalState.lifecycle, "exhausted");

  // Delays must GROW, not sit at a constant cadence. A cap alone would still
  // let a fixed 2.5s poll fire 12 times in 30 seconds.
  const delays = [...transport.delays];
  assert.ok(delays.length > 1);
  const firstDelay = delays.at(0) ?? 0;
  const lastDelay = delays.at(-1) ?? 0;
  assert.ok(lastDelay > firstDelay, `expected backoff to grow, got ${JSON.stringify(delays)}`);
  for (let index = 1; index < delays.length; index += 1) {
    const previous = delays.at(index - 1) ?? 0;
    const current = delays.at(index) ?? 0;
    assert.ok(current >= previous, `backoff must be monotonic non-decreasing, got ${JSON.stringify(delays)}`);
  }
});

test("no attempt follows the cap, even when the scheduler asks again", () => {
  const { finalState, transport } = driveUntilStopped();
  const attemptsAtStop = transport.attempts;

  // Simulate a late timer, a focus event, and a reconnect all racing in after
  // the hard stop. Each asks the primitive for permission; none may get it.
  let state = finalState;
  for (let index = 0; index < 50; index += 1) {
    const decision = nextRetryDecision(state, RESOLUTION_POLL_POLICY);
    assert.equal(decision.shouldRetry, false);
    state = recordRetryAttempt(state, RESOLUTION_POLL_POLICY);
  }

  assert.equal(transport.attempts, attemptsAtStop);
  assert.equal(state.attempts, RESOLUTION_POLL_POLICY.maxAttempts);
});

// ── Test 1 / owner's acceptance criterion ────────────────────────────────────

test("terminal entry stops every transport: exactly 0 network attempts afterwards", () => {
  // Resolution arrives on the 3rd poll — the ordinary happy path.
  const { finalState, reason, transport } = driveUntilStopped({
    onAttempt: (attemptNumber) => (attemptNumber === 3 ? "resolved" : null),
  });

  assert.equal(reason, "resolved");
  assert.equal(transport.attempts, 3);
  assert.ok(isTerminalLifecycle(finalState.lifecycle));

  // THE acceptance criterion. Count attempts made from the terminal state and
  // assert the count is exactly 0 — not that a flag flipped. Every transport
  // the page owns is modelled here: the resolution poll, the timeline probe,
  // and an SSE re-attach.
  const afterTerminal = createTransportCounter();
  for (const transportName of ["resolution-poll", "timeline-probe", "sse-attach"]) {
    for (let tick = 0; tick < 100; tick += 1) {
      const decision = nextRetryDecision(finalState, RESOLUTION_POLL_POLICY);
      if (decision.shouldRetry) {
        afterTerminal.record(decision.delayMs);
        assert.fail(`${transportName} attempted a network call after terminal entry`);
      }
    }
  }
  assert.equal(afterTerminal.attempts, 0, "an answered assist must make zero further network attempts");
});

test("a reaped surface is terminal for every transport and never resumes", () => {
  const reaped = enterTerminalLifecycle(createBoundedRetryState(), "reaped");
  const transport = createTransportCounter();

  for (let tick = 0; tick < 200; tick += 1) {
    const decision = nextRetryDecision(reaped, RESOLUTION_POLL_POLICY);
    if (decision.shouldRetry) {
      transport.record(decision.delayMs);
    }
  }

  assert.equal(transport.attempts, 0);
  assert.deepEqual(nextRetryDecision(reaped, RESOLUTION_POLL_POLICY), {
    reason: "reaped",
    shouldRetry: false,
  });
});

// ── Test 3: the stuck skeleton ───────────────────────────────────────────────

test("stuck skeleton resolves to a calm terminal message instead of spinning forever", () => {
  // "Stuck skeleton" is the page never receiving the state that would end the
  // wait. The loop must convert that into a terminal outcome with owner-facing
  // copy, rather than an eternal spinner.
  const { reason, transport } = driveUntilStopped();

  assert.equal(reason, "exhausted");
  assert.ok(transport.attempts > 0, "the page must genuinely try before giving up");

  const message = terminalRetryMessage(reason);
  assert.match(message, CONTINUING_COPY_RE);
  assert.match(message, CLOSE_PAGE_COPY_RE);
  // No protocol vocabulary in owner-facing copy.
  assert.doesNotMatch(message, PROTOCOL_VOCABULARY_RE);
});

test("terminal copy tells the owner collection continues, for every stop reason", () => {
  for (const reason of ["exhausted", "reaped", "resolved"] as const) {
    const message = terminalRetryMessage(reason);
    assert.match(message, COLLECTION_CONTINUING_RE);
    assert.match(message, CLOSE_PAGE_EXACT_RE);
  }
});

// ── Absorbing-state invariants ───────────────────────────────────────────────

test("terminal states absorb: a late attempt cannot resurrect the loop or inflate the count", () => {
  const resolved = enterTerminalLifecycle({ attempts: 4, lifecycle: "active" }, "resolved");
  const afterLateTimer = recordRetryAttempt(resolved, RESOLUTION_POLL_POLICY);

  assert.equal(afterLateTimer.lifecycle, "resolved");
  assert.equal(afterLateTimer.attempts, 4, "a late timer must not inflate the attempt count");
});

test("resolution is never downgraded to exhausted", () => {
  // Budget is spent, but the assist succeeded. The owner must keep the
  // reassuring message, not be told we gave up.
  const spent: BoundedRetryState = { attempts: RESOLUTION_POLL_POLICY.maxAttempts, lifecycle: "resolved" };
  const decision = nextRetryDecision(spent, RESOLUTION_POLL_POLICY);

  assert.equal(decision.shouldRetry, false);
  assert.equal(decision.shouldRetry === false && decision.reason, "resolved");
});

test("the attempt budget is bounded even if a caller ignores the decision", () => {
  // Defense in depth: a future site that calls recordRetryAttempt in a loop
  // without consulting nextRetryDecision still cannot exceed the cap.
  let state = createBoundedRetryState();
  for (let index = 0; index < 500; index += 1) {
    state = recordRetryAttempt(state, RESOLUTION_POLL_POLICY);
  }

  assert.equal(state.attempts, RESOLUTION_POLL_POLICY.maxAttempts);
  assert.equal(state.lifecycle, "exhausted");
});

// ── R2: defense in depth, at the source level ────────────────────────────────

test("no stream-page retry loop reintroduces an unbounded repeating timer", () => {
  // The defect was not a subtle logic error — it was a bare `setInterval` that
  // re-ran the server page loader forever. A future edit that adds one back
  // would silently restore the freeze, so the ban is enforced mechanically on
  // the two files that own the page's retry loops.
  for (const fileName of ["stream-viewer.tsx", "no-assistance-run-poller.tsx"]) {
    const source = readFileSync(fileURLToPath(new URL(`./${fileName}`, import.meta.url)), "utf8");
    assert.doesNotMatch(
      source,
      RAW_REFRESH_INTERVAL_RE,
      `${fileName} must schedule refreshes through the bounded-retry primitive, not a raw interval`
    );
    assert.match(source, BOUNDED_RETRY_CALL_RE, `${fileName} must consult the shared bounded-retry primitive`);
  }
});

test("the shipped resolution poll policy is bounded in both dimensions", () => {
  // Guards the policy itself: an edit that restored an unbounded cadence or an
  // effectively-infinite cap would reintroduce the freeze.
  assert.ok(RESOLUTION_POLL_POLICY.maxAttempts > 0);
  assert.ok(RESOLUTION_POLL_POLICY.maxAttempts <= 50, "the attempt cap must stay a real bound");
  assert.ok(RESOLUTION_POLL_POLICY.backoffMs.length > 1, "a single-entry ladder is a constant cadence");
  const ladder = RESOLUTION_POLL_POLICY.backoffMs;
  assert.ok((ladder.at(-1) ?? 0) > (ladder.at(0) ?? 0), "the ladder must actually back off");
});
