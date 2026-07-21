import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserSurfaceLeaseSweepTimer } from "../runtime/browser-surface-lease-sweep-timer.ts";

function createFakeTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setIntervalFn: (callback, ms) => {
      const id = nextId++;
      scheduled.set(id, { callback, ms });
      return id;
    },
    clearIntervalFn: (id) => {
      scheduled.delete(id);
    },
    scheduled,
    fire(id) {
      const entry = scheduled.get(id);
      if (!entry) {
        throw new Error(`no scheduled timer with id ${id}`);
      }
      entry.callback();
    },
  };
}

test("start creates exactly one interval at the configured cadence", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  timer.start();

  assert.equal(fake.scheduled.size, 1);
  const [, entry] = [...fake.scheduled.entries()][0];
  assert.equal(entry.ms, 30_000);
});

test("calling start twice does not create a second interval", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  timer.start();
  timer.start();
  timer.start();

  assert.equal(fake.scheduled.size, 1);
});

test("stop clears the interval", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  timer.start();
  assert.equal(fake.scheduled.size, 1);

  timer.stop();
  assert.equal(fake.scheduled.size, 0);
});

test("stop before start and repeated stop calls are safe no-ops", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  // Never started.
  timer.stop();
  assert.equal(fake.scheduled.size, 0);

  timer.start();
  timer.stop();
  timer.stop();
  timer.stop();
  assert.equal(fake.scheduled.size, 0);
});

test("a tick after stop never fires — the callback is unreachable once cleared", () => {
  const fake = createFakeTimers();
  let sweepCalls = 0;
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {
      sweepCalls += 1;
    },
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  timer.start();
  const [id] = [...fake.scheduled.keys()];
  fake.fire(id);
  assert.equal(sweepCalls, 1);

  timer.stop();
  // The fake clearIntervalFn actually removes the entry, so nothing is left
  // to fire — this is the deterministic proxy for "no real OS timer fires
  // after stop": the scheduler-level record is gone, not merely a flag.
  assert.equal(fake.scheduled.size, 0);
});

test("repeated start/stop cycles (simulating repeated startServer/stop) never accumulate timers", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  for (let cycle = 0; cycle < 5; cycle += 1) {
    timer.start();
    assert.equal(fake.scheduled.size, 1, `cycle ${cycle}: exactly one interval while running`);
    timer.stop();
    assert.equal(fake.scheduled.size, 0, `cycle ${cycle}: cleared after stop`);
  }
});

test("a fresh timer instance per cycle (a real repeated startServer call) also never accumulates timers", () => {
  const fake = createFakeTimers();
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const timer = createBrowserSurfaceLeaseSweepTimer({
      sweep: async () => {},
      intervalMs: 30_000,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    timer.start();
    timer.stop();
  }
  assert.equal(fake.scheduled.size, 0);
});

test("on tick, sweep() is invoked; a rejected sweep is routed to onSweepError, not thrown", async () => {
  const fake = createFakeTimers();
  let sweepCalls = 0;
  const errors = [];
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {
      sweepCalls += 1;
      throw new Error("sweep failed");
    },
    intervalMs: 30_000,
    onSweepError: (err) => errors.push(err),
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });

  timer.start();
  const [id] = [...fake.scheduled.keys()];
  fake.fire(id);

  // The callback fires synchronously but sweep() is async; let its rejection
  // settle before asserting.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sweepCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "sweep failed");
});
