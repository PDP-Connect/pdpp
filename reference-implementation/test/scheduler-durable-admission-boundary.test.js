// Scheduler duty-cycle overrun — durable admission boundary
// (revised after independent review rejected an earlier candidate fix).
//
// The live incident (`openspec/changes/harden-controller-durable-single-flight-gate/design.md`):
// incumbent run `run_1784154575706` remained alive, a second scheduled run
// `run_1784157985739` STARTED for the same connector, and the durable
// `controller_active_runs` row showed only the newcomer because admission
// used `INSERT ... ON CONFLICT ... DO UPDATE` (last-writer-wins). That is a
// durable, cross-process/restart admission defect, NOT a same-process
// governor-eligibility defect: on both merge-base and the (now-rejected)
// candidate, `scheduler.ts::executeRun` already checks the in-process
// `runtime.activeRuns` Set and returns `null` — silently, no skip record,
// no durable admission attempt — before `runExecutor.launchRun` could ever
// reach durable admission. A same-process overrun tick was never able to
// reach the durable gate in the first place; it cannot reproduce the
// incident. PR #323 (`fab621dfb`, "enforce durable connector single-flight",
// already merged before this task began) fixed the actual defect by making
// `upsertActiveRun` fail closed (`ON CONFLICT DO NOTHING`, returns `boolean`)
// instead of overwriting the incumbent row.
//
// This suite exists to FALSIFY (or confirm) that the fix already covers the
// four boundaries the incident actually crosses, using REAL SQLite-backed
// durable state and REAL independently-constructed scheduler/controller
// instances (not fakes) so a genuine cross-process race is exercised, not
// merely asserted:
//
//   1. Two independent `createScheduler()` instances (simulating two
//      processes / a restart) sharing one real durable store: only one may
//      admit a live run for the same connector instance; the incumbent row
//      is never overwritten; the second is a neutral skip, not a connector
//      launch.
//   2. A scheduler process "restarting" mid-run (fresh scheduler instance,
//      empty in-memory `activeRuns`, durable row from the still-live prior
//      process): the new process must not launch a second child.
//   3. A manual `controller.runNow()` racing a scheduled tick for the same
//      connector instance against the same durable store: exactly one may
//      launch; the other is rejected via the shared atomic admission
//      primitive regardless of which path got there first.
//   4. Completion anchoring: once a run (of any duration) actually
//      completes, the next legitimate dispatch is anchored to that run's
//      real completion time, not to when it was originally due — proven by
//      observing an actual second child start, not merely asserting
//      internal `eligible` state.
//
// If these already pass on current main with no production change, that is
// itself the correct, honest result: it proves the durable admission
// boundary already holds and no further code change is warranted for the
// cited incident.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import { createController } from "../runtime/controller.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/scheduler-durable-boundary";
const CONNECTOR_INSTANCE_ID = "cin_scheduler_durable_boundary";

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Scheduler Durable Boundary Test",
  version: "1.0.0",
  streams: [
    {
      name: "items",
      primary_key: "id",
      schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
  ],
  runtime_requirements: {},
};

async function eventually(assertion, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (err) {
      lastError = err;
      await delay(15);
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

// A real subprocess connector that signals readiness (writes `readyPath`)
// then blocks until `releasePath` appears, then emits DONE. Each attempt
// increments `attemptsPath` so tests can count real child spawns.
function writeReleasableConnector(tmpDir) {
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  const readyPath = join(tmpDir, "ready");
  const releasePath = join(tmpDir, "release");

  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const readyPath = ${JSON.stringify(readyPath)};
const releasePath = ${JSON.stringify(releasePath)};
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, Date.now() + '\\n', 'utf8');
  writeFileSync(readyPath, 'ready', 'utf8');
  const timer = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
  }, 15);
  timer.unref?.();
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);

  return {
    attemptsPath,
    connectorPath,
    readyPath,
    releasePath,
    release: () => writeFileSync(releasePath, "release", "utf8"),
  };
}

// A real subprocess connector that completes immediately on START —
// no pause, no release needed. Used for the completion-anchoring test where
// the point is to observe MULTIPLE real completions over real wall-clock
// time against a short interval.
function writeImmediateConnector(tmpDir) {
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");

  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, Date.now() + '\\n', 'utf8');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);

  return { attemptsPath, connectorPath };
}

function readAttempts(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function freshDb(t) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-durable-boundary-db-")), "pdpp.sqlite");
  initDb(dbPath);
  t.after(() => closeDb());
  return dbPath;
}

// ─── 1. Two independent scheduler instances sharing one durable store ────────

test("two independent scheduler processes sharing one durable store admit exactly one run, incumbent row is never overwritten", async (t) => {
  freshDb(t);
  const schedulerStore = createSqliteSchedulerStore();
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-two-scheduler-"));
  const connector = writeReleasableConnector(tmpDir);

  let schedulerA = null;
  let schedulerB = null;
  t.after(() => {
    schedulerA?.stop();
    schedulerB?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const connectorEntry = {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath: connector.connectorPath,
    intervalMs: 60_000,
    manifest: MANIFEST,
    ownerToken: "owner-token",
  };

  // Process A: starts first, reaches durable admission, blocks (paused
  // connector) so its active-run row stays live.
  schedulerA = createScheduler({
    connectors: [connectorEntry],
    getState: async () => null,
    onInteraction: () => ({ type: "INTERACTION_RESPONSE", status: "cancelled" }),
    schedulerStore,
    setState: async () => {},
  });
  schedulerA.start();

  await eventually(() => {
    assert.equal(existsSync(connector.readyPath), true, "process A's connector reached START");
  }, "process A did not start its connector");

  const incumbentRow = await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    const row = rows.find((r) => r.connector_instance_id === CONNECTOR_INSTANCE_ID);
    assert.ok(row, "durable active-run row should exist for process A's live run");
    return row;
  }, "process A's durable row was not persisted");

  // Process B: an entirely independent createScheduler() instance — its OWN
  // fresh `runtime.activeRuns` (empty), its OWN in-memory state — but wired
  // to the SAME durable store. Simulates a second scheduler process (or a
  // restarted process) racing process A while A's run is still genuinely
  // live.
  schedulerB = createScheduler({
    connectors: [connectorEntry],
    getState: async () => null,
    onInteraction: () => ({ type: "INTERACTION_RESPONSE", status: "cancelled" }),
    schedulerStore,
    setState: async () => {},
  });
  schedulerB.start();

  // Give process B's own immediate tick (scheduler.ts checks immediately on
  // start) a chance to reach durable admission and get rejected.
  await eventually(() => {
    const history = schedulerB.getHistory();
    const skip = history.find((r) => r.error?.includes("run_already_active"));
    assert.ok(skip, "process B should record a neutral run_already_active skip");
  }, "process B did not record the durable conflict skip");

  // The incumbent row must be untouched — not overwritten by process B's
  // conflicting admission attempt (this is the exact failure mode the live
  // incident exhibited pre-#323: DO UPDATE silently replaced the row).
  const rowsAfterConflict = await schedulerStore.listActiveRuns();
  assert.equal(rowsAfterConflict.length, 1, "exactly one durable active-run row must exist");
  assert.equal(rowsAfterConflict[0].run_id, incumbentRow.run_id, "the incumbent row must survive process B's conflicting attempt");

  // Only one real child process was ever spawned — process B never launched
  // a second connector despite its own empty in-memory activeRuns set.
  assert.equal(readAttempts(connector.attemptsPath).length, 1, "exactly one connector process attempt across both schedulers");

  connector.release();

  await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    assert.equal(rows.length, 0, "durable row must clear once the incumbent run terminates");
  }, "durable row was not cleared after the incumbent run completed");
});

// ─── 2. Restart mid-run: fresh scheduler process, durable row from prior process ──

test("scheduler restart while an incumbent run is genuinely still live does not launch a second child", async (t) => {
  freshDb(t);
  const schedulerStore = createSqliteSchedulerStore();
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-restart-mid-run-"));
  const connector = writeReleasableConnector(tmpDir);

  let originalScheduler = null;
  let restartedScheduler = null;
  t.after(() => {
    originalScheduler?.stop();
    restartedScheduler?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const connectorEntry = {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath: connector.connectorPath,
    intervalMs: 60_000,
    manifest: MANIFEST,
    ownerToken: "owner-token",
  };

  originalScheduler = createScheduler({
    connectors: [connectorEntry],
    getState: async () => null,
    onInteraction: () => ({ type: "INTERACTION_RESPONSE", status: "cancelled" }),
    schedulerStore,
    setState: async () => {},
  });
  originalScheduler.start();

  await eventually(() => {
    assert.equal(existsSync(connector.readyPath), true, "original process's connector reached START");
  }, "original process did not start its connector");

  // Simulate a restart: the original process's connector child is still
  // genuinely alive (real subprocess, not force-killed), but we construct a
  // brand-new scheduler instance — a totally fresh runtime, empty
  // `activeRuns` — as a restarted process would have. It must NOT hydrate
  // in-memory `activeRuns` from the durable row (that field is intentionally
  // process-local); the durable gate alone must prevent a second launch.
  restartedScheduler = createScheduler({
    connectors: [connectorEntry],
    getState: async () => null,
    onInteraction: () => ({ type: "INTERACTION_RESPONSE", status: "cancelled" }),
    schedulerStore,
    setState: async () => {},
  });
  restartedScheduler.start();

  await eventually(() => {
    const history = restartedScheduler.getHistory();
    const skip = history.find((r) => r.error?.includes("run_already_active"));
    assert.ok(skip, "restarted process should record a neutral run_already_active skip");
  }, "restarted process did not record the durable conflict skip");

  assert.equal(readAttempts(connector.attemptsPath).length, 1, "restart must not spawn a second connector process while the incumbent is genuinely live");

  connector.release();

  await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    assert.equal(rows.length, 0, "durable row must clear once the original process's incumbent run terminates");
  }, "durable row was not cleared after the original run completed");
});

// ─── 3. Manual controller run racing a scheduled tick ─────────────────────────

test("manual controller.runNow racing a scheduled tick for the same connector instance admits exactly one", async (t) => {
  freshDb(t);
  const schedulerStore = createSqliteSchedulerStore();
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-manual-vs-scheduled-"));
  const connector = writeReleasableConnector(tmpDir);

  let scheduler = null;
  let releaseManual;
  const manualHang = new Promise((resolve) => {
    releaseManual = () => resolve({ status: "succeeded", records_emitted: 0 });
  });
  let manualRunConnectorCalled = false;

  const controller = createController({
    connectorPathResolver: () => connector.connectorPath,
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    schedulerStore,
    runConnectorImpl: () => {
      manualRunConnectorCalled = true;
      return manualHang;
    },
  });

  t.after(() => {
    scheduler?.stop();
    releaseManual?.();
    connector.release();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Manual run admits first and holds the durable row via a controlled,
  // paused runConnectorImpl (deterministic — no real subprocess needed on
  // this side; the scheduled side below uses a real subprocess).
  const manualPromise = controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_manual_incumbent",
    triggerKind: "manual",
  });

  await eventually(() => {
    assert.equal(manualRunConnectorCalled, true, "manual run should have reached runConnectorImpl");
  }, "manual run did not start");

  const durableRowAfterManual = await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    const row = rows.find((r) => r.connector_instance_id === CONNECTOR_INSTANCE_ID);
    assert.ok(row, "manual run should have persisted a durable active-run row");
    assert.equal(row.run_id, "run_manual_incumbent");
    return row;
  }, "manual run's durable row was not persisted");

  // Now a scheduled tick (a real scheduler process, real subprocess
  // connector) races against the manual incumbent via the SAME durable
  // store. It must be rejected without spawning a child.
  scheduler = createScheduler({
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: connector.connectorPath,
        intervalMs: 60_000,
        manifest: MANIFEST,
        ownerToken: "owner-token",
      },
    ],
    getState: async () => null,
    onInteraction: () => ({ type: "INTERACTION_RESPONSE", status: "cancelled" }),
    schedulerStore,
    setState: async () => {},
  });
  scheduler.start();

  await eventually(() => {
    const history = scheduler.getHistory();
    const skip = history.find((r) => r.error?.includes("run_already_active"));
    assert.ok(skip, "scheduled tick should record a neutral run_already_active skip against the manual incumbent");
  }, "scheduled tick did not record the durable conflict skip");

  assert.equal(existsSync(connector.readyPath), false, "scheduled tick must not spawn a connector child while the manual run is live");

  const rowsAfterConflict = await schedulerStore.listActiveRuns();
  assert.equal(rowsAfterConflict.length, 1, "exactly one durable row must remain");
  assert.equal(rowsAfterConflict[0].run_id, durableRowAfterManual.run_id, "the manual incumbent row must survive the scheduled tick's conflicting attempt");

  releaseManual();
  await manualPromise;

  await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    assert.equal(rows.length, 0, "durable row must clear once the manual incumbent completes");
  }, "durable row was not cleared after the manual run completed");
});

// ─── 4. Completion anchoring: next real dispatch is anchored to actual completion ──

test("next scheduled dispatch is anchored to a run's actual completion time, observed via a real second child start", async (t) => {
  freshDb(t);
  const schedulerStore = createSqliteSchedulerStore();
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-completion-anchor-"));
  const connector = writeImmediateConnector(tmpDir);

  // A short interval and a fast-completing real connector: the point is to
  // observe TWO real, well-spaced completions over real wall-clock time,
  // proving the second dispatch waited a full interval from the first run's
  // actual completion rather than firing immediately or in a tight loop.
  const intervalMs = 200;

  let scheduler = null;
  const completedRuns = [];
  t.after(() => {
    scheduler?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  scheduler = createScheduler({
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: connector.connectorPath,
        intervalMs,
        manifest: MANIFEST,
        maxRetries: 0,
        ownerToken: "owner-token",
      },
    ],
    getState: async () => null,
    onInteraction: () => ({ type: "INTERACTION_RESPONSE", status: "cancelled" }),
    onRunComplete: (record) => {
      if (record.status === "succeeded") completedRuns.push(record);
    },
    schedulerStore,
    setState: async () => {},
  });

  scheduler.start();

  await eventually(() => {
    assert.ok(completedRuns.length >= 2, `expected at least 2 completions, got ${completedRuns.length}`);
  }, "did not observe two real scheduled completions", 5000);

  scheduler.stop();

  const [first, second] = completedRuns;
  const firstCompletedAtMs = Date.parse(first.completedAt);
  const secondStartedAtMs = Date.parse(second.startedAt);

  assert.ok(
    secondStartedAtMs - firstCompletedAtMs >= intervalMs - 50,
    `second run must start no earlier than one interval after the first run's actual completion ` +
      `(gap was ${secondStartedAtMs - firstCompletedAtMs}ms, expected >= ${intervalMs - 50}ms)`
  );

  const attempts = readAttempts(connector.attemptsPath);
  assert.ok(attempts.length >= 2, "at least two real connector process attempts must have been observed");
  const gapBetweenSpawns = attempts[1] - attempts[0];
  assert.ok(
    gapBetweenSpawns >= intervalMs - 50,
    `real child-process spawn gap must be at least one interval (was ${gapBetweenSpawns}ms, expected >= ${intervalMs - 50}ms)`
  );
});
