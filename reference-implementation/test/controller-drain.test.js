// Unit tests for `drainPromisesWithDeadline`, the graceful-shutdown drain
// primitive exported from runtime/controller.ts.
//
// The helper observes the *live* map size after the race, mirroring how
// the controller registers each in-flight run with a `.finally` that
// removes its entry. To exercise that contract realistically, each test
// wraps its promises with the same self-cleanup pattern.

import test from "node:test";
import assert from "node:assert/strict";

import { drainPromisesWithDeadline } from "../runtime/controller.ts";

function track(map, id, promise) {
  const wrapped = promise.finally(() => map.delete(id));
  map.set(id, wrapped);
  return wrapped;
}

test("drainPromisesWithDeadline: empty map returns zeros immediately", async () => {
  const result = await drainPromisesWithDeadline(new Map(), 1000);
  assert.deepEqual(result, { drained: 0, timedOut: 0, elapsedMs: 0 });
});

test("drainPromisesWithDeadline: all settle before deadline → drained=N, timedOut=0", async () => {
  const pending = new Map();
  track(pending, "a", new Promise((r) => setTimeout(r, 5)));
  track(pending, "b", new Promise((r) => setTimeout(r, 10)));
  track(pending, "c", Promise.resolve());

  const result = await drainPromisesWithDeadline(pending, 1000);
  assert.equal(result.drained, 3);
  assert.equal(result.timedOut, 0);
  assert.ok(result.elapsedMs < 1000);
  assert.equal(pending.size, 0);
});

test("drainPromisesWithDeadline: deadline expires with stragglers → counts split", async () => {
  // Use generous margins so the test isn't load-sensitive: fast resolves
  // at 30ms, deadline at 100ms, stragglers at 5_000ms. Under heavy parallel
  // load the timer queue can slip, but the relative ordering
  // fast(30) < deadline(100) < slow(5000) is robust to >2x slowdown.
  const pending = new Map();
  track(pending, "fast", new Promise((r) => setTimeout(r, 30)));
  track(pending, "slow1", new Promise((r) => setTimeout(r, 5_000).unref?.()));
  track(pending, "slow2", new Promise((r) => setTimeout(r, 5_000).unref?.()));

  const result = await drainPromisesWithDeadline(pending, 100);
  assert.equal(result.drained, 1, `expected 1 drained, got ${result.drained}; elapsed=${result.elapsedMs}`);
  assert.equal(result.timedOut, 2, `expected 2 timed out, got ${result.timedOut}; elapsed=${result.elapsedMs}`);
  assert.ok(result.elapsedMs >= 100, `elapsed=${result.elapsedMs} expected ≥100`);
});

test("drainPromisesWithDeadline: rejected promises count as drained (allSettled never throws)", async () => {
  const pending = new Map();
  // Pre-attach a catch so the rejection isn't unhandled, then track.
  const rejecting = Promise.reject(new Error("boom"));
  rejecting.catch(() => {});
  track(pending, "x", rejecting);
  track(pending, "y", Promise.resolve("ok"));

  const result = await drainPromisesWithDeadline(pending, 1000);
  assert.equal(result.drained, 2);
  assert.equal(result.timedOut, 0);
  assert.equal(pending.size, 0);
});

test("drainPromisesWithDeadline: snapshot is taken at call time (later additions ignored)", async () => {
  const pending = new Map();
  track(pending, "a", new Promise((r) => setTimeout(r, 5)));

  const drainPromise = drainPromisesWithDeadline(pending, 1000);
  // Register a new run AFTER the drain started — should not be awaited.
  track(pending, "late", new Promise((r) => setTimeout(r, 500).unref?.()));

  const result = await drainPromise;
  assert.equal(result.drained, 1);
  assert.equal(result.timedOut, 0);
  // The late entry is still alive in the map.
  assert.ok(pending.has("late"));
});
