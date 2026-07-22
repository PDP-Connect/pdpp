// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createBrowserSurfaceLeaseSweepTimer } from "../runtime/browser-surface-lease-sweep-timer.ts";

/**
 * Integration-level proof that the sweep timer's stopWhenAllClosed binds it
 * to the concept-owning server close lifecycle — stopping only once EVERY
 * bound server has closed, never on the first — and that the timer is only
 * ever started after binding, never before. Uses real node:http.Server
 * instances (cheap — 'close' fires without ever listening on a port) and the
 * real timer module — no live allocator, HTTP boot, or import of
 * server/index.js required.
 *
 * The timer's sweep operates on a controller reachable through EITHER
 * asServer or rsServer (neither exclusively owns it), so closing only one of
 * the two must NOT stop the sweep — the controller may still be reachable
 * through the other. Only once all bound sources have closed does the
 * timer stop. This is the regression test for two related defects:
 *   1. stopWhenAllClosed previously stopped on the FIRST close (see
 *      openspec/changes/fix-browser-surface-capacity-self-heal design.md) —
 *      wrong when the timer's state is reachable through more than one
 *      still-open server.
 *   2. server/index.js previously started the timer well before binding
 *      (and before the fallible remainder of startServer's boot sequence
 *      completed), so a boot failure between timer-construction and
 *      binding could leave a running, unref'd, unreachable timer. The
 *      production fix moved timer.start() to the single point after every
 *      fallible await in startServer succeeds, with binding established
 *      first; this suite proves the timer module's own contract (bind
 *      before start, stop only when ALL bound sources have closed) that
 *      makes that production ordering meaningful.
 */

function createFakeSweepTimers() {
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
  };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("closing only ONE of two bound servers does NOT stop the timer — the controller may still be reachable through the other", async () => {
  const fake = createFakeSweepTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });
  const asServerLike = http.createServer();
  const rsServerLike = http.createServer();

  timer.stopWhenAllClosed([asServerLike, rsServerLike]);
  timer.start();
  assert.equal(fake.scheduled.size, 1);

  await closeServer(asServerLike);
  assert.equal(fake.scheduled.size, 1, "timer must stay running: rsServerLike is still open");

  await closeServer(rsServerLike);
});

test("closing the LAST of two bound servers stops the timer, regardless of which one closes first", async () => {
  const fake = createFakeSweepTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });
  const asServerLike = http.createServer();
  const rsServerLike = http.createServer();

  timer.stopWhenAllClosed([asServerLike, rsServerLike]);
  timer.start();

  await closeServer(rsServerLike);
  assert.equal(fake.scheduled.size, 1, "still running: rsServerLike closing first is not enough");

  await closeServer(asServerLike);
  assert.equal(fake.scheduled.size, 0, "stopped once the LAST bound server (asServerLike) closed");
});

test("a single bound server: closing it stops the timer (degenerate case of 'all closed')", async () => {
  const fake = createFakeSweepTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });
  const soloServer = http.createServer();

  timer.stopWhenAllClosed([soloServer]);
  timer.start();
  assert.equal(fake.scheduled.size, 1);

  await closeServer(soloServer);
  assert.equal(fake.scheduled.size, 0);
});

test("closing both bound servers is a safe idempotent stop, not a double-stop error", async () => {
  const fake = createFakeSweepTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });
  const asServerLike = http.createServer();
  const rsServerLike = http.createServer();

  timer.stopWhenAllClosed([asServerLike, rsServerLike]);
  timer.start();

  await assert.doesNotReject(async () => {
    await closeServer(asServerLike);
    await closeServer(rsServerLike);
  });
  assert.equal(fake.scheduled.size, 0);

  // A close event arriving after the timer already stopped (e.g. an
  // explicit stop() raced ahead of both servers closing) must not throw or
  // re-schedule anything.
  assert.doesNotThrow(() => timer.stop());
  assert.equal(fake.scheduled.size, 0);
});

test("the explicit stop() call composes safely with stopWhenAllClosed regardless of ordering", async () => {
  const fake = createFakeSweepTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });
  const asServerLike = http.createServer();
  const rsServerLike = http.createServer();

  timer.stopWhenAllClosed([asServerLike, rsServerLike]);
  timer.start();

  // Explicit CLI-style stop fires before either server has closed
  // (defense-in-depth: fires fastest on a genuine process shutdown).
  timer.stop();
  assert.equal(fake.scheduled.size, 0);

  // The server close events that follow (only one, or both) must not throw
  // or double-schedule, regardless of whether all sources ever close.
  await assert.doesNotReject(async () => {
    await closeServer(asServerLike);
  });
  assert.equal(fake.scheduled.size, 0);
});

test("bind (stopWhenAllClosed) then start is the only supported ordering — start() before bind is never exercised in production", async () => {
  // server/index.js's armBrowserSurfaceLeaseSweepAfterBoot always calls
  // stopWhenAllClosed before start() (see design.md). This test proves that
  // ordering works end to end: binding first, then starting, then closing
  // all sources stops the timer exactly as the other tests in this file
  // prove for the bind-then-start shape.
  const fake = createFakeSweepTimers();
  const timer = createBrowserSurfaceLeaseSweepTimer({
    sweep: async () => {},
    intervalMs: 30_000,
    setIntervalFn: fake.setIntervalFn,
    clearIntervalFn: fake.clearIntervalFn,
  });
  const asServerLike = http.createServer();
  const rsServerLike = http.createServer();

  timer.stopWhenAllClosed([asServerLike, rsServerLike]);
  assert.equal(fake.scheduled.size, 0, "binding alone does not start the timer");

  timer.start();
  assert.equal(fake.scheduled.size, 1);

  await closeServer(asServerLike);
  await closeServer(rsServerLike);
  assert.equal(fake.scheduled.size, 0);
});

test("repeated programmatic create/bind/start/close-all cycles never accumulate timers or listeners (simulates repeated startServer/closeServer calls)", async () => {
  const fake = createFakeSweepTimers();

  for (let cycle = 0; cycle < 5; cycle += 1) {
    const timer = createBrowserSurfaceLeaseSweepTimer({
      sweep: async () => {},
      intervalMs: 30_000,
      setIntervalFn: fake.setIntervalFn,
      clearIntervalFn: fake.clearIntervalFn,
    });
    const asServerLike = http.createServer();
    const rsServerLike = http.createServer();

    timer.stopWhenAllClosed([asServerLike, rsServerLike]);
    timer.start();
    assert.equal(fake.scheduled.size, 1, `cycle ${cycle}: exactly one interval while the servers are open`);
    assert.equal(asServerLike.listenerCount("close"), 1, `cycle ${cycle}: exactly one close listener on the AS-like server`);
    assert.equal(rsServerLike.listenerCount("close"), 1, `cycle ${cycle}: exactly one close listener on the RS-like server`);

    // Close one first — the timer must survive — then the other, which
    // must stop it. Exercises the real "all must close" contract on every
    // cycle, not just the trivial both-at-once case.
    await closeServer(asServerLike);
    assert.equal(fake.scheduled.size, 1, `cycle ${cycle}: still running after only one of two servers closed`);
    await closeServer(rsServerLike);
    assert.equal(fake.scheduled.size, 0, `cycle ${cycle}: cleared once the last server closed, before the next cycle starts`);

    // Node removes a 'once' listener from the emitter after it fires, so
    // both closed servers' own listener counts must return to 0 — proof
    // this cycle's binding did not leak a listener.
    assert.equal(asServerLike.listenerCount("close"), 0, `cycle ${cycle}: 'once' listener consumed on close`);
    assert.equal(rsServerLike.listenerCount("close"), 0, `cycle ${cycle}: 'once' listener consumed on close`);
  }

  assert.equal(fake.scheduled.size, 0, "no accumulated timers across all cycles");
});
