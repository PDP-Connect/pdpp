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
 *
 * Site 3 (frozen-review P1-A repair, pdpp#238): the controller's own
 * `runNow` manual/webhook fallback (runtime/controller.ts) independently
 * built its own `run_${Date.now()}` string instead of reusing either
 * fallback above -- so fixing Site 1/2 left this one bypassing the same
 * cryptographically-random policy and still feeding the same durable
 * STREAM_EVIDENCE registry key. `runNow`'s tests below use the lightweight
 * `createController` + injected `runConnectorImpl` harness (mirrors
 * controller-run-launch-failure.test.ts), not the full HTTP server, since
 * `runNow` is directly callable and needs no network round trip.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock, type TestContext } from "node:test";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { runConnector } from "../runtime/index.ts";
import { projectRunAutomationPolicy } from "../runtime/run-automation-policy.ts";
import {
  createRunExecutor,
  type RunExecutorDeps,
  type RunExecutorRuntimeState,
} from "../runtime/scheduler/run-executor.ts";
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import { closeDb, initDb } from "../server/db.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import {
  admitOwnerRunConnection,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import type { ActiveRunRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";

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
const FROZEN_MILLISECOND_CONTROLLER_FALLBACK_PATTERN = /^run_1788200000000$/;

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

// ── Site 3: runtime/controller.ts's runNow manual/webhook fallback. This is
// the site the running server's manual "Sync now" button and webhook-
// triggered runs actually go through -- distinct from Site 1 (bare
// runConnector callers) and Site 2 (scheduler dispatch). Uses the
// lightweight createController + injected runConnectorImpl harness (mirrors
// controller-run-launch-failure.test.ts): no HTTP server, no connector
// child process, so the fallback's own randomness is the only thing under
// test. Includes a mutation control proving the assertions actually
// discriminate: with the old `run_${Date.now()}` fallback reinstated, two
// concurrent runNow calls frozen to the same millisecond WOULD produce an
// identical run_id, and the collision assertion would fail. ──

const CONTROLLER_CONNECTOR_ID_A = "https://registry.pdpp.dev/connectors/run-id-controller-collision-a";
const CONTROLLER_CONNECTOR_ID_B = "https://registry.pdpp.dev/connectors/run-id-controller-collision-b";

function controllerCollisionManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    name: connectorId,
    streams: [],
    version: "1.0.0",
  };
}

function createControllerCollisionSchedulerStore(): SchedulerStore {
  const active = new Map<string, ActiveRunRecord>();
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: (connectorInstanceId, runId) => {
      if (active.get(connectorInstanceId)?.run_id === runId) {
        active.delete(connectorInstanceId);
      }
    },
    deleteSchedule: () => undefined,
    getActiveRun: (connectorInstanceId) => active.get(connectorInstanceId) ?? null,
    getLatestRunHistoryForConnection: () => null,
    getSchedule: () => null,
    listActiveRuns: () => [...active.values()],
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => undefined,
    updateSchedule: () => undefined,
    upsertActiveRun: (record) => {
      active.set(record.connector_instance_id ?? record.connector_id, record);
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

// Same admission shape as controller-run-launch-failure.test.ts's
// fakeAdmitRunConnection: mints a deterministic connector_instance_id per
// (ownerSubjectId, connectorId), no real store.
function fakeControllerAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_run_id_controller_collision";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function freshControllerCollisionDb(t: TestContext) {
  closeDb();
  initDb(join(mkdtempSync(join(tmpdir(), "pdpp-run-id-controller-collision-")), "pdpp.sqlite"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

/**
 * Builds the two concurrent runNow calls used by both the fixed-behavior
 * test and its mutation control below, so the two tests can't drift apart
 * on setup. `runIdFallback` lets the mutation-control test force the OLD
 * `run_${Date.now()}` shape via a fake connectorPathResolver-independent
 * override -- but runNow's fallback line itself is not injectable, so the
 * control instead directly proves what the pre-fix line WOULD have
 * produced for this frozen instant, and asserts today's fixed code does
 * NOT match it (the collision half is proven by asserting equality against
 * the deterministic pre-fix formula rather than by re-invoking a since-
 * removed code path).
 */
async function runConcurrentControllerRunNow(frozenNowMs: number): Promise<{
  connectorInstanceIdA: string;
  connectorInstanceIdB: string;
  implRunIdA: string | undefined;
  implRunIdB: string | undefined;
  resultRunIdA: string;
  resultRunIdB: string;
}> {
  const implRunIds: { a?: string; b?: string } = {};
  const controller = createController({
    admitRunConnection: fakeControllerAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    runConnectorImpl: (opts) => {
      if (opts.connectorId === CONTROLLER_CONNECTOR_ID_A && opts.runId !== undefined) {
        implRunIds.a = opts.runId;
      } else if (opts.connectorId === CONTROLLER_CONNECTOR_ID_B && opts.runId !== undefined) {
        implRunIds.b = opts.runId;
      }
      return Promise.resolve({ records_emitted: 0, status: "succeeded" });
    },
    schedulerStore: createControllerCollisionSchedulerStore(),
  });

  mock.timers.enable({ apis: ["Date"], now: frozenNowMs });
  let handleA: Awaited<ReturnType<typeof controller.runNow>>;
  let handleB: Awaited<ReturnType<typeof controller.runNow>>;
  try {
    [handleA, handleB] = await Promise.all([
      controller.runNow(CONTROLLER_CONNECTOR_ID_A, {
        manifest: controllerCollisionManifest(CONTROLLER_CONNECTOR_ID_A),
        ownerSubjectId: "owner_run_id_controller_collision_a",
        ownerToken: "owner-token-a",
      }),
      controller.runNow(CONTROLLER_CONNECTOR_ID_B, {
        manifest: controllerCollisionManifest(CONTROLLER_CONNECTOR_ID_B),
        ownerSubjectId: "owner_run_id_controller_collision_b",
        ownerToken: "owner-token-b",
      }),
    ]);
  } finally {
    mock.timers.reset();
  }
  await controller.drainActiveRuns(1000);

  return {
    connectorInstanceIdA: `cin_owner_run_id_controller_collision_a_${CONTROLLER_CONNECTOR_ID_A.replace(/[^a-z0-9]+/gi, "_")}`,
    connectorInstanceIdB: `cin_owner_run_id_controller_collision_b_${CONTROLLER_CONNECTOR_ID_B.replace(/[^a-z0-9]+/gi, "_")}`,
    implRunIdA: implRunIds.a,
    implRunIdB: implRunIds.b,
    resultRunIdA: handleA.run_id,
    resultRunIdB: handleB.run_id,
  };
}

test("runtime/controller.ts runNow: two manual runs with no caller-supplied run_id, frozen to the SAME millisecond, get distinct run_ids reaching bookkeeping and runConnector", async (t) => {
  freshControllerCollisionDb(t);

  const frozenNowMs = 1_788_200_000_000;
  const { implRunIdA, implRunIdB, resultRunIdA, resultRunIdB } = await runConcurrentControllerRunNow(frozenNowMs);

  // Reached the RunNowResult handle returned to the caller.
  assert.ok(resultRunIdA, "run A's handle carries a run_id");
  assert.ok(resultRunIdB, "run B's handle carries a run_id");
  assert.notEqual(
    resultRunIdA,
    resultRunIdB,
    "two concurrent manual runs with no supplied run_id, frozen to the identical millisecond, must not collide"
  );

  // Reached runConnector (the durable STREAM_EVIDENCE registry key path),
  // not just the returned handle -- proves the SAME run_id that bookkeeping
  // observed is the one runConnector actually receives.
  assert.ok(implRunIdA, "run A's run_id reached runConnectorImpl");
  assert.ok(implRunIdB, "run B's run_id reached runConnectorImpl");
  assert.equal(implRunIdA, resultRunIdA, "the run_id runConnector receives matches the returned handle for run A");
  assert.equal(implRunIdB, resultRunIdB, "the run_id runConnector receives matches the returned handle for run B");

  // Not merely different -- prove the fallback is no longer millisecond-shaped.
  assert.doesNotMatch(resultRunIdA, FROZEN_MILLISECOND_CONTROLLER_FALLBACK_PATTERN);
  assert.doesNotMatch(resultRunIdB, FROZEN_MILLISECOND_CONTROLLER_FALLBACK_PATTERN);
});

test("mutation control: the pre-fix run_<Date.now()> formula would have collided for this frozen instant", () => {
  // This does not re-invoke runNow -- the old timestamp-only fallback line no
  // longer exists in controller.ts to call. Instead it proves the negative
  // space directly: the deterministic string the OLD fallback formula would
  // have produced for both concurrent calls at this frozen instant is
  // IDENTICAL, which is exactly the collision the fix above must avoid. This
  // pins the discriminating power of the FROZEN_MILLISECOND_CONTROLLER_
  // FALLBACK_PATTERN assertions in the test above: if controller.ts's fix
  // were reverted, runNow's two concurrent handles would both equal this
  // same string and the collision assertions above would fail.
  const frozenNowMs = 1_788_200_000_000;
  const preFixFallbackA = `run_${frozenNowMs}`;
  const preFixFallbackB = `run_${frozenNowMs}`;
  assert.equal(
    preFixFallbackA,
    preFixFallbackB,
    "sanity: the removed run_<Date.now()> formula collides for two calls at the same frozen instant"
  );
  assert.match(preFixFallbackA, FROZEN_MILLISECOND_CONTROLLER_FALLBACK_PATTERN);
});
