// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Diagnosability proof for the scheduler's own `run_history.failure_reason`
// column (runtime/scheduler/run-executor.ts, NOT the spine-hook writer
// already covered by run-history-writer-authority.test.ts).
//
// Production evidence (chatgpt-ingest-and-assistance-failure-modes-2026-08-18):
// every failed run_history row for a real connection had `terminal_reason`
// and `connector_error_json` populated, but `failure_reason` was EMPTY on
// every single one. Root cause: `buildSuccessOrFailureRecord` (run-executor.ts)
// hardcoded `failureReason: null` on every completed run regardless of
// status, even though `RuntimeRunConnectorResult` (the runtime's real return
// shape) computes a concise `failure_message` for a runtime-authored
// connector-exit failure — it was simply never read because the narrower
// `RunConnectorResult` type this function reads didn't declare the field.
//
// This suite drives `createRunExecutor(...).launchRun` with a REAL connector
// subprocess that exits nonzero WITHOUT ever emitting DONE — the runtime's
// close-handling path (`deriveClosedRunResolution` /
// `buildConnectorExitFailureMessage` in runtime/index.ts) RESOLVES the run
// with `status: "failed"` and a real `failure_message` ("Connector exited
// with code N before emitting DONE."), the same resolve-not-reject shape the
// assistance-timeout and scheduler-wall-clock-timeout paths use in
// production. No mocks of the runtime itself.

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
import type { ConnectorSchedule, RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/failure-reason-populated";
const CONNECTOR_INSTANCE_ID = "cin_failure_reason_populated";

const MANIFEST = { streams: [{ name: "items" }] };

const SCHEDULED_POLICY = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

const EXIT_WITHOUT_DONE_MESSAGE_RE = /Connector exited with code 1 before emitting DONE/;

// A connector that exits nonzero without ever emitting DONE. The runtime's
// `deriveClosedRunResolution` treats this as `exposeConnectorExitDiagnostic`
// (finalStatus === "failed" && !doneMessage) and RESOLVES the run with a real
// `failure_message` — the same resolve shape (not a rejected promise) the
// assistance-timeout path uses, so this exercises the same
// buildSuccessOrFailureRecord code the production bug lived in.
function writeExitWithoutDoneConnector(tmpDir: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  process.exit(1);
});
`,
    "utf8"
  );
  return connectorPath;
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

function makeHarness(runtime: RunExecutorRuntimeState): {
  launchRun: ReturnType<typeof createRunExecutor>["launchRun"];
} {
  const deps: RunExecutorDeps = {
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
      ownerSubjectId: ownerSubjectId ?? "owner_test",
    }),
    getState: async () => null,
    handleGrantFailureDisable: () => {
      // Out of scope for this oracle.
    },
    isManagedConnector: () => false,
    markNeedsHuman: () => {
      // Out of scope for this oracle.
    },
    maxRunWallClockMs: 0,
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: () => {
      // Out of scope for this oracle.
    },
    persistLastRunTime: () => {
      // Out of scope for this oracle.
    },
    recordAndNotify: (record) => {
      runtime.history.push(record);
      return record;
    },
    referenceBaseUrl: null,
    registerRunCancellation: null,
    resolveStaticSecretRunEnv: null,
    rsUrl: "http://localhost.invalid",
    runManagedConnectorViaController: null,
    runtime,
    schedulerStore: null,
    setState: async () => {
      // Out of scope for this oracle.
    },
  };
  return { launchRun: createRunExecutor(deps).launchRun };
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
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-failure-reason-"));
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
  "a runtime-authored run failure populates RunRecord.failureReason instead of leaving it null",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    const harness = makeHarness(runtime);

    const record: RunRecord = await harness.launchRun(
      schedule(writeExitWithoutDoneConnector(tmpDir)),
      false,
      SCHEDULED_POLICY
    );

    assert.equal(record.status, "failed");
    // FAIL-BEFORE / PASS-AFTER: before the fix, buildSuccessOrFailureRecord
    // hardcoded `failureReason: null` unconditionally — this run's
    // run_history row would have recorded terminal_reason with NO
    // failure_reason at all, exactly the production gap.
    assert.ok(
      typeof record.failureReason === "string" && record.failureReason.length > 0,
      `expected a non-empty failureReason carrying the runtime's own explanation; got: ${JSON.stringify(record.failureReason)}`
    );
    assert.match(
      record.failureReason ?? "",
      EXIT_WITHOUT_DONE_MESSAGE_RE,
      "failureReason must carry the runtime-authored failure_message, not just the coarse terminal_reason bucket"
    );
  })
);
