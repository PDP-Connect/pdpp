// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pdpp#238 provisional review P1-2: both reachable Date.now()-based fallback
 * run_id generators (runtime/index.ts's `spawnRunId` and
 * runtime/scheduler/run-executor.ts's `buildAttemptCall`) are only
 * millisecond-unique. Two concurrent invocations with no caller-supplied
 * run_id, in the same millisecond, previously produced an IDENTICAL run_id
 * string -- and run_id is the durable STREAM_EVIDENCE claim registry's SOLE
 * uniqueness key ((run_id, stream), connector-instance-excluded by design;
 * see server/stores/stream-evidence-run-registry-store.ts's module doc
 * comment). This file proves the fix (randomUUID()-based fallbacks)
 * deterministically avoids that collision at both sites, using
 * `mock.timers` to freeze Date.now() to a fixed value across both calls
 * rather than relying on timing to probabilistically land in the same
 * millisecond.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { runConnector } from "../runtime/index.ts";
import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import {
  createRunExecutor,
  type RunExecutorDeps,
  type RunExecutorRuntimeState,
} from "../runtime/scheduler/run-executor.ts";
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import {
  admitOwnerRunConnection,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

interface ClosableServer {
  abortStartupBackfill: (reason: string) => void;
  asPort: number;
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop: () => void };
  startupBackfillDone: Promise<unknown>;
  startupSummaryEvidenceSweepDone: Promise<unknown>;
  stopBrowserSurfaceLeaseSweep: () => void;
  stopClientEventDeliveryWorker: () => Promise<void>;
}

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}

const typedStartServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const c = (srv: { close: (cb: (err?: Error) => void) => void }) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, 2000);
      srv.close(() => {
        clearTimeout(t);
        r();
      });
    });
  await Promise.allSettled([
    c(server.asServer),
    c(server.rsServer),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return body.access_token;
}

function fakeAdmitRunConnection(
  ownerSubjectId: string
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId }) => {
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

function manifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

function writeConnectorStub(tmpDir: string, name: string): string {
  const connectorPath = join(tmpDir, `${name}.mjs`);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'items', key: '${name}', data: { id: '${name}' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'items', cursor: { cursor: '${name}-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return connectorPath;
}

const FROZEN_MILLISECOND_FALLBACK_PATTERN = /^run_1788000000000$/;
const FROZEN_MILLISECOND_ATTEMPT_FALLBACK_PATTERN = /^run_1788100000000_1$/;

async function registerManifest(asUrl: string, m: ReturnType<typeof manifest>): Promise<void> {
  const resp = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(m),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
}

test("runtime/index.ts: two runConnector invocations with no caller-supplied run_id, frozen to the SAME millisecond, get distinct run_ids", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const mA = manifest("run-id-fallback-collision-a");
  const mB = manifest("run-id-fallback-collision-b");
  await registerManifest(asUrl, mA);
  await registerManifest(asUrl, mB);
  const ownerTokenA = await issueOwnerToken(asUrl, "run_id_test_user_a");
  const ownerTokenB = await issueOwnerToken(asUrl, "run_id_test_user_b");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-run-id-fallback-collision-"));
  try {
    const connectorPathA = writeConnectorStub(tmpDir, "connector-a");
    const connectorPathB = writeConnectorStub(tmpDir, "connector-b");

    // Freeze Date.now() to a single fixed instant for the duration of both
    // runConnector calls below -- the old `run_${Date.now()}` fallback would
    // deterministically produce the SAME string for both, since neither
    // caller supplies its own run_id.
    mock.timers.enable({ apis: ["Date"], now: 1_788_000_000_000 });
    let runIdA: string | null = null;
    let runIdB: string | null = null;
    try {
      const [resultA, resultB] = await Promise.all([
        runConnector({
          admitRunConnection: fakeAdmitRunConnection("run_id_test_user_a"),
          collectionMode: "incremental",
          connectorId: mA.connector_id,
          connectorPath: connectorPathA,
          manifest: mA as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          onStarted: (info) => {
            runIdA = info.run_id;
          },
          ownerToken: ownerTokenA,
          persistState: true,
          rsUrl,
          state: null,
        }),
        runConnector({
          admitRunConnection: fakeAdmitRunConnection("run_id_test_user_b"),
          collectionMode: "incremental",
          connectorId: mB.connector_id,
          connectorPath: connectorPathB,
          manifest: mB as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          onStarted: (info) => {
            runIdB = info.run_id;
          },
          ownerToken: ownerTokenB,
          persistState: true,
          rsUrl,
          state: null,
        }),
      ]);
      assert.equal(resultA.status, "succeeded");
      assert.equal(resultB.status, "succeeded");
    } finally {
      mock.timers.reset();
    }
    assert.ok(runIdA, "run A got a run_id via onStarted");
    assert.ok(runIdB, "run B got a run_id via onStarted");
    assert.notEqual(
      runIdA,
      runIdB,
      "two concurrent runs with no supplied run_id, frozen to the identical millisecond, must not collide"
    );
    // Not merely different -- prove the fallback is no longer millisecond-shaped
    // (a UUID, not `run_<same-ms-digits>`).
    assert.doesNotMatch(runIdA as unknown as string, FROZEN_MILLISECOND_FALLBACK_PATTERN);
    assert.doesNotMatch(runIdB as unknown as string, FROZEN_MILLISECOND_FALLBACK_PATTERN);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

// ── Site 2: runtime/scheduler/run-executor.ts's buildAttemptCall. This is
// the MORE directly reachable collision surface per the exact-head audit:
// ordinary concurrent scheduler dispatch (two different connector schedules
// triggered in the same tick, both on their first attempt) previously
// produced an identical `run_<same-ms>_1` id with no caller-supplied run_id
// anywhere in the chain -- unlike Site 1, which required two concurrent
// direct runConnector callers (e.g. two `pdpp seed` processes). ──

const SCHEDULER_OWNER_SUBJECT_ID = "run_id_scheduler_test_user";
const CONNECTOR_ID_A = "run-id-scheduler-collision-a";
const CONNECTOR_ID_B = "run-id-scheduler-collision-b";
const CONNECTOR_INSTANCE_ID_A = makeDefaultAccountConnectorInstanceId(SCHEDULER_OWNER_SUBJECT_ID, CONNECTOR_ID_A);
const CONNECTOR_INSTANCE_ID_B = makeDefaultAccountConnectorInstanceId(SCHEDULER_OWNER_SUBJECT_ID, CONNECTOR_ID_B);

function schedulerManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
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
}

const SCHEDULED_POLICY = projectRunAutomationPolicy({ refreshPolicy: null, triggerKind: "scheduled" });

function freshSchedulerRuntime(): RunExecutorRuntimeState {
  return {
    announcedBackoffClass: new Map<string, string>(),
    announcedBlockedClass: new Map<string, string>(),
    exhaustedGrants: new Set<string>(),
    history: [],
    running: true,
  };
}

function schedulerSchedule(
  connectorId: string,
  connectorInstanceId: string,
  connectorPath: string,
  ownerToken: string
): ConnectorSchedule {
  return {
    connectorId,
    connectorInstanceId,
    connectorPath,
    intervalMs: 60_000,
    manifest: schedulerManifest(connectorId),
    maxRetries: 0,
    ownerSubjectId: SCHEDULER_OWNER_SUBJECT_ID,
    ownerToken,
  };
}

function makeSchedulerHarness(
  runtime: RunExecutorRuntimeState,
  rsUrl: string,
  connectorInstanceId: string
): ReturnType<typeof createRunExecutor>["launchRun"] {
  const deps: RunExecutorDeps = {
    admitRunConnection: async ({ connectorId, ownerSubjectId }) => ({
      connectorId,
      connectorInstanceId,
      ownerSubjectId: ownerSubjectId ?? SCHEDULER_OWNER_SUBJECT_ID,
    }),
    getState: async () => null,
    handleGrantFailureDisable: () => {
      // Grant-disable side effects are out of scope for this test.
    },
    isManagedConnector: () => false,
    markNeedsHuman: () => {
      // Needs-human escalation is out of scope for this test.
    },
    maxRunWallClockMs: 60_000,
    onInteraction: async () => ({ status: "cancelled" }),
    onRunComplete: () => {
      // Completion notification is out of scope for this test.
    },
    persistLastRunTime: () => {
      // Last-run stamping is out of scope for this test.
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
      // State persistence is out of scope for this test.
    },
  };
  return createRunExecutor(deps).launchRun;
}

async function setupSchedulerConnectorManifest(asUrl: string, connectorId: string): Promise<void> {
  await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(schedulerManifest(connectorId)),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

function writeSchedulerConnector(tmpDir: string, name: string): string {
  const connectorPath = join(tmpDir, `${name}.mjs`);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== "START") return;
  process.stdout.write(JSON.stringify({ type: "RECORD", stream: "items", key: "${name}", data: { id: "${name}" }, emitted_at: new Date().toISOString() }) + "\\n");
  process.stdout.write(JSON.stringify({ cursor: { last: "${name}" }, stream: "items", type: "STATE" }) + "\\n");
  process.stdout.write(JSON.stringify({ records_emitted: 1, status: "succeeded", type: "DONE" }) + "\\n");
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return connectorPath;
}

test("runtime/scheduler/run-executor.ts: two schedules' first-attempt launchRun calls, frozen to the SAME millisecond, get distinct run_ids", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  await setupSchedulerConnectorManifest(asUrl, CONNECTOR_ID_A);
  await setupSchedulerConnectorManifest(asUrl, CONNECTOR_ID_B);
  const ownerToken = await issueOwnerToken(asUrl, SCHEDULER_OWNER_SUBJECT_ID);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-run-id-scheduler-collision-"));
  try {
    const connectorPathA = writeSchedulerConnector(tmpDir, "scheduler-connector-a");
    const connectorPathB = writeSchedulerConnector(tmpDir, "scheduler-connector-b");
    const launchRunA = makeSchedulerHarness(freshSchedulerRuntime(), rsUrl, CONNECTOR_INSTANCE_ID_A);
    const launchRunB = makeSchedulerHarness(freshSchedulerRuntime(), rsUrl, CONNECTOR_INSTANCE_ID_B);

    // Freeze Date.now() so both schedules' buildAttemptCall (attempt === 1
    // for both, since neither call supplies its own runId) compute the
    // fallback at the IDENTICAL instant -- the old `run_${Date.now()}_1`
    // fallback would deterministically produce the SAME string for both.
    mock.timers.enable({ apis: ["Date"], now: 1_788_100_000_000 });
    let recordA: Awaited<ReturnType<typeof launchRunA>>;
    let recordB: Awaited<ReturnType<typeof launchRunB>>;
    try {
      [recordA, recordB] = await Promise.all([
        launchRunA(
          schedulerSchedule(CONNECTOR_ID_A, CONNECTOR_INSTANCE_ID_A, connectorPathA, ownerToken),
          false,
          SCHEDULED_POLICY
        ),
        launchRunB(
          schedulerSchedule(CONNECTOR_ID_B, CONNECTOR_INSTANCE_ID_B, connectorPathB, ownerToken),
          false,
          SCHEDULED_POLICY
        ),
      ]);
    } finally {
      mock.timers.reset();
    }
    assert.equal(recordA.status, "succeeded");
    assert.equal(recordB.status, "succeeded");
    assert.ok(recordA.runId, "run A's record carries a run_id");
    assert.ok(recordB.runId, "run B's record carries a run_id");
    assert.notEqual(
      recordA.runId,
      recordB.runId,
      "two schedules' concurrent first attempts, frozen to the identical millisecond, must not collide"
    );
    assert.doesNotMatch(recordA.runId as unknown as string, FROZEN_MILLISECOND_ATTEMPT_FALLBACK_PATTERN);
    assert.doesNotMatch(recordB.runId as unknown as string, FROZEN_MILLISECOND_ATTEMPT_FALLBACK_PATTERN);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
  }
});
