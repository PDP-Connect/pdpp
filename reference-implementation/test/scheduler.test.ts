const TOP_LEVEL_REGEX_1 = /State persistence failed for items: 403/;
const TOP_LEVEL_REGEX_2 = /automation_policy_blocked/;
const TOP_LEVEL_REGEX_3 = /not background-safe/;
const TOP_LEVEL_REGEX_4 = /Connector emitted RECORD for undeclared stream/;
const TOP_LEVEL_REGEX_5 = /State persistence failed for other_items: 500/;
const TOP_LEVEL_REGEX_6 = /Connector reported records_emitted 2 but runtime observed 1/;
const TOP_LEVEL_REGEX_7 = /Connector emitted RECORD for undeclared stream/;
const TOP_LEVEL_REGEX_8 = /Ingest failed for items: 401/;
const TOP_LEVEL_REGEX_9 = /Ingest failed for items: 400/;
const TOP_LEVEL_REGEX_10 = /^not_ready: required external tool definitely-missing-tool is not available\./;
const TOP_LEVEL_REGEX_11 = /^not_ready: required local source path\(s\) are missing or unreadable:/;
const TOP_LEVEL_REGEX_12 = /1970/;
const TOP_LEVEL_REGEX_13 = /next attempt at (.+)$/;
const TOP_LEVEL_REGEX_14 = /^\d{4}-/;
const TOP_LEVEL_REGEX_15 = /unknown|not scheduled/;
const TOP_LEVEL_REGEX_16 = /1970/;
const TOP_LEVEL_REGEX_17 = /not scheduled \(gave_up/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Controller } from "../runtime/controller.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { createSqliteConnectorInstanceCredentialStore } from "../server/stores/connector-instance-credential-store.ts";
import {
  admitOwnerRunConnection,
  createSqliteConnectorInstanceStore,
} from "../server/stores/connector-instance-store.ts";
import type { ActiveRunRecord, SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";
import { getDefaultSchedulerStore } from "../server/stores/scheduler-store.ts";
import { resolveCredentialFreeFixtureRunEnv } from "./helpers/credential-free-run-fixture.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

function readServerSchedulerFixtureManifest(): Record<string, unknown> & {
  connector_id: string;
  connector_key: string;
  display_name: string;
  manifest_uri: string;
} {
  const base = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  ) as Record<string, unknown> & { capabilities?: Record<string, unknown> };
  return {
    ...base,
    capabilities: {
      ...base.capabilities,
      refresh_policy: {
        background_safe: true,
        bot_detection_sensitivity: "low",
        interaction_posture: "none",
        maximum_staleness_seconds: 3600,
        minimum_interval_seconds: 1,
        rate_limit_sensitivity: "low",
        rationale: "Deterministic scheduler integration fixture.",
        recommended_interval_seconds: 60,
        recommended_mode: "automatic",
      },
    },
    connector_id: "scheduler-fixture",
    connector_key: "scheduler-fixture",
    display_name: "Scheduler fixture",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-fixture",
  };
}

interface ClosableHttpServer {
  close: (cb: () => void) => void;
  closeAllConnections?: () => void;
}

interface ClosableServer {
  asPort: number;
  asServer: ClosableHttpServer;
  controller: Controller;
  rsPort: number;
  rsServer: ClosableHttpServer;
  schedulerManager?: { stop?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();

  const closeWithTimeout = (srv: ClosableHttpServer) =>
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

function writeLoggingConnector(
  tmpDir: string,
  name = "scheduled-connector.mjs"
): { attemptsPath: string; connectorPath: string } {
  const attemptsPath = join(tmpDir, "scheduled-attempts.log");
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );
  return { attemptsPath, connectorPath };
}

function writeHangingConnector(tmpDir: string, name = "hanging-connector.mjs"): string {
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  setInterval(() => {}, 1000);
});
`,
    "utf8"
  );
  return connectorPath;
}

function writeDoneOnSigtermConnector(tmpDir: string, name = "done-on-sigterm-connector.mjs"): string {
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

process.on('SIGTERM', () => {
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n', () => process.exit(0));
});

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  setInterval(() => {}, 1000);
});
`,
    "utf8"
  );
  return connectorPath;
}

function writeSlowProgressConnector(tmpDir: string, name = "slow-progress-connector.mjs"): string {
  const connectorPath = join(tmpDir, name);
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    process.stdout.write(JSON.stringify({
      type: 'PROGRESS',
      message: 'still working',
      stream: 'items',
      count
    }) + '\\n');
    if (count >= 10) {
      clearInterval(timer);
      setTimeout(() => {
        process.stdout.write(JSON.stringify({
          type: 'DONE',
          status: 'succeeded',
          records_emitted: 0
        }) + '\\n', () => process.exit(0));
      }, 40);
    }
  }, 250);
});
`,
    "utf8"
  );
  return connectorPath;
}

function readAttempts(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

interface TimelineEvent {
  data?: { reason?: string } | null;
  event_type: string;
  [key: string]: unknown;
}

interface TimelineBody {
  data: TimelineEvent[];
  [key: string]: unknown;
}

async function waitForRunTerminalEvent(asUrl: string, runId: string, timeoutMs = 5000): Promise<TimelineBody> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    const { body } = await fetchJson(`${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`);
    const timeline = body as TimelineBody;
    if (
      timeline.data?.some((event) =>
        ["run.completed", "run.failed", "run.cancelled", "run.abandoned"].includes(event.event_type)
      )
    ) {
      return timeline;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for terminal event for ${runId}`);
}

function addressPort(server: http.Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error(`expected an AddressInfo with a port, got: ${JSON.stringify(address)}`);
  }
  return address.port;
}

async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = deviceBody as { user_code: string; device_code: string };

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = tokenBody as { access_token: string };

  return token.access_token;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered test polling is intentionally sequential
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for scheduler run to complete");
}

async function waitForAsync(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for scheduler run to complete");
}

interface KnownGap {
  kind?: string;
  recovery_hint?: { action?: string };
  scope?: { resource_ids?: unknown };
  severity?: string;
}

interface SchedulerInteraction {
  connector_display_name?: string;
  connector_id?: string;
  request_id: string;
  run_id?: string | null;
}

function asSchedulerInteraction(value: unknown): SchedulerInteraction {
  const record = value as SchedulerInteraction;
  return record;
}

function cancelledInteractionResponse(...args: unknown[]) {
  const interaction = asSchedulerInteraction(args[0]);
  return {
    request_id: interaction.request_id,
    status: "cancelled",
    type: "INTERACTION_RESPONSE",
  };
}

// Permissive admission fixture for the require-new-run-connection-id
// fail-closed boundary: every schedule fixture in this file now supplies an
// explicit `connectorInstanceId`, so this fixture simply echoes the exact
// admitted identity the scheduler passes in -- it never invents a different
// id, matching the connector's configured binding.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId }) =>
    Promise.resolve({
      connectorId,
      connectorInstanceId: connectorInstanceId ?? connectorId,
      ownerSubjectId: ownerSubjectId ?? "owner_local",
    });
}

async function materializeRunConnection(connectorId: string, ownerSubjectId: string): Promise<string> {
  const namespace = await admitOwnerRunConnection({
    connectorId,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId,
  });
  return namespace.connectorInstanceId;
}

// Registers the connector-instance row a scheduler fixture's admission must
// resolve to. Production's admitRunConnection wiring (server/index.ts) always
// resolves an existing, owner-authorized row and returns its true id; the
// RS ingest route independently re-resolves connector_instance_id per
// request the same way (resolveOwnerConnectorNamespace). Without a real row
// here, ingest falls through to a different (deterministic default-account)
// id than the one admission/run.started used, and the run-admission fence
// (assertSqliteRunStillAdmitted) then finds no matching running row. Every
// scheduler fixture in this file that admits a run must call this first so
// admission and ingest agree on the same identity. See "requires an existing
// connector-instance row" at the first call site below for the original
// discovery of this requirement.
async function registerSchedulerFixtureConnectorInstance(options: {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string | undefined;
  ownerSubjectId: string;
  sourceBindingKey: string;
  timestamp?: string;
}): Promise<void> {
  const timestamp = options.timestamp ?? "2026-04-29T00:00:00.000Z";
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: options.connectorId,
    connectorInstanceId: options.connectorInstanceId,
    createdAt: timestamp,
    displayName: options.displayName ?? options.connectorId,
    ownerSubjectId: options.ownerSubjectId,
    sourceBinding: { kind: "test_scheduler_fixture" },
    sourceBindingKey: options.sourceBindingKey,
    sourceKind: "account",
    updatedAt: timestamp,
  });
}

test("server-owned scheduler starts persisted enabled schedules after startup", async () => {
  const spotifyManifest = readServerSchedulerFixtureManifest();
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-server-scheduler-enabled-"));
  const dbPath = join(tmpDir, "pdpp.sqlite");
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
  let server = null;

  try {
    server = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, JSON.stringify(registerResp.body));
    // Admission requires an existing connector-instance row for this owner +
    // connector (require-new-run-connection-id): the production
    // admitRunConnection wiring in server/index.ts refuses to materialize one
    // implicitly once the schedule row carries an explicit
    // connector_instance_id (upsertSchedule always sets one), so the fixture
    // must register the connection before the scheduler can admit a run.
    // upsertSchedule (called below with no explicit connectorInstanceId option)
    // stores the schedule's connector_instance_id as the CANONICAL key, not the
    // URL-shaped connector_id — the connector-instance row must be keyed the
    // same way so buildConnectors' admission lookup finds it.
    const serverOwnedCanonicalKey = canonicalConnectorKey(spotifyManifest.connector_id) ?? spotifyManifest.connector_id;
    await registerSchedulerFixtureConnectorInstance({
      connectorId: serverOwnedCanonicalKey,
      connectorInstanceId: serverOwnedCanonicalKey,
      displayName: spotifyManifest.display_name,
      ownerSubjectId: "owner_local",
      sourceBindingKey: "scheduler_server_owned_fixture",
    });
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      enabled: true,
      interval_seconds: 60,
      jitter_seconds: 0,
    });
    await closeServer(server);
    closeDb();
    server = null;

    server = await startServer({
      asPort: 0,
      connectionScopedRunEnvResolver: resolveCredentialFreeFixtureRunEnv,
      connectorPathResolver: () => connectorPath,
      dbPath,
      quiet: true,
      rsPort: 0,
    });

    await waitFor(() => readAttempts(attemptsPath).length === 1, 5000);
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler enforces automation policy before starting an unsafe automatic run", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-automation-policy-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const scheduler = createScheduler({
    admitRunConnection: fakeAdmitRunConnection(),
    connectors: [
      {
        connectorId: "unsafe-automatic",
        connectorInstanceId: "unsafe-automatic",
        connectorPath,
        intervalMs: 1,
        manifest: {
          capabilities: {
            refresh_policy: { background_safe: false },
          },
        },
        ownerSubjectId: "owner_local",
        ownerToken: "owner-token",
      },
    ],
    onInteraction: cancelledInteractionResponse,
    rsUrl: "http://localhost.invalid",
  });

  try {
    scheduler.start();
    await waitFor(() => scheduler.getHistory().length >= 1, 5000);
    scheduler.stop();
    assert.deepEqual(readAttempts(attemptsPath), []);
    const [record] = scheduler.getHistory();
    assert.ok(record, "expected a scheduler history record");
    assert.equal(record.status, "skipped");
    assert.match(record.error || "", TOP_LEVEL_REGEX_2);
    assert.match(record.error || "", TOP_LEVEL_REGEX_3);
  } finally {
    scheduler.stop();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("server-owned scheduler refreshes after schedule route mutations", async () => {
  const spotifyManifest = readServerSchedulerFixtureManifest();
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-server-scheduler-route-refresh-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const server = await startServer({
    asPort: 0,
    connectionScopedRunEnvResolver: resolveCredentialFreeFixtureRunEnv,
    connectorPathResolver: () => connectorPath,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, JSON.stringify(registerResp.body));

    // A 1s interval, not 60s. The pause assertion below is a NEGATIVE ("no
    // further attempt"), and a negative is only meaningful if a live scheduler
    // would actually have ticked again in the observation window. At the
    // previous 60s interval nothing could tick a second time regardless, so
    // that assertion held whether or not pause refreshed anything — it was
    // vacuous. `minimum_interval_seconds: 1` in the fixture manifest permits
    // this, and `setInterval` arms at `min(intervalMs, 60_000)`.
    const putResp = await fetch(
      `${asUrl}/_ref/connectors/${encodeURIComponent(spotifyManifest.connector_id)}/schedule`,
      {
        body: JSON.stringify({ enabled: true, interval_seconds: 1, jitter_seconds: 0 }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }
    );
    assert.equal(putResp.status, 200);
    // The route awaits `onScheduleMutation` -> `schedulerManager.refresh()`, so
    // by the time it answers, the rebuilt scheduler has already fired its
    // startup tick. Dispatch then crosses a connector SUBPROCESS boundary, so
    // the attempt lands asynchronously and must be converged on rather than
    // read straight out. This is a convergence wait on a spawn, not a race
    // against a deadline: it settles in one 25ms poll locally.
    await waitFor(() => readAttempts(attemptsPath).length === 1, 5000);

    const pauseResp = await fetch(
      `${asUrl}/_ref/connectors/${encodeURIComponent(spotifyManifest.connector_id)}/schedule/pause`,
      {
        method: "POST",
      }
    );
    assert.equal(pauseResp.status, 200);

    // No barrier call here on purpose. The pause ROUTE is what must rebuild the
    // scheduler; calling `schedulerManager.refresh()` from the test would
    // perform that rebuild itself and mask a route that had stopped doing it —
    // the assertion would then pass for the wrong reason.

    // The negative still needs an observation window, but it is now a window in
    // which a surviving scheduler would DEMONSTRABLY have acted: the schedule's
    // 1s interval fits 2.5 times into it, so a scheduler that outlived the pause
    // gets two full chances to append a second attempt. That is what makes this
    // assertion discriminating rather than vacuous; verified by disabling the
    // pause route's refresh, which fails this loop ~1.5s in.
    //
    // Sampling throughout, rather than once at the end, also reports the
    // violation at the tick that caused it instead of after the fact.
    const PAUSE_OBSERVATION_SAMPLES = 25;
    const PAUSE_OBSERVATION_SAMPLE_MS = 100;
    for (let sample = 0; sample < PAUSE_OBSERVATION_SAMPLES; sample += 1) {
      assert.equal(
        readAttempts(attemptsPath).length,
        1,
        `paused route mutation should stop the live scheduler (sample ${sample})`
      );
      // biome-ignore lint/performance/noAwaitInLoops: sequential sampling of a negative is the point
      await new Promise((resolve) => setTimeout(resolve, PAUSE_OBSERVATION_SAMPLE_MS));
    }
    assert.equal(readAttempts(attemptsPath).length, 1, "paused route mutation should stop the live scheduler (final)");
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("server-owned scheduler ignores paused and deleted persisted schedules", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-server-scheduler-paused-deleted-"));
  const dbPath = join(tmpDir, "pdpp.sqlite");
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
  let server = null;

  try {
    server = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await server.controller.upsertSchedule(spotifyManifest.connector_id, {
      enabled: true,
      interval_seconds: 60,
      jitter_seconds: 0,
    });
    await server.controller.setScheduleEnabled(spotifyManifest.connector_id, false);
    await closeServer(server);
    closeDb();
    server = null;

    server = await startServer({
      asPort: 0,
      connectorPathResolver: () => connectorPath,
      dbPath,
      quiet: true,
      rsPort: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readAttempts(attemptsPath).length, 0, "paused schedule should not run after startup");

    await closeServer(server);
    closeDb();
    server = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    await server.controller.deleteSchedule(spotifyManifest.connector_id);
    await closeServer(server);
    closeDb();
    server = null;

    server = await startServer({
      asPort: 0,
      connectorPathResolver: () => connectorPath,
      dbPath,
      quiet: true,
      rsPort: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(readAttempts(attemptsPath).length, 0, "deleted schedule should not run after startup");
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("autonomous scheduler canonicalizes a legacy URL-shaped schedule connector_id before running", async () => {
  // GAP A regression: a pre-canonicalization `connector_schedules` row can hold
  // a URL-shaped (or legacy-alias) `connector_id`. The controller's
  // `upsertSchedule` canonicalizes on write, but a legacy/migration row seeded
  // directly into the store bypasses that. `buildConnectors` reads the row and
  // (before the fix) forwards the non-canonical id straight into the scheduler,
  // which emits the spine run source and persists run-history / last-run rows
  // under the non-canonical key — mismatching the canonical key the read and
  // admission paths key on. This test seeds the legacy row directly, ticks the
  // scheduler once, and asserts every persisted identity is the canonical key.
  const schedulerManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "../packages/polyfill-connectors/manifests/ynab.json"), "utf8")
  );
  const canonicalKey = schedulerManifest.connector_key;
  const legacyConnectorId = schedulerManifest.manifest_uri;
  assert.notEqual(legacyConnectorId, canonicalKey, "fixture precondition: ids differ");

  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-legacy-canonical-"));
  const dbPath = join(tmpDir, "pdpp.sqlite");
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
  let server = null;

  try {
    server = await startServer({
      asPort: 0,
      dbPath,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;

    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(schedulerManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    // Admission requires an existing connector-instance row. The connection
    // identity is already canonical; only the legacy schedule connector_id is
    // under test here.
    await registerSchedulerFixtureConnectorInstance({
      connectorId: canonicalKey,
      connectorInstanceId: canonicalKey,
      displayName: schedulerManifest.display_name,
      ownerSubjectId: "owner_local",
      sourceBindingKey: "scheduler_legacy_canonical_fixture",
    });
    await createSqliteConnectorInstanceCredentialStore({
      env: { PDPP_CREDENTIAL_ENCRYPTION_KEY: "11".repeat(32) },
    }).capture({
      connectorInstanceId: canonicalKey,
      credentialKind: "personal_access_token",
      now: new Date().toISOString(),
      ownerSubjectId: "owner_local",
      secret: "scheduler-fixture-token",
    });

    // Seed the schedule row directly — NOT via controller.upsertSchedule, which
    // would canonicalize — to faithfully model a legacy row written before the
    // canonicalization slice landed.
    const seedStore = getDefaultSchedulerStore();
    const now = new Date(Date.now() - 120_000).toISOString();
    await seedStore.createSchedule({
      connector_id: legacyConnectorId,
      connector_instance_id: canonicalKey,
      created_at: now,
      enabled: true,
      interval_seconds: 1,
      jitter_seconds: 0,
      updated_at: now,
    });

    await closeServer(server);
    closeDb();
    server = await startServer({
      asPort: 0,
      connectionScopedRunEnvResolver: resolveCredentialFreeFixtureRunEnv,
      connectorPathResolver: () => connectorPath,
      dbPath,
      quiet: true,
      rsPort: 0,
    });
    const store = getDefaultSchedulerStore();

    await waitForAsync(async () => {
      const history = await store.listRunHistory(50);
      return readAttempts(attemptsPath).length >= 1 || history.length >= 1;
    }, 8000);
    assert.ok(
      readAttempts(attemptsPath).length >= 1,
      `expected scheduled connector attempt; history=${JSON.stringify(await store.listRunHistory(50))}`
    );
    // The run record is appended to history asynchronously after the run
    // completes; poll the durable store (SQLite listRunHistory is synchronous)
    // until the row lands so the assertion sees the persisted identity.
    let history: readonly SchedulerRunHistoryRecord[] = [];
    await waitForAsync(async () => {
      history = await store.listRunHistory(50);
      return history.length >= 1;
    }, 8000);

    const record = history.find((entry) => entry.status === "succeeded") ?? history[0];
    assert.ok(record, "expected a persisted run-history record from the scheduled run");

    // The persisted run-history connectorId and the emitted spine run source id
    // must be the canonical key, not the legacy URL-shaped connector_id.
    assert.equal(
      record.connectorId,
      canonicalKey,
      `run-history connectorId should be canonical '${canonicalKey}', got '${record.connectorId}'`
    );
    assert.equal(
      (record.source as { id?: unknown })?.id,
      canonicalKey,
      `spine run source.id should be canonical '${canonicalKey}', got '${JSON.stringify(record.source)}'`
    );

    const lastRunTimes = await store.listLastRunTimes();
    const lastRun = lastRunTimes.find((row) => row.connector_id === canonicalKey);
    assert.ok(
      lastRun,
      `last-run row should be keyed by canonical '${canonicalKey}', got ${JSON.stringify(
        lastRunTimes.map((row) => row.connector_id)
      )}`
    );
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler history records checkpoint summaries from runConnector results", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const stateStore = new Map<string, unknown>();

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_user");
    const connectorInstanceId = await materializeRunConnection(spotifyManifest.connector_key, "scheduler_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_key,
          connectorInstanceId,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 60_000,
          manifest: spotifyManifest,
          ownerSubjectId: "scheduler_user",
          ownerToken,
        },
      ],
      getState: async (connectorId: string) => stateStore.get(connectorId) || null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      setState: async (connectorId: string, state: unknown) => {
        stateStore.set(connectorId, state);
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "succeeded");
    assert.deepEqual(record.source, {
      id: spotifyManifest.connector_key,
      kind: "connector",
    });
    assert.ok(record.runId);
    assert.ok(record.traceId);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "committed",
      mode: "checkpointed_streaming",
      records_accepted: 21,
      records_attempted: 21,
      records_flushed: 21,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 2,
      state_streams_staged: 2,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.deepEqual(historyRecord.source, record.source);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[connectorInstanceId];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.deepEqual(connectorStats.lastRun?.source, record.source);
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);

    const persistedState = stateStore.get(spotifyManifest.connector_key) as
      | { saved_tracks?: unknown; top_artists?: unknown }
      | undefined;
    assert.ok(persistedState?.top_artists);
    assert.ok(persistedState?.saved_tracks);
  } finally {
    await closeServer(server);
  }
});

test("scheduler hydrates persisted history without bypassing a fresh persisted last-run interval", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const appendedHistory: SchedulerRunHistoryRecord[] = [];
  interface LastRunUpsert {
    connectorId: string;
    lastRunTimeMs: number;
    updatedAt: string;
  }
  const lastRunUpserts: LastRunUpsert[] = [];
  const persistedHistory: SchedulerRunHistoryRecord = {
    attempt: 0,
    checkpointSummary: null,
    completedAt: "2026-04-29T00:00:00.000Z",
    connectorError: null,
    connectorId: "persisted-history",
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: {
      id: "persisted-history",
      kind: "connector",
    },
    startedAt: "2026-04-29T00:00:00.000Z",
    status: "skipped",
    terminalReason: null,
    traceId: null,
  };

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_persistence_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 60_000,
          manifest: spotifyManifest,
          ownerSubjectId: "scheduler_persistence_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      schedulerStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        appendRunHistory: async (record: SchedulerRunHistoryRecord) => {
          appendedHistory.push(record);
        },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        deleteActiveRun: async () => {},
        listLastRunTimes: async () => [
          {
            connector_id: spotifyManifest.connector_id,
            connector_instance_id: spotifyManifest.connector_id,
            last_run_time_ms: Date.now(),
            updated_at: "2026-04-29T00:00:00.000Z",
          },
        ],
        listRunHistory: async () => [persistedHistory],
        upsertActiveRun: async () => true,
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        upsertLastRunTime: async (connectorId: string, lastRunTimeMs: number, updatedAt: string) => {
          lastRunUpserts.push({ connectorId, lastRunTimeMs, updatedAt });
        },
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => scheduler.getHistory().length >= 1, 8000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    scheduler.stop();

    const [hydratedHistoryRecord] = scheduler.getHistory();
    assert.ok(hydratedHistoryRecord, "expected a hydrated scheduler history record");
    assert.equal(hydratedHistoryRecord.connectorId, persistedHistory.connectorId);
    assert.equal(appendedHistory.length, 0);
    assert.equal(lastRunUpserts.length, 0);
    assert.equal(completedRuns.length, 0);
  } finally {
    await closeServer(server);
  }
});

test("scheduler direct runs timeout, terminal, and clear durable active-run rows", async () => {
  const manifest = {
    connector_id: "scheduler-timeout-test",
    display_name: "Scheduler Timeout Test Connector",
    protocol_version: "0.1.0",
    streams: [{ fields: [{ name: "id", type: "string" }], name: "items" }],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-timeout-"));
  const connectorPath = writeHangingConnector(tmpDir);
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const activeRuns = new Map<string, ActiveRunRecord>();
  const appendedHistory: SchedulerRunHistoryRecord[] = [];
  const completedRuns: RunRecord[] = [];

  try {
    const ownerToken = await issueOwnerToken(asUrl, "scheduler_timeout_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_timeout_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      maxRunWallClockMs: 100,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      schedulerStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
        appendRunHistory: async (record: SchedulerRunHistoryRecord) => {
          appendedHistory.push(record);
        },
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        deleteActiveRun: async (connectorInstanceId: string, runId: string) => {
          const current = activeRuns.get(connectorInstanceId);
          if (current?.run_id === runId) {
            activeRuns.delete(connectorInstanceId);
          }
        },
        listLastRunTimes: async () => [],
        listRunHistory: async () => [],
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
        upsertActiveRun: async (record: ActiveRunRecord) => {
          if (!record.connector_instance_id) {
            return false;
          }
          activeRuns.set(record.connector_instance_id, record);
          return true;
        },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        upsertLastRunTime: async () => {},
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
    await waitFor(() => scheduler.getHistory().some((record) => record.terminalReason === "run_timed_out"), 5000);
    scheduler.stop();

    const [record] = scheduler.getHistory().filter((entry) => entry.terminalReason === "run_timed_out");
    assert.ok(record, "expected a timed-out run record");
    assert.equal(record.status, "failed");
    assert.equal(record.failureReason, "run_timed_out");
    assert.equal(record.connectorId, manifest.connector_id);
    assert.ok(record.runId, "timed-out record preserves run_id");
    assert.equal(activeRuns.size, 0, "timeout cleanup clears durable active-run row");
    assert.equal(completedRuns.at(-1)?.terminalReason, "run_timed_out");
    assert.equal(appendedHistory.at(-1)?.terminalReason, "run_timed_out");

    const timeline = await waitForRunTerminalEvent(asUrl, record.runId);
    const failed = timeline.data.find((event) => event.event_type === "run.failed");
    assert.equal(failed?.data?.reason, "run_timed_out");
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler timeout beats connector DONE emitted during shutdown", async () => {
  const manifest = {
    connector_id: "scheduler-timeout-done-test",
    display_name: "Scheduler Timeout DONE Test Connector",
    protocol_version: "0.1.0",
    streams: [{ fields: [{ name: "id", type: "string" }], name: "items" }],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-timeout-done-"));
  const connectorPath = writeDoneOnSigtermConnector(tmpDir);
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    const ownerToken = await issueOwnerToken(asUrl, "scheduler_timeout_done_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_timeout_done_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      maxRunWallClockMs: 100,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
    await waitFor(() => scheduler.getHistory().some((record) => record.terminalReason === "run_timed_out"), 5000);
    scheduler.stop();

    const [record] = scheduler.getHistory().filter((entry) => entry.terminalReason === "run_timed_out");
    assert.ok(record, "expected a timed-out run record");
    assert.equal(record.status, "failed");
    assert.equal(record.failureReason, "run_timed_out");
    assert.ok(record.runId, "timed-out record preserves run_id");

    const timeline = await waitForRunTerminalEvent(asUrl, record.runId);
    assert.equal(
      timeline.data.some((event) => event.event_type === "run.completed"),
      false
    );
    const failed = timeline.data.find((event) => event.event_type === "run.failed");
    assert.equal(failed?.data?.reason, "run_timed_out");
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler progress watchdog allows long direct runs that keep reporting progress", async () => {
  const manifest = {
    connector_id: "scheduler-progress-watchdog-test",
    display_name: "Scheduler Progress Watchdog Test Connector",
    protocol_version: "0.1.0",
    streams: [{ fields: [{ name: "id", type: "string" }], name: "items" }],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-progress-watchdog-"));
  const connectorPath = writeSlowProgressConnector(tmpDir);
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  let scheduler: ReturnType<typeof createScheduler> | null = null;

  try {
    const ownerToken = await issueOwnerToken(asUrl, "scheduler_progress_watchdog_user");
    const activeScheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_progress_watchdog_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      maxRunWallClockMs: 2000,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });
    scheduler = activeScheduler;

    activeScheduler.start();
    // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
    await waitFor(() => activeScheduler.getHistory().some((record) => record.status === "succeeded"), 5000);
    activeScheduler.stop();

    const [record] = activeScheduler.getHistory().filter((entry) => entry.connectorId === manifest.connector_id);
    assert.ok(record, "expected a completed run record for this connector");
    assert.equal(record.status, "succeeded");
    assert.equal(record.terminalReason, null);
    assert.equal(
      activeScheduler.getHistory().some((entry) => entry.terminalReason === "run_timed_out"),
      false,
      "valid connector progress must reset the scheduler watchdog"
    );

    assert.ok(record.runId, "expected run to have a run_id");
    const timeline = await waitForRunTerminalEvent(asUrl, record.runId);
    assert.equal(
      timeline.data.filter((event) => event.event_type === "run.progress_reported").length >= 10,
      true,
      "runtime should persist connector progress events"
    );
    const completed = timeline.data.find((event) => event.event_type === "run.completed");
    assert.ok(completed, "expected a completed terminal event");
  } finally {
    scheduler?.stop();
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler preserves failure reasons and checkpoint summaries from failed runConnector results", async () => {
  const manifest = {
    connector_id: "scheduler-failure-test",
    display_name: "Scheduler Failure Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-failure-test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-failure-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'unexpected_items',
    key: 'oops',
    data: { id: 'oops', value: 'bad stream' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_failure_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_failure_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.failureReason, "connector_protocol_violation");
    assert.equal(record.terminalReason, "connector_protocol_violation");
    assert.equal(record.connectorError, null);
    assert.match(record.error || "", TOP_LEVEL_REGEX_4);
    assert.ok(record.runId);
    assert.ok(record.traceId);
    assert.deepEqual(record.source, {
      id: manifest.connector_id,
      kind: "connector",
    });
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 0,
      records_attempted: 0,
      records_flushed: 0,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.failureReason, record.failureReason);
    assert.equal(historyRecord.runId, record.runId);
    assert.equal(historyRecord.traceId, record.traceId);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.failed, 1);
    assert.equal(connectorStats.lastRun?.failureReason, "connector_protocol_violation");
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler preserves partial checkpoint commit summaries from state persistence failures after DONE(succeeded)", async () => {
  const manifest = {
    connector_id: "scheduler-partial-checkpoint-test",
    display_name: "Scheduler Partial Checkpoint Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-partial-checkpoint-test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
      {
        name: "other_items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-partial-checkpoint-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_partial_items',
    data: { id: 'scheduler_partial_items', value: 'items value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'other_items',
    key: 'scheduler_partial_other_items',
    data: { id: 'scheduler_partial_other_items', value: 'other value' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'other_items',
    cursor: { cursor: 'other_items_cursor_partial_commit' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const completedRuns: RunRecord[] = [];
  const committedState: unknown[] = [];
  let stateWriteCount = 0;
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname.startsWith("/v1/ingest/")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
      return;
    }

    if (req.method === "PUT" && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      stateWriteCount += 1;
      const payload = JSON.parse(body || "{}");
      if (stateWriteCount === 1) {
        committedState.push(payload.state);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "simulated_state_write_failure" }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  try {
    await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
    const rsPort = addressPort(rsServer);

    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_partial_checkpoint_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_partial_checkpoint_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: `http://localhost:${rsPort}`,
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      setState: async () => {
        throw new Error("setState should not be called when checkpoint commit fails");
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.failureReason, "runtime_error");
    assert.equal(record.terminalReason, "runtime_error");
    assert.equal(record.connectorError, null);
    assert.equal(record.recordsEmitted, 2);
    assert.equal(record.reportedRecordsEmitted, 2);
    assert.match(record.error || "", TOP_LEVEL_REGEX_5);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "partially_committed",
      mode: "checkpointed_streaming",
      records_accepted: 2,
      records_attempted: 2,
      records_flushed: 2,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 1,
      state_streams_staged: 2,
    });
    assert.deepEqual(committedState, [{ items: { cursor: "items_cursor_partial_commit" } }]);

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.failureReason, record.failureReason);
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.failed, 1);
    assert.equal(connectorStats.lastRun?.failureReason, "runtime_error");
    assert.equal(connectorStats.lastRun?.terminalReason, "runtime_error");
    assert.equal(connectorStats.lastRun?.recordsEmitted, 2);
    assert.equal(connectorStats.lastRun?.reportedRecordsEmitted, 2);
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeHttpServer(rsServer);
    await closeServer(server);
  }
});

test("scheduler preserves terminal counter mismatch failures from runConnector results", async () => {
  const manifest = {
    connector_id: "scheduler-terminal-counter-mismatch-test",
    display_name: "Scheduler Terminal Counter Mismatch Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-terminal-counter-mismatch-test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-terminal-counter-mismatch-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_terminal_counter_mismatch',
    data: { id: 'scheduler_terminal_counter_mismatch', value: 'before mismatch' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'scheduler_terminal_counter_mismatch_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 2,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_terminal_counter_mismatch_user");
    const connectorInstanceId = await materializeRunConnection(
      manifest.connector_id,
      "scheduler_terminal_counter_mismatch_user"
    );
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_terminal_counter_mismatch_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      setState: async () => {
        throw new Error("setState should not be called when terminal counter validation fails");
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.recordsEmitted, 1);
    assert.equal(record.reportedRecordsEmitted, 2);
    assert.equal(record.failureReason, "connector_protocol_violation");
    assert.equal(record.terminalReason, "connector_protocol_violation");
    assert.equal(record.connectorError, null);
    assert.match(record.error || "", TOP_LEVEL_REGEX_6);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 1,
      records_attempted: 1,
      records_flushed: 1,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 1,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.failureReason, record.failureReason);
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[connectorInstanceId];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.failed, 1);
    assert.equal(connectorStats.lastRun?.recordsEmitted, 1);
    assert.equal(connectorStats.lastRun?.reportedRecordsEmitted, 2);
    assert.equal(connectorStats.lastRun?.failureReason, "connector_protocol_violation");
    assert.equal(connectorStats.lastRun?.terminalReason, "connector_protocol_violation");
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler preserves connector-declared terminal error details from failed runs", async () => {
  const manifest = {
    connector_id: "scheduler-terminal-error-test",
    display_name: "Scheduler Terminal Error Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-terminal-error-test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-terminal-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_terminal_error',
    data: { id: 'scheduler_terminal_error', value: 'before failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 1,
    error: { message: 'Remote provider rate limit', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_terminal_error_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_terminal_error_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, "connector_reported_failed");
    assert.deepEqual(record.connectorError, {
      message: "Remote provider rate limit",
      retryable: true,
    });
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 1,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 0,
      records_attempted: 0,
      records_flushed: 0,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.connectorError, record.connectorError);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.lastRun?.terminalReason, "connector_reported_failed");
    assert.deepEqual(connectorStats.lastRun?.connectorError, {
      message: "Remote provider rate limit",
      retryable: true,
    });
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler preserves known gaps from partial connector runs", async () => {
  const manifest = {
    connector_id: "scheduler-known-gap-test",
    display_name: "Scheduler Known Gap Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-known-gap-test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-known-gap-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'SKIP_RESULT',
    stream: 'items',
    reason: 'http_429',
    message: 'provider returned 429',
    resource_ids: ['item_1'],
  }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_known_gap_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_known_gap_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "succeeded");
    assert.equal(record.knownGaps.length, 1);
    const [knownGap] = record.knownGaps as readonly KnownGap[];
    assert.ok(knownGap, "expected a known gap entry");
    assert.equal(knownGap.kind, "skip_result");
    assert.equal(knownGap.severity, "transient");
    assert.equal(knownGap.recovery_hint?.action, "retry_by_runtime");
    assert.deepEqual(knownGap.scope?.resource_ids, ["item_1"]);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.deepEqual(connectorStats.lastRun?.knownGaps, record.knownGaps);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler preserves connector-declared terminal error details from cancelled runs", async () => {
  const manifest = {
    connector_id: "scheduler-cancelled-terminal-error-test",
    display_name: "Scheduler Cancelled Terminal Error Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-cancelled-terminal-error-test",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-cancelled-terminal-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_cancelled_terminal_error',
    data: { id: 'scheduler_cancelled_terminal_error', value: 'before cancellation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'cancelled',
    records_emitted: 1,
    error: { message: 'User denied follow-up verification', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_cancelled_terminal_error_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_cancelled_terminal_error_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "cancelled");
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, "connector_reported_cancelled");
    assert.deepEqual(record.connectorError, {
      message: "User denied follow-up verification",
      retryable: false,
    });
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 1,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 0,
      records_attempted: 0,
      records_flushed: 0,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.terminalReason, record.terminalReason);
    assert.deepEqual(historyRecord.connectorError, record.connectorError);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.lastRun?.terminalReason, "connector_reported_cancelled");
    assert.deepEqual(connectorStats.lastRun?.connectorError, {
      message: "User denied follow-up verification",
      retryable: false,
    });
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler does not retry deterministic connector protocol violations", async () => {
  const manifest = {
    connector_id: "scheduler-no-retry-protocol-violation",
    display_name: "Scheduler No Retry Protocol Violation Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-no-retry-protocol-violation",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-no-retry-protocol-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'wrong_items',
    key: 'protocol_violation',
    data: { id: 'protocol_violation' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_no_retry_protocol_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "scheduler_no_retry_protocol_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, "connector_protocol_violation");
    assert.equal(record.terminalReason, "connector_protocol_violation");
    assert.match(record.error || "", TOP_LEVEL_REGEX_7);

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "protocol violations should not be retried by the scheduler");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler retries connector-declared retryable failures and records the succeeding attempt", async () => {
  const manifest = {
    connector_id: "scheduler-retryable-terminal-error",
    display_name: "Scheduler Retryable Terminal Error Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-retryable-terminal-error",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-retryable-terminal-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'readline';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  if (attempts === 1) {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'failed',
      records_emitted: 0,
      error: { message: 'Rate limited, retry later', retryable: true },
    }) + '\\n');
    rl.close();
    process.exit(1);
    return;
  }

  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'retry_success',
    data: { id: 'retry_success', value: 'after retry' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_retryable_terminal_error_user");
    const connectorInstanceId = await materializeRunConnection(
      manifest.connector_id,
      "scheduler_retryable_terminal_error_user"
    );
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "scheduler_retryable_terminal_error_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 8000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "succeeded");
    assert.equal(record.attempt, 2);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.equal(record.recordsEmitted, 1);

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 2, "retryable terminal failures should be retried once before succeeding");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler does not retry connector-declared non-retryable failures", async () => {
  const manifest = {
    connector_id: "scheduler-nonretryable-terminal-error",
    display_name: "Scheduler Nonretryable Terminal Error Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-nonretryable-terminal-error",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-nonretryable-terminal-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';
const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 0,
    error: { message: 'Credentials revoked', retryable: false },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_nonretryable_terminal_error_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "scheduler_nonretryable_terminal_error_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, "connector_reported_failed");
    assert.deepEqual(record.connectorError, {
      message: "Credentials revoked",
      retryable: false,
    });

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "explicitly non-retryable connector failures should not be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler does not retry runtime authentication failures from ingest", async () => {
  const manifest = {
    connector_id: "scheduler-authentication-error",
    display_name: "Scheduler Authentication Error Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-authentication-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_authentication_error',
    data: { id: 'scheduler_authentication_error', value: 'before auth failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );

  const completedRuns: RunRecord[] = [];
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/ingest/items") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Invalid or expired token",
          },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  try {
    await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
    const rsPort = addressPort(rsServer);
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "owner_local",
          ownerToken: "invalid_owner_token",
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: `http://localhost:${rsPort}`,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, "authentication_error");
    assert.equal(record.terminalReason, "authentication_error");
    assert.equal(record.connectorError, null);
    assert.match(record.error || "", TOP_LEVEL_REGEX_8);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 1,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 0,
      records_attempted: 1,
      records_flushed: 0,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 1,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.failureReason, "authentication_error");
    assert.equal(historyRecord.terminalReason, "authentication_error");
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.failed, 1);
    assert.equal(connectorStats.lastRun?.failureReason, "authentication_error");
    assert.equal(connectorStats.lastRun?.terminalReason, "authentication_error");
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "runtime authentication failures should not be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeHttpServer(rsServer);
  }
});

test("scheduler does not retry runtime permission failures from state persistence", async () => {
  const manifest = {
    connector_id: "scheduler-permission-error",
    display_name: "Scheduler Permission Error Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-permission-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_permission_error',
    data: { id: 'scheduler_permission_error', value: 'before permission failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'STATE',
    stream: 'items',
    cursor: { cursor: 'permission_error_cursor' },
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );

  const completedRuns: RunRecord[] = [];
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/ingest/items") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
      return;
    }

    if (req.method === "PUT" && url.pathname === `/v1/state/${encodeURIComponent(manifest.connector_id)}`) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Owner token required",
          },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  try {
    await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
    const rsPort = addressPort(rsServer);
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "owner_local",
          ownerToken: "client_token_instead_of_owner",
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: `http://localhost:${rsPort}`,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, "permission_error");
    assert.equal(record.terminalReason, "permission_error");
    assert.equal(record.connectorError, null);
    assert.match(record.error || "", TOP_LEVEL_REGEX_1);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 1,
      records_attempted: 1,
      records_flushed: 1,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 1,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.failureReason, "permission_error");
    assert.equal(historyRecord.terminalReason, "permission_error");
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.failed, 1);
    assert.equal(connectorStats.lastRun?.failureReason, "permission_error");
    assert.equal(connectorStats.lastRun?.terminalReason, "permission_error");
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "runtime permission failures should not be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeHttpServer(rsServer);
  }
});

test("scheduler does not retry deterministic runtime connector_invalid failures", async () => {
  const manifest = {
    connector_id: "scheduler-connector-invalid",
    display_name: "Scheduler Connector Invalid Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-connector-invalid-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: 'scheduler_connector_invalid',
    data: { id: 'scheduler_connector_invalid', value: 'before connector invalid' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );

  const completedRuns: RunRecord[] = [];
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/ingest/items") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "connector_invalid",
            message: "Connector manifest is malformed",
            type: "invalid_request_error",
          },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  try {
    await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
    const rsPort = addressPort(rsServer);
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "owner_local",
          ownerToken: "owner_token",
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: `http://localhost:${rsPort}`,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "failed");
    assert.equal(record.attempt, 1);
    assert.equal(record.failureReason, "connector_invalid");
    assert.equal(record.terminalReason, "connector_invalid");
    assert.equal(record.connectorError, null);
    assert.match(record.error || "", TOP_LEVEL_REGEX_9);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 1,
      commit_status: "not_committed",
      mode: "checkpointed_streaming",
      records_accepted: 0,
      records_attempted: 1,
      records_flushed: 0,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 1,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const [historyRecord] = scheduler.getHistory();
    assert.ok(historyRecord, "expected a scheduler history record");
    assert.equal(historyRecord.failureReason, "connector_invalid");
    assert.equal(historyRecord.terminalReason, "connector_invalid");
    assert.deepEqual(historyRecord.checkpointSummary, record.checkpointSummary);

    const stats = scheduler.getStats();
    const connectorStats = stats[manifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.failed, 1);
    assert.equal(connectorStats.lastRun?.failureReason, "connector_invalid");
    assert.equal(connectorStats.lastRun?.terminalReason, "connector_invalid");
    assert.deepEqual(connectorStats.lastRun?.checkpointSummary, record.checkpointSummary);

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "deterministic runtime connector_invalid failures should not be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeHttpServer(rsServer);
  }
});

test("scheduler retries runtime rate_limit_error failures and records the succeeding attempt", async () => {
  const manifest = {
    connector_id: "scheduler-rate-limit-error",
    display_name: "Scheduler Rate Limit Error Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-rate-limit-error-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: attempts === 1 ? 'scheduler_rate_limit_retry_1' : 'scheduler_rate_limit_retry_2',
    data: {
      id: attempts === 1 ? 'scheduler_rate_limit_retry_1' : 'scheduler_rate_limit_retry_2',
      value: attempts === 1 ? 'before rate limit' : 'after retry',
    },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );

  let ingestAttempts = 0;
  const completedRuns: RunRecord[] = [];
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/ingest/items") {
      ingestAttempts += 1;
      if (ingestAttempts === 1) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              message: "Too many requests",
            },
          })
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  try {
    await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
    const rsPort = addressPort(rsServer);
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "owner_local",
          ownerToken: "owner_token",
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: `http://localhost:${rsPort}`,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 8000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "succeeded");
    assert.equal(record.attempt, 2);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "committed",
      mode: "checkpointed_streaming",
      records_accepted: 1,
      records_attempted: 1,
      records_flushed: 1,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 2, "runtime rate_limit_error failures should be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeHttpServer(rsServer);
  }
});

test("scheduler retries transient runtime 500 failures and records the succeeding attempt", async () => {
  const manifest = {
    connector_id: "scheduler-runtime-500-retry",
    display_name: "Scheduler Runtime 500 Retry Connector",
    protocol_version: "0.1.0",
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            value: { type: "string" },
          },
          required: ["id"],
          type: "object",
        },
        semantics: "append_only",
      },
    ],
    version: "1.0.0",
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-runtime-500-retry-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const attemptsPath = join(tmpDir, "attempts.log");
  writeFileSync(
    connectorPath,
    `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: attempts === 1 ? 'scheduler_runtime_500_retry_1' : 'scheduler_runtime_500_retry_2',
    data: {
      id: attempts === 1 ? 'scheduler_runtime_500_retry_1' : 'scheduler_runtime_500_retry_2',
      value: attempts === 1 ? 'before transient failure' : 'after retry',
    },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );

  let ingestAttempts = 0;
  const completedRuns: RunRecord[] = [];
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  const rsServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/v1/ingest/items") {
      ingestAttempts += 1;
      if (ingestAttempts === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "temporary_upstream_failure" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  try {
    await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
    const rsPort = addressPort(rsServer);
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 2,
          ownerSubjectId: "owner_local",
          ownerToken: "owner_token",
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl: `http://localhost:${rsPort}`,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 8000);
    scheduler.stop();

    const [record] = completedRuns;
    assert.ok(record, "expected a completed run record");
    assert.equal(record.status, "succeeded");
    assert.equal(record.attempt, 2);
    assert.equal(record.failureReason, null);
    assert.equal(record.terminalReason, null);
    assert.equal(record.connectorError, null);
    assert.deepEqual(record.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "committed",
      mode: "checkpointed_streaming",
      records_accepted: 1,
      records_attempted: 1,
      records_flushed: 1,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 2, "transient runtime 500 failures should be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeHttpServer(rsServer);
  }
});

test("scheduler treats single_use grants as one successful run followed by exhausted skips without persisting state", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const persistedStates: unknown[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_single_use_user");
    const singleUseCanonicalKey = canonicalConnectorKey(spotifyManifest.connector_id);
    assert.ok(singleUseCanonicalKey, "expected the spotify fixture connector_id to canonicalize");
    await registerSchedulerFixtureConnectorInstance({
      connectorId: singleUseCanonicalKey,
      connectorInstanceId: spotifyManifest.connector_id,
      displayName: spotifyManifest.display_name,
      ownerSubjectId: "scheduler_single_use_user",
      sourceBindingKey: "scheduler_single_use_fixture",
      timestamp: "2026-04-29T02:00:00.000Z",
    });
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          grantAccessMode: "single_use",
          intervalMs: 25,
          manifest: spotifyManifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_single_use_user",
          ownerToken,
        },
      ],
      getState: async () => ({ top_artists: { cursor: "should_not_be_used" } }),
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      setState: async (_connectorId: string, state: unknown) => {
        persistedStates.push(state);
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 2, 5000);
    scheduler.stop();

    const [first, second] = completedRuns;
    assert.ok(first, "expected a first completed run record");
    assert.ok(second, "expected a second completed run record");
    assert.equal(first.status, "succeeded");
    assert.equal(first.attempt, 1);
    assert.equal(first.recordsEmitted, 21);
    assert.deepEqual(first.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "disabled",
      mode: "checkpointed_streaming",
      records_accepted: 21,
      records_attempted: 21,
      records_flushed: 21,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 2,
    });

    assert.equal(second.status, "skipped");
    assert.equal(second.attempt, 0);
    assert.equal(second.recordsEmitted, 0);
    assert.equal(second.error, "single_use grant already consumed");
    assert.equal(second.checkpointSummary, null);
    assert.deepEqual(second.source, {
      id: spotifyManifest.connector_id,
      kind: "connector",
    });

    assert.deepEqual(persistedStates, [], "single_use scheduler runs should not persist connector state");

    const history = scheduler.getHistory();
    assert.equal(history.length >= 2, true);
    const [firstHistoryRecord, secondHistoryRecord] = history;
    assert.ok(firstHistoryRecord, "expected a first history record");
    assert.ok(secondHistoryRecord, "expected a second history record");
    assert.equal(firstHistoryRecord.status, "succeeded");
    assert.equal(secondHistoryRecord.status, "skipped");

    const stats = scheduler.getStats();
    const connectorStats = stats[spotifyManifest.connector_id];
    assert.ok(connectorStats, "expected stats for the connector");
    assert.equal(connectorStats.succeeded, 1);
    assert.equal(connectorStats.failed, 0);
    assert.equal(connectorStats.totalRuns >= 2, true);
    assert.equal(connectorStats.lastRun?.status, "skipped");
  } finally {
    await closeServer(server);
  }
});

test("scheduler does not start overlapping runs for the same connector while a prior run is active", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-active-run-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  const connectorPath = join(tmpDir, "slow-connector.mjs");

  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'succeeded',
      records_emitted: 0,
    }) + '\\n');
    rl.close();
    process.exit(0);
  }, 150);
});
`,
    "utf8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_active_run_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: spotifyManifest.connector_id,
          connectorPath,
          intervalMs: 50,
          manifest: spotifyManifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_active_run_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 5000);
    scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 125));

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "scheduler should not start overlapping runs for the same connector");
    assert.equal(completedRuns.length, 1, "scheduler should only complete the original active run before stop");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler keeps single_use grants reusable after failed runs until a later success consumes them", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-single-use-retry-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  const connectorPath = join(tmpDir, "flaky-single-use-connector.mjs");

  writeFileSync(
    connectorPath,
    `
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

function getAttemptCount() {
  try {
    return readFileSync(attemptsPath, 'utf8').trim().split('\\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const attempt = getAttemptCount() + 1;
  appendFileSync(attemptsPath, \`attempt-\${attempt}\\n\`, 'utf8');
  if (attempt === 1) {
    process.stdout.write(JSON.stringify({
      type: 'DONE',
      status: 'failed',
      records_emitted: 0,
      error: { message: 'Transient upstream failure', retryable: false },
    }) + '\\n');
    rl.close();
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 0,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
    "utf8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const persistedStates: unknown[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_single_use_retry_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: spotifyManifest.connector_id,
          connectorPath,
          grantAccessMode: "single_use",
          intervalMs: 50,
          manifest: spotifyManifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_single_use_retry_user",
          ownerToken,
        },
      ],
      getState: async () => ({ top_artists: { cursor: "should_not_be_used" } }),
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      setState: async (_connectorId: string, state: unknown) => {
        persistedStates.push(state);
      },
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 3, 5000);
    scheduler.stop();

    const [first, second, third] = completedRuns;
    assert.ok(first, "expected a first completed run record");
    assert.ok(second, "expected a second completed run record");
    assert.ok(third, "expected a third completed run record");
    assert.equal(first.status, "failed");
    assert.equal(first.attempt, 1);
    assert.equal(first.terminalReason, "connector_reported_failed");
    assert.deepEqual(first.connectorError, {
      message: "Transient upstream failure",
      retryable: false,
    });

    assert.equal(second.status, "succeeded");
    assert.equal(second.attempt, 1);
    assert.deepEqual(second.checkpointSummary, {
      buffered_records_dropped: 0,
      commit_status: "disabled",
      mode: "checkpointed_streaming",
      records_accepted: 0,
      records_attempted: 0,
      records_flushed: 0,
      records_permanently_rejected: 0,
      records_unresolved_retryable: 0,
      state_streams_committed: 0,
      state_streams_staged: 0,
    });

    assert.equal(third.status, "skipped");
    assert.equal(third.attempt, 0);
    assert.equal(third.error, "single_use grant already consumed");

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(
      attempts.length,
      2,
      "single_use grants should remain usable after a failed run until a later success consumes them"
    );
    assert.deepEqual(
      persistedStates,
      [],
      "single_use scheduler runs should not persist connector state even across failed-then-successful runs"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler stop prevents retryable failures from launching another attempt after backoff", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-stop-retry-"));
  const attemptsPath = join(tmpDir, "attempts.log");
  const connectorPath = join(tmpDir, "retryable-connector.mjs");

  writeFileSync(
    connectorPath,
    `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'failed',
    records_emitted: 0,
    error: { message: 'Temporary upstream outage', retryable: true },
  }) + '\\n');
  rl.close();
  process.exit(1);
});
`,
    "utf8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_stop_retry_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: spotifyManifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest: spotifyManifest,
          maxRetries: 2,
          ownerSubjectId: "scheduler_stop_retry_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => {
      try {
        const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
        return attempts.length === 1;
      } catch {
        return false;
      }
    }, 5000);
    scheduler.stop();
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "scheduler stop should prevent retry backoff from launching a second attempt");
    assert.equal(
      completedRuns.length,
      1,
      "scheduler should emit a single failed run record when stop cancels further retries"
    );
    const [stopRetryRecord] = completedRuns;
    assert.ok(stopRetryRecord, "expected a completed run record");
    assert.equal(stopRetryRecord.status, "failed");
    assert.equal(stopRetryRecord.attempt, 1);
    assert.equal(stopRetryRecord.terminalReason, "connector_reported_failed");
    assert.deepEqual(stopRetryRecord.connectorError, {
      message: "Temporary upstream outage",
      retryable: true,
    });
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("scheduler start is idempotent and does not launch a second immediate run", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_idempotent_start_user");
    const connectorInstanceId = await materializeRunConnection(
      spotifyManifest.connector_key,
      "scheduler_idempotent_start_user"
    );
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_key,
          connectorInstanceId,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 10_000,
          manifest: spotifyManifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_idempotent_start_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length === 1, 5000);
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    assert.equal(
      completedRuns.length,
      1,
      "calling start twice should not trigger a second immediate run or duplicate schedules"
    );
    const [idempotentStartRecord] = completedRuns;
    assert.ok(idempotentStartRecord, "expected a completed run record");
    assert.equal(idempotentStartRecord.status, "succeeded");
    assert.equal(idempotentStartRecord.attempt, 1);
  } finally {
    await closeServer(server);
  }
});

test("scheduler emits one disabled skip after deterministic grant lifecycle failures and then stays quiet", async () => {
  for (const terminalReason of ["grant_invalid", "grant_revoked", "grant_expired", "grant_consumed"]) {
    const manifest = {
      connector_id: `scheduler-${terminalReason}`,
      display_name: `Scheduler ${terminalReason} Connector`,
      protocol_version: "0.1.0",
      streams: [
        {
          name: "items",
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            required: ["id"],
            type: "object",
          },
          semantics: "append_only",
        },
      ],
      version: "1.0.0",
    };
    const tmpDir = mkdtempSync(join(tmpdir(), `pdpp-scheduler-${terminalReason}-`));
    const connectorPath = join(tmpDir, "connector.mjs");
    const attemptsPath = join(tmpDir, "attempts.log");

    writeFileSync(
      connectorPath,
      `
import { appendFileSync } from 'node:fs';
import { createInterface } from 'readline';

const attemptsPath = ${JSON.stringify(attemptsPath)};
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  appendFileSync(attemptsPath, 'attempt\\n', 'utf8');
  process.stdout.write(JSON.stringify({
    type: 'RECORD',
    stream: 'items',
    key: ${JSON.stringify(`scheduler_${terminalReason}`)},
    data: { id: ${JSON.stringify(`scheduler_${terminalReason}`)}, value: 'before grant lifecycle failure' },
    emitted_at: new Date().toISOString(),
  }) + '\\n');
  process.stdout.write(JSON.stringify({
    type: 'DONE',
    status: 'succeeded',
    records_emitted: 1,
  }) + '\\n');
  rl.close();
  process.exit(0);
});
`,
      "utf8"
    );

    const completedRuns: RunRecord[] = [];
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    const rsServer = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/v1/ingest/items") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: terminalReason,
              message: `${terminalReason} while scheduling`,
              type: "invalid_request_error",
            },
          })
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      await new Promise<void>((resolve) => rsServer.listen(0, () => resolve()));
      const rsPort = addressPort(rsServer);
      const scheduler = createScheduler({
        admitRunConnection: fakeAdmitRunConnection(),
        connectors: [
          {
            connectorId: manifest.connector_id,
            connectorInstanceId: manifest.connector_id,
            connectorPath,
            intervalMs: 50,
            manifest,
            maxRetries: 2,
            ownerSubjectId: "owner_local",
            ownerToken: "grant_token",
          },
        ],
        getState: async () => null,
        onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
        onRunComplete: (record) => completedRuns.push(record),
        rsUrl: `http://localhost:${rsPort}`,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        setState: async () => {},
      });

      scheduler.start();
      await waitFor(() => completedRuns.length >= 2, 5000);
      await new Promise((resolve) => setTimeout(resolve, 180));
      scheduler.stop();

      const [first, second] = completedRuns;
      assert.ok(first, "expected a first completed run record");
      assert.ok(second, "expected a second completed run record");
      assert.equal(first.status, "failed");
      assert.equal(first.attempt, 1);
      assert.equal(first.failureReason, terminalReason);
      assert.equal(first.terminalReason, terminalReason);
      assert.equal(first.error?.includes("403"), true);

      assert.equal(second.status, "skipped");
      assert.equal(second.attempt, 0);
      assert.equal(second.terminalReason, terminalReason);
      assert.equal(second.error, `${terminalReason} grant no longer usable`);
      assert.equal(
        completedRuns.length,
        2,
        `${terminalReason} should emit a single disabled skip before future intervals go quiet`
      );

      const attempts = readFileSync(attemptsPath, "utf8").trim().split("\n").filter(Boolean);
      assert.equal(
        attempts.length,
        1,
        `${terminalReason} should disable future scheduled attempts after the first deterministic failure`
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
      await closeHttpServer(rsServer);
    }
  }
});

test("scheduler skips automatic run with needs_human_attention when isNeedsHuman returns true", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_nhuman_skip_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: spotifyManifest.connector_id,
          connectorInstanceId: spotifyManifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          // Short interval so several ticks fire during the test window.
          intervalMs: 25,
          manifest: spotifyManifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_nhuman_skip_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      isNeedsHuman: () => true,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    // Let several more ticks fire to verify suppression.
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    assert.equal(first.status, "skipped");
    assert.equal(first.attempt, 0);
    assert.ok(
      first.error?.startsWith("needs_human_attention:"),
      `expected needs_human_attention skip, got: ${first.error}`
    );
    assert.equal(
      completedRuns.length,
      1,
      "needs-human skip should be emitted exactly once — subsequent ticks must be suppressed"
    );
  } finally {
    await closeServer(server);
  }
});

test("scheduler records one not-ready skip for automatic runs when runtime prerequisites are absent", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-not-ready-test",
    connector_key: "scheduler-not-ready-test",
  };
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
  const readinessCalls = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_not_ready_skip_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_not_ready_skip_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      readinessChecker: async () => {
        readinessCalls.push(Date.now());
        return { ready: false, reason: "missing docker prerequisite for test" };
      },
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    assert.equal(first.status, "skipped");
    assert.equal(first.attempt, 0);
    assert.equal(first.error, "not_ready: missing docker prerequisite for test");
    assert.equal(completedRuns.length, 1, "stable not-ready skips should be emitted once, not spammed");
    assert.ok(readinessCalls.length > 1, "scheduler should keep probing readiness on later ticks");
  } finally {
    await closeServer(server);
  }
});

test("scheduler emits a fresh not-ready skip when readiness reason changes", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-not-ready-changing-test",
    connector_key: "scheduler-not-ready-changing-test",
  };
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  let readinessCalls = 0;

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_not_ready_changing_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_not_ready_changing_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      readinessChecker: async () => {
        readinessCalls += 1;
        return {
          ready: false,
          reason: readinessCalls < 3 ? "missing prerequisite A" : "missing prerequisite B",
        };
      },
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 2, 5000);
    scheduler.stop();

    assert.deepEqual(
      completedRuns.map((record) => record.error),
      ["not_ready: missing prerequisite A", "not_ready: missing prerequisite B"]
    );
  } finally {
    await closeServer(server);
  }
});

test("scheduler default readiness checker skips missing manifest-declared external tools", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-missing-tool-test",
    connector_key: "scheduler-missing-tool-test",
    runtime_requirements: {
      bindings: { network: { required: true } },
      external_tools: [
        {
          detect: { args: ["--help"], executable: "definitely-missing-tool-pdpp-test", exit_code: 0 },
          install_hint: "install definitely-missing-tool",
          license: "test-only",
          name: "definitely-missing-tool",
          purpose: "Prove scheduler readiness gating",
        },
      ],
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-missing-tool-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_missing_tool_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_missing_tool_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    assert.equal(first.status, "skipped");
    assert.match(first.error || "", TOP_LEVEL_REGEX_10);
    assert.equal(readAttempts(attemptsPath).length, 0, "not-ready scheduler runs must not spawn the connector");
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler default readiness checker probes a manifest-declared executable_env_override with version when set", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-slackdump-bin-test",
    connector_key: "scheduler-slackdump-bin-test",
    runtime_requirements: {
      bindings: { network: { required: true } },
      external_tools: [
        {
          detect: {
            args: ["version"],
            executable: "unused-slackdump",
            executable_env_override: "SLACKDUMP_BIN",
            exit_code: 0,
          },
          install_hint: "mount slackdump and set SLACKDUMP_BIN",
          license: "AGPL-3.0",
          name: "slackdump",
          purpose: "Session-token Slack archive export",
        },
      ],
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-slackdump-bin-"));
  const fakeSlackdumpPath = join(tmpDir, "mounted-slackdump");
  writeFileSync(fakeSlackdumpPath, '#!/bin/sh\n[ "$1" = "version" ] || exit 2\nexit 0\n', "utf8");
  chmodSync(fakeSlackdumpPath, 0o755);
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousSlackdumpBin = process.env.SLACKDUMP_BIN;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    process.env.SLACKDUMP_BIN = fakeSlackdumpPath;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_slackdump_bin_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 60_000,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_slackdump_bin_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => readAttempts(attemptsPath).length === 1, 5000);
    scheduler.stop();
  } finally {
    if (previousSlackdumpBin === undefined) {
      delete process.env.SLACKDUMP_BIN;
    } else {
      process.env.SLACKDUMP_BIN = previousSlackdumpBin;
    }
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler default readiness checker applies local-source checks declared by the schedule's own manifest", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-canonical-local-source-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousSessionsDir = process.env.CODEX_SESSIONS_DIR;
  const previousStateDb = process.env.CODEX_STATE_DB;
  const completedRuns: RunRecord[] = [];
  const scheduler = createScheduler({
    admitRunConnection: fakeAdmitRunConnection(),
    connectors: [
      {
        connectorId: "codex",
        connectorInstanceId: "codex",
        connectorPath,
        intervalMs: 25,
        manifest: {
          capabilities: {
            refresh_policy: { background_safe: true },
          },
          runtime_requirements: {
            bindings: { filesystem: { required: true }, network: { required: true } },
            local_paths: {
              home_default_relative_to_user_home: ".codex",
              home_env_override: "CODEX_HOME",
              paths: [
                {
                  default_relative_to_home: "sessions",
                  env_override: "CODEX_SESSIONS_DIR",
                  label: "sessions directory",
                  required_for_readiness: true,
                },
                {
                  default_relative_to_home: "state_5.sqlite",
                  env_override: "CODEX_STATE_DB",
                  label: "state database",
                  required_for_readiness: true,
                },
              ],
            },
          },
        },
        maxRetries: 0,
        ownerSubjectId: "owner_local",
        ownerToken: "owner-token",
      },
    ],
    getState: async () => null,
    onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
    onRunComplete: (record) => completedRuns.push(record),
    rsUrl: "http://localhost.invalid",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
    setState: async () => {},
  });

  try {
    process.env.CODEX_SESSIONS_DIR = join(tmpDir, "missing-sessions");
    process.env.CODEX_STATE_DB = join(tmpDir, "missing-state.sqlite");
    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    assert.equal(first.status, "skipped");
    assert.match(first.error || "", TOP_LEVEL_REGEX_11);
    assert.deepEqual(readAttempts(attemptsPath), [], "canonical local-source checks must prevent connector spawn");
  } finally {
    scheduler.stop();
    if (previousSessionsDir === undefined) {
      delete process.env.CODEX_SESSIONS_DIR;
    } else {
      process.env.CODEX_SESSIONS_DIR = previousSessionsDir;
    }
    if (previousStateDb === undefined) {
      delete process.env.CODEX_STATE_DB;
    } else {
      process.env.CODEX_STATE_DB = previousStateDb;
    }
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler default readiness checker does not treat browser bindings as ready by default", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-browser-not-ready-test",
    connector_key: "scheduler-browser-not-ready-test",
    runtime_requirements: {
      bindings: { browser: { required: true }, network: { required: true } },
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-browser-not-ready-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousRemoteCdp = process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
  const previousUnmanagedOptIn = process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
  const previousNekoCdpUrl = process.env.PDPP_NEKO_CDP_HTTP_URL;
  const previousNekoManaged = process.env.PDPP_NEKO_MANAGED_CONNECTORS;
  const previousRuntimeBrowser = process.env.PDPP_RUNTIME_BROWSER;
  const previousDisplay = process.env.DISPLAY;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    delete process.env.PDPP_NEKO_CDP_HTTP_URL;
    delete process.env.PDPP_NEKO_MANAGED_CONNECTORS;
    // A genuinely-unconfigured deployment has neither signal set — clear
    // both so this test's intent (not-ready) holds even when run on a
    // host with an ambient DISPLAY (e.g. a developer desktop).
    delete process.env.PDPP_RUNTIME_BROWSER;
    delete process.env.DISPLAY;
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_browser_not_ready_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_browser_not_ready_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    assert.equal(first.status, "skipped");
    assert.equal(first.error, "not_ready: required browser runtime is not configured for unattended scheduled runs");
    assert.equal(readAttempts(attemptsPath).length, 0);
  } finally {
    if (previousRemoteCdp === undefined) {
      delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    } else {
      process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL = previousRemoteCdp;
    }
    if (previousUnmanagedOptIn === undefined) {
      delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    } else {
      process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES = previousUnmanagedOptIn;
    }
    if (previousNekoCdpUrl === undefined) {
      delete process.env.PDPP_NEKO_CDP_HTTP_URL;
    } else {
      process.env.PDPP_NEKO_CDP_HTTP_URL = previousNekoCdpUrl;
    }
    if (previousNekoManaged === undefined) {
      delete process.env.PDPP_NEKO_MANAGED_CONNECTORS;
    } else {
      process.env.PDPP_NEKO_MANAGED_CONNECTORS = previousNekoManaged;
    }
    if (previousRuntimeBrowser === undefined) {
      delete process.env.PDPP_RUNTIME_BROWSER;
    } else {
      process.env.PDPP_RUNTIME_BROWSER = previousRuntimeBrowser;
    }
    if (previousDisplay === undefined) {
      delete process.env.DISPLAY;
    } else {
      process.env.DISPLAY = previousDisplay;
    }
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler default readiness checker treats PDPP_NEKO_CDP_HTTP_URL as managed browser surface", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-browser-neko-cdp-ready-test",
    connector_key: "scheduler-browser-neko-cdp-ready-test",
    runtime_requirements: {
      bindings: { browser: { required: true }, network: { required: true } },
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-browser-neko-cdp-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousRemoteCdp = process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
  const previousUnmanagedOptIn = process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
  const previousNekoCdpUrl = process.env.PDPP_NEKO_CDP_HTTP_URL;
  const previousNekoManaged = process.env.PDPP_NEKO_MANAGED_CONNECTORS;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    delete process.env.PDPP_NEKO_MANAGED_CONNECTORS;
    // Simulate reference Docker stack static neko mode — no PDPP_BROWSER_SURFACE_REMOTE_CDP_URL needed.
    process.env.PDPP_NEKO_CDP_HTTP_URL = "http://neko:9223";

    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_browser_neko_cdp_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_browser_neko_cdp_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    // Readiness gate must pass — connector should run (succeeded or failed), not be skipped as not_ready.
    assert.ok(
      first.status !== "skipped" || !first.error?.startsWith("not_ready:"),
      `expected run to pass readiness gate but got: ${first.error}`
    );
    assert.ok(readAttempts(attemptsPath).length >= 1, "connector should have been launched");
  } finally {
    if (previousRemoteCdp === undefined) {
      delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    } else {
      process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL = previousRemoteCdp;
    }
    if (previousUnmanagedOptIn === undefined) {
      delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    } else {
      process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES = previousUnmanagedOptIn;
    }
    if (previousNekoCdpUrl === undefined) {
      delete process.env.PDPP_NEKO_CDP_HTTP_URL;
    } else {
      process.env.PDPP_NEKO_CDP_HTTP_URL = previousNekoCdpUrl;
    }
    if (previousNekoManaged === undefined) {
      delete process.env.PDPP_NEKO_MANAGED_CONNECTORS;
    } else {
      process.env.PDPP_NEKO_MANAGED_CONNECTORS = previousNekoManaged;
    }
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler default readiness checker treats PDPP_NEKO_MANAGED_CONNECTORS as managed browser surface", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-browser-neko-managed-ready-test",
    connector_key: "scheduler-browser-neko-managed-ready-test",
    runtime_requirements: {
      bindings: { browser: { required: true }, network: { required: true } },
    },
  };
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-browser-neko-managed-"));
  const { attemptsPath, connectorPath } = writeLoggingConnector(tmpDir);
  const previousRemoteCdp = process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
  const previousUnmanagedOptIn = process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
  const previousNekoCdpUrl = process.env.PDPP_NEKO_CDP_HTTP_URL;
  const previousNekoManaged = process.env.PDPP_NEKO_MANAGED_CONNECTORS;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  try {
    delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    delete process.env.PDPP_NEKO_CDP_HTTP_URL;
    // Simulate reference Docker stack dynamic neko mode.
    process.env.PDPP_NEKO_MANAGED_CONNECTORS = "https://registry.pdpp.dev/connectors/chatgpt";

    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_browser_neko_managed_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_browser_neko_managed_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 1, 5000);
    scheduler.stop();

    const [first] = completedRuns;
    assert.ok(first, "expected a completed run record");
    assert.ok(
      first.status !== "skipped" || !first.error?.startsWith("not_ready:"),
      `expected run to pass readiness gate but got: ${first.error}`
    );
    assert.ok(readAttempts(attemptsPath).length >= 1, "connector should have been launched");
  } finally {
    if (previousRemoteCdp === undefined) {
      delete process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    } else {
      process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL = previousRemoteCdp;
    }
    if (previousUnmanagedOptIn === undefined) {
      delete process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES;
    } else {
      process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES = previousUnmanagedOptIn;
    }
    if (previousNekoCdpUrl === undefined) {
      delete process.env.PDPP_NEKO_CDP_HTTP_URL;
    } else {
      process.env.PDPP_NEKO_CDP_HTTP_URL = previousNekoCdpUrl;
    }
    if (previousNekoManaged === undefined) {
      delete process.env.PDPP_NEKO_MANAGED_CONNECTORS;
    } else {
      process.env.PDPP_NEKO_MANAGED_CONNECTORS = previousNekoManaged;
    }
    await closeServer(server);
    rmSync(tmpDir, { force: true, recursive: true });
  }
});

test("scheduler marks connector as needs-human when automatic run triggers interaction", async () => {
  const manifest = {
    connector_id: "scheduler-interaction-test",
    display_name: "Interaction Test Connector",
    manifest_uri: "https://registry.pdpp.dev/connectors/scheduler-interaction-test",
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

  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-scheduler-interaction-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  // Connector that emits one INTERACTION then exits after response.
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
process.on('SIGTERM', () => process.exit(1));
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'INTERACTION_RESPONSE') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    process.exit(0);
  }
  if (msg.type !== 'START') return;
  process.stdout.write(JSON.stringify({
    type: 'INTERACTION',
    request_id: 'req_1',
    kind: 'otp',
    message: 'Enter OTP',
  }) + '\\n');
});
`,
    "utf-8"
  );

  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const interactions: SchedulerInteraction[] = [];
  const markedConnectors: string[] = [];

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_interaction_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath,
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_interaction_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      isNeedsHuman: (connectorId: string) => markedConnectors.includes(connectorId),
      markNeedsHuman: (connectorId: string) => markedConnectors.push(connectorId),
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      onInteraction: async (interaction: unknown) => {
        interactions.push(asSchedulerInteraction(interaction));
        return cancelledInteractionResponse(interaction);
      },
      onRunComplete: (record) => completedRuns.push(record),
      rsUrl,
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.length >= 2, 8000);
    scheduler.stop();

    assert.ok(
      markedConnectors.includes(manifest.connector_id),
      "markNeedsHuman should be called when an automatic run triggers an interaction"
    );
    const [interactionRun, needsHumanSkip] = completedRuns;
    assert.equal(interactionRun?.status, "succeeded");
    assert.notEqual(interactionRun?.terminalReason, "interaction_handler_invalid_response");
    assert.equal(interactions[0]?.connector_id, manifest.connector_id);
    assert.equal(interactions[0]?.connector_display_name, manifest.display_name);
    assert.equal(interactions[0]?.run_id, interactionRun?.runId);
    assert.equal(needsHumanSkip?.status, "skipped");
    assert.ok(needsHumanSkip?.error?.startsWith("needs_human_attention:"));
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

// ─── Regression: 1970 next_attempt_at on back-off skips ─────────────────────
//
// Symptom from production probe: Reddit `scheduler_backoff_applied` skip
// rows surfaced `next attempt at 1970-01-02T00:00:00.000Z`. Cause: hydrated
// history contained 3+ same-class failures, but `scheduler_last_run_times`
// had no row for the connector (separate write; can drop on process crash
// or older runtime). `evaluateBackoffDispatch` then computed
// `nextRunAt = 0 + effectiveIntervalMs`, surfacing an epoch-derived
// timestamp. Fix derives `lastRun` from the newest history record when
// the last-run map is empty, and the skip-message formatter substitutes
// safe phrasing if the resolved timestamp is still epoch-suspicious.
test("scheduler backoff skip derives next_attempt_at from history when last_run_time is missing", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-backoff-1970-regression",
    connector_key: "scheduler-backoff-1970-regression",
  };
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  const recentEpochMs = Date.now() - 60_000;
  const historyRecords: SchedulerRunHistoryRecord[] = [];
  // biome-ignore lint/style/noIncrementDecrement: counter mutation is explicit in this ordered test
  for (let i = 0; i < 4; i++) {
    const startedAtMs = recentEpochMs + i * 1000;
    historyRecords.push({
      attempt: 1,
      checkpointSummary: null,
      completedAt: new Date(startedAtMs + 500).toISOString(),
      connectorError: { reason: "reddit_login_unexpected_ui" },
      connectorId: manifest.connector_id,
      failureReason: null,
      knownGaps: [],
      recordsEmitted: 0,
      reportedRecordsEmitted: null,
      runId: null,
      source: { id: manifest.connector_id, kind: "connector" },
      startedAt: new Date(startedAtMs).toISOString(),
      status: "failed",
      terminalReason: null,
      traceId: null,
    });
  }

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_backoff_1970_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_backoff_1970_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: async () => ({ ready: false, reason: "simulated unattended gate" }),
      rsUrl,
      schedulerStore: {
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        appendRunHistory: async () => {},
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        deleteActiveRun: async () => {},
        listLastRunTimes: async () => [],
        listRunHistory: async () => historyRecords,
        upsertActiveRun: async () => true,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        upsertLastRunTime: async () => {},
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.some((r) => r.error?.startsWith("scheduler_backoff_applied:")), 5000);
    scheduler.stop();

    const backoffSkip = completedRuns.find((r) => r.error?.startsWith("scheduler_backoff_applied:"));
    assert.ok(backoffSkip, "expected a scheduler_backoff_applied skip event");
    assert.equal(backoffSkip.status, "skipped");
    assert.ok(backoffSkip.error, "expected the backoff skip to carry an error message");
    assert.doesNotMatch(
      backoffSkip.error,
      TOP_LEVEL_REGEX_12,
      `backoff skip must never reference 1970 epoch; got: ${backoffSkip.error}`
    );
    const nextAttemptMatch = backoffSkip.error.match(TOP_LEVEL_REGEX_13);
    assert.ok(nextAttemptMatch, `expected explicit next-attempt phrase, got: ${backoffSkip.error}`);
    // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
    const nextAttemptPhrase = nextAttemptMatch[1];
    assert.ok(nextAttemptPhrase, "expected a captured next-attempt phrase");
    if (TOP_LEVEL_REGEX_14.test(nextAttemptPhrase)) {
      const parsed = Date.parse(nextAttemptPhrase);
      assert.ok(Number.isFinite(parsed), `parseable ISO timestamp, got: ${nextAttemptPhrase}`);
      assert.ok(
        parsed >= recentEpochMs,
        `next_attempt_at should be at or after the most recent failure (${new Date(recentEpochMs).toISOString()}); got: ${nextAttemptPhrase}`
      );
    } else {
      // Acceptable alternate: explicit safe phrasing when no anchor is
      // available. Should not be hit with history present.
      assert.match(nextAttemptPhrase, TOP_LEVEL_REGEX_15);
    }
  } finally {
    await closeServer(server);
  }
});

// ─── Regression: blocked-state backoff skip messaging ───────────────────────
//
// When a streak crosses the BLOCKED_PROMOTION_THRESHOLD, the scheduler
// suppresses auto-dispatch entirely. A timestamp in the skip message is
// then misleading — no retry is planned. Verify the skip uses explicit
// `gave_up` phrasing instead, and a one-shot `schedule.gave_up` event
// fires.
test("scheduler backoff skip uses gave_up phrasing once health-state crosses blocked threshold", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-backoff-blocked-msg",
    connector_key: "scheduler-backoff-blocked-msg",
  };
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];

  const recentEpochMs = Date.now() - 60_000;
  const historyRecords: SchedulerRunHistoryRecord[] = [];
  // biome-ignore lint/style/noIncrementDecrement: counter mutation is explicit in this ordered test
  for (let i = 0; i < 20; i++) {
    const startedAtMs = recentEpochMs + i * 1000;
    historyRecords.push({
      attempt: 1,
      checkpointSummary: null,
      completedAt: new Date(startedAtMs + 500).toISOString(),
      connectorError: { reason: "reddit_login_unexpected_ui" },
      connectorId: manifest.connector_id,
      failureReason: null,
      knownGaps: [],
      recordsEmitted: 0,
      reportedRecordsEmitted: null,
      runId: null,
      source: { id: manifest.connector_id, kind: "connector" },
      startedAt: new Date(startedAtMs).toISOString(),
      status: "failed",
      terminalReason: null,
      traceId: null,
    });
  }

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_backoff_blocked_msg_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_backoff_blocked_msg_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: async () => ({ ready: false, reason: "simulated unattended gate" }),
      rsUrl,
      schedulerStore: {
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        appendRunHistory: async () => {},
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        deleteActiveRun: async () => {},
        listLastRunTimes: async () => [],
        listRunHistory: async () => historyRecords,
        upsertActiveRun: async () => true,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        upsertLastRunTime: async () => {},
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => completedRuns.some((r) => r.error?.startsWith("scheduler_backoff_applied:")), 5000);
    scheduler.stop();

    const backoffSkip = completedRuns.find((r) => r.error?.startsWith("scheduler_backoff_applied:"));
    assert.ok(backoffSkip, "expected a scheduler_backoff_applied skip event");
    assert.ok(backoffSkip.error, "expected the backoff skip to carry an error message");
    assert.doesNotMatch(backoffSkip.error, TOP_LEVEL_REGEX_16);
    assert.match(
      backoffSkip.error,
      TOP_LEVEL_REGEX_17,
      `blocked-state skip should say gave_up, not a misleading retry time. got: ${backoffSkip.error}`
    );

    const gaveUpEvent = completedRuns.find((r) => r.error?.startsWith("schedule.gave_up:"));
    assert.ok(gaveUpEvent, "expected a one-shot schedule.gave_up spine event");
  } finally {
    await closeServer(server);
  }
});

test("scheduler does not re-emit persisted backoff transition markers on restart", async () => {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const manifest = {
    ...spotifyManifest,
    connector_id: "scheduler-backoff-restart-noise",
    connector_key: "scheduler-backoff-restart-noise",
  };
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const completedRuns: RunRecord[] = [];
  const appendedHistory: SchedulerRunHistoryRecord[] = [];

  const recentEpochMs = Date.now() - 60_000;
  const historyRecords: SchedulerRunHistoryRecord[] = [];
  // biome-ignore lint/style/noIncrementDecrement: counter mutation is explicit in this ordered test
  for (let i = 0; i < 20; i++) {
    const startedAtMs = recentEpochMs + i * 1000;
    historyRecords.push({
      attempt: 1,
      checkpointSummary: null,
      completedAt: new Date(startedAtMs + 500).toISOString(),
      connectorError: { reason: "reddit_login_unexpected_ui" },
      connectorId: manifest.connector_id,
      failureReason: null,
      knownGaps: [],
      recordsEmitted: 0,
      reportedRecordsEmitted: null,
      runId: null,
      source: { id: manifest.connector_id, kind: "connector" },
      startedAt: new Date(startedAtMs).toISOString(),
      status: "failed",
      terminalReason: null,
      traceId: null,
    });
  }

  const markerBase: Omit<SchedulerRunHistoryRecord, "error"> = {
    attempt: 0,
    checkpointSummary: null,
    completedAt: new Date(recentEpochMs + 30_000).toISOString(),
    connectorError: null,
    connectorId: manifest.connector_id,
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: manifest.connector_id, kind: "connector" },
    startedAt: new Date(recentEpochMs + 30_000).toISOString(),
    status: "skipped",
    terminalReason: null,
    traceId: null,
  };
  historyRecords.push({
    ...markerBase,
    error:
      'schedule.back_off.started: {"reason_class":"connector:reddit_login_unexpected_ui","consecutive_failures":20,"next_attempt_at":"2026-05-16T00:00:00.000Z"}',
  });
  historyRecords.push({
    ...markerBase,
    error:
      'schedule.gave_up: {"reason_class":"connector:reddit_login_unexpected_ui","final_consecutive_failures":20,"last_success_at":null}',
  });

  try {
    const registerResp = await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);

    const ownerToken = await issueOwnerToken(asUrl, "scheduler_backoff_restart_noise_user");
    const scheduler = createScheduler({
      admitRunConnection: fakeAdmitRunConnection(),
      connectors: [
        {
          connectorId: manifest.connector_id,
          connectorInstanceId: manifest.connector_id,
          connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
          intervalMs: 25,
          manifest,
          maxRetries: 0,
          ownerSubjectId: "scheduler_backoff_restart_noise_user",
          ownerToken,
        },
      ],
      getState: async () => null,
      onInteraction: async (interaction: unknown) => cancelledInteractionResponse(interaction),
      onRunComplete: (record) => completedRuns.push(record),
      readinessChecker: async () => ({ ready: false, reason: "simulated unattended gate" }),
      rsUrl,
      schedulerStore: {
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        appendRunHistory: async (record: SchedulerRunHistoryRecord) => {
          appendedHistory.push(record);
        },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        deleteActiveRun: async () => {},
        listLastRunTimes: async () => [],
        listRunHistory: async () => historyRecords,
        upsertActiveRun: async () => true,
        // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
        upsertLastRunTime: async () => {},
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      setState: async () => {},
    });

    scheduler.start();
    await waitFor(() => scheduler.getHistory().length >= historyRecords.length, 5000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    scheduler.stop();

    assert.equal(
      completedRuns.some((r) => r.error?.startsWith("scheduler_backoff_applied:")),
      false,
      "restart should not emit a duplicate backoff skip when the persisted streak already has a marker"
    );
    assert.equal(
      completedRuns.some((r) => r.error?.startsWith("schedule.back_off.started:")),
      false,
      "restart should not emit a duplicate back_off.started marker"
    );
    assert.equal(
      completedRuns.some((r) => r.error?.startsWith("schedule.gave_up:")),
      false,
      "restart should not emit a duplicate gave_up marker"
    );
    assert.equal(appendedHistory.length, 0);
  } finally {
    await closeServer(server);
  }
});
