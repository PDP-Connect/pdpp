/**
 * Behavioral coverage for the records-page poll cadence.
 *
 * The cadence decision is factored into a pure module so the load-bearing
 * behavior — "a quiet page still polls, only slower" — is testable without a
 * JSX render harness (this app has none; see `connector-row.test.ts`). The
 * React effect in `records-page-poller.tsx` is a thin wrapper around
 * `recordsPollIntervalMs`, whose structure is pinned by
 * `records-page-poller.invariants.test.ts`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { IDLE_POLL_MS, RUNNING_POLL_MS, recordsPollIntervalMs } from "./records-poll-interval.ts";

test("an active run polls at the fast cadence", () => {
  assert.equal(recordsPollIntervalMs(true), RUNNING_POLL_MS);
});

test("a quiet page polls at the slow idle heartbeat — it never stops polling", () => {
  // The regression this guards: the old poller disabled itself entirely when
  // no run was active, so a quiet page froze until manual reload. A finite,
  // positive idle interval is the contract that a quiet page reconciles itself.
  const idle = recordsPollIntervalMs(false);
  assert.equal(idle, IDLE_POLL_MS);
  assert.ok(Number.isFinite(idle) && idle > 0, "idle cadence must be a real, positive interval");
});

test("idle is strictly slower than running so idle load stays negligible", () => {
  // The active cadence watches a run land; the idle heartbeat only reconciles
  // background drift. Idle must be slower, or the load tradeoff is wrong.
  assert.ok(IDLE_POLL_MS > RUNNING_POLL_MS, "idle interval must be slower than the running interval");
});

test("the fast cadence stays at 3s and the idle heartbeat at 30s", () => {
  // Pin the concrete cadences the freshness report specified so a future tweak
  // is a deliberate, reviewed change rather than an accident.
  assert.equal(RUNNING_POLL_MS, 3000);
  assert.equal(IDLE_POLL_MS, 30_000);
});
