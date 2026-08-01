// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { SynthesizedRevalidationAnchor } from "../runtime/scheduler/synthesized-attention-revalidation.ts";
import {
  DEFAULT_INITIAL_REVALIDATION_DELAY_MS,
  DEFAULT_MAX_REVALIDATION_DELAY_MS,
  decideSynthesizedRevalidation,
} from "../runtime/scheduler/synthesized-attention-revalidation.ts";

function anchor(atMs: number, attempt = 0): SynthesizedRevalidationAnchor {
  return { anchorAt: new Date(atMs).toISOString(), attempt };
}

test("no prior anchor: never admits immediately, arms initial delay from now", () => {
  const now = 1_000_000;
  const decision = decideSynthesizedRevalidation(null, now);
  assert.equal(decision.admit, false);
  assert.equal(decision.attempt, 0);
  assert.equal(decision.delayMs, DEFAULT_INITIAL_REVALIDATION_DELAY_MS);
  assert.equal(decision.nextEligibleAt, new Date(now + DEFAULT_INITIAL_REVALIDATION_DELAY_MS).toISOString());
});

test("first anchor: not admitted before the initial delay elapses", () => {
  const skipAt = 1_000_000;
  const now = skipAt + 1000; // 1 second later, far short of 30 minutes
  const decision = decideSynthesizedRevalidation(anchor(skipAt), now, { initialDelayMs: 30 * 60 * 1000 });
  assert.equal(decision.admit, false);
  assert.equal(decision.attempt, 0);
});

test("first anchor: admitted exactly once the initial delay elapses", () => {
  const skipAt = 1_000_000;
  const initialDelayMs = 30 * 60 * 1000;
  const now = skipAt + initialDelayMs;
  const decision = decideSynthesizedRevalidation(anchor(skipAt), now, { initialDelayMs });
  assert.equal(decision.admit, true);
  assert.equal(decision.attempt, 0);
});

test("a failed probe re-arms the cooldown from the failure, not the original sighting", () => {
  const skipAt = 1_000_000;
  const initialDelayMs = 30 * 60 * 1000;
  const failAt = skipAt + initialDelayMs; // the admitted attempt happens here
  const afterFailAnchor = anchor(failAt, 1);

  // Immediately after the failed probe: not due (doubling means 2x initial).
  const justAfterFail = decideSynthesizedRevalidation(afterFailAnchor, failAt + 1000, { initialDelayMs });
  assert.equal(justAfterFail.admit, false);
  assert.equal(justAfterFail.attempt, 1);
  assert.equal(justAfterFail.delayMs, initialDelayMs * 2);

  // Only 30 min after the failure (the ORIGINAL initial delay, not doubled) — still not due.
  const oneIntervalLater = decideSynthesizedRevalidation(afterFailAnchor, failAt + initialDelayMs, { initialDelayMs });
  assert.equal(oneIntervalLater.admit, false, "doubled delay must not admit at the un-doubled interval");

  // A full doubled interval after the failure — now due.
  const twoIntervalsLater = decideSynthesizedRevalidation(afterFailAnchor, failAt + initialDelayMs * 2, {
    initialDelayMs,
  });
  assert.equal(twoIntervalsLater.admit, true);
});

test("repeated failed probes double the delay monotonically up to the cap", () => {
  const initialDelayMs = 60_000; // 1 min, small unit for fast exponent growth in the test
  const maxDelayMs = 5_000_000;
  let t = 0;
  let attempt = 0;
  let currentAnchor: SynthesizedRevalidationAnchor = anchor(t, attempt);
  const observedDelays: number[] = [];

  for (let round = 0; round < 12; round += 1) {
    const decision = decideSynthesizedRevalidation(currentAnchor, t, { initialDelayMs, maxDelayMs });
    observedDelays.push(decision.delayMs);
    // Advance to exactly when this round's probe is admitted, then record its failure.
    t += decision.delayMs;
    attempt += 1;
    currentAnchor = anchor(t, attempt);
  }

  for (let i = 1; i < observedDelays.length; i += 1) {
    assert.ok(
      (observedDelays[i] ?? 0) >= (observedDelays[i - 1] ?? 0),
      `delay must be monotonically non-decreasing: round ${i} was ${observedDelays[i]}, previous was ${observedDelays[i - 1]}`
    );
  }
  assert.ok((observedDelays[0] ?? 0) >= initialDelayMs, "first delay must be bounded below by the initial floor");
  for (const d of observedDelays) {
    assert.ok(d <= maxDelayMs, `delay ${d} must never exceed the cap ${maxDelayMs}`);
  }
  assert.ok(
    observedDelays.some((d) => d === maxDelayMs),
    "the cap must actually bind within 12 rounds, not be dead code"
  );
});

test("mutation check: removing the cap allows delay to exceed maxDelayMs (proves the cap assertion is load-bearing)", () => {
  const initialDelayMs = 60_000;
  const maxExp = 20; // deliberately large so 2^20 * 60s vastly exceeds any sane cap
  const uncappedDelay = initialDelayMs * 2 ** Math.min(11, maxExp);
  assert.ok(uncappedDelay > DEFAULT_MAX_REVALIDATION_DELAY_MS, "the uncapped math must exceed the production cap");
  // decideSynthesizedRevalidation itself must still clamp — proves Math.min(...) is not a no-op.
  const decision = decideSynthesizedRevalidation(anchor(11 * 60_000, 11), 11 * 60_000, {
    initialDelayMs,
    maxBackoffExp: maxExp,
    maxDelayMs: DEFAULT_MAX_REVALIDATION_DELAY_MS,
  });
  assert.ok(
    decision.delayMs <= DEFAULT_MAX_REVALIDATION_DELAY_MS,
    `capped delay ${decision.delayMs} must not exceed ${DEFAULT_MAX_REVALIDATION_DELAY_MS}`
  );
});

test("a cleared anchor (succeeded probe) starts a subsequent new failure fresh with the initial delay", () => {
  const initialDelayMs = 30 * 60 * 1000;
  const newSkipAt = 5_000_000;
  // A succeeded probe clears the anchor entirely (pre-run-gate.ts's
  // gateAttention calls synthesizedRevalidationStore.clear() when evidence
  // resolves) — simulated here by a brand-new anchor with attempt: 0,
  // exactly what a fresh pending-skip sighting creates after clear().
  const freshAnchor = anchor(newSkipAt, 0);

  const rightAfterNewSkip = decideSynthesizedRevalidation(freshAnchor, newSkipAt + 1000, { initialDelayMs });
  assert.equal(rightAfterNewSkip.attempt, 0, "attempt count resets after a success clears the prior streak");
  assert.equal(
    rightAfterNewSkip.admit,
    false,
    "must not admit immediately even after a healed-then-reoccurring failure"
  );
  assert.equal(rightAfterNewSkip.delayMs, initialDelayMs, "must get the FULL initial delay again, no residual memory");
});

test("malformed anchorAt timestamp: treated exactly like no anchor, never crashes or admits immediately", () => {
  const now = 1_000_000;
  const decision = decideSynthesizedRevalidation({ anchorAt: "not-a-real-timestamp", attempt: 3 }, now, {
    initialDelayMs: 30 * 60 * 1000,
  });
  assert.equal(decision.admit, false);
  assert.equal(decision.delayMs, 30 * 60 * 1000);
});

test("negative or fractional attempt counts are normalized, never produce a negative exponent", () => {
  const now = 1_000_000;
  const decision = decideSynthesizedRevalidation(anchor(now - 1000, -5), now, { initialDelayMs: 1000 });
  assert.equal(decision.attempt, 0, "a negative stored attempt must floor to 0, not underflow the exponent");
  assert.equal(decision.delayMs, 1000);
});
