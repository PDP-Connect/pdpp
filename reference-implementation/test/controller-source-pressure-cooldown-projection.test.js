// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import { makeTemporaryDbPath } from "./helpers/temp-dir.js";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
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
  initDb(makeTemporaryDbPath("pdpp-cooldown-proj-"));
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

test("pending pressure gaps after elapsed cooldown project as eligible, not cooling_off", async (t) => {
  const controller = await buildScheduledController(t, {
    gaps: [pressureGapRow({ attempt_count: 1 })],
    lastRunOffsetMs: 3 * 60 * 60 * 1000,
  });
  const schedule = await controller.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  assert.ok(schedule);
  const backoff = schedule.scheduler_backoff;
  assert.equal(backoff?.recommended_health_state ?? null, null, "due pressure backlog must not render cooling_off");
  assert.equal(backoff?.backoff_applied ?? false, false, "due pressure backlog must not mark backoff active");
  assert.equal(backoff?.reason_class ?? null, null, "due pressure backlog must not be labeled source_pressure");
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

// ─── Catch-up honesty: a connection that will not auto-resume must not be ─────
// projected as a cooling-off connection that "resumes at <next>". The console's
// source-pressure copy reads "the scheduler is spacing out automatic attempts;
// the captured progress is retained and it resumes at <next>." That promise is
// only true when the connection actually has an eligible automatic schedule.
// A manual-only / background-unsafe connector (e.g. ChatGPT — browser-scraped
// behind a login wall, large history caught up slowly) has no such schedule, so
// the projection must NOT stamp `cooling_off` + `next_run_at` for it even while
// pending source-pressure gaps exist. These tests pin the two gates that keep
// that promise honest, so a future refactor of `buildSchedulerBackoffApi` or the
// schedule-creation gate cannot silently regress a manual connector into a false
// auto-resume promise.

test("a DISABLED schedule with pending pressure gaps projects no cooling_off (nothing will auto-resume)", async (t) => {
  const controller = await buildScheduledController(t, { gaps: [pressureGapRow({ attempt_count: 2 })] });
  // Same pressure picture as the cooling_off test above, but the operator has
  // paused the schedule. A disabled row never auto-dispatches, so promising a
  // deferred "next attempt" would be a lie.
  await controller.setScheduleEnabled(CONNECTOR_ID, false, { connectorInstanceId: INSTANCE_ID });
  const schedule = await controller.getSchedule(CONNECTOR_ID, { connectorInstanceId: INSTANCE_ID });

  assert.ok(schedule, "schedule should still project while paused");
  assert.equal(schedule.enabled, false);
  assert.equal(
    schedule.scheduler_backoff ?? null,
    null,
    "a paused connection must not advertise a cooling-off auto-resume it will never honor",
  );
});

// A manual/background-unsafe manifest is rejected at schedule creation time —
// the operator can never reach the enabled-eligible state that would project
// `cooling_off` + `next_run_at`. This is the authoritative gate upstream of
// the projection: it keeps the catch-up copy honest by construction.
const MANUAL_CONNECTOR_MANIFEST = {
  protocol_version: "0.1.0",
  connector_id: "https://registry.pdpp.org/connectors/chatgpt",
  connector_key: "chatgpt",
  version: "0.1.0",
  display_name: "Manual catch-up test",
  capabilities: {
    refresh_policy: {
      recommended_mode: "manual",
      background_safe: false,
      interaction_posture: "manual_action_likely",
      rationale: "Synthetic fixture that cannot honestly run on a schedule.",
    },
  },
  streams: [
    {
      name: "items",
      semantics: "append_only",
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      primary_key: ["id"],
    },
  ],
};

test("a manual / background-unsafe connector cannot enable an automatic schedule (creation-time gate)", async (t) => {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-cooldown-proj-manual-"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  // Register the manual-policy manifest under the canonical key the controller
  // resolves schedules by (`connector_key`, which `upsertSchedule` derives from
  // the connector_id), so the eligibility gate sees the true
  // `recommended_mode: "manual"` / `background_safe: false` policy.
  const manifest = MANUAL_CONNECTOR_MANIFEST;
  const manifestText = JSON.stringify(manifest);
  assert.equal(manifest.capabilities.refresh_policy.recommended_mode, "manual", "fixture must be a manual-policy connector");
  getDb()
    .prepare("INSERT INTO connectors (connector_id, manifest) VALUES (?, ?)")
    .run(manifest.connector_key, manifestText);

  const schedulerStore = createSchedulerStore();
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore,
    detailGapStore: fakeDetailGapStore(new Map()),
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });

  await assert.rejects(
    () =>
      controller.upsertSchedule(
        manifest.connector_id,
        { interval_seconds: 3600, enabled: true },
        { connectorInstanceId: "cin_manual_catchup" },
      ),
    /manual runs|background-safe|automatic scheduling is disabled/i,
    "enabling an automatic schedule for a manual / background-unsafe connector must be rejected",
  );

  // And the row must not have been created: no schedule means no cooling-off
  // projection can ever be built for it.
  const schedule = await controller.getSchedule(manifest.connector_id, {
    connectorInstanceId: "cin_manual_catchup",
  });
  assert.equal(schedule ?? null, null, "a rejected automatic schedule must not be persisted");
});
