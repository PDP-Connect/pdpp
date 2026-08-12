// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { listSpineCorrelations, listSpineEventsPage } from "../lib/spine.ts";
import { createScheduler, type Scheduler } from "../runtime/scheduler.ts";
import type { RunCancellationRegistration, RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import { createSqliteSchedulerStore } from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/scheduler-direct-liveness";
const CONNECTOR_INSTANCE_ID = "cin_scheduler_direct_liveness";

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Scheduler Direct Liveness",
  runtime_requirements: {},
  streams: [
    {
      name: "items",
      primary_key: "id",
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
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

async function eventually<T>(assertion: () => T | Promise<T>, label: string, timeoutMs = 2500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
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
  let scheduler: Scheduler | null = null;

  t.after(() => {
    scheduler?.stop();
    closeDb();
    rmSync(connector.dir, { force: true, recursive: true });
  });

  scheduler = createScheduler({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
      assert.equal(connectorId, CONNECTOR_ID);
      assert.equal(connectorInstanceId, CONNECTOR_INSTANCE_ID);
      assert.equal(ownerSubjectId, "owner_scheduler_liveness");
      return Promise.resolve({ connectorId, connectorInstanceId: CONNECTOR_INSTANCE_ID, ownerSubjectId });
    },
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: connector.connectorPath,
        intervalMs: 60_000,
        manifest: MANIFEST,
        ownerSubjectId: "owner_scheduler_liveness",
        ownerToken: "owner-token",
      },
    ],
    getState: async () => null,
    onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
    schedulerStore,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
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
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(row.run_id, /^run_/);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(row.trace_id, /^trc_/);
    return row;
  }, "active-run row was not persisted");

  const page = await listSpineCorrelations("run", { limit: 50 });
  const summary = page.summaries.find(
    (candidate) => candidate.run_id === active.run_id || candidate.id === active.run_id
  );
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
  const completedRuns: RunRecord[] = [];
  const unregistered: string[] = [];
  let scheduler: Scheduler | null = null;
  let resolveRegistration: (registration: RunCancellationRegistration) => void;
  const registrationReady = new Promise<RunCancellationRegistration>((resolve) => {
    resolveRegistration = resolve;
  });

  t.after(() => {
    scheduler?.stop();
    closeDb();
    rmSync(connector.dir, { force: true, recursive: true });
  });

  scheduler = createScheduler({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
      assert.equal(connectorId, CONNECTOR_ID);
      assert.equal(connectorInstanceId, CONNECTOR_INSTANCE_ID);
      assert.equal(ownerSubjectId, "owner_scheduler_liveness");
      return Promise.resolve({ connectorId, connectorInstanceId: CONNECTOR_INSTANCE_ID, ownerSubjectId });
    },
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: connector.connectorPath,
        intervalMs: 60_000,
        manifest: MANIFEST,
        ownerSubjectId: "owner_scheduler_liveness",
        ownerToken: "owner-token",
      },
    ],
    getState: async () => null,
    onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
    onRunComplete: (record) => completedRuns.push(record),
    // biome-ignore lint/suspicious/noShadow: localized test assertion preserves its explicit contract.
    registerRunCancellation: (registration) => {
      resolveRegistration(registration);
      return () => {
        unregistered.push(registration.runId);
      };
    },
    schedulerStore,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    setState: async () => {},
  });

  scheduler.start();

  await eventually(() => {
    assert.equal(existsSync(connector.readyPath), true, "connector reached START and paused");
  }, "connector did not start");

  const registration = await eventually(async () => {
    const value = await Promise.race([registrationReady, delay(25).then(() => null)]);
    assert.ok(value, "cancellation registration should exist");
    return value;
  }, "cancellation registration was not created");

  assert.equal(registration.connectorId, CONNECTOR_ID);
  assert.equal(registration.connectorInstanceId, CONNECTOR_INSTANCE_ID);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.match(registration.runId, /^run_/);

  registration.cancel();

  await eventually(async () => {
    assert.equal(completedRuns.length, 1, "cancelled run should complete once");
    const [record] = completedRuns;
    assert.ok(record, "expected exactly one completed run");
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

test("direct scheduled run skips without spawning a child when durable active-run row already exists", async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "pdpp-scheduler-conflict-db-")), "pdpp.sqlite");
  const connector = writePausedConnector();
  initDb(dbPath);
  const schedulerStore = createSqliteSchedulerStore();
  let scheduler: Scheduler | null = null;

  await schedulerStore.upsertActiveRun({
    connector_id: CONNECTOR_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
    run_generation: 1,
    run_id: "run_existing_conflict",
    scenario_id: "scn_existing_conflict",
    started_at: new Date().toISOString(),
    trace_id: "trc_existing_conflict",
  });

  t.after(() => {
    scheduler?.stop();
    closeDb();
    rmSync(connector.dir, { force: true, recursive: true });
  });

  scheduler = createScheduler({
    admitRunConnection: ({ connectorId, connectorInstanceId, ownerSubjectId }) => {
      assert.equal(connectorId, CONNECTOR_ID);
      assert.equal(connectorInstanceId, CONNECTOR_INSTANCE_ID);
      assert.equal(ownerSubjectId, "owner_scheduler_liveness");
      return Promise.resolve({ connectorId, connectorInstanceId: CONNECTOR_INSTANCE_ID, ownerSubjectId });
    },
    connectors: [
      {
        connectorId: CONNECTOR_ID,
        connectorInstanceId: CONNECTOR_INSTANCE_ID,
        connectorPath: connector.connectorPath,
        intervalMs: 60_000,
        manifest: MANIFEST,
        ownerSubjectId: "owner_scheduler_liveness",
        ownerToken: "owner-token",
      },
    ],
    getState: async () => null,
    onInteraction: () => ({ status: "cancelled", type: "INTERACTION_RESPONSE" }),
    schedulerStore,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    setState: async () => {},
  });

  scheduler.start();

  // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
  const conflictRecord = await eventually(async () => {
    const history = scheduler.getHistory();
    const record = history.find((candidate) => candidate.error?.includes("run_already_active"));
    assert.ok(record, "scheduler should record a neutral run_already_active skip");
    return record;
  }, "scheduler should have recorded the active-run skip");

  assert.equal(
    existsSync(connector.readyPath),
    false,
    "connector child must not start when durable active-run row already exists"
  );
  assert.equal(conflictRecord?.status, "skipped");
  assert.equal(conflictRecord?.connectorInstanceId, CONNECTOR_INSTANCE_ID);

  const rows = await schedulerStore.listActiveRuns();
  assert.equal(rows.length, 1, "durable incumbent row must remain intact");
  const [incumbent] = rows;
  assert.ok(incumbent, "expected the durable incumbent row");
  assert.equal(incumbent.run_id, "run_existing_conflict");
});
