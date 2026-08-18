// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Proof for the run-scoped logger seam (runtime/run-logger.ts,
// design-notes/failure-diagnosability-2026-08-18.md): before this change,
// `runtime/scheduler/run-executor.ts` had no logger at all — a failed run's
// history-persist failure went to `console.error` with a `[scheduler]` tag
// and no `run_id`, which is the mechanical reason a failed ChatGPT run
// (`run_1787075769450`) wrote zero log lines matching its own run id.
//
// Two properties, driven through the REAL `createRunExecutor` (no mocking
// of the seam itself):
//   1. When a run's history-persist write fails, the injected base logger
//      receives at least one call whose fields carry that exact run's
//      `run_id`/`connector_id`/`connector_instance_id`.
//   2. A PII-shaped string threaded through the run logger's `message` is
//      redacted before it reaches the base logger — the same
//      `redactStderrTail` convention `runtime/stderr-redact.ts` documents,
//      proven directly against `createRunLogger` rather than through the
//      full run-executor (that string never occurs naturally in a run-
//      history-persist failure, so this half is a focused unit proof).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import { createRunLogger, type RunBaseLogger } from "../runtime/run-logger.ts";
import {
  createRunExecutor,
  type RunExecutorDeps,
  type RunExecutorRuntimeState,
} from "../runtime/scheduler/run-executor.ts";
import type { ConnectorSchedule, RunRecord } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";

const HISTORY_PERSIST_FAILURE_MESSAGE_RE = /failed to persist run history/;
const REDACTED_TOKEN_RE = /\[REDACTED\]/;
const DECLARED_REASON_TOKEN_RE = /login_form_never_appeared/;

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/run-logger-correlation";
const CONNECTOR_INSTANCE_ID = "cin_run_logger_correlation";
const MANIFEST = { streams: [{ name: "items" }] };
const SCHEDULED_POLICY = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

interface CapturedLogCall {
  readonly fields: Record<string, unknown>;
  readonly level: "error" | "info" | "warn";
  readonly message: string;
}

function createCapturingLogger(): { calls: CapturedLogCall[]; logger: RunBaseLogger } {
  const calls: CapturedLogCall[] = [];
  const record = (level: CapturedLogCall["level"]) => (fields: Record<string, unknown>, message: string) => {
    calls.push({ fields, level, message });
  };
  return {
    calls,
    logger: { error: record("error"), info: record("info"), warn: record("warn") },
  };
}

// A connector that exits nonzero without ever emitting DONE — the runtime's
// close-handling path resolves the run with status "failed" (not a rejected
// promise), the same shape a real production failure takes. See
// run-history-failure-reason-populated.test.ts for the same connector shape.
function writeFailingConnector(tmpDir: string): string {
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
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-run-logger-"));
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
  "a failed run's history-persist failure logs a line carrying that run's own run_id",
  withTmpDir(async (tmpDir) => {
    const runtime = freshRuntime();
    const { calls, logger } = createCapturingLogger();

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
      logger,
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
      recordAndNotify: (rec) => {
        runtime.history.push(rec);
        return rec;
      },
      referenceBaseUrl: null,
      registerRunCancellation: null,
      resolveStaticSecretRunEnv: null,
      rsUrl: "http://localhost.invalid",
      runManagedConnectorViaController: null,
      runtime,
      // Durable history append always rejects — forces the exact catch path
      // `appendRunHistoryBestEffort` uses in production when the store write
      // fails, which is the site that used to be console.error-only.
      schedulerStore: {
        appendRunHistory: () => Promise.reject(new Error("simulated durable run_history append failure")),
        deleteActiveRun: () => {
          // Not exercised on this path (no active-run store configured for reserve).
        },
        upsertActiveRun: async () => true,
      },
      setState: async () => {
        // Out of scope for this oracle.
      },
    };

    const record: RunRecord = await createRunExecutor(deps).launchRun(
      schedule(writeFailingConnector(tmpDir)),
      false,
      SCHEDULED_POLICY
    );

    assert.equal(record.status, "failed");
    assert.ok(
      typeof record.runId === "string" && record.runId.length > 0,
      `expected the failed run to carry its own run_id; got: ${JSON.stringify(record.runId)}`
    );

    // FAIL-BEFORE / PASS-AFTER: before this change, the equivalent
    // console.error call in appendRunHistoryBestEffort carried only
    // connectorId in its string — no run_id field existed anywhere in the
    // scheduler/run-executor module, so grepping for this run's run_id
    // against process output would find nothing (production incident 3).
    const correlated = calls.find((call) => call.level === "error" && call.fields.run_id === record.runId);
    assert.ok(
      correlated,
      `expected at least one logged error carrying run_id=${record.runId}; got fields: ${JSON.stringify(calls.map((c) => c.fields))}`
    );
    assert.equal(correlated?.fields.connector_id, CONNECTOR_ID);
    assert.equal(correlated?.fields.connector_instance_id, CONNECTOR_INSTANCE_ID);
    assert.match(correlated?.message ?? "", HISTORY_PERSIST_FAILURE_MESSAGE_RE);
  })
);

test("a PII-shaped message threaded through the run logger is redacted, not carried raw", () => {
  const { calls, logger } = createCapturingLogger();
  const runLogger = createRunLogger(logger, {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    runId: "run_pii_probe",
  });

  // Shaped exactly like the production defect this project already found
  // (design-notes/failure-diagnosability-2026-08-18.md): a long opaque
  // alphanumeric run that could be a secret, a session token, or — the
  // load-bearing case stderr-redact.ts's own tests pin — a personal name.
  const piiShapedToken = "tim_nunamaker_gmail_com_account_identifier";
  runLogger.error(`ingest failed for account ${piiShapedToken}`);

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call, "expected exactly one logged call");
  assert.ok(
    !call.message.includes(piiShapedToken),
    `expected the PII-shaped token to be redacted from the logged message; got: ${call.message}`
  );
  assert.match(call.message, REDACTED_TOKEN_RE);
  // The redaction must not have silently dropped run identity, too — only
  // the untrusted free-form content should be touched.
  assert.equal(call.fields.run_id, "run_pii_probe");
  assert.equal(call.fields.connector_id, CONNECTOR_ID);
});

test("a declared reason token survives the run logger's redaction, same allowlist as stderr-redact.ts", () => {
  const { calls, logger } = createCapturingLogger();
  const declaredReasonTokens = new Set(["login_form_never_appeared"]);
  const runLogger = createRunLogger(
    logger,
    { connectorId: CONNECTOR_ID, connectorInstanceId: CONNECTOR_INSTANCE_ID, runId: "run_declared_probe" },
    { declaredReasonTokens }
  );

  runLogger.error("heb_session_failed: login_form_never_appeared");

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.ok(call, "expected exactly one logged call");
  assert.match(call.message, DECLARED_REASON_TOKEN_RE);
  assert.ok(!call.message.includes("[REDACTED]"));
});
