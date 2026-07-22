// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdaptiveLane } from "./adaptive-lane.ts";
import { ProviderBudgetController } from "./provider-budget.ts";
import { ProviderPacing } from "./provider-pacing.ts";
import { PreflightWaitProbe, type SendGovernor } from "./send-governor.ts";

test("PreflightWaitProbe: counts only non-zero pre-flight waits", async () => {
  const probe = new PreflightWaitProbe();
  const slept: number[] = [];
  const wrapped = probe.wrap((ms) => {
    slept.push(ms);
  });
  await wrapped(0);
  await wrapped(0);
  assert.equal(probe.count, 0, "zero-delay waits are not gates");
  await wrapped(500);
  await wrapped(250);
  assert.equal(probe.count, 2);
  assert.equal(probe.totalMs, 750);
  assert.deepEqual(slept, [0, 0, 500, 250], "the underlying sleep is always called");
  probe.reset();
  assert.equal(probe.count, 0);
  assert.equal(probe.totalMs, 0);
});

test("STACKING REGRESSION: a converged ChatGPT-shaped request path has exactly ONE pre-flight wait source", async () => {
  // Reconstruct the live ChatGPT composition: an adaptive concurrency lane
  // (the send governor) PLUS a provider-budget controller carrying a GCRA
  // pacing bucket. In `"signal"` mode the controller does not sleep — its
  // pacing is folded into the lane's single launch wait. The probe must see
  // exactly one wait source per admitted request.
  const probe = new PreflightWaitProbe();
  let clock = 0;
  const now = (): number => clock;
  const tick = (ms: number): void => {
    clock += ms;
  };
  const sleep = probe.wrap((ms: number) => {
    tick(ms);
  });

  const controller = new ProviderBudgetController({
    pacing: { initialIntervalMs: 2500, minIntervalMs: 250, now, sleep: (ms) => Promise.resolve(sleep(ms)) },
    pacingMode: "signal",
  });

  const lane = createAdaptiveLane<string>({
    name: "stacking.regression",
    classifyOutcome: () => ({ kind: "ok" }),
    initialConcurrency: 1,
    maxConcurrency: 1,
    minConcurrency: 1,
    maxAttempts: 1,
    maxQueueSize: 8,
    minDelayMs: 1500,
    maxDelayMs: 3000,
    random: () => 0.5,
    sleep,
    // Pacing is a SIGNAL folded into the lane's single launch wait, not a gate.
    launchDelayHint: () => controller.pacingDelayHint(),
  });

  // First launch: lane launchDelay is 0 (launchCount 0), pacing hint anchors at
  // its full interval (2500). One wait source.
  probe.reset();
  await lane.run(async () => {
    const gate = await controller.beforeRequest();
    assert.ok(gate.ok);
    return "a";
  });
  assert.equal(probe.count, 1, "first request waits through exactly one pre-flight source");

  // Second launch: lane launchDelay = 2250 (mid of 1500..3000 at random 0.5),
  // pacing hint computes its interval; the lane takes the MAX, ONE wait.
  probe.reset();
  await lane.run(async () => {
    const gate = await controller.beforeRequest();
    assert.ok(gate.ok);
    return "b";
  });
  assert.equal(probe.count, 1, "second request still has exactly one pre-flight wait source — no stacking");
});

test("STACKING DETECTOR: the legacy preflight mode IS detectably a second gate", async () => {
  // Demonstrates the probe actually catches stacking: with the controller in
  // legacy `"preflight"` mode AND a lane launch delay, two waits fire.
  const probe = new PreflightWaitProbe();
  let clock = 0;
  const sleep = probe.wrap((ms: number) => {
    clock += ms;
  });
  const controller = new ProviderBudgetController({
    pacing: { initialIntervalMs: 2500, now: () => clock, sleep: (ms) => Promise.resolve(sleep(ms)) },
    pacingMode: "preflight",
  });
  const lane = createAdaptiveLane<string>({
    name: "stacking.detector",
    classifyOutcome: () => ({ kind: "ok" }),
    initialConcurrency: 1,
    maxConcurrency: 1,
    minConcurrency: 1,
    maxAttempts: 1,
    maxQueueSize: 8,
    minDelayMs: 1500,
    maxDelayMs: 3000,
    random: () => 0.5,
    sleep,
  });
  // Prime one launch so the second has a non-zero lane launch delay.
  await lane.run(async () => "warm");
  probe.reset();
  await lane.run(async () => {
    await controller.beforeRequest(); // legacy mode sleeps here too
    return "x";
  });
  assert.equal(probe.count, 2, "legacy preflight mode + lane launch delay = TWO pre-flight waits (the anti-pattern)");
});

test("ProviderBudgetController: signal mode performs no pre-flight wait in beforeRequest", async () => {
  const slept: number[] = [];
  const controller = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 2500,
      now: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
    pacingMode: "signal",
  });
  const gate = await controller.beforeRequest();
  assert.ok(gate.ok);
  assert.deepEqual(slept, [], "signal mode never sleeps inside beforeRequest");
  // The owed delay is instead exposed as a hint for the single governor.
  assert.equal(controller.pacingDelayHint(), 2500, "the hint carries the GCRA interval");
});

test("ProviderBudgetController: preflight mode still sleeps in beforeRequest (legacy parity)", async () => {
  const slept: number[] = [];
  const controller = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 2500,
      now: () => 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    },
    pacingMode: "preflight",
  });
  await controller.beforeRequest();
  assert.deepEqual(slept, [2500], "preflight mode owns the wait, unchanged");
  assert.equal(controller.pacingDelayHint(), 0, "preflight mode yields no hint (would double-count)");
});

test("ProviderBudgetController: nextDelayMs equals what admit() would have slept (signal parity)", () => {
  // Two identical pacing configs: one consumed via the controller hint, one via
  // ProviderPacing.admit()'s delay. They must agree.
  const a = new ProviderBudgetController({
    pacing: { initialIntervalMs: 1000, now: () => 0 },
    pacingMode: "signal",
  });
  const direct = new ProviderPacing({ initialIntervalMs: 1000, now: () => 0 });
  assert.equal(a.pacingDelayHint(), direct.nextDelayMs());
});

test("SendGovernor: acquire is the single sanctioned pre-flight wait", async () => {
  const probe = new PreflightWaitProbe();
  const noopSleep = probe.wrap(() => undefined);
  const pacing = new ProviderPacing({
    initialIntervalMs: 800,
    now: () => 0,
    sleep: (ms) => Promise.resolve(noopSleep(ms)),
  });
  const governor: SendGovernor = { acquire: () => pacing.admit() };
  await governor.acquire();
  assert.equal(probe.count, 1, "one acquire = one pre-flight wait");
});
