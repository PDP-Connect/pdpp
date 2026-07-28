// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the owner-only single-run cancellation primitive
// `controller.cancelRun(runId)` added by
// openspec/changes/add-owner-run-cancellation-control.
//
// These tests use an injected `runConnectorImpl` so no connector child is
// spawned: the fake run resolves only when its `cancelSignal` aborts (or when
// the test explicitly resolves it), which lets us assert that cancellation is
// scoped to exactly one run, that typed results are returned for missing and
// already-terminal runs, and that the cancelled run's active-run lock is
// cleared so a fresh manual run is admitted while a sibling run is untouched.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { emitSpineEvent } from "../lib/spine.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { ActiveRunRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/cancel-run-test";
const SIBLING_ID = "https://registry.pdpp.org/connectors/cancel-run-sibling";
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "Cancel Run Test",
  streams: [],
  version: "1.0.0",
};
const SIBLING_MANIFEST = { ...MANIFEST, connector_id: SIBLING_ID, name: "Cancel Run Sibling" };

function createSchedulerStore(): SchedulerStore {
  const activeRuns = new Map<string, ActiveRunRecord>();
  const history: Parameters<SchedulerStore["appendRunHistory"]>[0][] = [];
  return {
    appendRunHistory: (record) => {
      history.push(record);
    },
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
    listRunHistory: () => history,
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

interface CancellableRunImpl {
  aborted: boolean;
  forceResolve: () => void;
  runId: string | null;
  signal: AbortSignal | null;
  (opts: RuntimeRunConnectorOptions): Promise<RuntimeRunConnectorResult>;
}

// A fake connector run that resolves when its cancel signal aborts. Records
// whether the signal was observed and the aborted state so the controller-side
// scoping can be asserted without a real child process.
function cancellableRun(): CancellableRunImpl {
  let resolveRun!: (value: RuntimeRunConnectorResult) => void;
  const settled = new Promise<RuntimeRunConnectorResult>((done) => {
    resolveRun = done;
  });
  const impl = ((opts: RuntimeRunConnectorOptions) => {
    impl.signal = opts.cancelSignal ?? null;
    impl.runId = opts.runId ?? null;
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
  }) as CancellableRunImpl;
  impl.aborted = false;
  impl.signal = null;
  impl.runId = null;
  impl.forceResolve = () => resolveRun({ records_emitted: 0, status: "succeeded" });
  return impl;
}

function freshDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-cancel-run-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

test("cancelRun aborts only the targeted run; sibling run is untouched", async (t) => {
  freshDb(t);

  const runA = cancellableRun();
  const runB = cancellableRun();
  const store = createSchedulerStore();
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: (opts) => (opts.connectorInstanceId === "cin_b" ? runB(opts) : runA(opts)),
    schedulerStore: store,
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_a",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_a",
  });
  await controller.runNow(SIBLING_ID, {
    connectorInstanceId: "cin_b",
    manifest: SIBLING_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_b",
  });

  assert.equal(controller.getActiveRun(CONNECTOR_ID, { connectorInstanceId: "cin_a" })?.run_id, "run_a");
  assert.equal(controller.getActiveRun(SIBLING_ID, { connectorInstanceId: "cin_b" })?.run_id, "run_b");

  const result = await controller.cancelRun("run_a");
  assert.deepEqual(result, { run_id: "run_a", status: "cancel_requested" });

  // run_a's fake observed the abort; run_b's did not.
  assert.equal(runA.aborted, true, "targeted run observed the cancel signal");
  assert.equal(runB.aborted, false, "sibling run did NOT observe a cancel signal");

  // run_a settles and its active-run lock clears; run_b stays active.
  await controller.drainActiveRuns(1000).catch(() => undefined);
  assert.equal(
    controller.getActiveRun(CONNECTOR_ID, { connectorInstanceId: "cin_a" }),
    null,
    "cancelled run's active-run row cleared"
  );
  assert.equal(
    controller.getActiveRun(SIBLING_ID, { connectorInstanceId: "cin_b" })?.run_id,
    "run_b",
    "sibling active-run row remains"
  );

  // Tidy: let run_b finish so the drain primitive doesn't leak a timer.
  runB.forceResolve();
  await controller.drainActiveRuns(1000).catch(() => undefined);
});

test("cancelRun on an unknown run returns no_active_run", async (t) => {
  freshDb(t);
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
  });

  const result = await controller.cancelRun("run_does_not_exist");
  assert.deepEqual(result, { run_id: "run_does_not_exist", status: "no_active_run" });
});

test("cancelRun on a run with a terminal event returns already_terminal", async (t) => {
  freshDb(t);
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
    schedulerStore: createSchedulerStore(),
  });

  // No in-memory active run, but a terminal spine event exists for this id.
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: { source: { id: CONNECTOR_ID, kind: "connector" } },
    event_type: "run.completed",
    object_id: "run_finished",
    object_type: "run",
    run_id: "run_finished",
    status: "succeeded",
  });

  const result = await controller.cancelRun("run_finished");
  assert.deepEqual(result, { run_id: "run_finished", status: "already_terminal" });
});

test("after cancel, a new manual run for the same connector is admitted", async (t) => {
  freshDb(t);

  const firstRun = cancellableRun();
  let secondImplCalled = false;
  const controller = createController({
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: (opts) => {
      if (opts.runId === "run_first") {
        return firstRun(opts);
      }
      secondImplCalled = true;
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
    schedulerStore: createSchedulerStore(),
  });

  await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_a",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });

  // Before cancel, a second run for the same connector must be rejected.
  await assert.rejects(
    () =>
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId: "cin_a",
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_second_blocked",
      }),
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    /run_already_active|already has an active run/i
  );

  await controller.cancelRun("run_first");
  await controller.drainActiveRuns(1000).catch(() => undefined);

  // Lock cleared → a fresh manual run is admitted.
  const second = await controller.runNow(CONNECTOR_ID, {
    connectorInstanceId: "cin_a",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_second",
  });
  assert.equal(second.run_id, "run_second");
  assert.equal(secondImplCalled, true);
  await controller.drainActiveRuns(1000).catch(() => undefined);
});
