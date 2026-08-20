// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `schedule.back_off.cleared` transition-marker oracle.
//
// `emitBackoffClearedIfStreakEnded` (runtime/scheduler/run-executor.ts) owns
// three ordered invariants that previously had no test anywhere in the fleet:
//
//   1. ORDERING — the cleared marker is emitted AFTER the success record is
//      persisted to history and AFTER the success completion notification
//      ("success → cleared in the same tick"). A reordering that announces
//      the streak end before the success record exists would let a timeline
//      reader observe a cleared streak with no success to explain it.
//   2. NO EMIT while the streak remains — a failed run, or a success with no
//      announced back-off/blocked streak, must not emit the marker, and a
//      failure must leave the announce-once maps intact so the eventual
//      recovery still announces exactly once.
//   3. PRE-SUCCESS CAPTURE — the streak check reads state captured BEFORE
//      the success side effects run. `onRunComplete` for the success record
//      can synchronously trigger dispatch-governor evaluation that clears
//      `announcedBackoffClass` on its own; the marker must still be emitted
//      exactly once in that interleaving.
//
// This suite drives `createRunExecutor(...).launchRun` — the exact seam the
// scheduler's `executeRun` calls after the pre-run gate — with a real
// connector subprocess, so the marker path runs through the genuine
// runWithRetries → finalizeSuccessOrFailure flow, not a re-implementation.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import {
  createRunExecutor,
  type RunExecutorDeps,
  type RunExecutorRuntimeState,
} from "../runtime/scheduler/run-executor.ts";
import type {
  ConnectorSchedule,
  RunManagedConnectorViaController,
  RunRecord,
} from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";

const CONNECTOR_ID = "https://registry.pdpp.dev/connectors/backoff-cleared-marker";
const CONNECTOR_INSTANCE_ID = "cin_backoff_cleared_marker";

const MANIFEST = { streams: [{ name: "items" }] };

const SCHEDULED_POLICY = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

function writeConnector(tmpDir: string, doneMessage: Record<string, unknown>, exitCode: number): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  process.stdout.write(JSON.stringify(${JSON.stringify(doneMessage)}) + "\\n");
  rl.close();
  process.exit(${exitCode});
});
`,
    "utf8"
  );
  return connectorPath;
}

function writeSucceedingConnector(tmpDir: string): string {
  return writeConnector(tmpDir, { records_emitted: 0, status: "succeeded", type: "DONE" }, 0);
}

// A failed DONE must exit nonzero or the runtime records a protocol violation.
function writeFailingConnector(tmpDir: string): string {
  return writeConnector(
    tmpDir,
    {
      error: { message: "provider rejected credentials", retryable: false },
      records_emitted: 0,
      status: "failed",
      type: "DONE",
    },
    1
  );
}

function freshRuntime(): RunExecutorRuntimeState {
  return {
    announcedBackoffClass: new Map<string, string>(),
    announcedBlockedClass: new Map<string, string>(),
    exhaustedGrants: new Set<string>(),
    history: [],
    running: true,
  };
}

function isClearedMarker(record: RunRecord): boolean {
  return typeof record.error === "string" && record.error.startsWith("schedule.back_off.cleared:");
}

interface Harness {
  completions: RunRecord[];
  launchRun: ReturnType<typeof createRunExecutor>["launchRun"];
  runtime: RunExecutorRuntimeState;
}

interface HarnessOptions {
  readonly managedResult?: NonNullable<Awaited<ReturnType<RunManagedConnectorViaController>>>;
  readonly onRunComplete?: (record: RunRecord) => void;
  readonly schedulerStore?: NonNullable<RunExecutorDeps["schedulerStore"]>;
}

function makeHarness(runtime: RunExecutorRuntimeState, options: HarnessOptions = {}): Harness {
  const completions: RunRecord[] = [];
  const notifyCompletion = (record: RunRecord): void => {
    completions.push(record);
    options.onRunComplete?.(record);
  };
  const deps: RunExecutorDeps = {
    // The runtime fails closed without an admitted run connection; admit the
    // claimed identity verbatim so the run reaches finalizeSuccessOrFailure.
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
      ownerSubjectId: ownerSubjectId ?? "owner_test",
    }),
    getState: async () => null,
    handleGrantFailureDisable: () => {
      // Grant-disable side effects are out of scope for the marker oracle.
    },
    isManagedConnector: () => options.managedResult !== undefined,
    markNeedsHuman: () => {
      // Needs-human escalation is out of scope for the marker oracle.
    },
    maxRunWallClockMs: 0,
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: notifyCompletion,
    persistLastRunTime: () => {
      // Last-run stamping is out of scope for the marker oracle.
    },
    // Mirrors scheduler.ts::recordAndNotify (history append + completion
    // notification) so marker emission is observed with production ordering.
    recordAndNotify: (record) => {
      runtime.history.push(record);
      notifyCompletion(record);
      return record;
    },
    referenceBaseUrl: null,
    registerRunCancellation: null,
    resolveStaticSecretRunEnv: null,
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController: options.managedResult ? async () => options.managedResult ?? null : null,
    runtime,
    schedulerStore: options.schedulerStore ?? null,
    setState: async () => {
      // State persistence is out of scope for the marker oracle.
    },
  };
  return { completions, launchRun: createRunExecutor(deps).launchRun, runtime };
}

function schedule(connectorPath: string): ConnectorSchedule {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath,
    intervalMs: 60_000,
    manifest: MANIFEST,
    maxRetries: 0,
    ownerSubjectId: "owner_local",
    ownerToken: "owner-token",
  };
}

function withTmpDir(fn: (tmpDir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-backoff-cleared-"));
    // The runtime's default detail-gap store reads the process-global DB;
    // give each test a throwaway SQLite file so the run can finalize.
    initDb(join(tmpDir, "test.db"));
    try {
      await fn(tmpDir);
    } finally {
      closeDb();
      rmSync(tmpDir, { force: true, recursive: true });
    }
  };
}

test(
  "success ending an announced back-off streak emits the cleared marker AFTER the success record, and resets both announce-once maps",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    runtime.announcedBackoffClass.set(CONNECTOR_INSTANCE_ID, "terminal:authentication_error");
    const harness = makeHarness(runtime);

    await harness.launchRun(schedule(writeSucceedingConnector(tmpDir)), false, SCHEDULED_POLICY);

    const markers = runtime.history.filter(isClearedMarker);
    assert.equal(markers.length, 1, "exactly one cleared marker must be recorded");
    const [marker] = markers;
    assert.ok(marker);

    // ORDERING: the durable history must read success → cleared, and the
    // completion notifications must fire in that same order.
    const successIndex = runtime.history.findIndex((r) => r.status === "succeeded");
    const markerIndex = runtime.history.indexOf(marker);
    assert.ok(successIndex >= 0, "the success record must be persisted to history");
    assert.ok(
      markerIndex > successIndex,
      `cleared marker must be recorded after the success record (success at ${successIndex}, marker at ${markerIndex})`
    );
    assert.deepEqual(
      harness.completions.map((r) => (isClearedMarker(r) ? "cleared" : r.status)),
      ["succeeded", "cleared"],
      "completion notifications must fire success first, cleared marker second"
    );

    // Marker payload anchors the timeline to the success that ended the streak.
    const successRecord = runtime.history[successIndex];
    assert.ok(successRecord);
    assert.equal(marker.status, "skipped");
    assert.equal(marker.connectorInstanceId, CONNECTOR_INSTANCE_ID);
    const payload = JSON.parse(marker.error?.slice("schedule.back_off.cleared: ".length) ?? "{}") as {
      resumed_at?: string;
    };
    assert.equal(payload.resumed_at, successRecord.completedAt, "resumed_at must be the success record's completedAt");

    // Both announce-once maps reset so a future degradation re-announces.
    assert.equal(runtime.announcedBackoffClass.has(CONNECTOR_INSTANCE_ID), false);
    assert.equal(runtime.announcedBlockedClass.has(CONNECTOR_INSTANCE_ID), false);
  })
);

test(
  "delayed durable success settles before the cleared marker append",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    runtime.announcedBackoffClass.set(CONNECTOR_INSTANCE_ID, "terminal:authentication_error");
    const durableOrder: string[] = [];
    let successCommitted = false;
    const delayedStore: NonNullable<RunExecutorDeps["schedulerStore"]> = {
      appendRunHistory: async (record) => {
        const marker = record.error?.startsWith("schedule.back_off.cleared:") === true;
        const label = marker ? "cleared" : "success";
        durableOrder.push(`${label}:started`);
        if (marker) {
          assert.equal(successCommitted, true, "the cleared marker append must not begin before success commits");
        } else {
          await new Promise((resolve) => setTimeout(resolve, 25));
          successCommitted = true;
        }
        durableOrder.push(`${label}:committed`);
      },
      deleteActiveRun: async () => undefined,
      upsertActiveRun: async () => true,
    };
    const harness = makeHarness(runtime, { schedulerStore: delayedStore });

    await harness.launchRun(schedule(writeSucceedingConnector(tmpDir)), false, SCHEDULED_POLICY);

    assert.deepEqual(durableOrder, ["success:started", "success:committed", "cleared:started", "cleared:committed"]);
  })
);

test(
  "success ending an announced BLOCKED streak also emits the cleared marker",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    runtime.announcedBlockedClass.set(CONNECTOR_INSTANCE_ID, "terminal:authentication_error");
    const harness = makeHarness(runtime);

    await harness.launchRun(schedule(writeSucceedingConnector(tmpDir)), false, SCHEDULED_POLICY);

    assert.equal(runtime.history.filter(isClearedMarker).length, 1, "blocked-streak end must emit the cleared marker");
    assert.equal(runtime.announcedBlockedClass.has(CONNECTOR_INSTANCE_ID), false);
  })
);

test(
  "success with NO announced streak emits no cleared marker",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    const harness = makeHarness(runtime);

    await harness.launchRun(schedule(writeSucceedingConnector(tmpDir)), false, SCHEDULED_POLICY);

    assert.equal(
      runtime.history.some((r) => r.status === "succeeded"),
      true,
      "the run itself must succeed"
    );
    assert.deepEqual(runtime.history.filter(isClearedMarker), [], "no streak was announced, so nothing was cleared");
  })
);

test(
  "failed run with an announced streak emits no cleared marker and leaves the announce-once maps intact",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    runtime.announcedBackoffClass.set(CONNECTOR_INSTANCE_ID, "terminal:authentication_error");
    const harness = makeHarness(runtime);

    await harness.launchRun(schedule(writeFailingConnector(tmpDir)), false, SCHEDULED_POLICY);

    // Pin the finalizeSuccessOrFailure path (a resolved DONE(failed)), not the
    // exhausted-retries path — only the former owns the marker decision.
    const failure = runtime.history.find((r) => r.status === "failed");
    assert.ok(failure, "the run must record its failure");
    assert.equal(failure.terminalReason, "connector_reported_failed", "failure must settle via the resolved-DONE path");
    assert.deepEqual(runtime.history.filter(isClearedMarker), [], "the streak remains — no cleared marker");
    assert.equal(
      runtime.announcedBackoffClass.get(CONNECTOR_INSTANCE_ID),
      "terminal:authentication_error",
      "a failure must not consume the announce-once entry"
    );
  })
);

test(
  "cleared marker still emits when onRunComplete for the success concurrently clears the announce map (pre-success capture)",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    runtime.announcedBackoffClass.set(CONNECTOR_INSTANCE_ID, "terminal:authentication_error");
    // Simulates `evaluateBackoffDispatch` running synchronously from the
    // success completion notification and clearing the announce map itself
    // before `emitBackoffClearedIfStreakEnded` runs. The marker decision
    // must rest on the PRE-success capture, not a live map read.
    const harness = makeHarness(runtime, {
      onRunComplete: (record) => {
        if (record.status === "succeeded") {
          runtime.announcedBackoffClass.delete(CONNECTOR_INSTANCE_ID);
        }
      },
    });

    await harness.launchRun(schedule(writeSucceedingConnector(tmpDir)), false, SCHEDULED_POLICY);

    assert.equal(
      runtime.history.filter(isClearedMarker).length,
      1,
      "the streak ended with this success, so the marker must emit even though the map was already cleared"
    );
  })
);

test(
  "managed scheduled success records the run before clearing an announced back-off streak",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    runtime.announcedBackoffClass.set(CONNECTOR_INSTANCE_ID, "terminal:authentication_error");
    const harness = makeHarness(runtime, {
      managedResult: {
        run_id: "run_managed_recovered",
        status: "succeeded",
        trace_id: "trace_managed_recovered",
      },
    });

    await harness.launchRun(schedule(writeSucceedingConnector(tmpDir)), false, SCHEDULED_POLICY);

    assert.deepEqual(
      runtime.history.map((record) => (isClearedMarker(record) ? "cleared" : record.status)),
      ["succeeded", "cleared"],
      "managed recovery must persist success before its cleared transition"
    );
    assert.equal(runtime.announcedBackoffClass.has(CONNECTOR_INSTANCE_ID), false);
  })
);
