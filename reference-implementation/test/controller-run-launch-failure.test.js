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
import test from "node:test";

import { emitSpineEvent, getRunTerminalEvent, listSpineEventsPage } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.js";
import {
  __resetControllerInteractionStateForTests,
  createController,
} from "../runtime/controller.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/launch-failure-test";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Launch Failure Test",
  version: "1.0.0",
  streams: [],
};

const TERMINAL_EVENT_TYPES = new Set(["run.completed", "run.failed", "run.cancelled", "run.abandoned"]);

function createSchedulerStore() {
  const activeRuns = new Map();
  return {
    appendRunHistory: () => {},
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (activeRuns.get(connectorInstanceId)?.run_id === runId) activeRuns.delete(connectorInstanceId);
    },
    getSchedule: () => null,
    listActiveRuns: () => [...activeRuns.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    upsertActiveRun: (record) => {
      activeRuns.set(record.connector_instance_id ?? record.connector_id, record);
    },
    upsertLastRunTime: () => {},
  };
}

function freshDb(t) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-launch-failure-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

function countTerminalEvents(runId) {
  const page = listSpineEventsPage("run", runId, { limit: 100 });
  return page.events.filter((event) => TERMINAL_EVENT_TYPES.has(event.event_type)).length;
}

// A fake launch that rejects only when the test triggers it, so the test
// can observe in-flight state deterministically before the crash.
function deferredLaunchCrash(message) {
  let rejectRun;
  const settled = new Promise((_resolve, reject) => {
    rejectRun = reject;
  });
  return {
    impl: () => settled,
    crash: () => rejectRun(new Error(message)),
  };
}

test("launch crash before run.started emits a typed launch_failed terminal and logs run/trace ids", async (t) => {
  freshDb(t);

  const errorLines = [];
  const launch = deferredLaunchCrash("could not spawn connector child: executable missing");
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: (line) => errorLines.push(line), warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: launch.impl,
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
  assert.match(String(terminal?.data?.message), /executable missing/);
  assert.equal(terminal?.actor_id, CONNECTOR_ID);
  assert.equal(terminal?.trace_id, handle.trace_id);
  assert.equal(countTerminalEvents("run_launch_crash"), 1, "exactly one terminal event");

  // Flight state cleared after settle.
  assert.equal(controller.findActiveRunByRunId("run_launch_crash"), null);

  // Swallow log carries the run handle, not just the connector id.
  const line = errorLines.find((entry) => String(entry).includes("run_launch_crash"));
  assert.ok(line, `a failure log line names the run id (got: ${JSON.stringify(errorLines)})`);
  assert.match(String(line), /run_id=run_launch_crash/);
  assert.match(String(line), new RegExp(`trace_id=${handle.trace_id}`));
  assert.match(String(line), /executable missing/);
});

test("launch-failure terminal message is bounded", async (t) => {
  freshDb(t);

  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: () => Promise.reject(new Error("x".repeat(5000))),
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
  // terminal `run.failed` (as runtime/index.js does), then reject.
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: async (opts) => {
      await emitSpineEvent({
        event_type: "run.failed",
        trace_id: opts.traceContext?.trace_id,
        actor_type: "runtime",
        actor_id: CONNECTOR_ID,
        object_type: "run",
        object_id: opts.runId,
        status: "failed",
        run_id: opts.runId,
        data: {
          source: { kind: "connector", id: CONNECTOR_ID },
          reason: "connector_reported_failed",
          records_emitted: 0,
        },
      });
      throw new Error("connector exited non-zero");
    },
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

test("findActiveRunByRunId returns null for unknown or empty run ids", async (t) => {
  freshDb(t);
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    runConnectorImpl: () => Promise.resolve({ status: "succeeded", records_emitted: 0 }),
  });
  assert.equal(controller.findActiveRunByRunId("run_unknown"), null);
  assert.equal(controller.findActiveRunByRunId(""), null);
});
