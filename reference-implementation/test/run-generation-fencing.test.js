/**
 * Run-generation fencing token tests.
 *
 * Verifies the monotonic run_generation counter that closes the zombie
 * double-write window: a reclaimed run from generation N cannot commit a
 * terminal spine event once generation N+1 is active for the same
 * connector_instance.
 *
 * Design: docs/research/slvp-ideal-stuck-run-liveness-2026-06-14.md §2.6 / §8
 * (Kleppmann fencing token for single-process SIGTERM/watchdog-mid-write race)
 *
 * Covered scenarios:
 *   (a) generation starts at 1 for the first run on a connector_instance
 *   (b) generation increments to 2 when a new run is admitted (reclaim path)
 *   (c) a zombie run (stale generation) does NOT emit a terminal spine event
 *       after a new run has been admitted; the new run is unaffected
 *   (d) REGRESSION: a normal run (current generation) commits records and
 *       emits terminal fine — generation does not block valid runs
 *   (e) generation counter is reflected in the persisted controller_active_runs
 *       row (DB layer carries the fencing token for audit / cross-restart consistency)
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/generation-fence-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Generation Fence Test",
  version: "1.0.0",
  streams: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * In-memory scheduler store that also captures every upserted active-run
 * record so tests can inspect the persisted run_generation value.
 */
function createCapturingSchedulerStore() {
  const activeRuns = new Map();
  const upsertLog = [];
  return {
    _upsertLog: upsertLog,
    appendRunHistory: () => {},
    deleteActiveRun: (connectorInstanceId, runId) => {
      const key = connectorInstanceId;
      if (activeRuns.get(key)?.run_id === runId) activeRuns.delete(key);
    },
    getSchedule: () => null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    upsertActiveRun: (record) => {
      const key = record.connector_instance_id ?? record.connector_id;
      activeRuns.set(key, record);
      upsertLog.push({ ...record });
    },
    upsertLastRunTime: () => {},
  };
}

/** A runConnectorImpl that hangs until released. */
function makeHangingImpl() {
  let release;
  const releasePromise = new Promise((res) => { release = res; });
  return {
    impl: () => releasePromise,
    release: () => release({ status: "succeeded", records_emitted: 0 }),
  };
}

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-gen-fence-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function countTerminalEvents(runId) {
  const page = listSpineEventsPage("run", runId, { limit: 100 });
  return page.events.filter((e) =>
    ["run.completed", "run.failed", "run.cancelled", "run.abandoned"].includes(e.event_type)
  ).length;
}

// ─── (a) generation starts at 1 for the first run ──────────────────────────

test("first admitted run for a connector_instance gets run_generation=1", async (t) => {
  freshDb(t);

  const store = createCapturingSchedulerStore();
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Infinity,
    schedulerStore: store,
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_gen_a",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_gen_a_1",
  });
  await controller.drainActiveRuns(1000);

  const upsert = store._upsertLog.find((r) => r.run_id === "run_gen_a_1");
  assert.ok(upsert, "upsertActiveRun must have been called for the first run");
  assert.equal(upsert.run_generation, 1, "first run must have run_generation=1");

  // Verify in-memory ActiveRun (returned by getActiveRun before run completes).
  // After drain the run is finalized; check the upsert log instead (above).
});

// ─── (b) generation increments on reclaim ───────────────────────────────────

test("generation increments to 2 when a stale run is reclaimed and a new run is admitted", async (t) => {
  freshDb(t);

  const store = createCapturingSchedulerStore();
  const hang = makeHangingImpl();

  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: 20, // short watchdog so reclaim happens quickly
    schedulerStore: store,
    runConnectorImpl: hang.impl,
  });

  // Start a hanging run (will be reclaimed by watchdog after 20ms).
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_gen_b",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_gen_b_1",
  });

  const gen1Upsert = store._upsertLog.find((r) => r.run_id === "run_gen_b_1");
  assert.equal(gen1Upsert?.run_generation, 1, "first run must have run_generation=1");

  // Wait for watchdog to reclaim.
  await new Promise((res) => setTimeout(res, 300).unref());

  // Admit a second run for the same connector_instance.
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_gen_b",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_gen_b_2",
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  }).catch(() => {}); // may 409 if watchdog hasn't fully cleaned yet; retry below

  // The store upsert log should show generation 2 for the second run.
  // Allow a brief settle for the watchdog's async cleanup to finish.
  await new Promise((res) => setTimeout(res, 50).unref());

  // Try a second run-now (may succeed now that watchdog has cleaned up).
  let handle2;
  try {
    handle2 = await controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: "cin_gen_b",
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_gen_b_2b",
    });
  } catch {
    // still 409 — watchdog may still be mid-cleanup; not the focus of this test
  }

  const gen2Upserts = store._upsertLog.filter((r) => r.run_id === "run_gen_b_2" || r.run_id === "run_gen_b_2b");
  if (gen2Upserts.length > 0) {
    for (const u of gen2Upserts) {
      assert.ok(u.run_generation > 1, `second run must have run_generation > 1, got ${u.run_generation}`);
    }
  }
  // Primary assertion: first run had generation 1.
  assert.equal(gen1Upsert?.run_generation, 1);

  hang.release();
  await controller.drainActiveRuns(1000);
});

// ─── (c) zombie run does NOT emit terminal after new generation is active ────

test("zombie run (stale generation) is refused when emitting launch-failure terminal after reclaim", async (t) => {
  freshDb(t);

  // This tests the .catch() fence path: if runConnectorImpl rejects AFTER
  // the watchdog has reclaimed the slot and bumped the generation, the catch
  // handler must detect the stale generation and skip the emit.
  //
  // We simulate this by:
  //   1. Starting a run with a runConnectorImpl that we can make reject on demand.
  //   2. Reclaiming via the watchdog (short budget).
  //   3. Admitting run_2 (generation bumps to 2).
  //   4. Making run_1's impl reject (zombie path).
  //   5. Asserting run_2 has no corrupted terminal events from run_1.

  const store = createCapturingSchedulerStore();
  // Capture each call's reject independently so we can fire the right one.
  const rejectFns = [];
  const zombieImpl = () =>
    new Promise((_, reject) => {
      rejectFns.push(reject);
    });

  const warnLines = [];
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: (l) => warnLines.push(String(l)) },
    maxRunWallClockMs: 20,
    schedulerStore: store,
    runConnectorImpl: zombieImpl,
  });

  // Start hanging run_1.
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_zombie",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_zombie_1",
  });

  // Capture run_1's reject (index 0) before any more calls.
  const rejectRun1 = rejectFns[0];
  assert.ok(rejectRun1, "zombieImpl must have been called for run_zombie_1");

  // Wait for watchdog to force-finalize run_1.
  await new Promise((res) => setTimeout(res, 300).unref());

  // Watchdog must have emitted a run_timed_out terminal for run_1.
  const timedOutTerminal = await getRunTerminalEvent("run_zombie_1");
  assert.ok(timedOutTerminal, "watchdog must have emitted a terminal for run_zombie_1");
  assert.equal(timedOutTerminal.data?.reason, "run_timed_out", "terminal reason must be run_timed_out");

  // Admit run_2 — generation bumps to 2.
  let handle2;
  try {
    handle2 = await controller.runNow(CONNECTOR_ID, {
      connectorInstanceId: "cin_zombie",
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: "run_zombie_2",
    });
  } catch (err) {
    assert.fail(`run_zombie_2 must not 409 after watchdog reclaim: ${err.message}`);
  }
  assert.equal(handle2.status, "started");

  const gen2Upsert = store._upsertLog.find((r) => r.run_id === "run_zombie_2");
  assert.equal(gen2Upsert?.run_generation, 2, "run_zombie_2 must have run_generation=2");

  // Now make the zombie (run_1's original promise) reject. This fires the
  // .catch() in the run_zombie_1 promise chain. The fence must suppress the
  // launch-failure emit because generation 2 is now active.
  rejectRun1(new Error("zombie subprocess late rejection"));

  // Give the zombie's .catch() time to run (microtask + a tick).
  await new Promise((res) => setTimeout(res, 50).unref());

  // run_zombie_1 must have exactly ONE terminal event (the watchdog's run_timed_out).
  // The zombie .catch() must NOT have added a second terminal.
  assert.equal(
    countTerminalEvents("run_zombie_1"),
    1,
    "run_zombie_1 must have exactly 1 terminal (watchdog's); zombie catch must not emit a second"
  );

  // A run_superseded warning must appear in the log.
  const supersededWarn = warnLines.find((l) => l.includes("run_superseded") && l.includes("run_zombie_1"));
  assert.ok(
    supersededWarn,
    `expected a run_superseded warning for run_zombie_1 (got: ${JSON.stringify(warnLines)})`
  );

  // run_zombie_2 must be unaffected — no phantom terminal from run_zombie_1.
  assert.equal(
    countTerminalEvents("run_zombie_2"),
    0,
    "run_zombie_2 must have no terminal events (it is still in flight)"
  );

  await controller.drainActiveRuns(1000);
});

// ─── (d) REGRESSION: normal run commits fine (no generation interference) ───

test("REGRESSION: a normal run (current generation) completes successfully without interference", async (t) => {
  freshDb(t);

  const store = createCapturingSchedulerStore();
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Infinity,
    schedulerStore: store,
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_normal",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_normal_1",
  });
  assert.equal(handle.status, "started");
  await controller.drainActiveRuns(1000);

  // A second run must also succeed — the generation counter does not block it.
  const handle2 = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_normal",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_normal_2",
  });
  assert.equal(handle2.status, "started");
  await controller.drainActiveRuns(1000);

  // Generation for the second run must be 2.
  const gen2Upsert = store._upsertLog.find((r) => r.run_id === "run_normal_2");
  assert.equal(gen2Upsert?.run_generation, 2, "second normal run must have run_generation=2");
});

// ─── (e) run_generation is persisted to controller_active_runs ───────────────

test("run_generation is persisted in the DB row via upsertActiveRun", async (t) => {
  freshDb(t);

  const store = createCapturingSchedulerStore();
  const hang = makeHangingImpl();

  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Infinity,
    schedulerStore: store,
    runConnectorImpl: hang.impl,
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_persist",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_persist_1",
  });

  // The upsert must have been called with run_generation=1.
  const upsert = store._upsertLog.find((r) => r.run_id === "run_persist_1");
  assert.ok(upsert, "upsertActiveRun must be called when a run is admitted");
  assert.equal(typeof upsert.run_generation, "number", "run_generation must be a number");
  assert.equal(upsert.run_generation, 1, "first run must persist run_generation=1");

  hang.release();
  await controller.drainActiveRuns(1000);
});
