// Schedule-projection tests for the cross-run source-pressure cooldown
// (`add-schedule-source-pressure-cooldown`).
//
// These prove the dashboard-facing honesty requirement: while a connection
// carries pending source-pressure detail gaps, `getSchedule().scheduler_backoff`
// must surface `cooling_off` with a deferred `next_run_at` rather than leaving
// the connection bare green. They drive the controller's `getSchedule`
// projection with an in-memory scheduler store + a fake detail-gap store, so no
// RS/db/connector spawn is involved.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, initDb } from "../server/db.js";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/cooldown-projection-test";
const INSTANCE_ID = "cin_cooldown_projection";

function createSchedulerStore() {
  const schedules = new Map();
  const activeRuns = new Map();
  const history = [];
  const lastRunTimes = new Map();
  return {
    appendRunHistory: (record) => history.push(record),
    createSchedule: (record) => {
      const key = record.connector_instance_id ?? record.connector_id;
      schedules.set(key, {
        connector_instance_id: key,
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
    deleteSchedule: (connectorInstanceId) => schedules.delete(connectorInstanceId),
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
    upsertActiveRun: (record) => activeRuns.set(record.connector_instance_id ?? record.connector_id, record),
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

// A fake detail-gap store returning whatever pending gaps the test supplies for
// the connector type. The controller only calls `listPendingGapsForConnector`.
function fakeDetailGapStore(gapsByConnectorId) {
  return {
    listPendingGapsForConnector: (connectorId) => gapsByConnectorId.get(connectorId) ?? [],
  };
}

function pressureGapRow(overrides = {}) {
  return {
    connector_instance_id: INSTANCE_ID,
    reason: "upstream_pressure",
    attempt_count: 0,
    next_attempt_after: null,
    stream: "messages",
    ...overrides,
  };
}

async function buildScheduledController(t, { gaps = [], lastRunOffsetMs = 0 } = {}) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-cooldown-proj-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const schedulerStore = createSchedulerStore();
  const gapsByConnectorId = new Map([[CONNECTOR_ID, gaps]]);
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore,
    detailGapStore: fakeDetailGapStore(gapsByConnectorId),
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  await controller.upsertSchedule(CONNECTOR_ID, { interval_seconds: 3600 }, { connectorInstanceId: INSTANCE_ID });
  // Seed a recent last-run anchor so the projection computes a real next-run /
  // cooldown rather than bailing on a never-run connection.
  schedulerStore.upsertLastRunTime(INSTANCE_ID, Date.now() - lastRunOffsetMs, new Date().toISOString(), CONNECTOR_ID);
  return controller;
}

test("a connection with pending upstream_pressure gaps projects cooling_off with a deferred next_run_at", async (t) => {
  const controller = await buildScheduledController(t, { gaps: [pressureGapRow({ attempt_count: 2 })] });
  const schedule = await controller.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  assert.ok(schedule, "schedule should project");
  const backoff = schedule.scheduler_backoff;
  assert.ok(backoff, "scheduler_backoff should be present for an enabled eligible schedule");
  assert.equal(backoff.recommended_health_state, "cooling_off", "pending pressure should render cooling_off, not bare green");
  assert.equal(backoff.backoff_applied, true);
  assert.equal(backoff.reason_class, "source_pressure");
  assert.ok(backoff.next_run_at, "a cooling-off connection must advertise its deferred next attempt");
  // The deferred next-run must be later than the last run (cooldown pushed it out).
  assert.ok(Date.parse(backoff.next_run_at) > Date.now(), "next_run_at must be in the future while cooling");
});

test("no pending pressure gaps -> no cooling_off (the connection is not throttled)", async (t) => {
  const controller = await buildScheduledController(t, { gaps: [] });
  const schedule = await controller.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  assert.ok(schedule);
  const backoff = schedule.scheduler_backoff;
  // No failure streak and no pressure -> backoff is the plain base-interval shape.
  assert.equal(backoff?.recommended_health_state ?? null, null);
  assert.equal(backoff?.backoff_applied ?? false, false);
});

test("non-pressure detail gaps do not project cooling_off", async (t) => {
  const controller = await buildScheduledController(t, {
    gaps: [pressureGapRow({ reason: "retry_exhausted" }), pressureGapRow({ reason: "temporary_unavailable" })],
  });
  const schedule = await controller.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  assert.ok(schedule);
  const backoff = schedule.scheduler_backoff;
  assert.equal(backoff?.recommended_health_state ?? null, null, "non-pressure gap reasons must not throttle the schedule");
  assert.equal(backoff?.backoff_applied ?? false, false);
});

test("cooldown next_run_at grows with pressure persistence", async (t) => {
  const lowController = await buildScheduledController(t, { gaps: [pressureGapRow({ attempt_count: 0 })] });
  const low = await lowController.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  const highController = await buildScheduledController(t, { gaps: [pressureGapRow({ attempt_count: 3 })] });
  const high = await highController.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  assert.ok(
    Date.parse(high.scheduler_backoff.next_run_at) > Date.parse(low.scheduler_backoff.next_run_at),
    "a more-persistent pressure picture must defer the next attempt further out",
  );
});
