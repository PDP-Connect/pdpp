// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the run-now launch-failure honesty fixes added by
 * openspec/changes/surface-run-handle-resolvability:
 *
 *   - the controller's run-now catch path (the "phantom 202" window: a
 *     throw before the runtime's `run.started` emit) records a typed
 *     terminal `run.failed` event with reason `launch_failed`, so a
 *     202-returned run handle always resolves;
 *   - the swallow log includes the run id and trace id;
 *   - post-spawn rejections that already carry a runtime-recorded
 *     terminal event are NOT double-terminated;
 *   - `findActiveRunByRunId` resolves the run while it is in flight and
 *     returns null after the run settles.
 *
 * Uses an injected `runConnectorImpl` (no connector child is spawned),
 * mirroring controller-cancel-run.test.js.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { emitSpineEvent, getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { ActiveRunRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";

const REGEXP_1 = /run_id=run_launch_crash/;
const REGEXP_2 = /executable missing/;
const REGEXP_3 = /executable missing/;

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/launch-failure-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Launch Failure Test",
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

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-launch-failure-")), "pdpp.sqlite"));
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

// A fake launch that rejects only when the test triggers it, so the test
// can observe in-flight state deterministically before the crash.
function deferredLaunchCrash(message: string) {
  let rejectRun!: (reason: Error) => void;
  const settled = new Promise<RuntimeRunConnectorResult>((_resolve, reject) => {
    rejectRun = reject;
  });
  return {
    crash: () => rejectRun(new Error(message)),
    impl: () => settled,
  };
}

test("launch crash before run.started emits a typed launch_failed terminal and logs run/trace ids", async (t) => {
  freshDb(t);

  const errorLines: string[] = [];
  const launch = deferredLaunchCrash("could not spawn connector child: executable missing");
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: {
      error: (message) => {
        errorLines.push(message);
      },
      warn: () => undefined,
    },
    runConnectorImpl: launch.impl,
    schedulerStore: createSchedulerStore(),
  });

  const handle = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_launch",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_launch_crash",
  });
  assert.equal(handle.run_id, "run_launch_crash");
  assert.equal(handle.status, "started", "202-shaped handle returned before the crash");

  // In flight: the run-id-keyed lookup resolves the active run.
  const inFlight = controller.findActiveRunByRunId("run_launch_crash");
  assert.equal(inFlight?.run_id, "run_launch_crash");
  assert.equal(inFlight?.connector_id, CONNECTOR_ID);
  assert.equal(inFlight?.trace_id, handle.trace_id);

  launch.crash();
  await controller.drainActiveRuns(1000);

  // The phantom window is closed: a typed terminal event exists.
  const terminal = await getRunTerminalEvent("run_launch_crash");
  assert.equal(terminal?.status, "failed");
  assert.equal(terminal?.data?.reason, "launch_failed");
  assert.equal(terminal?.data?.failure_reason, "launch_failed");
  assert.equal(terminal?.data?.records_emitted, 0);
  assert.match(String(terminal?.data?.message), REGEXP_2);
  assert.equal(terminal?.actor_id, CONNECTOR_ID);
  assert.equal(terminal?.trace_id, handle.trace_id);
  assert.equal(countTerminalEvents("run_launch_crash"), 1, "exactly one terminal event");

  // Flight state cleared after settle.
  assert.equal(controller.findActiveRunByRunId("run_launch_crash"), null);

  // Swallow log carries the run handle, not just the connector id.
  const line = errorLines.find((entry) => String(entry).includes("run_launch_crash"));
  assert.ok(line, `a failure log line names the run id (got: ${JSON.stringify(errorLines)})`);
  assert.match(String(line), REGEXP_1);
  assert.match(String(line), new RegExp(`trace_id=${handle.trace_id}`));
  assert.match(String(line), REGEXP_3);
});

test("launch-failure terminal message is bounded", async (t) => {
  freshDb(t);

  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.reject(new Error("x".repeat(5000))),
    schedulerStore: createSchedulerStore(),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_bounded",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_launch_bounded",
  });
  await controller.drainActiveRuns(1000);

  const terminal = await getRunTerminalEvent("run_launch_bounded");
  assert.equal(terminal?.status, "failed");
  const message = String(terminal?.data?.message);
  assert.ok(message.length <= 501, `message bounded (got length ${message.length})`);
});

test("post-spawn rejection with a runtime-recorded terminal event is not double-terminated", async (t) => {
  freshDb(t);

  // Fake runtime behaviour for the connector-exit failure path: record the
  // terminal `run.failed` (as runtime/index.ts does), then reject.
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: async (opts) => {
      await emitSpineEvent({
        actor_id: CONNECTOR_ID,
        actor_type: "runtime",
        data: {
          reason: "connector_reported_failed",
          records_emitted: 0,
          source: { id: CONNECTOR_ID, kind: "connector" },
        },
        event_type: "run.failed",
        object_id: opts.runId ?? null,
        object_type: "run",
        run_id: opts.runId ?? null,
        status: "failed",
        trace_id: opts.traceContext?.trace_id ?? null,
      });
      throw new Error("connector exited non-zero");
    },
    schedulerStore: createSchedulerStore(),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_post_spawn",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_post_spawn",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(countTerminalEvents("run_post_spawn"), 1, "runtime terminal is preserved, no controller duplicate");
  const terminal = await getRunTerminalEvent("run_post_spawn");
  assert.equal(terminal?.data?.reason, "connector_reported_failed", "original runtime reason wins");
});

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
test("findActiveRunByRunId returns null for unknown or empty run ids", async (t) => {
  freshDb(t);
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
  });
  assert.equal(controller.findActiveRunByRunId("run_unknown"), null);
  assert.equal(controller.findActiveRunByRunId(""), null);
});
