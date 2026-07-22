// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/instance-runtime-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Instance Runtime Test",
  version: "1.0.0",
  streams: [],
};

function createSchedulerStore() {
  const schedules = new Map();
  const activeRuns = new Map();
  const history = [];
  const lastRunTimes = new Map();
  return {
    appendRunHistory: (record) => {
      history.push(record);
    },
    createSchedule: (record) => {
      schedules.set(record.connector_instance_id ?? record.connector_id, {
        connector_instance_id: record.connector_instance_id ?? record.connector_id,
        connector_id: record.connector_id,
        interval_seconds: record.interval_seconds,
        jitter_seconds: record.jitter_seconds,
        enabled: record.enabled,
        created_at: record.created_at,
        updated_at: record.updated_at,
      });
    },
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) activeRuns.delete(connectorInstanceId);
    },
    deleteSchedule: (connectorInstanceId) => {
      schedules.delete(connectorInstanceId);
    },
    getSchedule: (connectorInstanceId) => schedules.get(connectorInstanceId) ?? null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [...lastRunTimes.values()],
    listRunHistory: () => history,
    listSchedules: () => [...schedules.values()],
    setScheduleEnabled: (connectorInstanceId, enabled, updatedAt) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) schedules.set(connectorInstanceId, { ...existing, enabled, updated_at: updatedAt });
    },
    updateSchedule: (connectorInstanceId, patch) => {
      const existing = schedules.get(connectorInstanceId);
      if (existing) schedules.set(connectorInstanceId, { ...existing, ...patch });
    },
    upsertActiveRun: (record) => {
      activeRuns.set(record.connector_instance_id ?? record.connector_id, record);
    },
    upsertLastRunTime: (connectorInstanceId, lastRunTimeMs, updatedAt, connectorId = connectorInstanceId) => {
      lastRunTimes.set(connectorInstanceId, {
        connector_instance_id: connectorInstanceId,
        connector_id: connectorId,
        last_run_time_ms: lastRunTimeMs,
        updated_at: updatedAt,
      });
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
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

  const calls = [];
  const firstRun = deferred();
  const secondRun = deferred();
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: (opts) => {
      calls.push(opts);
      return opts.connectorInstanceId === "cin_one" ? firstRun.promise : secondRun.promise;
    },
  });

  const firstSchedule = await controller.upsertSchedule(
    CONNECTOR_ID,
    { interval_seconds: 60 },
    { connectorInstanceId: "cin_one" },
  );
  const secondSchedule = await controller.upsertSchedule(
    CONNECTOR_ID,
    { interval_seconds: 120 },
    { connectorInstanceId: "cin_two" },
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
  assert.deepEqual(
    calls.map((call) => call.connectorInstanceId).sort(),
    ["cin_one", "cin_two"],
  );

  firstRun.resolve({ status: "succeeded", records_emitted: 0 });
  secondRun.resolve({ status: "succeeded", records_emitted: 0 });
  await controller.drainActiveRuns(1000);
});
