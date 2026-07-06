import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { listSpineCorrelations, listSpineEventsPage } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.js";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";
import { createScheduler } from "../runtime/scheduler.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/scheduler-direct-liveness";
const CONNECTOR_INSTANCE_ID = "cin_scheduler_direct_liveness";

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Scheduler Direct Liveness",
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

function writePausedConnector() {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-liveness-"));
  const connectorPath = join(dir, "connector.mjs");
  const readyPath = join(dir, "ready");
  const releasePath = join(dir, "release");

  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync } from 'node:fs';

const readyPath = ${JSON.stringify(readyPath)};
const releasePath = ${JSON.stringify(releasePath)};
const rl = createInterface({ input: process.stdin });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(readyPath, 'ready', 'utf8');
  const timer = setInterval(() => {
    if (!existsSync(releasePath)) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
  }, 20);
  timer.unref?.();
});
`,
    "utf8"
  );
  chmodSync(connectorPath, 0o755);

  return {
    connectorPath,
    dir,
    readyPath,
    release: () => writeFileSync(releasePath, "release", "utf8"),
  };
}

async function eventually(assertion, label, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await assertion();
    } catch (err) {
      lastError = err;
      await delay(25);
    }
  }
  throw new Error(`${label}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

test("direct scheduled run persists active liveness until terminal", async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-scheduler-liveness-db-")), "pdpp.sqlite");
  const connector = writePausedConnector();
  initDb(dbPath);
  const schedulerStore = createSqliteSchedulerStore();
  let scheduler = null;

  t.after(() => {
    scheduler?.stop();
    closeDb();
    rmSync(connector.dir, { recursive: true, force: true });
  });

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
    assert.equal(existsSync(connector.readyPath), true, "connector reached START and paused");
  }, "connector did not start");

  const active = await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    const row = rows.find((candidate) => candidate.connector_instance_id === CONNECTOR_INSTANCE_ID);
    assert.ok(row, "active-run row should exist while direct scheduled run is paused");
    assert.equal(row.connector_id, CONNECTOR_ID);
    assert.match(row.run_id, /^run_/);
    assert.match(row.trace_id, /^trc_/);
    return row;
  }, "active-run row was not persisted");

  const page = await listSpineCorrelations("run", { limit: 50 });
  const summary = page.summaries.find((candidate) => candidate.run_id === active.run_id || candidate.id === active.run_id);
  assert.ok(summary, "expected a run summary for the paused direct scheduled run");
  assert.equal(summary.status, "in_progress");
  assert.equal(summary.failure, null);

  connector.release();

  await eventually(async () => {
    const rows = await schedulerStore.listActiveRuns();
    assert.equal(
      rows.some((candidate) => candidate.run_id === active.run_id),
      false,
      "active-run row should be cleared after terminal"
    );
    const history = await schedulerStore.listRunHistory(10);
    const record = history.find((candidate) => candidate.runId === active.run_id);
    assert.equal(record?.status, "succeeded");
  }, "active-run row was not cleared");
});

test("direct scheduled run cancellation registers by run id and terminals as cancelled", async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-scheduler-cancel-db-")), "pdpp.sqlite");
  const connector = writePausedConnector();
  initDb(dbPath);
  const schedulerStore = createSqliteSchedulerStore();
  const completedRuns = [];
  const unregistered = [];
  let scheduler = null;
  let resolveRegistration;
  const registrationReady = new Promise((resolve) => {
    resolveRegistration = resolve;
  });

  t.after(() => {
    scheduler?.stop();
    closeDb();
    rmSync(connector.dir, { recursive: true, force: true });
  });

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
    onRunComplete: (record) => completedRuns.push(record),
    registerRunCancellation: (registration) => {
      resolveRegistration(registration);
      return () => {
        unregistered.push(registration.runId);
      };
    },
    schedulerStore,
    setState: async () => {},
  });

  scheduler.start();

  await eventually(() => {
    assert.equal(existsSync(connector.readyPath), true, "connector reached START and paused");
  }, "connector did not start");

  const registration = await eventually(async () => {
    const value = await Promise.race([
      registrationReady,
      delay(25).then(() => null),
    ]);
    assert.ok(value, "cancellation registration should exist");
    return value;
  }, "cancellation registration was not created");

  assert.equal(registration.connectorId, CONNECTOR_ID);
  assert.equal(registration.connectorInstanceId, CONNECTOR_INSTANCE_ID);
  assert.match(registration.runId, /^run_/);

  registration.cancel();

  await eventually(async () => {
    assert.equal(completedRuns.length, 1, "cancelled run should complete once");
    const [record] = completedRuns;
    assert.equal(record.runId, registration.runId);
    assert.equal(record.status, "cancelled");
    assert.equal(record.terminalReason, "owner_cancelled");

    const rows = await schedulerStore.listActiveRuns();
    assert.equal(
      rows.some((candidate) => candidate.run_id === registration.runId),
      false,
      "active-run row should be cleared after cancellation"
    );
    const history = await schedulerStore.listRunHistory(10);
    const stored = history.find((candidate) => candidate.runId === registration.runId);
    assert.equal(stored?.status, "cancelled");
    assert.equal(stored?.terminalReason, "owner_cancelled");
  }, "direct scheduled run did not cancel cleanly");

  assert.deepEqual(unregistered, [registration.runId]);

  const page = listSpineEventsPage("run", registration.runId, { limit: 50 });
  const types = page.events.map((event) => event.event_type);
  assert.ok(types.includes("run.cancel_requested"));
  assert.ok(types.includes("run.cancelled"));
  assert.ok(!types.includes("run.failed"));
});
