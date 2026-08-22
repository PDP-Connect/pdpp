// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `run_timed_out` honesty oracle for `runTimedOutError` (runtime/scheduler/
// run-executor.ts).
//
// Bug: when the scheduler's wall-clock watchdog kills a run, `runTimedOutError`
// built a fresh error object carrying only classification fields
// (failure_reason/terminal_reason/message/run_id/trace_id) and silently
// dropped `records_emitted`, `known_gaps`, `reported_records_emitted`, and
// `checkpoint_summary` — even though `runConnector`'s own terminal result
// (`buildClosedRunResult` in runtime/index.ts) had already computed the real
// values from durable ingest accounting before resolving. Every timed-out run
// therefore reported `records_emitted: 0` / `known_gaps: []` regardless of how
// much work it durably committed before being killed. Reproduced against
// production: run_1787407222861 (Slack) durably wrote 402,494 messages +
// 91,202 reactions + 81,857 message_attachments + 19,936 files, and still
// recorded records_emitted: 0, known_gaps_json: [].
//
// This suite drives a REAL timeout: a connector that durably emits records
// through a real in-memory ingest server, then hangs forever (never sends
// DONE), with maxRunWallClockMs set low enough that the watchdog's real
// setTimeout fires and kills it. This is not a mock of the timeout path —
// it is the actual watchdog, the actual child-process kill, and the actual
// ingest round-trip that production hit.

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
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import { startServer } from "../server/index.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

// `runConnector`'s ingest POSTs (runtime/index.ts flushBatch) send a real
// `Authorization: Bearer <ownerToken>` header the RS validates — a fake
// string 401s, which the runtime folds into `permission_error` and the
// watchdog test would never reach `run_timed_out` at all. Mirrors
// collection-report-projection-e2e.test.ts's issueOwnerToken.
async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv: TestServer["asServer"]) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);
      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

const CONNECTOR_ID = "timeout-honesty";
const OWNER_SUBJECT_ID = "owner_local";
// The RS requires a real, already-provisioned connector_instances row before
// ingest will accept records (connector_instance_not_found otherwise). The
// default-account id is the one path the store auto-provisions without a
// separate registration call — mirrors collection-report-projection-e2e.test.ts's
// fakeAdmitRunConnection, which relies on the same auto-provisioning.
const CONNECTOR_INSTANCE_ID = makeDefaultAccountConnectorInstanceId(OWNER_SUBJECT_ID, CONNECTOR_ID);

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  display_name: "Timeout Honesty",
  manifest_uri: "https://sources.example/timeout-honesty",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

const SCHEDULED_POLICY = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

/**
 * Writes a connector that emits `recordCount` RECORD messages + a STATE
 * checkpoint, then (if `hang` is true) blocks forever without sending DONE or
 * exiting — the only way to reach the watchdog's real `run_timed_out` path
 * rather than a connector-initiated failure. If `hang` is false it sends DONE
 * and exits immediately (used as the "genuinely completed" control).
 */
function writeConnector(tmpDir: string, recordCount: number, hang: boolean): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  const records = Array.from({ length: recordCount }, (_, i) => ({
    data: { id: `i${i}` },
    emitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    key: `i${i}`,
    stream: "items",
    type: "RECORD",
  }));
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  const records = ${JSON.stringify(records)};
  for (const r of records) {
    process.stdout.write(JSON.stringify(r) + "\\n");
  }
  process.stdout.write(JSON.stringify({ cursor: { last: records.length ? records[records.length - 1].key : null }, stream: "items", type: "STATE" }) + "\\n");
  if (${hang ? "true" : "false"}) {
    // Never send DONE, never exit — only the scheduler watchdog's
    // maxRunWallClockMs setTimeout can end this run.
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify({ records_emitted: records.length, status: "succeeded", type: "DONE" }) + "\\n");
    rl.close();
    process.exit(0);
  }
});
`,
    "utf8"
  );
  return connectorPath;
}

/**
 * Writes a connector that emits `recordCount` records, then sends a PROGRESS
 * message with `phase_boundary: "local_only_phase_started"`, then sleeps for
 * `sleepMs` (simulating local-only work with no external dependency) before
 * completing successfully. Used to prove the watchdog stops applying
 * `maxRunWallClockMs` once a connector declares it has left the
 * provider-rate-limited phase — `sleepMs` is deliberately set well past
 * `maxRunWallClockMs` in the test that uses this.
 */
function writeConnectorWithPhaseBoundary(tmpDir: string, recordCount: number, sleepMs: number): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  const records = Array.from({ length: recordCount }, (_, i) => ({
    data: { id: `i${i}` },
    emitted_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    key: `i${i}`,
    stream: "items",
    type: "RECORD",
  }));
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  const records = ${JSON.stringify(records)};
  for (const r of records) {
    process.stdout.write(JSON.stringify(r) + "\\n");
  }
  process.stdout.write(JSON.stringify({ cursor: { last: records.length ? records[records.length - 1].key : null }, stream: "items", type: "STATE" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "PROGRESS", message: "entering local-only phase", phase_boundary: "local_only_phase_started" }) + "\\n");
  await new Promise((resolve) => setTimeout(resolve, ${sleepMs}));
  process.stdout.write(JSON.stringify({ records_emitted: records.length, status: "succeeded", type: "DONE" }) + "\\n");
  rl.close();
  process.exit(0);
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

function schedule(connectorPath: string, ownerToken: string): ConnectorSchedule {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath,
    intervalMs: 60_000,
    manifest: MANIFEST,
    maxRetries: 0,
    ownerSubjectId: OWNER_SUBJECT_ID,
    ownerToken,
  };
}

function makeHarness(
  runtime: RunExecutorRuntimeState,
  rsUrl: string,
  maxRunWallClockMs: number
): ReturnType<typeof createRunExecutor>["launchRun"] {
  const deps: RunExecutorDeps = {
    admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? CONNECTOR_INSTANCE_ID,
      ownerSubjectId: ownerSubjectId ?? OWNER_SUBJECT_ID,
    }),
    getState: async () => null,
    handleGrantFailureDisable: () => {
      // Grant-disable side effects are out of scope for this oracle.
    },
    isManagedConnector: () => false,
    markNeedsHuman: () => {
      // Needs-human escalation is out of scope for this oracle.
    },
    maxRunWallClockMs,
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: () => {
      // Completion notification is out of scope for this oracle.
    },
    persistLastRunTime: () => {
      // Last-run stamping is out of scope for this oracle.
    },
    recordAndNotify: (record) => {
      runtime.history.push(record);
      return record;
    },
    referenceBaseUrl: null,
    registerRunCancellation: null,
    resolveStaticSecretRunEnv: null,
    rsUrl,
    runManagedConnectorViaController: null,
    runtime,
    schedulerStore: null,
    setState: async () => {
      // State persistence is out of scope for this oracle.
    },
  };
  return createRunExecutor(deps).launchRun;
}

async function setupConnectorManifest(asUrl: string): Promise<void> {
  await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function withServerAndTmpDir(
  fn: (ctx: { ownerToken: string; rsUrl: string; tmpDir: string }) => Promise<void>
): () => Promise<void> {
  return async () => {
    const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-timeout-honesty-"));
    try {
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;
      await setupConnectorManifest(asUrl);
      const ownerToken = await issueOwnerToken(asUrl);
      await fn({ ownerToken, rsUrl, tmpDir });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeServer(server);
    }
  };
}

test(
  "a run that durably emits N records before being killed by the wall-clock watchdog reports records_emitted: N, not 0",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    // 150ms is comfortably longer than the ingest round-trip for 5 records
    // but short enough the test doesn't hang; the connector hangs forever
    // after emitting, so ONLY the watchdog can end this run.
    const launchRun = makeHarness(runtime, rsUrl, 150);

    const record = await launchRun(schedule(writeConnector(tmpDir, 5, true), ownerToken), false, SCHEDULED_POLICY);

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
    assert.equal(
      record.recordsEmitted,
      5,
      "the 5 records were durably ingested before the timeout fired; records_emitted must report that, not 0"
    );
  })
);

test(
  "a run that emits zero records before being killed by the watchdog still reports records_emitted: 0 (no fabrication in either direction)",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    const launchRun = makeHarness(runtime, rsUrl, 150);

    const record = await launchRun(schedule(writeConnector(tmpDir, 0, true), ownerToken), false, SCHEDULED_POLICY);

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
    assert.equal(
      record.recordsEmitted,
      0,
      "genuinely zero emitted records must still report 0, not a fabricated count"
    );
  })
);

test(
  "a run killed by the watchdog with unfinished work records a typed gap, not an empty known_gaps array",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    const launchRun = makeHarness(runtime, rsUrl, 150);

    const record = await launchRun(schedule(writeConnector(tmpDir, 5, true), ownerToken), false, SCHEDULED_POLICY);

    assert.equal(record.status, "failed");
    assert.ok(Array.isArray(record.knownGaps), "knownGaps must be an array");
    assert.ok(
      record.knownGaps.length > 0,
      `a timed-out run with unfinished work must name a typed gap, got: ${JSON.stringify(record.knownGaps)}`
    );
    const gap = record.knownGaps[0] as { kind?: string; reason?: string };
    assert.equal(gap.kind, "run_failed", "the gap must be a typed run_failed gap, not an untyped placeholder");
  })
);

test(
  "a run that genuinely completes (no timeout) is unaffected by the timeout-path fix",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    const launchRun = makeHarness(runtime, rsUrl, 60_000);

    const record = await launchRun(schedule(writeConnector(tmpDir, 5, false), ownerToken), false, SCHEDULED_POLICY);

    assert.equal(record.status, "succeeded");
    assert.equal(record.terminalReason, null);
    assert.equal(record.recordsEmitted, 5);
    assert.deepEqual(record.knownGaps, []);
  })
);

test(
  "a connector that declares a local-only phase boundary is not truncated by maxRunWallClockMs, even though it runs well past that budget",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    // Budget (150ms) is far shorter than the connector's post-boundary sleep
    // (500ms). Without the phase-boundary fix this run would be killed by
    // run_timed_out at ~150ms; with the fix, the watchdog disarms itself once
    // the PROGRESS phase_boundary message arrives and the run is free to run
    // past 150ms to genuine completion.
    const launchRun = makeHarness(runtime, rsUrl, 150);

    const record = await launchRun(
      schedule(writeConnectorWithPhaseBoundary(tmpDir, 5, 500), ownerToken),
      false,
      SCHEDULED_POLICY
    );

    assert.equal(
      record.status,
      "succeeded",
      `expected the local-only phase to survive past maxRunWallClockMs, got status=${record.status} terminalReason=${String(record.terminalReason)}`
    );
    assert.equal(record.terminalReason, null);
    assert.equal(record.recordsEmitted, 5);
  })
);

test(
  "without a phase-boundary declaration, a connector running past maxRunWallClockMs IS killed (control for the phase-boundary test above)",
  withServerAndTmpDir(async ({ ownerToken, rsUrl, tmpDir }) => {
    const runtime = freshRuntime();
    const launchRun = makeHarness(runtime, rsUrl, 150);

    // Same shape as the phase-boundary connector (5 records, then a 500ms
    // sleep before DONE) but with no phase_boundary PROGRESS message — proves
    // the watchdog's default behavior (kill at maxRunWallClockMs) is still
    // intact and it is specifically the phase_boundary signal, not merely
    // "the connector kept emitting PROGRESS", that disarms it.
    const record = await launchRun(schedule(writeConnector(tmpDir, 5, true), ownerToken), false, SCHEDULED_POLICY);

    assert.equal(record.status, "failed");
    assert.equal(record.terminalReason, "run_timed_out");
  })
);
