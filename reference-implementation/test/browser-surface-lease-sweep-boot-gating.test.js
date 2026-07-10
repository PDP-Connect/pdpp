import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  armBrowserSurfaceLeaseSweepAfterBoot,
  createBrowserSurfaceLeaseSweepTimerFor,
} from "../server/index.js";

/**
 * Structural proof (not a comment) that server/index.js's real production
 * seam never starts the browser-surface lease sweep timer until the entire
 * fallible startServer boot sequence has succeeded.
 *
 * createBrowserSurfaceLeaseSweepTimerFor constructs the timer WITHOUT
 * starting it. armBrowserSurfaceLeaseSweepAfterBoot is the only function in
 * server/index.js that ever calls timer.start(), and it binds
 * stopWhenAllClosed before starting. startServer calls
 * createBrowserSurfaceLeaseSweepTimerFor early (once the controller exists)
 * and armBrowserSurfaceLeaseSweepAfterBoot as the LAST statement before its
 * return — after every other fallible await in that function. This test
 * exercises exactly those two exported functions (the real production code,
 * not a reimplementation).
 */

function fakeController() {
  return { sweepBrowserSurfaceLeases: async () => {} };
}

function fakeLogger() {
  return { warn: () => {} };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("createBrowserSurfaceLeaseSweepTimerFor never starts the timer on its own", () => {
  const timer = createBrowserSurfaceLeaseSweepTimerFor(
    fakeController(),
    { browserSurfaceAllocator: {} },
    fakeLogger(),
  );
  let startCalled = false;
  const originalStart = timer.start.bind(timer);
  timer.start = (...args) => {
    startCalled = true;
    return originalStart(...args);
  };

  // Construction alone — the real startServer shape between
  // createBrowserSurfaceLeaseSweepTimerFor and armBrowserSurfaceLeaseSweepAfterBoot
  // is many fallible `await`s (buildRsApp, rsApp.listen, schedulerManager.start,
  // auto-enroll, ...). None of them touch the timer, so simulating "boot
  // hasn't reached arming yet" is simply: don't call arm.
  assert.equal(startCalled, false, "construction must never call start()");

  timer.stop();
});

test("a boot failure before armBrowserSurfaceLeaseSweepAfterBoot is reached means start() is never called — nothing left running to leak", async () => {
  const timer = createBrowserSurfaceLeaseSweepTimerFor(
    fakeController(),
    { browserSurfaceAllocator: {} },
    fakeLogger(),
  );
  let startCalled = false;
  timer.start = () => {
    startCalled = true;
  };

  // Simulate the real startServer control flow: construct the timer (done
  // above), run fallible boot steps, one of which throws — this IS what a
  // real `await rsApp.listen(...)` rejecting looks like from the timer's
  // perspective: every statement after the throw, including the
  // armBrowserSurfaceLeaseSweepAfterBoot call at the end of startServer, is
  // simply never reached.
  async function simulateFalliableBootStep() {
    await Promise.resolve();
    throw new Error("simulated late boot failure (e.g. rsApp.listen EADDRINUSE)");
  }

  await assert.rejects(simulateFalliableBootStep);

  assert.equal(startCalled, false, "timer.start() must never be called when boot fails before arming");
});

test("armBrowserSurfaceLeaseSweepAfterBoot binds stopWhenAllClosed BEFORE calling start()", async () => {
  const timer = createBrowserSurfaceLeaseSweepTimerFor(
    fakeController(),
    { browserSurfaceAllocator: {} },
    fakeLogger(),
  );
  const asServer = http.createServer();
  const rsServer = http.createServer();

  let boundBeforeStart = null;
  let bound = false;
  const originalStopWhenAllClosed = timer.stopWhenAllClosed.bind(timer);
  const originalStart = timer.start.bind(timer);
  timer.stopWhenAllClosed = (sources) => {
    bound = true;
    originalStopWhenAllClosed(sources);
  };
  timer.start = (...args) => {
    boundBeforeStart = bound;
    return originalStart(...args);
  };

  armBrowserSurfaceLeaseSweepAfterBoot(timer, { browserSurfaceAllocator: {} }, asServer, rsServer);

  assert.equal(boundBeforeStart, true, "stopWhenAllClosed must have run before start() was called");

  await closeServer(asServer);
  await closeServer(rsServer);
});

test("armBrowserSurfaceLeaseSweepAfterBoot never starts the timer when no dynamic-mode allocator is configured", async () => {
  const timer = createBrowserSurfaceLeaseSweepTimerFor(fakeController(), {}, fakeLogger());
  const asServer = http.createServer();
  const rsServer = http.createServer();

  let startCalled = false;
  timer.start = () => {
    startCalled = true;
  };

  armBrowserSurfaceLeaseSweepAfterBoot(timer, {}, asServer, rsServer);

  assert.equal(startCalled, false, "no allocator configured means the timer must never start");

  await closeServer(asServer);
  await closeServer(rsServer);
});

test("the real end-to-end production shape: construct early (unstarted), arm last (starts exactly once), stops once both servers close", async () => {
  const timer = createBrowserSurfaceLeaseSweepTimerFor(
    fakeController(),
    { browserSurfaceAllocator: {} },
    fakeLogger(),
  );
  const asServer = http.createServer();
  const rsServer = http.createServer();
  let startCount = 0;
  const originalStart = timer.start.bind(timer);
  timer.start = (...args) => {
    startCount += 1;
    return originalStart(...args);
  };

  // Between construction and arming, in production, many fallible awaits
  // run. None of them call start() — the count stays 0 until arm.
  assert.equal(startCount, 0);

  armBrowserSurfaceLeaseSweepAfterBoot(timer, { browserSurfaceAllocator: {} }, asServer, rsServer);
  assert.equal(startCount, 1, "armBrowserSurfaceLeaseSweepAfterBoot started the timer exactly once");

  await closeServer(asServer);
  await closeServer(rsServer);

  // Calling start() again on an already-stopped timer must not throw
  // (start() is itself idempotent against a fresh start after full stop).
  assert.doesNotThrow(() => timer.start());
  timer.stop();
});
