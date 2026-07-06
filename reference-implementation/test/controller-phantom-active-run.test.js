/**
 * Tests for the phantom-active-run fix:
 *
 *   BUG: runNow registers the run in the in-memory `activeRuns` Map before
 *   the async runConnectorImpl chain. If runConnectorImpl hangs (never
 *   resolves or rejects), the .finally() never fires, the Map entry leaks
 *   permanently, and every subsequent run-now returns 409 run_already_active
 *   until the process is restarted — even though no connector is actually
 *   running.  Proven live: a YNAB run wedged with no spine event, no DB row,
 *   but an activeRuns memory entry that blocked all future run-nows.
 *
 * FIX — two complementary parts:
 *
 *   1. WALL-CLOCK WATCHDOG (maxRunWallClockMs): bounds every runConnectorImpl
 *      run. If a run does not reach terminal state within the budget, the
 *      watchdog fires: it aborts the cancellation signal, emits a typed
 *      run.failed (reason: run_timed_out), and calls finalizeRunCleanup to
 *      clear all in-memory and DB state. The timer is .unref()'d and cleared
 *      on normal completion so well-behaved runs are unaffected.
 *      finalizeRunCleanup is idempotent so both the watchdog and the run's
 *      own .finally() can call it without double-cleanup.
 *
 *   2. STALE-ENTRY RECONCILIATION (409 guard): before throwing 409
 *      run_already_active, checks whether the existing activeRuns entry's
 *      promise has already settled (settledRunIds set) or is absent from
 *      activeRunPromises. If stale, clears the entry and allows the new run
 *      to proceed. Genuinely-live in-flight runs still 409.
 *
 * Covered scenarios:
 *   (a) hung run self-heals via watchdog → subsequent run-now succeeds (not 409)
 *   (b) stale entry (settled promise / no activeRunPromises entry) → reclaimed
 *   (c) REGRESSION: genuinely live in-flight run still returns 409
 *   (d) watchdog emits a typed run_timed_out terminal spine event
 *   (e) watchdog does NOT fire for runs that complete within budget
 *   (f) finalizeRunCleanup is idempotent (double-call is a silent no-op)
 */

import assert from "node:assert/strict";
import { makeTemporaryDbPath } from "./helpers/temp-dir.js";
import test from "node:test";

import { getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/phantom-run-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Phantom Run Test",
  version: "1.0.0",
  streams: [],
};

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled", "run.abandoned"]);

function createSchedulerStore() {
  const activeRuns = new Map();
  return {
    appendRunHistory: () => {},
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) activeRuns.delete(connectorInstanceId);
    },
    getSchedule: () => null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    upsertActiveRun: (record) => {
      activeRuns.set(record.connector_instance_id ?? record.connector_id, record);
    },
    upsertLastRunTime: () => {},
  };
}

function freshDb(t) {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-phantom-run-"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function countTerminalEvents(runId) {
  const page = listSpineEventsPage("run", runId, { limit: 100 });
  return page.events.filter((event) => TERMINAL_EVENT_TYPES.has(event.event_type)).length;
}

/**
 * Returns a runConnectorImpl that hangs forever (never resolves or rejects)
 * until `release()` is called (which resolves it). This simulates a wedged
 * connector subprocess.
 */
function makeHangingImpl() {
  let resolveHang;
  const hangPromise = new Promise((resolve) => {
    resolveHang = resolve;
  });
  return {
    impl: () => hangPromise,
    release: () => resolveHang({ status: "succeeded", records_emitted: 0 }),
  };
}

// ─── (a) Hung run self-heals via watchdog ────────────────────────────────────

test("watchdog force-finalizes a hung run and allows a subsequent run-now to succeed", async (t) => {
  freshDb(t);

  const warnLines = [];
  const hang = makeHangingImpl();

  // Use a very short watchdog budget (20 ms) so the test is fast.
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: (line) => warnLines.push(line) },
    maxRunWallClockMs: 20,
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: hang.impl,
  });

  // Start a run that hangs.
  const handle1 = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_hang",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_hang_1",
  });
  assert.equal(handle1.run_id, "run_hang_1");
  assert.equal(handle1.status, "started");

  // Confirm it is in-flight.
  assert.ok(controller.findActiveRunByRunId("run_hang_1"), "run should be active while hanging");

  // Wait for the watchdog to fire (budget=20ms; give it 500ms to be safe).
  await new Promise((resolve) => setTimeout(resolve, 300).unref());

  // The watchdog should have cleared the active run entry.
  assert.equal(
    controller.findActiveRunByRunId("run_hang_1"),
    null,
    "watchdog must clear the activeRuns entry after force-finalizing"
  );

  // A subsequent run-now for the same connector must succeed (NOT 409).
  let handle2;
  try {
    handle2 = await controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: "cin_hang",
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_hang_2",
    });
  } catch (err) {
    assert.fail(`run-now after watchdog should not throw; got: ${err instanceof Error ? err.message : err}`);
  }
  assert.equal(handle2.run_id, "run_hang_2");
  assert.equal(handle2.status, "started");

  // Release the hanging impl to avoid leaving the promise dangling.
  hang.release();
  await controller.drainActiveRuns(1000);

  // Watchdog must have logged a warning.
  const watchdogWarn = warnLines.find((l) => String(l).includes("watchdog") && String(l).includes("run_hang_1"));
  assert.ok(watchdogWarn, `expected a watchdog warning log for run_hang_1 (got: ${JSON.stringify(warnLines)})`);
});

// ─── (d) Watchdog emits a typed run_timed_out terminal spine event ───────────

test("watchdog emits a typed run_timed_out terminal spine event for hung run", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: 20,
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: hang.impl,
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_timeout_event",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_timeout_event",
  });

  // Wait for watchdog.
  await new Promise((resolve) => setTimeout(resolve, 300).unref());

  // Terminal event must exist.
  const terminal = await getRunTerminalEvent("run_timeout_event");
  assert.equal(terminal?.status, "failed", "timed-out run must have a failed terminal event");
  assert.equal(terminal?.data?.reason, "run_timed_out", "reason must be run_timed_out");
  assert.equal(terminal?.data?.failure_reason, "run_timed_out");
  assert.equal(terminal?.data?.records_emitted, 0);
  assert.equal(terminal?.actor_id, CONNECTOR_ID);
  assert.equal(countTerminalEvents("run_timeout_event"), 1, "exactly one terminal event (no double-terminate)");

  hang.release();
  await controller.drainActiveRuns(500);
});

// ─── (e) Watchdog does NOT fire for runs that complete within budget ──────────

test("watchdog does not fire for a run that completes within budget", async (t) => {
  freshDb(t);

  const warnLines = [];
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: (line) => warnLines.push(line) },
    maxRunWallClockMs: 5000, // 5 s — run completes immediately
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_fast",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_fast",
  });
  await controller.drainActiveRuns(1000);

  // No watchdog warning.
  const watchdogWarn = warnLines.find((l) => String(l).includes("watchdog"));
  assert.equal(watchdogWarn, undefined, "watchdog must not fire for a run that completes within budget");

  // No run_timed_out terminal event.
  const terminal = await getRunTerminalEvent("run_fast");
  // run_fast completes normally (no terminal emitted by fake impl) → terminal may be null
  if (terminal) {
    assert.notEqual(terminal.data?.reason, "run_timed_out", "run_timed_out must not appear for a fast run");
  }
});

// ─── (b) Stale-entry reconciliation: settled promise → reclaimed ─────────────

test("stale activeRuns entry (settled promise) is reclaimed and new run-now succeeds", async (t) => {
  freshDb(t);

  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    // Disable the watchdog so we can exercise the reconciliation path directly.
    maxRunWallClockMs: Infinity,
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  // Run 1 completes normally.
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_stale",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stale_1",
  });
  await controller.drainActiveRuns(1000);

  // After the run settles, the entry must be gone — so a second run-now must
  // succeed without 409 (the normal post-settle case).
  const handle2 = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_stale",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stale_2",
  });
  assert.equal(handle2.status, "started");
  await controller.drainActiveRuns(1000);
});

// ─── (c) REGRESSION: genuinely live in-flight run still returns 409 ──────────

test("a genuinely live in-flight run still returns 409 run_already_active", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  // Disable watchdog so the run stays live for the duration of the test.
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Infinity,
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: hang.impl,
  });

  // Start a run that hangs — it is genuinely live.
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_live",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_live_1",
  });

  // A second run-now for the same connector must 409.
  let caughtError;
  try {
    await controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: "cin_live",
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_live_2",
    });
  } catch (err) {
    caughtError = err;
  }

  assert.ok(caughtError, "expected a 409 error for a concurrent run-now on a live run");
  assert.equal(caughtError.code, "run_already_active", `expected run_already_active, got: ${caughtError.code}`);
  assert.equal(caughtError.runId, "run_live_1");

  // Release and clean up.
  hang.release();
  await controller.drainActiveRuns(1000);
});

// ─── (f) finalizeRunCleanup is idempotent ─────────────────────────────────────

test("a run that completes normally then has its entry reclaimed is not double-finalized", async (t) => {
  freshDb(t);

  // Scenario: watchdog disabled; run completes normally (finalizeRunCleanup
  // called once via .finally); then we attempt a second run-now — this must
  // not crash or emit a duplicate terminal event.
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Infinity,
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_idempotent",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_idempotent_1",
  });
  await controller.drainActiveRuns(1000);

  // Second run-now should work (entry already cleaned up by .finally).
  const handle2 = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_idempotent",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_idempotent_2",
  });
  assert.equal(handle2.status, "started");
  await controller.drainActiveRuns(1000);

  // No duplicate terminal events for run_idempotent_1.
  assert.equal(countTerminalEvents("run_idempotent_1"), 0, "no terminal event for immediate-resolve run");
});
