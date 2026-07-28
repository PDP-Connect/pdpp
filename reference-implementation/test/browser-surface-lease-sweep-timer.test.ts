// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserSurfaceLeaseSweepTimer } from "../runtime/browser-surface-lease-sweep-timer.ts";

function mustExist<T>(value: T | null | undefined, description: string): T {
  assert.ok(value, description);
  return value;
}

// createBrowserSurfaceLeaseSweepTimer's injected setIntervalFn/clearIntervalFn
// are typed against the real NodeJS.Timeout so production callers get real
// type safety. This fake only ever treats that value as an opaque handle
// (Map key + Symbol.toPrimitive for readable ids) — it never calls ref()/
// unref()/close(), so those are harmless stubs satisfying the interface, not
// behavior the tests below depend on.
interface FakeTimeoutHandle extends NodeJS.Timeout {
  readonly fakeId: number;
}

function makeFakeTimeoutHandle(fakeId: number): FakeTimeoutHandle {
  const handle: Partial<FakeTimeoutHandle> = {
    fakeId,
    [Symbol.toPrimitive]: () => fakeId,
    [Symbol.dispose]: () => {
      /* intentionally empty */
    },
    close() {
      return handle as FakeTimeoutHandle;
    },
    hasRef: () => true,
    ref() {
      return handle as FakeTimeoutHandle;
    },
    refresh() {
      return handle as FakeTimeoutHandle;
    },
    unref() {
      return handle as FakeTimeoutHandle;
    },
  };
  return handle as FakeTimeoutHandle;
}

interface ScheduledEntry {
  readonly callback: () => void;
  readonly ms: number;
}

function createFakeTimers() {
  let nextId = 1;
  const scheduled = new Map<FakeTimeoutHandle, ScheduledEntry>();
  return {
    clearIntervalFn: (id: NodeJS.Timeout) => {
      scheduled.delete(id as FakeTimeoutHandle);
    },
    fire(id: FakeTimeoutHandle) {
      const entry = scheduled.get(id);
      if (!entry) {
        throw new Error(`no scheduled timer with id ${id.fakeId}`);
      }
      entry.callback();
    },
    scheduled,
    setIntervalFn: (callback: () => void, ms: number): NodeJS.Timeout => {
      // biome-ignore lint/suspicious/noAssignInExpressions: Loop guard mutation is deliberately coupled to cursor progression.
      const handle = makeFakeTimeoutHandle((nextId += 1));
      scheduled.set(handle, { callback, ms });
      return handle;
    },
  };
}

test("start creates exactly one interval at the configured cadence", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    sweep: async () => {
      /* intentionally empty */
    },
  });

  timer.start();

  assert.equal(fake.scheduled.size, 1);
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const first = [...fake.scheduled.entries()][0];
  assert.ok(first);
  const [, entry] = first;
  assert.equal(entry.ms, 30_000);
});

test("calling start twice does not create a second interval", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    sweep: async () => {
      /* intentionally empty */
    },
  });

  timer.start();
  timer.start();
  timer.start();

  assert.equal(fake.scheduled.size, 1);
});

test("stop clears the interval", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    sweep: async () => {
      /* intentionally empty */
    },
  });

  timer.start();
  assert.equal(fake.scheduled.size, 1);

  timer.stop();
  assert.equal(fake.scheduled.size, 0);
});

test("stop before start and repeated stop calls are safe no-ops", () => {
  const fake = createFakeTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    sweep: async () => {
      /* intentionally empty */
    },
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
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    sweep: async () => {
      sweepCalls += 1;
    },
  });

  timer.start();
  const id = mustExist([...fake.scheduled.keys()][0], "timer was scheduled");
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
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    sweep: async () => {
      /* intentionally empty */
    },
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
      clearIntervalFn: fake.clearIntervalFn,
      intervalMs: 30_000,
      setIntervalFn: fake.setIntervalFn,
      sweep: async () => {
        /* intentionally empty */
      },
    });
    timer.start();
    timer.stop();
  }
  assert.equal(fake.scheduled.size, 0);
});

test("on tick, sweep() is invoked; a rejected sweep is routed to onSweepError, not thrown", async () => {
  const fake = createFakeTimers();
  let sweepCalls = 0;
  const errors: unknown[] = [];
  const timer = createBrowserSurfaceLeaseSweepTimer({
    clearIntervalFn: fake.clearIntervalFn,
    intervalMs: 30_000,
    onSweepError: (err) => errors.push(err),
    setIntervalFn: fake.setIntervalFn,
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    sweep: async () => {
      sweepCalls += 1;
      throw new Error("sweep failed");
    },
  });

  timer.start();
  const id = mustExist([...fake.scheduled.keys()][0], "timer was scheduled");
  fake.fire(id);

  // The callback fires synchronously but sweep() is async; let its rejection
  // settle before asserting.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sweepCalls, 1);
  assert.equal(errors.length, 1);
  const firstError = mustExist(errors[0], "one sweep error recorded");
  assert.ok(firstError instanceof Error);
  assert.equal(firstError.message, "sweep failed");
});
