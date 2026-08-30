// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *   (g) DURABLE-ROW WEDGE (owner-reported "Try Again" defect): a durable
 *       `controller_active_runs` row can outlive its run when the
 *       fire-and-forget `clearPersistedActiveRun` in `finalizeRunCleanup`
 *       fails or races — e.g. a browser session that never finished
 *       starting. `assertNoConflictingDurableActiveRun` now treats a row
 *       whose full (run_id, connector_instance_id) identity already has a
 *       terminal spine event as stale and self-heals it. A terminal event for
 *       another connection sharing the run ID still blocks; a row with no
 *       terminal event also blocks (REGRESSION, both backends).
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";

import { emitSpineEvent, getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";
import {
  __getRunWatchdogSettlementsSizeForTests,
  __resetControllerInteractionStateForTests,
  ControllerError,
  createController,
} from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import {
  createPostgresSchedulerStore,
  createSqliteSchedulerStore,
  type ActiveRunRecord,
  type SchedulerStore,
} from "../server/stores/scheduler-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/phantom-run-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Phantom Run Test",
  streams: [],
  version: "1.0.0",
};

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled", "run.abandoned"]);

function createSchedulerStore(): SchedulerStore {
  const activeRuns = new Map<string, ActiveRunRecord>();
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) {
        activeRuns.delete(connectorInstanceId);
      }
    },
    deleteSchedule: () => undefined,
    getActiveRun: (connectorInstanceId) => activeRuns.get(connectorInstanceId) ?? null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: (record) => {
      activeRuns.set(record.connector_instance_id ?? record.connector_id, record);
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

function createDurableConflictSchedulerStore(existingRow: ActiveRunRecord | null): SchedulerStore {
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: () => undefined,
    deleteSchedule: () => undefined,
    getActiveRun: () => (existingRow ? { ...existingRow } : null),
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => (existingRow ? [{ ...existingRow }] : []),
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: () => false,
    upsertLastRunTime: () => undefined,
  };
}

/**
 * Like `createDurableConflictSchedulerStore`, but a mutable single-row store
 * that actually honors `deleteActiveRun` — so a test can seed one orphaned
 * durable row, drive `runNow`, and then assert on whether the row survived
 * or was reclaimed. Mirrors the real `controller_active_runs` "one flight
 * row per connector instance" shape closely enough to exercise
 * `assertNoConflictingDurableActiveRun` honestly, without a real DB.
 */
function createMutableDurableRowSchedulerStore(existingRow: ActiveRunRecord): SchedulerStore & {
  currentRow: () => ActiveRunRecord | null;
} {
  let row: ActiveRunRecord | null = { ...existingRow };
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    currentRow: () => (row ? { ...row } : null),
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (row?.run_id === runId && (row.connector_instance_id ?? row.connector_id) === connectorInstanceId) {
        row = null;
      }
    },
    deleteSchedule: () => undefined,
    getActiveRun: (connectorInstanceId) =>
      row && (row.connector_instance_id ?? row.connector_id) === connectorInstanceId ? { ...row } : null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => (row ? [{ ...row }] : []),
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: (record) => {
      if (row) {
        return false;
      }
      row = { ...record };
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

/**
 * `createController`'s startup reconciliation
 * (`releaseAbandonedControllerRunClaims`, which clears any durable row
 * present at boot) is not on the public `Controller` interface — it is
 * internal plumbing consumed only by the browser-surface subsystem. Tests
 * that need to seed a durable row AFTER boot reconciliation has settled
 * (so the seeded row models a run orphaned mid-process-life, not one
 * bootstrap reconciliation would clear anyway) poll the fixture store's own
 * observable state instead of reaching into that internal promise.
 */
async function waitForBootstrapRowCleared(store: { currentRow: () => ActiveRunRecord | null }): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (store.currentRow() === null) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Deliberately sequential polling with no fixed tick count to wait on.
    await setTimeoutPromise(1);
  }
  throw new Error("timed out waiting for startup reconciliation to clear the bootstrap placeholder row");
}

async function waitForPersistedActiveRunCleared(
  store: Pick<SchedulerStore, "getActiveRun">,
  connectorInstanceId: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await store.getActiveRun(connectorInstanceId)) === null) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Deliberately sequential polling for asynchronous boot reconciliation.
    await setTimeoutPromise(1);
  }
  throw new Error("timed out waiting for startup reconciliation to clear the persisted bootstrap row");
}

// A minimal, production-shaped admission fixture: mints a deterministic
// default-account connector_instance_id per (ownerSubjectId, connectorId) and
// refuses any other claimed id — the same authority shape
// `admitOwnerRunConnection` enforces in production, without a real store.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function freshDb(t: TestContext) {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-phantom-run-"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function countTerminalEvents(runId: string) {
  const page = listSpineEventsPage("run", runId, { limit: 100 });
  return page.events.filter((event) => TERMINAL_EVENT_TYPES.has(event.event_type)).length;
}

/**
 * Returns a runConnectorImpl that hangs forever (never resolves or rejects)
 * until `release()` is called (which resolves it). This simulates a wedged
 * connector subprocess.
 */
function makeHangingImpl() {
  let resolveHang!: (value: RuntimeRunConnectorResult) => void;
  const hangPromise = new Promise<RuntimeRunConnectorResult>((resolve) => {
    resolveHang = resolve;
  });
  return {
    impl: () => hangPromise,
    release: () => resolveHang({ records_emitted: 0, status: "succeeded" }),
  };
}

// ─── (a) Hung run self-heals via watchdog ────────────────────────────────────

test("watchdog force-finalizes a hung run and allows a subsequent run-now to succeed", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();

  // Use a very short watchdog budget (20 ms) so the test is fast.
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: 20,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
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
  let handle2: Awaited<ReturnType<typeof controller.runNow>> | undefined;
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
  assert.ok(handle2);
  assert.equal(handle2.run_id, "run_hang_2");
  assert.equal(handle2.status, "started");

  // Release the hanging impl to avoid leaving the promise dangling.
  hang.release();
  await controller.drainActiveRuns(1000);
});

// ─── (d) Watchdog emits a typed run_timed_out terminal spine event ───────────

test("watchdog emits a typed run_timed_out terminal spine event for hung run", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: 20,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
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

  const warnLines: string[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: {
      error: () => undefined,
      warn: (line) => {
        warnLines.push(line);
      },
    },
    maxRunWallClockMs: 5000, // 5 s — run completes immediately
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
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

// ─── (b) Normal post-settle admission: no false 409 after a clean completion ──
//
// NOTE: despite this suite's original name, this test does NOT construct a
// genuinely stale `activeRuns` entry (map entry present while its owning
// run/resource is actually gone). `finalizeRunCleanup` marks
// `settledRunIds` and deletes the `activeRuns` entry in the same
// synchronous step (no `await` between them), so there is no window an
// external caller can observe where the entry is stale-but-present. This
// test's own sequence (run 1 fully drains via `drainActiveRuns` before run 2
// starts) is the ordinary non-conflicting case and would pass identically
// against a controller with NO stale-reconciliation logic at all — it does
// not exercise `assertNoConflictingActiveRun`'s `isStale` branch. The
// GENUINE stale-entry race (watchdog force-finalizes while a caller's
// in-flight run-now is still using the old entry) is covered by
// "watchdog force-finalizes a hung run and allows a subsequent run-now to
// succeed" above, which actually forces the watchdog path.

test("a run that has fully settled (drained) does not block a subsequent run-now with a false 409", async (t) => {
  freshDb(t);

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    // Disable the watchdog so we can exercise the reconciliation path directly.
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
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

test("durable active-run row blocks manual and recovery admission after restart", async (t) => {
  freshDb(t);

  const durableRow = {
    connector_id: CONNECTOR_ID,
    connector_instance_id: "cin_restart",
    run_generation: 1,
    run_id: "run_restart_live",
    scenario_id: "scn_restart",
    started_at: "2026-04-28T00:00:00.000Z",
    trace_id: "trc_restart",
  };
  let runConnectorCalled = false;
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => {
      runConnectorCalled = true;
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
    schedulerStore: createDurableConflictSchedulerStore(durableRow),
  });

  await assert.rejects(
    () =>
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId: "cin_restart",
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_manual_conflict",
        triggerKind: "manual",
      }),
    (err) => err instanceof ControllerError && err.code === "run_already_active" && err.runId === "run_restart_live"
  );

  await assert.rejects(
    () =>
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId: "cin_restart",
        manifest: MANIFEST,
        ownerToken: "owner-token",
        recoveryContinuationDepth: 1,
        recoveryOnly: true,
        runId: "run_recovery_conflict",
        triggerKind: "manual",
      }),
    (err) => err instanceof ControllerError && err.code === "run_already_active" && err.runId === "run_restart_live"
  );

  assert.equal(runConnectorCalled, false, "durable conflict must block connector launch");
});

// ─── (g) Stuck durable row with a dead session self-heals; a genuinely live
//         durable row still blocks ──────────────────────────────────────────
//
// Reproduces the owner-reported defect: "Try Again" on a failed run returns
// "Connector already has an active run: run_XXXX" even though the cited run
// is not active in the UI. Root cause: `finalizeRunCleanup`'s durable delete
// (`clearPersistedActiveRun`) is fire-and-forget — if it fails or races (a
// browser session that never finished starting is exactly the kind of fast,
// early failure most likely to hit this), the in-memory `activeRuns` entry
// is gone (so the UI, and `assertNoConflictingActiveRun`, see no active run)
// but the durable `controller_active_runs` row survives. Unlike its
// in-memory sibling, `assertNoConflictingDurableActiveRun` used to trust
// that row unconditionally, forever — until the process rebooted and the
// boot reconciler (which also excludes the CURRENT boot epoch) happened to
// clear it. The fix: treat a durable row whose run_id already has a
// terminal spine event as stale and self-heal it, exactly as the in-memory
// check already does for stale `activeRuns` entries.
//
// The row is seeded via `store.upsertActiveRun` AFTER `createController`
// resolves its startup reconciliation (`releaseAbandonedControllerRunClaims`),
// which unconditionally clears any row present AT BOOT — the honest analog
// of a process restart. Seeding before that point would prove nothing about
// this fix: it would pass (or fail) purely on startup reconciliation's
// unrelated behavior. The reachable bug is a row orphaned mid-process-life,
// after boot has already happened once — exactly what this models.

test("a stuck durable row with a dead session (terminal spine event, no live process) self-heals and Try Again succeeds", async (t) => {
  freshDb(t);

  const store = createMutableDurableRowSchedulerStore({
    connector_id: CONNECTOR_ID,
    connector_instance_id: "cin_wedged",
    run_generation: 0,
    run_id: "run_bootstrap_placeholder",
    scenario_id: "scn_bootstrap",
    started_at: "2026-08-29T00:00:00.000Z",
    trace_id: "trc_bootstrap",
  });

  let runConnectorCalled = false;
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => {
      runConnectorCalled = true;
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
    schedulerStore: store,
  });
  // Let boot-time reconciliation clear the placeholder row it inherited,
  // exactly as it would clear one from a prior process's flight table.
  await waitForBootstrapRowCleared(store);

  // Now simulate the actual bug: mid-process-life, a run is admitted (its
  // durable row written), its browser session fails fast, and the
  // fire-and-forget durable delete in `finalizeRunCleanup` is lost (DB
  // error, race — never retried). The durable row outlives the run.
  const orphanedRunId = "run_wedged_session_never_started";
  const inserted = store.upsertActiveRun({
    connector_id: CONNECTOR_ID,
    connector_instance_id: "cin_wedged",
    run_generation: 1,
    run_id: orphanedRunId,
    scenario_id: "scn_wedged",
    started_at: "2026-08-29T00:05:00.000Z",
    trace_id: "trc_wedged",
  });
  assert.equal(inserted, true);
  // The dead run's failure WAS observed and recorded on the spine (e.g. by
  // whatever caught the launch error) even though the durable-row delete
  // that should have accompanied it was lost.
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      connector_instance_id: "cin_wedged",
      connection_id: "cin_wedged",
      failure_reason: "browser_surface_failed",
      message: "Browser session did not finish starting.",
      records_emitted: 0,
    },
    event_type: "run.browser_surface_failed",
    object_id: orphanedRunId,
    object_type: "run",
    run_id: orphanedRunId,
    status: "failed",
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_wedged",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_try_again",
  });

  assert.equal(handle.status, "started", "Try Again must succeed once the wedged run is proven terminal");
  assert.equal(runConnectorCalled, true, "the new run must actually launch, not just be admitted");
  assert.notEqual(
    store.currentRow()?.run_id,
    orphanedRunId,
    "the stale durable row for the dead run must be cleared, not left behind"
  );

  await controller.drainActiveRuns(1000);
});

test("a durable row with NO terminal spine event (genuinely live or unproven) still returns 409", async (t) => {
  freshDb(t);

  const store = createMutableDurableRowSchedulerStore({
    connector_id: CONNECTOR_ID,
    connector_instance_id: "cin_live_durable",
    run_generation: 0,
    run_id: "run_bootstrap_placeholder_2",
    scenario_id: "scn_bootstrap",
    started_at: "2026-08-29T00:00:00.000Z",
    trace_id: "trc_bootstrap",
  });

  let runConnectorCalled = false;
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => {
      runConnectorCalled = true;
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
    schedulerStore: store,
  });
  await waitForBootstrapRowCleared(store);

  // A run is admitted after boot and is still genuinely in flight — no
  // terminal spine event exists for it. From the spine's point of view this
  // run has not reached a terminal state, so it must still be presumed
  // live (fail-closed): a real concurrent run must never be let through.
  const liveRunId = "run_live_durable";
  const inserted = store.upsertActiveRun({
    connector_id: CONNECTOR_ID,
    connector_instance_id: "cin_live_durable",
    run_generation: 1,
    run_id: liveRunId,
    scenario_id: "scn_live_durable",
    started_at: "2026-08-29T00:05:00.000Z",
    trace_id: "trc_live_durable",
  });
  assert.equal(inserted, true);

  await assert.rejects(
    () =>
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId: "cin_live_durable",
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_try_again_2",
      }),
    (err) => err instanceof ControllerError && err.code === "run_already_active" && err.runId === liveRunId
  );

  assert.equal(runConnectorCalled, false, "a genuinely live (unproven-terminal) durable row must still block");
  assert.equal(store.currentRow()?.run_id, liveRunId, "the live row must not be touched when no terminal event exists");
});

test("SQLite: a foreign terminal event sharing a run_id cannot reclaim a live durable row, while a matching terminal event can", async (t) => {
  freshDb(t);

  const connectorInstanceId = "cin_sqlite_live";
  const foreignConnectorInstanceId = "cin_sqlite_terminal_elsewhere";
  const sharedRunId = "run_sqlite_reused";
  const store = createSqliteSchedulerStore();
  await store.upsertActiveRun({
    connector_id: CONNECTOR_ID,
    connector_instance_id: connectorInstanceId,
    run_generation: 0,
    run_id: "run_sqlite_bootstrap",
    scenario_id: "scn_sqlite_bootstrap",
    started_at: "2026-08-30T00:00:00.000Z",
    trace_id: "trc_sqlite_bootstrap",
  });

  const hang = makeHangingImpl();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: hang.impl,
    schedulerStore: store,
  });
  await waitForPersistedActiveRunCleared(store, connectorInstanceId);

  assert.equal(
    await store.upsertActiveRun({
      connector_id: CONNECTOR_ID,
      connector_instance_id: connectorInstanceId,
      run_generation: 1,
      run_id: sharedRunId,
      scenario_id: "scn_sqlite_live",
      started_at: "2026-08-30T00:05:00.000Z",
      trace_id: "trc_sqlite_live",
    }),
    true
  );
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      connector_instance_id: foreignConnectorInstanceId,
      connection_id: foreignConnectorInstanceId,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: "run.failed",
    object_id: sharedRunId,
    object_type: "run",
    run_id: sharedRunId,
    status: "failed",
  });

  await assert.rejects(
    () =>
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId,
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_sqlite_must_not_start",
      }),
    (err) => err instanceof ControllerError && err.code === "run_already_active" && err.runId === sharedRunId
  );
  assert.equal(
    (await store.getActiveRun(connectorInstanceId))?.run_id,
    sharedRunId,
    "the foreign terminal event must not evict the live SQLite claim"
  );

  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      connector_instance_id: connectorInstanceId,
      connection_id: connectorInstanceId,
      source: { id: CONNECTOR_ID, kind: "connector" },
    },
    event_type: "run.failed",
    object_id: sharedRunId,
    object_type: "run",
    run_id: sharedRunId,
    status: "failed",
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId,
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sqlite_reclaimed",
  });
  assert.equal(handle.status, "started", "a matching terminal event reclaims the real SQLite durable row");
  assert.equal((await store.getActiveRun(connectorInstanceId))?.run_id, handle.run_id);

  hang.release();
  await controller.drainActiveRuns(1000);
});

// ─── (c) REGRESSION: genuinely live in-flight run still returns 409 ──────────

test("a genuinely live in-flight run still returns 409 run_already_active", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  // Disable watchdog so the run stays live for the duration of the test.
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
  });

  // Start a run that hangs — it is genuinely live.
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_live",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_live_1",
  });

  // A second run-now for the same connector must 409.
  let caughtError: unknown;
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
  assert.ok(caughtError instanceof ControllerError);
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
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
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

// ─── awaitRun vs. the watchdog: closing the activeRuns-leak class ────────────
//
// `controller.awaitRun` is the seam `scheduler-manager-factory.ts`'s
// `runManagedConnectorViaController` callback (`via`) uses to wait for a
// scheduled managed run's real terminal outcome before returning to
// `routeScheduledManagedRun` -> `launchRun` -> `executeRun` (scheduler.ts).
// Before this fix, `awaitRun` awaited ONLY the raw `activeRunPromises` entry.
// If `runConnectorImpl` never resolves or rejects — even past the watchdog's
// own cancellation-signal abort — that raw promise never settles, `awaitRun`
// never returns, `executeRun`'s `finally` never reaches
// `runtime.activeRuns.delete(key)`, and the connector instance is
// PERMANENTLY blacked out (no dispatch, no back-off, no escalation, no
// recovery) until process restart. These tests prove `awaitRun` now races
// that raw promise against the watchdog's own settlement signal, closing the
// leak without a second timer.

test("awaitRun returns once the watchdog force-finalizes a run whose impl never settles", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    // Short budget: the impl below never resolves even after the watchdog
    // aborts its cancellation signal (modeling a child that ignores SIGTERM /
    // a parent-side await on a promise nothing will ever settle).
    maxRunWallClockMs: 20,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_await_never_settles",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_await_never_settles",
  });

  // Without the fix this call hangs forever — the test's own timeout is the
  // proof. With the fix it returns once the watchdog's settlement resolves.
  const status = await controller.awaitRun(handle.run_id);
  assert.equal(status, "failed", "watchdog-forced timeout must read back as failed");

  // The raw impl promise is still genuinely unsettled — awaitRun did NOT
  // wait for it, it raced past it via the watchdog signal.
  assert.equal(
    controller.findActiveRunByRunId("run_await_never_settles"),
    null,
    "activeRuns entry must be cleared once awaitRun returns"
  );

  hang.release();
  await controller.drainActiveRuns(500);
});

test("awaitRun returns the true status for a run that completes normally, watchdog never fires", async (t) => {
  freshDb(t);

  const warnLines: string[] = [];
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: {
      error: () => undefined,
      warn: (line) => {
        warnLines.push(line);
      },
    },
    maxRunWallClockMs: 5000,
    // The fake impl mirrors a real successful connector run by emitting its
    // own `run.completed` terminal event before resolving — this test file's
    // OTHER fixtures resolve without emitting one (see "watchdog does not
    // fire..." above), which is fine for THOSE assertions (they only check
    // for the ABSENCE of a run_timed_out event) but would make `awaitRun`
    // read back `null` -> "failed" here, which is not what this test means
    // to discriminate on.
    runConnectorImpl: async (implOpts: { runId?: string }) => {
      const runId = implOpts.runId ?? "run_await_normal";
      await emitSpineEvent({
        actor_id: CONNECTOR_ID,
        actor_type: "runtime",
        data: { records_emitted: 0 },
        event_type: "run.completed",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        status: "succeeded",
      });
      return { records_emitted: 0, status: "succeeded" };
    },
    schedulerStore: createSchedulerStore(),
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_await_normal",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_await_normal",
  });

  const status = await controller.awaitRun(handle.run_id);
  assert.equal(status, "succeeded");
  assert.equal(
    warnLines.find((l) => String(l).includes("watchdog")),
    undefined,
    "watchdog must not fire for a run that completes within budget"
  );
});

test("awaitRun on a run the watchdog force-finalizes reads the watchdog's own terminalization, not a duplicate", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: 20,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_await_watchdog_terminal",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_await_watchdog_terminal",
  });

  await controller.awaitRun(handle.run_id);

  const terminal = await getRunTerminalEvent(handle.run_id);
  assert.equal(terminal?.data?.reason, "run_timed_out");
  assert.equal(countTerminalEvents(handle.run_id), 1, "exactly one terminal event — no double-terminalization");

  // The impl finally settles well after awaitRun already returned. Its own
  // .finally()/finalizeRunCleanup chain must be a no-op (idempotency guard),
  // not a second terminalization of an already-force-finalized run.
  hang.release();
  await controller.drainActiveRuns(500);
  assert.equal(countTerminalEvents(handle.run_id), 1, "late-settling impl must not add a second terminal event");
});

// ─── Cross-run eviction: a stale finalize must never touch a newer run ──────
//
// `finalizeRunCleanup` can be invoked twice for the SAME run (watchdog +
// the run's own `.finally()` — see the idempotency guard at its top). If the
// first call suspends mid-cleanup (e.g. inside `beforeRunCleanup`, which is
// awaited) and a NEW run is admitted for the same connector_instance while
// it's suspended, the second (or resumed) call must not evict that new run's
// live `activeRuns` entry. Before the run_id fence, the guard only checked
// key PRESENCE (`!activeRuns.has(key)`) — which is true for the new run too,
// so a resumed stale call for the old run would treat the new run's entry as
// "not yet finalized" and delete it out from under it.
test("a suspended finalize for run A must not evict a live run B admitted on the same key", async (t) => {
  freshDb(t);

  const hangA = makeHangingImpl();
  const hangB = makeHangingImpl();
  let releaseCleanupBarrier!: () => void;
  const cleanupBarrier = new Promise<void>((resolve) => {
    releaseCleanupBarrier = resolve;
  });
  let sawCleanupBarrier = false;

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    // Suspend indefinitely on run A's cleanup only — run B must not be
    // blocked by this barrier so it can be admitted while A is suspended.
    beforeRunCleanup: async ({ runId }) => {
      if (runId === "run_evict_a") {
        sawCleanupBarrier = true;
        await cleanupBarrier;
      }
    },
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    // Short budget so the watchdog force-finalizes A quickly. B is released
    // well within this same budget (see below), so B's OWN watchdog never
    // fires — B's activeRuns entry can only be touched by A's stale finalize.
    maxRunWallClockMs: 200,
    runConnectorImpl: (implOpts: { runId?: string }) =>
      implOpts.runId === "run_evict_b" ? hangB.impl() : hangA.impl(),
    schedulerStore: createSchedulerStore(),
  });

  // Run A starts, then hangs — the watchdog will force-finalize it.
  const handleA = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_evict",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_evict_a",
  });
  assert.equal(handleA.status, "started");

  // Wait for the watchdog to fire and enter finalizeRunCleanup for A. It
  // clears A's activeRuns entry synchronously, then suspends on
  // beforeRunCleanup (the barrier above) before returning.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (sawCleanupBarrier) {
        clearInterval(check);
        resolve();
      }
    }, 5).unref();
  });

  // A's entry must already be gone (the watchdog's finalize deleted it
  // before suspending on the barrier) — this is what allows B's admission.
  assert.equal(controller.findActiveRunByRunId("run_evict_a"), null, "A must be cleared before B can be admitted");

  // B is admitted on the SAME connector_instance key while A's finalize is
  // still suspended in beforeRunCleanup.
  const handleB = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_evict",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_evict_b",
  });
  assert.equal(handleB.status, "started");
  assert.ok(controller.findActiveRunByRunId("run_evict_b"), "B must be active immediately after admission");

  // Release A's original hanging impl (NOT B's). A's OWN `.finally()` chain
  // now also reaches finalizeRunCleanup for run_evict_a — a SECOND call for
  // the same run, racing behind the watchdog's already-suspended first call.
  // Pre-fix, whichever of these two calls resumes/runs last would see B's
  // entry present under a bare `!activeRuns.has(key)` check and wrongly
  // delete it. B itself is left hanging throughout, well inside its own
  // watchdog budget, so it stays genuinely active for this whole window.
  hangA.release();
  await new Promise((resolve) => setTimeout(resolve, 50).unref());

  // B must still be active: neither A's watchdog-triggered finalize nor A's
  // own late .finally()-triggered finalize may touch B's entry.
  assert.ok(
    controller.findActiveRunByRunId("run_evict_b"),
    "B must remain active — a stale finalize for A must not evict a live, differently-run_id'd entry on the same key"
  );

  // Unblock A's suspended barrier last, so both of A's finalize paths can
  // finish and the test can drain cleanly.
  releaseCleanupBarrier();
  hangB.release();
  await controller.drainActiveRuns(1000);
});

test("next tick after a watchdog-forced settle: scheduler can dispatch the instance again", async (t) => {
  freshDb(t);

  const hang = makeHangingImpl();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: 20,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
  });

  const handle1 = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_recovery_next_tick",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_recovery_next_tick_1",
  });

  // Model the scheduler's managed-run seam: routeScheduledManagedRun -> via ->
  // controller.awaitRun. Without the fix this await would hang forever and
  // the scheduler's own executeRun `finally` (runtime.activeRuns.delete)
  // would never run, permanently blacking out this connector instance.
  await controller.awaitRun(handle1.run_id);

  // The "next tick" recovery case: a fresh run-now for the same instance must
  // succeed immediately — proving the instance is not permanently wedged.
  const handle2 = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_recovery_next_tick",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_recovery_next_tick_2",
  });
  assert.equal(handle2.status, "started", "connector instance must recover on the next tick, not stay blacked out");

  hang.release();
  await controller.drainActiveRuns(500);
});

// ─── runWatchdogSettlements drains on every exit path ───────────────────────
//
// The settlement map entry (armed by armRunWatchdog whenever the watchdog is
// enabled) must not outlive its run under ANY of the three ways a run can
// end: normal completion, watchdog-forced timeout, and owner cancellation.
// finalizeRunCleanup's `runWatchdogSettlements.delete(input.runId)` is the
// only delete site and it is NOT exercised by any assertion elsewhere in this
// file — a future refactor could remove it with nothing objecting. These
// tests close that gap using the minimal test-only size introspection
// (`__getRunWatchdogSettlementsSizeForTests`) added alongside the existing
// `__resetControllerInteractionStateForTests` test seam.

function cancellableRun(): {
  (opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult>;
  aborted: boolean;
} {
  let resolveRun!: (value: RuntimeRunConnectorResult) => void;
  const settled = new Promise<RuntimeRunConnectorResult>((done) => {
    resolveRun = done;
  });
  const impl = ((opts: RuntimeRunConnectorOptions) => {
    if (opts.cancelSignal) {
      opts.cancelSignal.addEventListener(
        "abort",
        () => {
          impl.aborted = true;
          resolveRun({ records_emitted: 0, run_id: opts.runId ?? null, status: "cancelled" });
        },
        { once: true }
      );
    }
    return settled;
  }) as { (opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult>; aborted: boolean };
  impl.aborted = false;
  return impl;
}

test("runWatchdogSettlements drains after a run completes normally (watchdog armed, never fires)", async (t) => {
  freshDb(t);

  assert.equal(__getRunWatchdogSettlementsSizeForTests(), 0, "no leftover settlements from a prior test");

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    // Long enough that the watchdog never fires for this fast-completing run,
    // but still finite so armRunWatchdog actually creates a settlement entry.
    maxRunWallClockMs: 5000,
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_drain_normal",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_drain_normal",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(
    __getRunWatchdogSettlementsSizeForTests(),
    0,
    "the settlement entry must be dropped by finalizeRunCleanup once the run completes normally"
  );
});

test("runWatchdogSettlements drains after the watchdog force-finalizes a timed-out run", async (t) => {
  freshDb(t);

  assert.equal(__getRunWatchdogSettlementsSizeForTests(), 0, "no leftover settlements from a prior test");

  const hang = makeHangingImpl();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    maxRunWallClockMs: 20,
    runConnectorImpl: hang.impl,
    schedulerStore: createSchedulerStore(),
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_drain_timeout",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_drain_timeout",
  });

  // awaitRun races the raw run promise against the watchdog settlement — once
  // it returns, the settlement has resolved AND finalizeRunCleanup has run.
  await controller.awaitRun(handle.run_id);

  assert.equal(
    __getRunWatchdogSettlementsSizeForTests(),
    0,
    "the settlement entry must be dropped once the watchdog force-finalizes the run"
  );

  hang.release();
  await controller.drainActiveRuns(500);
});

test("runWatchdogSettlements drains after an owner cancels a run", async (t) => {
  freshDb(t);

  assert.equal(__getRunWatchdogSettlementsSizeForTests(), 0, "no leftover settlements from a prior test");

  const run = cancellableRun();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    // Long enough that only the explicit cancel (not the watchdog) resolves
    // this run — proves the settlement drains via finalizeRunCleanup's own
    // delete, not via the watchdog's early-return branch.
    maxRunWallClockMs: 5000,
    runConnectorImpl: run,
    schedulerStore: createSchedulerStore(),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_drain_cancel",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_drain_cancel",
  });

  const result = await controller.cancelRun("run_drain_cancel", "owner_local");
  assert.equal(result.status, "cancel_requested");

  await controller.drainActiveRuns(1000);
  assert.equal(run.aborted, true, "the run must have observed the cancel signal");

  assert.equal(
    __getRunWatchdogSettlementsSizeForTests(),
    0,
    "the settlement entry must be dropped once a cancelled run finalizes"
  );
});

// ─── (g) Postgres path: same durable-row-wedge fix, real PG-backed spine ─────
//
// `runAlreadyTerminal` (the oracle `assertNoConflictingDurableActiveRun` now
// consults) branches on `isPostgresStorageBackend()` and issues a distinct
// inline SQL query against real Postgres — the SQLite gate above proves
// nothing about that branch. Requires the dedicated loopback Postgres test
// listener (`PDPP_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:
// 55447/pdpp_test`, or run via `PDPP_TEST_PROFILE=postgres`); skipped
// otherwise. The `controller_active_runs` row itself still lives in the
// in-memory fixture store (mirroring the SQLite-path tests above) — only the
// spine terminal-event oracle needs to be real Postgres to exercise the
// backend-specific branch.

const RAW_POSTGRES_URL_PHANTOM_RUN = process.env.PDPP_TEST_POSTGRES_URL;
const POSTGRES_URL_PHANTOM_RUN = dedicatedPostgresTestUrl(RAW_POSTGRES_URL_PHANTOM_RUN);
if (RAW_POSTGRES_URL_PHANTOM_RUN && !POSTGRES_URL_PHANTOM_RUN) {
  throw new Error(
    "PDPP_TEST_POSTGRES_URL must target the dedicated loopback PostgreSQL test listener on 127.0.0.1:55447"
  );
}

let phantomRunPostgresDbCounter = 0;
function phantomRunPostgresDatabaseName(): string {
  phantomRunPostgresDbCounter += 1;
  return `pdpp_test_phantom_run_${process.pid}_${Date.now()}_${phantomRunPostgresDbCounter}`;
}

test("postgres: a stuck durable row with a dead session (terminal spine event, no live process) self-heals and Try Again succeeds", {
  skip: POSTGRES_URL_PHANTOM_RUN ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL_PHANTOM_RUN);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL_PHANTOM_RUN,
      databaseName: phantomRunPostgresDatabaseName(),
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      __resetControllerInteractionStateForTests();
      try {
        const store = createMutableDurableRowSchedulerStore({
          connector_id: CONNECTOR_ID,
          connector_instance_id: "cin_wedged_pg",
          run_generation: 0,
          run_id: "run_bootstrap_placeholder_pg",
          scenario_id: "scn_bootstrap_pg",
          started_at: "2026-08-29T00:00:00.000Z",
          trace_id: "trc_bootstrap_pg",
        });

        let runConnectorCalled = false;
        const controller = createController({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorPathResolver: () => "/tmp/connector.js",
          logger: { error: () => undefined, warn: () => undefined },
          maxRunWallClockMs: Number.POSITIVE_INFINITY,
          runConnectorImpl: () => {
            runConnectorCalled = true;
            return Promise.resolve({ records_emitted: 0, status: "succeeded" });
          },
          schedulerStore: store,
        });
        await waitForBootstrapRowCleared(store);

        const orphanedRunId = "run_wedged_session_never_started_pg";
        const inserted = store.upsertActiveRun({
          connector_id: CONNECTOR_ID,
          connector_instance_id: "cin_wedged_pg",
          run_generation: 1,
          run_id: orphanedRunId,
          scenario_id: "scn_wedged_pg",
          started_at: "2026-08-29T00:05:00.000Z",
          trace_id: "trc_wedged_pg",
        });
        assert.equal(inserted, true);
        await emitSpineEvent({
          actor_id: CONNECTOR_ID,
          actor_type: "runtime",
          data: {
            connector_instance_id: "cin_wedged_pg",
            connection_id: "cin_wedged_pg",
            failure_reason: "browser_surface_failed",
            message: "Browser session did not finish starting.",
            records_emitted: 0,
          },
          event_type: "run.browser_surface_failed",
          object_id: orphanedRunId,
          object_type: "run",
          run_id: orphanedRunId,
          status: "failed",
        });

        const handle = await controller.runNow(CONNECTOR_ID, {
          connectorInstanceId: "cin_wedged_pg",
          manifest: MANIFEST,
          ownerToken: "owner-token",
          runId: "run_try_again_pg",
        });

        assert.equal(handle.status, "started", "Try Again must succeed once the wedged run is proven terminal");
        assert.equal(runConnectorCalled, true, "the new run must actually launch, not just be admitted");
        assert.notEqual(
          store.currentRow()?.run_id,
          orphanedRunId,
          "the stale durable row for the dead run must be cleared, not left behind"
        );

        await controller.drainActiveRuns(1000);
      } finally {
        __resetControllerInteractionStateForTests();
        await closePostgresStorage();
      }
    }
  );
});

test("postgres: a durable row with NO terminal spine event (genuinely live or unproven) still returns 409", {
  skip: POSTGRES_URL_PHANTOM_RUN ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL_PHANTOM_RUN);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL_PHANTOM_RUN,
      databaseName: phantomRunPostgresDatabaseName(),
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      __resetControllerInteractionStateForTests();
      try {
        const store = createMutableDurableRowSchedulerStore({
          connector_id: CONNECTOR_ID,
          connector_instance_id: "cin_live_durable_pg",
          run_generation: 0,
          run_id: "run_bootstrap_placeholder_2_pg",
          scenario_id: "scn_bootstrap_pg",
          started_at: "2026-08-29T00:00:00.000Z",
          trace_id: "trc_bootstrap_pg",
        });

        let runConnectorCalled = false;
        const controller = createController({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorPathResolver: () => "/tmp/connector.js",
          logger: { error: () => undefined, warn: () => undefined },
          maxRunWallClockMs: Number.POSITIVE_INFINITY,
          runConnectorImpl: () => {
            runConnectorCalled = true;
            return Promise.resolve({ records_emitted: 0, status: "succeeded" });
          },
          schedulerStore: store,
        });
        await waitForBootstrapRowCleared(store);

        const liveRunId = "run_live_durable_pg";
        const inserted = store.upsertActiveRun({
          connector_id: CONNECTOR_ID,
          connector_instance_id: "cin_live_durable_pg",
          run_generation: 1,
          run_id: liveRunId,
          scenario_id: "scn_live_durable_pg",
          started_at: "2026-08-29T00:05:00.000Z",
          trace_id: "trc_live_durable_pg",
        });
        assert.equal(inserted, true);

        await assert.rejects(
          () =>
            controller.runNow(CONNECTOR_ID, {
              connectorInstanceId: "cin_live_durable_pg",
              manifest: MANIFEST,
              ownerToken: "owner-token",
              runId: "run_try_again_2_pg",
            }),
          (err) => err instanceof ControllerError && err.code === "run_already_active" && err.runId === liveRunId
        );

        assert.equal(runConnectorCalled, false, "a genuinely live (unproven-terminal) durable row must still block");
        assert.equal(
          store.currentRow()?.run_id,
          liveRunId,
          "the live row must not be touched when no terminal event exists"
        );
      } finally {
        __resetControllerInteractionStateForTests();
        await closePostgresStorage();
      }
    }
  );
});

test("PostgreSQL: a foreign terminal event sharing a run_id cannot reclaim a live durable row, while a matching terminal event can", {
  skip: POSTGRES_URL_PHANTOM_RUN ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL_PHANTOM_RUN);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL_PHANTOM_RUN,
      databaseName: phantomRunPostgresDatabaseName(),
    },
    async (databaseUrl) => {
      await initPostgresStorage({ backend: "postgres", databaseUrl });
      __resetControllerInteractionStateForTests();
      try {
        const connectorInstanceId = "cin_pg_live";
        const foreignConnectorInstanceId = "cin_pg_terminal_elsewhere";
        const sharedRunId = "run_pg_reused";
        const store = createPostgresSchedulerStore();
        await store.upsertActiveRun({
          connector_id: CONNECTOR_ID,
          connector_instance_id: connectorInstanceId,
          run_generation: 0,
          run_id: "run_pg_bootstrap",
          scenario_id: "scn_pg_bootstrap",
          started_at: "2026-08-30T00:00:00.000Z",
          trace_id: "trc_pg_bootstrap",
        });

        const hang = makeHangingImpl();
        const controller = createController({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorPathResolver: () => "/tmp/connector.js",
          logger: { error: () => undefined, warn: () => undefined },
          maxRunWallClockMs: Number.POSITIVE_INFINITY,
          runConnectorImpl: hang.impl,
          schedulerStore: store,
        });
        await waitForPersistedActiveRunCleared(store, connectorInstanceId);

        assert.equal(
          await store.upsertActiveRun({
            connector_id: CONNECTOR_ID,
            connector_instance_id: connectorInstanceId,
            run_generation: 1,
            run_id: sharedRunId,
            scenario_id: "scn_pg_live",
            started_at: "2026-08-30T00:05:00.000Z",
            trace_id: "trc_pg_live",
          }),
          true
        );
        await emitSpineEvent({
          actor_id: CONNECTOR_ID,
          actor_type: "runtime",
          data: {
            connector_instance_id: foreignConnectorInstanceId,
            connection_id: foreignConnectorInstanceId,
            source: { id: CONNECTOR_ID, kind: "connector" },
          },
          event_type: "run.failed",
          object_id: sharedRunId,
          object_type: "run",
          run_id: sharedRunId,
          status: "failed",
        });

        await assert.rejects(
          () =>
            controller.runNow(CONNECTOR_ID, {
              connectorInstanceId,
              manifest: MANIFEST,
              ownerToken: "owner-token",
              runId: "run_pg_must_not_start",
            }),
          (err) => err instanceof ControllerError && err.code === "run_already_active" && err.runId === sharedRunId
        );
        assert.equal(
          (await store.getActiveRun(connectorInstanceId))?.run_id,
          sharedRunId,
          "the foreign terminal event must not evict the live PostgreSQL claim"
        );

        await emitSpineEvent({
          actor_id: CONNECTOR_ID,
          actor_type: "runtime",
          data: {
            connector_instance_id: connectorInstanceId,
            connection_id: connectorInstanceId,
            source: { id: CONNECTOR_ID, kind: "connector" },
          },
          event_type: "run.failed",
          object_id: sharedRunId,
          object_type: "run",
          run_id: sharedRunId,
          status: "failed",
        });

        const handle = await controller.runNow(CONNECTOR_ID, {
          connectorInstanceId,
          manifest: MANIFEST,
          ownerToken: "owner-token",
          runId: "run_pg_reclaimed",
        });
        assert.equal(handle.status, "started", "a matching terminal event reclaims the real PostgreSQL durable row");
        assert.equal((await store.getActiveRun(connectorInstanceId))?.run_id, handle.run_id);

        hang.release();
        await controller.drainActiveRuns(1000);
      } finally {
        __resetControllerInteractionStateForTests();
        await closePostgresStorage();
      }
    }
  );
});
