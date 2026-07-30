// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import type {
  ActiveRunRecord,
  ScheduleRecord,
  SchedulerLastRunTimeRecord,
  SchedulerRunHistoryRecord,
  SchedulerStore,
} from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/instance-runtime-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Instance Runtime Test",
  streams: [],
  version: "1.0.0",
};

function createSchedulerStore(): SchedulerStore {
  const schedules = new Map<string, ScheduleRecord>();
  const activeRuns = new Map<string, ActiveRunRecord>();
  const history: SchedulerRunHistoryRecord[] = [];
  const lastRunTimes = new Map<string, SchedulerLastRunTimeRecord>();
  return {
    appendRunHistory: (record) => {
      history.push(record);
    },
    createSchedule: (record) => {
      schedules.set(record.connector_instance_id ?? record.connector_id, {
        connector_id: record.connector_id,
        connector_instance_id: record.connector_instance_id ?? record.connector_id,
        created_at: record.created_at,
        enabled: record.enabled,
        interval_seconds: record.interval_seconds,
        jitter_seconds: record.jitter_seconds,
        updated_at: record.updated_at,
      });
    },
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) {
        activeRuns.delete(connectorInstanceId);
      }
    },
    deleteSchedule: (connectorInstanceId) => {
      schedules.delete(connectorInstanceId);
    },
    getActiveRun: (connectorInstanceId) => activeRuns.get(connectorInstanceId) ?? null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: (connectorInstanceId) => schedules.get(connectorInstanceId) ?? null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [...lastRunTimes.values()],
    listRunHistory: () => history,
    listSchedules: () => [...schedules.values()],
    setScheduleEnabled: (connectorInstanceId, enabled, updatedAt) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) {
        schedules.set(connectorInstanceId, { ...existing, enabled, updated_at: updatedAt });
      }
    },
    updateSchedule: (connectorInstanceId, patch) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) {
        schedules.set(connectorInstanceId, { ...existing, ...patch });
      }
    },
    upsertActiveRun: (record) => {
      activeRuns.set(record.connector_instance_id ?? record.connector_id, record);
      return true;
    },
    upsertLastRunTime: (connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) => {
      lastRunTimes.set(connectorInstanceId, {
        connector_id: connectorId,
        connector_instance_id: connectorInstanceId,
        last_run_time_ms: lastRunTimeMs,
        updated_at: updatedAt,
      });
    },
  };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("controller scopes schedules and active runs by connector instance", async (t) => {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-controller-instance-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const calls: RuntimeRunConnectorOptions[] = [];
  const firstRun = deferred<RuntimeRunConnectorResult>();
  const secondRun = deferred<RuntimeRunConnectorResult>();
  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return opts.connectorInstanceId === "cin_one" ? firstRun.promise : secondRun.promise;
    },
    schedulerStore: createSchedulerStore(),
  });

  const firstSchedule = await controller.upsertSchedule(
    CONNECTOR_ID,
    { interval_seconds: 60 },
    { connectorInstanceId: "cin_one" }
  );
  const secondSchedule = await controller.upsertSchedule(
    CONNECTOR_ID,
    { interval_seconds: 120 },
    { connectorInstanceId: "cin_two" }
  );

  assert.equal(firstSchedule.schedule.connector_id, CONNECTOR_ID);
  assert.equal(firstSchedule.schedule.connector_instance_id, "cin_one");
  assert.equal(secondSchedule.schedule.connector_id, CONNECTOR_ID);
  assert.equal(secondSchedule.schedule.connector_instance_id, "cin_two");

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_one",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_one",
  });
  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_two",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_two",
  });

  assert.equal(controller.getActiveRun(CONNECTOR_ID, { connectorInstanceId: "cin_one" })?.run_id, "run_one");
  assert.equal(controller.getActiveRun(CONNECTOR_ID, { connectorInstanceId: "cin_two" })?.run_id, "run_two");
  // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
  assert.deepEqual(calls.map((call) => call.connectorInstanceId).sort(), ["cin_one", "cin_two"]);

  firstRun.resolve({ records_emitted: 0, status: "succeeded" });
  secondRun.resolve({ records_emitted: 0, status: "succeeded" });
  await controller.drainActiveRuns(1000);
});
