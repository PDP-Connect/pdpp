// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Controller integration tests for the browser-surface readiness gate.
 *
 * Proves: when a connector is about to launch with a managed browser
 * surface, the controller invokes the readiness probe BEFORE the
 * connector child is spawned. On probe failure the controller:
 *
 *   - emits `run.browser_surface_probe_failed` with a typed probe code,
 *   - releases the lease,
 *   - returns `status: "surface_failed"` from `runNow`,
 *   - DOES NOT call runConnectorImpl,
 *
 * so the human is never asked for an OTP against a dead CDP target.
 *
 * On probe success the controller:
 *
 *   - emits `run.browser_surface_ready`,
 *   - proceeds to spawn the connector,
 *   - the connector child receives the browser-surface env block.
 *
 * Uses the same fake lease manager + allocator that the existing
 * controller-browser-surface-leases tests use; the probe is mocked
 * directly so no real DevTools server is involved.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  type EnsureBrowserSurfaceRequest,
  type StopBrowserSurfaceRequest,
  // biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
} from "@opendatalabs/remote-surface/leases";
import { createTraceContext, emitSpineEvent } from "../lib/spine.ts";
import { createBrowserSurfaceManager } from "../runtime/browser-surface/run-coordinator.ts";
import type { BrowserSurfaceReadinessProbe } from "../runtime/browser-surface-readiness.ts";
import type { RunNowOptions } from "../runtime/controller.ts";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import type { BrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import { getDefaultBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";
import type { ActiveRunRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const REGEXP_FIXTURE_ADMISSION_REJECTED = /fixture admission rejected/;
const REGEXP_LEAKED_SECRET = /secret-token-xyz/;
const REGEXP_LEAKED_BEARER = /Bearer/;
const REGEXP_LEAKED_STACK_TRACE = /\.ts:\d+|at Object|at async/;
const REGEXP_LEAKED_NON_ALLOWLISTED_FIELD = /surfaceIdSeen/;

const MANIFEST = {
  capabilities: {
    browser_surface: {
      profile_key: "managed-profile",
    },
  },
  connector_id: "managed",
  name: "Managed",
  streams: [],
  version: "1.0.0",
};

// Maps each fixture connection id to the one owner that actually holds it.
// Mirrors the production store's owner-scoping (connector_instance_owner_mismatch):
// admission must reject a claim from any subject other than the id's real
// owner, not merely check connectorId/connectorInstanceId membership.
const FIXTURE_CONNECTION_OWNERS: Readonly<Record<string, string>> = {
  cin_managed_fixture: "owner_local",
  "live-instance-from-memory": "owner_local",
  managed: "owner_local",
  "other-managed-instance-2": "owner_local",
  "owner-bob-instance": "owner_bob",
};

function admitManagedFixtureRun({
  connectorId,
  connectorInstanceId,
  ownerSubjectId,
}: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId?: string | null;
}) {
  const exactId = connectorInstanceId ?? "managed";
  const requestedOwnerSubjectId = ownerSubjectId || "owner_local";
  const actualOwnerSubjectId = FIXTURE_CONNECTION_OWNERS[exactId];
  if (connectorId !== "managed" || !actualOwnerSubjectId) {
    throw new Error(`fixture admission rejected ${connectorId}/${exactId}`);
  }
  if (actualOwnerSubjectId !== requestedOwnerSubjectId) {
    throw new Error(
      `fixture admission rejected: connection '${exactId}' belongs to '${actualOwnerSubjectId}', not '${requestedOwnerSubjectId}'`
    );
  }
  return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId: actualOwnerSubjectId });
}

function tempDbPath() {
  return makeTemporaryDbPath("pdpp-controller-rdy-");
}

function createSchedulerStore(): SchedulerStore {
  const activeRuns = new Map<string, ActiveRunRecord>();
  return {
    appendRunHistory: () => undefined,
    createSchedule: () => undefined,
    deleteActiveRun: (_connectorId, runId) => {
      activeRuns.delete(runId);
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
      activeRuns.set(record.run_id, record);
      return true;
    },
    upsertLastRunTime: () => undefined,
  };
}

function createManagerWithReadySurface(
  surfaceOverrides: Partial<BrowserSurface> & { browser_generation_hash?: string; container_id?: string } = {}
) {
  let leaseSeq = 0;
  let tokenSeq = 0;
  const manager = new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      staticCdpHttpUrl: "http://127.0.0.1:9222",
      staticProfileKey: "managed-profile",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      surfaceCap: 1,
      surfaceMode: "static",
    },
    initialSurfaces: [
      {
        backend: "neko",
        cdp_url: "http://127.0.0.1:9222",
        connector_id: "managed",
        created_at: "2026-05-12T11:00:00.000Z",
        health: "ready",
        last_used_at: "2026-05-12T11:00:00.000Z",
        profile_key: "managed-profile",
        stream_base_url: "http://127.0.0.1:8080",
        surface_id: "surface_static",
      },
    ],
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_${leaseSeq}`;
    },
    makeSurfaceId: () => "surface_static",
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
  });
  if (Object.keys(surfaceOverrides).length > 0) {
    const getSurface = manager.getSurface.bind(manager);
    manager.getSurface = (surfaceId: string) => {
      const surface = getSurface(surfaceId);
      return surface ? { ...surface, ...surfaceOverrides } : surface;
    };
  }
  return manager;
}

function createDynamicManagerWithReadySurface({
  initialActiveLease = false,
  noInitialSurface = false,
  runId = "run_dynamic_1",
}: {
  initialActiveLease?: boolean;
  noInitialSurface?: boolean;
  runId?: string;
} = {}) {
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode: "dynamic",
    },
    initialSurfaces: noInitialSurface
      ? []
      : [
          {
            backend: "neko",
            cdp_url: "http://stale:9223",
            connector_id: "managed",
            created_at: "2026-05-12T11:00:00.000Z",
            health: "ready",
            last_used_at: "2026-05-12T11:00:00.000Z",
            profile_key: "managed-profile",
            stream_base_url: "http://stale:8080",
            surface_id: "surface_stale",
            ...(initialActiveLease ? { active_lease_id: "lease_dynamic_1" } : {}),
          },
        ],
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_${leaseSeq}`;
    },
    makeSurfaceId: () => {
      surfaceSeq += 1;
      return `surface_dynamic_${surfaceSeq}`;
    },
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    ...(initialActiveLease
      ? {
          initialLeases: [
            {
              connector_id: "managed",
              expires_at: "2026-05-12T13:00:00.000Z",
              fencing_token: 1,
              lease_id: "lease_dynamic_1",
              leased_at: "2026-05-12T11:00:01.000Z",
              priority_class: "background" as const,
              profile_key: "managed-profile",
              requested_at: "2026-05-12T11:00:00.000Z",
              run_id: runId,
              status: "leased" as const,
              surface_id: "surface_stale",
            },
          ],
        }
      : {}),
  });
}

function createReadyDynamicAllocator(initialSurfaces: readonly BrowserSurface[] = []) {
  const surfaces = new Map<string, BrowserSurface>(initialSurfaces.map((surface) => [surface.surface_id, surface]));
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const allocator: BrowserSurfaceAllocator = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    ensureSurface: async (request) => {
      ensureRequests.push(request);
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
        ...(request.surfaceSubjectId ? { surface_subject_id: request.surfaceSubjectId } : {}),
      };
      surfaces.set(request.surfaceId, surface);
      return surface;
    },
    getSurfaceStatus: async (surfaceId) => surfaces.get(surfaceId) ?? null,
    listSurfaces: async () => [...surfaces.values()],
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    stopSurface: async (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return surface ? { ...surface, health: "stopping" } : null;
    },
  };
  return { allocator, ensureRequests, stopRequests };
}

interface SetupOptions {
  browserSurfaceAllocator?: BrowserSurfaceAllocator;
  browserSurfaceLeaseStore?: BrowserSurfaceLeaseStore;
  browserSurfaceStartingPollRetryAttempts?: number;
  browserSurfaceStartingPollRetryDelayMs?: number;
  leaseManager?: BrowserSurfaceLeaseManager;
  onWarn?: (message: string) => void;
  probe?: BrowserSurfaceReadinessProbe;
  runConnectorImpl?: (
    opts: RuntimeRunConnectorOptions
  ) => RuntimeRunConnectorResult | Promise<RuntimeRunConnectorResult>;
}

function setup(
  t: TestContext,
  {
    browserSurfaceAllocator,
    browserSurfaceLeaseStore,
    browserSurfaceStartingPollRetryAttempts,
    browserSurfaceStartingPollRetryDelayMs,
    onWarn,
    probe,
    leaseManager,
    runConnectorImpl,
  }: SetupOptions = {}
) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const runConnectorCalls: RuntimeRunConnectorOptions[] = [];
  const controller = createController({
    admitRunConnection: admitManagedFixtureRun,
    ...(browserSurfaceAllocator ? { browserSurfaceAllocator } : {}),
    ...(browserSurfaceLeaseStore ? { browserSurfaceLeaseStore } : {}),
    ...(browserSurfaceStartingPollRetryAttempts === undefined ? {} : { browserSurfaceStartingPollRetryAttempts }),
    ...(browserSurfaceStartingPollRetryDelayMs === undefined ? {} : { browserSurfaceStartingPollRetryDelayMs }),
    browserSurfaceLeaseManager: leaseManager || createManagerWithReadySurface(),
    ...(probe ? { browserSurfaceReadinessProbe: probe } : {}),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: onWarn ?? (() => undefined) },
    resolveOwnerSubjectIdForConnectorInstance: async (connectorInstanceId) =>
      FIXTURE_CONNECTION_OWNERS[connectorInstanceId] ?? null,
    runConnectorImpl: async (opts) => {
      runConnectorCalls.push(opts);
      if (runConnectorImpl) {
        return await runConnectorImpl(opts);
      }
      return {
        checkpoint_summary: null,
        records_emitted: 0,
        state: null,
        status: "succeeded",
      };
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
    },
  });
  return { controller, runConnectorCalls };
}

const SESSION_CLOSED_MESSAGE =
  "could not open browser profile: attach-session race exhausted its retry budget: Protocol error (Network.setCacheDisabled): Internal server error, session closed.";

// The connector-runtime source boundary
// (packages/polyfill-connectors/src/browser-launch.ts's
// connectOverCdpWithRetry) is the ONLY place that classifies the narrow
// attach-session race. It tags an exhausted-retry-budget failure with a
// stable `connector_error.code`, carried unmodified through
// `DONE.error.code` -> `connector_error.code`. The reference-implementation
// controller consumes ONLY this typed code — it never re-parses
// connector_error.message itself. These fixtures build the connector_error
// shape the real source boundary produces so the tests exercise the
// controller's typed-consumer contract, not a re-implementation of the
// classifier.
const BROWSER_SURFACE_ATTACH_EXHAUSTED_CODE = "browser_surface_attach_exhausted";

function attachExhaustedConnectorError() {
  return { code: BROWSER_SURFACE_ATTACH_EXHAUSTED_CODE, message: SESSION_CLOSED_MESSAGE, retryable: true };
}

function ordinaryRetryableConnectorError() {
  // Same exact error text as the attach-exhausted shape, but WITHOUT the
  // typed code — simulates a connector that classified the failure as
  // retryable for a different reason, or an older connector build that
  // predates this code. The controller must key off the typed code, not
  // off the message text, so this must NOT trigger surface recycling.
  return { message: SESSION_CLOSED_MESSAGE, retryable: true };
}

interface RunEventRow {
  data_json: string | null;
  event_type: string;
  status: string;
}

function listRunEvents(runId: string) {
  return (
    getDb()
      .prepare("SELECT event_type, status, data_json FROM spine_events WHERE run_id = ? ORDER BY event_seq")
      .all(runId) as RunEventRow[]
  ).map((row) => ({
    data: row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : null,
    event_type: row.event_type,
    status: row.status,
  }));
}

/** Asserts index i exists and returns it typed — avoids noUncheckedIndexedAccess churn on array[i] throughout this file. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item, `expected an element at index ${index}`);
  return item;
}

interface BrowserSurfaceProbeEventData {
  readonly browser_surface_probe: {
    readonly ok: boolean;
    readonly page_target_count?: number;
    readonly browser_version?: string;
    readonly browser_generation_hash?: string;
    readonly code: string;
    readonly detail: string;
  };
  readonly interaction_id?: string;
  readonly kind?: string;
}

/** Reads the (unknown) `data` payload of a listRunEvents() row as the browser-surface-probe event shape. */
function probeEventData(data: Record<string, unknown> | null): BrowserSurfaceProbeEventData {
  assert.ok(data);
  return data as unknown as BrowserSurfaceProbeEventData;
}

test("readiness probe success: connector spawned with surface env and run.browser_surface_ready emitted", async (t) => {
  const probeCalls: BrowserSurface[] = [];
  const probe: BrowserSurfaceReadinessProbe = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    probe: async (surface) => {
      probeCalls.push(surface);
      return { browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 };
    },
  };
  const { controller, runConnectorCalls } = setup(t, { probe });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_ok",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(probeCalls.length, 1);
  assert.equal(at(probeCalls, 0).health, "ready");
  assert.equal(at(probeCalls, 0).cdp_url, "http://127.0.0.1:9222");
  assert.equal(runConnectorCalls.length, 1);

  const surfaceEnv = at(runConnectorCalls, 0).browserSurfaceEnv;
  assert.ok(surfaceEnv);
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REQUIRED, "neko");
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, "http://127.0.0.1:9222");

  const events = listRunEvents("run_ok").map((e) => e.event_type);
  assert.ok(events.includes("run.browser_surface_ready"), `events were: ${events.join(",")}`);
  const ready = listRunEvents("run_ok").find((e) => e.event_type === "run.browser_surface_ready");
  assert.ok(ready);
  const readyData = probeEventData(ready.data);
  assert.equal(readyData.browser_surface_probe.ok, true);
  assert.equal(readyData.browser_surface_probe.page_target_count, 1);
  assert.equal(readyData.browser_surface_probe.browser_version, "Chrome/124.0");
});

test("admission rejects a claim for another owner's connection, even with a valid connector/instance id", async (t) => {
  const { controller, runConnectorCalls } = setup(t);

  // "owner-bob-instance" is a real fixture connection, but it belongs to
  // owner_bob (see FIXTURE_CONNECTION_OWNERS) — the default-owner caller here
  // must be refused, not silently admitted onto someone else's connection.
  await assert.rejects(
    () =>
      controller.runNow("managed", {
        connectorInstanceId: "owner-bob-instance",
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_cross_owner_denied",
      }),
    REGEXP_FIXTURE_ADMISSION_REJECTED
  );
  assert.equal(runConnectorCalls.length, 0, "the connector child must never spawn for a denied cross-owner claim");
});

test("static managed readiness defaults the durable replacement store without an allocator", async (t) => {
  const leaseStore = createSqliteBrowserSurfaceLeaseStore();
  let resolveRun!: (value: RuntimeRunConnectorResult) => void;
  const runDone = new Promise<RuntimeRunConnectorResult>((resolve) => {
    resolveRun = resolve;
  });
  const leaseManager = createManagerWithReadySurface({
    browser_generation_hash: "a".repeat(64),
    container_id: "static-container",
  });
  const upsertSurface = leaseStore.upsertSurface.bind(leaseStore);
  leaseStore.upsertSurface = (surface) =>
    upsertSurface({
      ...surface,
      browser_generation_hash: surface.browser_generation_hash ?? "a".repeat(64),
      container_id: surface.container_id ?? "static-container",
    });
  const { controller } = setup(t, {
    browserSurfaceLeaseStore: leaseStore,
    leaseManager,
    probe: {
      probe: async () => ({
        browserGenerationHash: "b".repeat(64),
        ok: true,
        pageTargetCount: 1,
      }),
    },
    runConnectorImpl: () => runDone,
  });
  await leaseStore.upsertSurface({
    backend: "neko",
    browser_generation_hash: "a".repeat(64),
    cdp_url: "http://127.0.0.1:9222",
    connector_id: "managed",
    container_id: "static-container",
    created_at: "2026-05-12T11:00:00.000Z",
    health: "ready",
    last_used_at: "2026-05-12T11:00:00.000Z",
    profile_key: "managed-profile",
    stream_base_url: "http://127.0.0.1:8080",
    surface_id: "neko-static",
  });
  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_static_generation",
  });
  const receipts = await getDefaultBrowserSurfaceReplacementReceiptStore().list();
  assert.deepEqual(
    receipts.filter((receipt) => receipt.surface_id === "neko-static").map((receipt) => receipt.phase),
    ["started", "completed"]
  );
  assert.equal(
    receipts.find((receipt) => receipt.surface_id === "neko-static" && receipt.phase === "completed")?.cause,
    "same_container_browser_generation_change"
  );
  const surfaceAfter = await leaseStore.getSurface("neko-static");
  assert.ok(surfaceAfter);
  assert.equal(surfaceAfter.browser_generation_hash, "b".repeat(64));
  resolveRun({ checkpoint_summary: null, records_emitted: 0, state: null, status: "succeeded" });
  await controller.drainActiveRuns(1000);
});

test("readiness probe failure: missing leased surface is typed and does not spawn connector", async (t) => {
  const leaseManager = createManagerWithReadySurface();
  leaseManager.getSurface = () => undefined;
  const { controller, runConnectorCalls } = setup(t, {
    leaseManager,
    probe: {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      probe: async () => {
        throw new Error("probe should not be called without a surface");
      },
    },
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_missing_surface",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "surface_failed");
  assert.equal(runConnectorCalls.length, 0);
  const probeEvent = listRunEvents("run_missing_surface").find(
    (e) => e.event_type === "run.browser_surface_probe_failed"
  );
  assert.ok(probeEvent);
  assert.equal(probeEventData(probeEvent.data).browser_surface_probe.code, "browser_surface_not_ready");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(probeEventData(probeEvent.data).browser_surface_probe.detail, /missing surface/);
});

test("readiness probe failure: surface_failed returned, connector NOT spawned, typed event emitted, lease released", async (t) => {
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => ({
      code: "browser_surface_cdp_disconnected",
      detail: "GET http://127.0.0.1:9222/json/version returned HTTP 503",
      ok: false as const,
    }),
  };
  const { controller, runConnectorCalls } = setup(t, { probe });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dead_cdp",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "surface_failed");
  assert.equal(runConnectorCalls.length, 0, "connector must NOT be spawned when probe fails");

  const events = listRunEvents("run_dead_cdp");
  const probeEvent = events.find((e) => e.event_type === "run.browser_surface_probe_failed");
  assert.ok(probeEvent, `expected probe-failed event; got: ${events.map((e) => e.event_type).join(",")}`);
  assert.equal(probeEvent.status, "surface_failed");
  assert.equal(probeEventData(probeEvent.data).browser_surface_probe.ok, false);
  assert.equal(probeEventData(probeEvent.data).browser_surface_probe.code, "browser_surface_cdp_disconnected");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(probeEventData(probeEvent.data).browser_surface_probe.detail, /HTTP 503/);

  // Lease must be released so a follow-up run can acquire a new surface.
  const releaseEvent = events.find((e) => e.event_type === "run.browser_surface_released");
  assert.ok(releaseEvent, "lease must be released after probe failure");
});

test("probe that throws is mapped to browser_surface_cdp_unreachable rather than crashing the run", async (t) => {
  const probe: BrowserSurfaceReadinessProbe = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    probe: async () => {
      throw new Error("kernel said no");
    },
  };
  const { controller, runConnectorCalls } = setup(t, { probe });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_throw",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "surface_failed");
  assert.equal(runConnectorCalls.length, 0);

  const events = listRunEvents("run_throw");
  const probeEvent = events.find((e) => e.event_type === "run.browser_surface_probe_failed");
  assert.ok(probeEvent);
  assert.equal(probeEventData(probeEvent.data).browser_surface_probe.code, "browser_surface_cdp_unreachable");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(probeEventData(probeEvent.data).browser_surface_probe.detail, /kernel said no/);
});

test("readiness probe failure evicts the stale in-memory surface so the next acquire cannot relay-fail", async (t) => {
  // Construction guarantee: when a probe says the leased surface is dead, the
  // lease manager must not keep that surface in memory with `health: ready`
  // and hand it to the next acquire. Otherwise we burn another OTP cycle
  // against the same dead CDP socket. This regression is the exact failure
  // mode observed in run_1779900509276 against USAA.
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => ({
      code: "browser_surface_cdp_unreachable",
      detail: "GET http://stale:9223/json/version failed: fetch failed",
      ok: false as const,
    }),
  };
  const leaseManager = createManagerWithReadySurface();
  const { controller, runConnectorCalls } = setup(t, { leaseManager, probe });

  // First run trips the probe.
  const first = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(first.status, "surface_failed");
  assert.equal(runConnectorCalls.length, 0);
  // The stale in-memory surface must be evicted, NOT left around with
  // health=ready.
  assert.equal(leaseManager.getSurface("surface_static"), undefined);
});

test("readiness probe failure calls allocator.stopSurface(reason: surface_failed) so the dynamic container is reset", async (t) => {
  // Construction guarantee: when a dynamic allocator is configured and the
  // readiness probe says the leased dynamic surface is dead, the controller
  // must tell the allocator to stop/remove the underlying container. Without
  // this, the next acquire's ensureSurface() finds an exited container and
  // either fails to start it or hands back another dead CDP URL.
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => ({
      code: "browser_surface_cdp_unreachable",
      detail: "GET http://dynamic-stale:9223/json/version failed: fetch failed",
      ok: false as const,
    }),
  };
  const leaseManager = createManagerWithReadySurface();
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async () => ({
      backend: "neko",
      cdp_url: "http://127.0.0.1:9222",
      connector_id: "managed",
      created_at: "2026-05-12T11:00:00.000Z",
      health: "ready",
      last_used_at: "2026-05-12T11:00:00.000Z",
      profile_key: "managed-profile",
      stream_base_url: "http://127.0.0.1:8080",
      surface_id: "surface_static",
    }),
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [],
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    stopSurface: async (request) => {
      stopRequests.push(request);
      return null;
    },
  };
  setup(t, { leaseManager, probe });
  // Setup the controller with the allocator wired up. We have to do this by
  // re-instantiating since setup() doesn't expose allocator. Instead, force
  // controller wiring via the existing createController interface.
  // Use the createController seam: tests in this file go through setup(); we
  // build a new controller specifically threaded with the allocator.
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const otherCalls: RuntimeRunConnectorOptions[] = [];
  const c2 = createController({
    admitRunConnection: admitManagedFixtureRun,
    browserSurfaceAllocator: allocator,
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceReadinessProbe: probe,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => undefined, warn: () => undefined },
    resolveOwnerSubjectIdForConnectorInstance: async (connectorInstanceId) =>
      FIXTURE_CONNECTION_OWNERS[connectorInstanceId] ?? null,
    runConnectorImpl: (opts) => {
      otherCalls.push(opts);
      return Promise.resolve({
        checkpoint_summary: null,
        records_emitted: 0,
        state: null,
        status: "succeeded" as const,
      });
    },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      clearNonce: () => undefined,
      registerNonce: () => undefined,
    },
  });

  const result = await c2.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_with_allocator",
  });
  await c2.drainActiveRuns(1000);

  assert.equal(result.status, "surface_failed");
  assert.equal(otherCalls.length, 0, "connector must NOT spawn after probe failure");
  assert.equal(stopRequests.length, 1, "allocator.stopSurface must be called once after probe failure");
  assert.equal(at(stopRequests, 0).surfaceId, "neko-static");
  assert.equal(
    at(stopRequests, 0).reason,
    "surface_failed",
    "stop reason must be 'surface_failed' so the allocator removes the dead container"
  );
});

test("readiness probe failure on a stale dynamic surface reacquires once and launches on the fresh surface", async (t) => {
  const probeCalls: BrowserSurface[] = [];
  const probe: BrowserSurfaceReadinessProbe = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    probe: async (surface) => {
      probeCalls.push(surface);
      if (surface.surface_id === "surface_stale") {
        return {
          code: "browser_surface_cdp_unreachable",
          detail: "GET http://stale:9223/json/version failed: fetch failed",
          ok: false as const,
        };
      }
      return { browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 };
    },
  };
  const leaseManager = createDynamicManagerWithReadySurface();
  const { allocator, stopRequests } = createReadyDynamicAllocator();
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    leaseManager,
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dynamic_reacquire",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(probeCalls.length, 2);
  assert.equal(at(probeCalls, 0).surface_id, "surface_stale");
  assert.equal(at(probeCalls, 1).surface_id, "surface_dynamic_1");
  assert.equal(stopRequests.length, 1);
  assert.equal(at(stopRequests, 0).surfaceId, "surface_stale");
  assert.equal(at(stopRequests, 0).reason, "surface_failed");
  assert.equal(runConnectorCalls.length, 1);
  const surfaceEnv = at(runConnectorCalls, 0).browserSurfaceEnv;
  assert.ok(surfaceEnv);
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, "http://surface_dynamic_1:9223");

  const events = listRunEvents("run_dynamic_reacquire").map((e) => e.event_type);
  assert.equal(events.filter((event) => event === "run.browser_surface_requested").length, 2);
  assert.equal(events.filter((event) => event === "run.browser_surface_leased").length, 2);
  assert.equal(events.filter((event) => event === "run.browser_surface_probe_failed").length, 1);
  assert.equal(events.filter((event) => event === "run.browser_surface_ready").length, 1);
});

/**
 * Reproduces the 2026-07-31 live Amazon Personal canary
 * (run_1785535443538, superseding the 2026-07-31 USAA incident this test
 * previously modeled): an interactive run's browser-surface acquire calls
 * the allocator's ensureSurface/getSurfaceStatus while the lease is in
 * `starting_surface`, and that call throws (Docker daemon hiccup, transient
 * allocator timeout, etc). The live incident proved this is frequently a
 * PURE POLL HICCUP, not real container death: the exact surface minted by
 * the failing attempt went on to become healthy moments later. The fix is a
 * bounded in-place retry of the allocator call AGAINST THE SAME surface_id
 * (wrapAllocatorWithTransientPollRetry, run-coordinator.ts) — no new
 * container is minted, no capacity is spent twice, and the outer
 * reacquire-once path (handleStartingSurfaceWaitForRun's
 * remainingStartFailureRetries-free single retry, unchanged) is never even
 * reached for a merely-transient hiccup.
 */
test("starting-surface transient allocator hiccup retries in place against the SAME surface_id, never mints a replacement", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureRequests.push(request);
      ensureCalls += 1;
      if (ensureCalls === 1) {
        throw new Error("Docker POST /containers/create failed: connect ECONNREFUSED");
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return await Promise.resolve(surface ? { ...surface, health: "stopping" } : null);
    },
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_start_failed_reacquire",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started", "the in-place poll retry recovers within the same interactive run");
  assert.equal(ensureCalls, 2, "first ensureSurface call throws, the in-place retry's second call succeeds");
  assert.equal(at(ensureRequests, 0).surfaceId, "surface_dynamic_1");
  assert.equal(
    at(ensureRequests, 1).surfaceId,
    "surface_dynamic_1",
    "the in-place retry targets the SAME surface_id — it must never mint a replacement for a transient hiccup"
  );
  assert.equal(runConnectorCalls.length, 1);
  const surfaceEnv = at(runConnectorCalls, 0).browserSurfaceEnv;
  assert.ok(surfaceEnv);
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, "http://surface_dynamic_1:9223");
  assert.equal(stopRequests.length, 0, "an in-place poll retry never stops/discards the surface it is retrying");

  const events = listRunEvents("run_start_failed_reacquire").map((e) => e.event_type);
  assert.equal(
    events.filter((event) => event === "run.browser_surface_requested").length,
    1,
    "exactly one acquire — the in-place retry does not re-enter the outer acquire pipeline"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_failed").length,
    0,
    "a transient hiccup absorbed in place must never emit the terminal event"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_retried").length,
    0,
    "the non-terminal sibling event is reserved for the OUTER reacquire path (a confirmed-dead surface), not an in-place poll retry"
  );
  assert.ok(
    events.filter((event) => event === "run.browser_surface_ready").length >= 1,
    "the same surface reaches readiness after the in-place retry"
  );
});

/**
 * wrapAllocatorWithTransientPollRetry wraps BOTH ensureSurface AND
 * getSurfaceStatus (run-coordinator.ts) — remote-surface's
 * ensureStartingSurfaceReady calls getSurfaceStatus in the same try block
 * immediately after a successful ensureSurface, and a throw there hits the
 * IDENTICAL bare catch{} that collapses to surface_failed/
 * surface_start_failed. The previous test only ever throws from
 * ensureSurface; deleting the getSurfaceStatus retry wrapping would leave
 * that test green while silently reintroducing the exact live-incident
 * failure mode for this second call site. This test throws ONLY from
 * getSurfaceStatus's POST-ENSURE poll call (the package's own call site at
 * ensureStartingSurfaceReady's `const status = await
 * request.allocator.getSurfaceStatus(...)`) to prove that call site is
 * independently covered.
 *
 * Two nested getSurfaceStatus call sites exist and must be told apart: the
 * OBSERVED allocator (replacementAwareAllocator, createReplacementObservingAllocator
 * in replacement-observing-allocator.ts) ALSO calls getSurfaceStatus as a
 * pre-flight "before" snapshot inside its own ensureSurface wrapper, before
 * delegating to the real ensureSurface — that pre-flight call happens before
 * this surface has ever been ensured (its container_id is unset), while the
 * package's own post-ensure poll call happens only after ensureSurface
 * already returned a surface WITH a container_id. Keying the mock's
 * throw/succeed branch on `surfaces.get(surfaceId)?.container_id` isolates
 * the package's call site from the unrelated observation-layer call site.
 */
test("starting-surface transient getSurfaceStatus hiccup retries in place against the SAME surface_id, never mints a replacement", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  let postEnsureStatusCalls = 0;
  const postEnsureStatusRequests: string[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureCalls += 1;
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        container_id: `container_${request.surfaceId}`,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "starting",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => {
      const existing = surfaces.get(surfaceId);
      if (!existing?.container_id) {
        // The replacement-observing allocator's pre-flight "before" snapshot,
        // called before ensureSurface has ever run for this surface_id.
        // Unrelated to the retry under test — must always succeed cleanly.
        return await Promise.resolve(existing ?? null);
      }
      // The package's own post-ensure poll call (ensureStartingSurfaceReady's
      // `const status = await request.allocator.getSurfaceStatus(...)`).
      postEnsureStatusRequests.push(surfaceId);
      postEnsureStatusCalls += 1;
      if (postEnsureStatusCalls === 1) {
        throw new Error("GET http://surface_dynamic_1:9223/json/version failed: fetch failed");
      }
      const ready = { ...existing, health: "ready" as const };
      surfaces.set(surfaceId, ready);
      return await Promise.resolve(ready);
    },
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return await Promise.resolve(surface ? { ...surface, health: "stopping" } : null);
    },
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_start_failed_status_reacquire",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started", "the in-place poll retry recovers within the same interactive run");
  assert.equal(
    ensureCalls,
    1,
    "ensureSurface itself never throws in this scenario — only the post-ensure getSurfaceStatus poll does"
  );
  assert.equal(
    postEnsureStatusCalls,
    2,
    "first post-ensure getSurfaceStatus call throws, the in-place retry's second call succeeds"
  );
  assert.equal(at(postEnsureStatusRequests, 0), "surface_dynamic_1");
  assert.equal(
    at(postEnsureStatusRequests, 1),
    "surface_dynamic_1",
    "the in-place retry targets the SAME surface_id — it must never mint a replacement for a transient hiccup"
  );
  assert.equal(runConnectorCalls.length, 1);
  const surfaceEnv = at(runConnectorCalls, 0).browserSurfaceEnv;
  assert.ok(surfaceEnv);
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, "http://surface_dynamic_1:9223");
  assert.equal(stopRequests.length, 0, "an in-place poll retry never stops/discards the surface it is retrying");

  const events = listRunEvents("run_start_failed_status_reacquire").map((e) => e.event_type);
  assert.equal(
    events.filter((event) => event === "run.browser_surface_requested").length,
    1,
    "exactly one acquire — the in-place retry does not re-enter the outer acquire pipeline"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_failed").length,
    0,
    "a transient getSurfaceStatus hiccup absorbed in place must never emit the terminal event"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_retried").length,
    0,
    "the non-terminal sibling event is reserved for the OUTER reacquire path (a confirmed-dead surface), not an in-place poll retry"
  );
});

/**
 * Fail-closed boundary for the getSurfaceStatus call site specifically
 * (mirroring the persistent-ensureSurface-failure test above): a
 * persistently throwing post-ensure getSurfaceStatus poll must still
 * exhaust the in-place poll-retry budget and fail closed via the
 * pre-existing outer reacquire-once path, never loop, never paper over
 * real death. Uses the same container_id-gated mock shape as the
 * transient-recovery test above to isolate the package's post-ensure poll
 * call site from the replacement-observing allocator's unrelated
 * pre-flight snapshot call.
 */
test("starting-surface getSurfaceStatus failure on every post-ensure poll (in-place AND the outer reacquire) still fails closed, not an infinite loop", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  let postEnsureStatusCalls = 0;
  const surfaces = new Map<string, BrowserSurface>();
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureCalls += 1;
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        container_id: `container_${request.surfaceId}`,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "starting",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => {
      const existing = surfaces.get(surfaceId);
      if (!existing?.container_id) {
        return await Promise.resolve(existing ?? null);
      }
      postEnsureStatusCalls += 1;
      throw new Error(`GET http://${surfaceId}:9223/json/version failed: fetch failed`);
    },
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async (request) => {
      stopRequests.push(request);
      return await Promise.resolve(null);
    },
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_start_failed_status_persistent",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(
    result.status,
    "surface_failed",
    "a persistently broken post-ensure getSurfaceStatus poll still fails closed, not an infinite loop"
  );
  assert.equal(
    ensureCalls,
    2,
    "ensureSurface succeeds once per outer acquire attempt (initial + 1 reacquire) — it is not the failing call, and the poll loop only re-enters ensureStartingSurfaceReady while status stays starting_surface, not once per in-place status retry"
  );
  assert.equal(
    postEnsureStatusCalls,
    7,
    "3 in-place poll attempts against the post-ensure getSurfaceStatus call per surface (default browserSurfaceStartingPollRetryAttempts=3), across the 2 outer acquire attempts, plus 1 extra getSurfaceStatus 'before' snapshot taken when the outer reacquire stops the first surface's abandoned container before minting a replacement — bounded, never unbounded"
  );
  assert.equal(runConnectorCalls.length, 0, "connector is never spawned when the surface never reaches ready");
  // This mock's getSurfaceStatus throws unconditionally for any surface with
  // a container_id — including the replacement-observing allocator's own
  // pre-flight "before" snapshot inside stopSurface (see
  // replacement-observing-allocator.ts's stopSurfaceWithObservation), which
  // is not itself retried. So the best-effort container-reclaim attempt
  // fails the SAME way the original readiness poll did, and is swallowed
  // (stopAllocatorSurfaceAfterProbeFailure logs a warning, does not throw)
  // rather than blocking the outer reacquire — a persistently unreachable
  // allocator cannot stop containers any more than it can poll them, and
  // that must not prevent the bounded reacquire-once path from proceeding.
  assert.equal(
    stopRequests.length,
    0,
    "a persistently broken allocator cannot service the reclaim stop either — it fails best-effort, logged, and must not block the outer reacquire"
  );

  const events = listRunEvents("run_start_failed_status_persistent").map((e) => e.event_type);
  assert.equal(
    events.filter((event) => event === "run.browser_surface_retried").length,
    1,
    "exactly one outer reacquire, only after the first surface's getSurfaceStatus is confirmed persistently broken"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_failed").length,
    1,
    "exactly one terminal failure — the bounded outer retry does not itself retry again"
  );
});

/**
 * The in-place poll retry (previous test) is bounded — it must not paper
 * over a genuinely dead surface forever. Once its budget
 * (browserSurfaceStartingPollRetryAttempts) is exhausted, the error reaches
 * remote-surface's ensureStartingSurfaceReady exactly as before this fix,
 * which terminalizes that ONE surface to surface_failed, and the pre-
 * existing, UNCHANGED outer reacquire-once path
 * (handleStartingSurfaceWaitForRun) takes over: exactly one fresh
 * acquire against a brand-new surface_id.
 */
test("starting-surface allocator failure persisting past the in-place poll-retry budget still reacquires once on a fresh surface", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureRequests.push(request);
      ensureCalls += 1;
      // The first surface_id (surface_dynamic_1) is genuinely, persistently
      // dead — every poll against it fails, exhausting the in-place retry
      // budget. The second surface_id (surface_dynamic_2, minted by the
      // OUTER reacquire) succeeds immediately.
      if (request.surfaceId === "surface_dynamic_1") {
        throw new Error(
          `Docker POST /containers/create failed: connect ECONNREFUSED (attempt for ${request.surfaceId})`
        );
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async () => await Promise.resolve(null),
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_start_failed_reacquire_after_budget",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(
    result.status,
    "started",
    "the outer reacquire-once path still recovers after the surface is confirmed dead"
  );
  assert.equal(
    ensureCalls,
    4,
    "3 in-place poll attempts against the dead surface (default browserSurfaceStartingPollRetryAttempts=3), then 1 against the fresh reacquired surface"
  );
  assert.equal(at(ensureRequests, 0).surfaceId, "surface_dynamic_1");
  assert.equal(at(ensureRequests, 1).surfaceId, "surface_dynamic_1");
  assert.equal(at(ensureRequests, 2).surfaceId, "surface_dynamic_1");
  assert.equal(
    at(ensureRequests, 3).surfaceId,
    "surface_dynamic_2",
    "only once the in-place budget is exhausted does the outer path mint a fresh surface_id"
  );
  assert.equal(runConnectorCalls.length, 1);

  const events = listRunEvents("run_start_failed_reacquire_after_budget").map((e) => e.event_type);
  assert.equal(
    events.filter((event) => event === "run.browser_surface_failed").length,
    0,
    "the run recovers on the outer reacquire, so no terminal event fires"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_retried").length,
    1,
    "exactly one outer reacquire, only after the confirmed-dead surface's in-place budget was exhausted"
  );
});

/**
 * The 2026-08-01 Amazon UAT root-cause gate: the deployed lease manager's
 * bare `catch {}` erases the exhausted allocator error's operation, HTTP
 * status, client code, category, and retryable bit into an untyped
 * `surface_start_failed`, leaving no way to distinguish a port-binding race
 * from any other non-retryable class. wrapAllocatorWithTransientPollRetry
 * must emit exactly one bounded, allowlisted warning immediately before
 * that erasure — only after the retry budget (default 3 attempts) is fully
 * exhausted, never on an earlier attempt that still has budget left.
 */
function throwingAllocatorError(overrides: Record<string, unknown> = {}) {
  const error = new Error(
    "should never appear in the warning: contains an auth header Bearer secret-token-xyz and a stack trace"
  );
  error.name = "NekoSurfaceAllocatorError";
  return Object.assign(error, {
    category: "docker_malformed_response",
    code: "docker_malformed_response",
    retryable: false,
    status: 502,
    ...overrides,
  });
}

test("exhausted ensureSurface poll retry emits exactly one allowlisted warning, only after the third failed attempt", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: (request) => {
      ensureCalls += 1;
      if (request.surfaceId === "surface_dynamic_1") {
        throw throwingAllocatorError({ surfaceIdSeen: request.surfaceId });
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async () => await Promise.resolve(null),
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const warnings: string[] = [];
  const { controller } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    onWarn: (message) => warnings.push(message),
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_instrument_ensure_exhausted",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(
    result.status,
    "started",
    "the outer reacquire recovers on a fresh surface after the dead one exhausts its budget"
  );
  assert.equal(ensureCalls, 4, "3 in-place attempts on the first dead surface, then 1 on the outer-reacquired surface");
  const instrumentationWarnings = warnings.filter((message) => message.includes("poll retry exhausted"));
  assert.equal(
    instrumentationWarnings.length,
    1,
    "exactly one record — the reacquired surface succeeds on its first try, so only the original surface's exhausted budget produces a warning; never one per attempt"
  );

  const firstWarning = at(instrumentationWarnings, 0);
  const record = JSON.parse(firstWarning.slice(firstWarning.indexOf("{")));
  assert.deepEqual(
    new Set(Object.keys(record)),
    new Set([
      "run_id",
      "lease_id",
      "surface_id",
      "operation",
      "attempts",
      "error_name",
      "code",
      "status",
      "category",
      "retryable",
    ]),
    "exact allowlist — no extra and no missing fields"
  );
  assert.equal(record.operation, "ensureSurface");
  assert.equal(record.attempts, 3, "the warning fires only once the full retry budget (3) is exhausted");
  assert.equal(record.run_id, "run_instrument_ensure_exhausted");
  assert.equal(record.category, "docker_malformed_response");
  assert.equal(record.retryable, false);
  assert.equal(record.code, "docker_malformed_response");
  assert.equal(record.status, 502);
  assert.equal(record.error_name, "NekoSurfaceAllocatorError");
  assert.ok(typeof record.lease_id === "string" && record.lease_id.length > 0);
  assert.ok(typeof record.surface_id === "string" && record.surface_id.length > 0);

  for (const message of instrumentationWarnings) {
    assert.doesNotMatch(message, REGEXP_LEAKED_SECRET, "must never leak error.message");
    assert.doesNotMatch(message, REGEXP_LEAKED_BEARER, "must never leak credentials embedded in message/stack");
    assert.doesNotMatch(message, REGEXP_LEAKED_STACK_TRACE, "must never leak a stack trace");
    assert.doesNotMatch(
      message,
      REGEXP_LEAKED_NON_ALLOWLISTED_FIELD,
      "must never leak arbitrary error fields outside the allowlist"
    );
  }
});

test("exhausted getSurfaceStatus poll retry emits exactly one allowlisted warning naming the getSurfaceStatus operation", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let postEnsureStatusCalls = 0;
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        container_id: `container_${request.surfaceId}`,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "starting",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: (surfaceId) => {
      const existing = surfaces.get(surfaceId);
      if (!existing?.container_id) {
        return Promise.resolve(existing ?? null);
      }
      postEnsureStatusCalls += 1;
      throw throwingAllocatorError({ category: "docker_http_error", code: "docker_http_error", status: 503 });
    },
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async () => await Promise.resolve(null),
  };
  const warnings: string[] = [];
  const { controller } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    onWarn: (message) => warnings.push(message),
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_instrument_status_exhausted",
  });
  await controller.drainActiveRuns(1000);

  assert.ok(postEnsureStatusCalls >= 3, "at least the first surface's 3-attempt budget was exhausted");
  const instrumentationWarnings = warnings.filter((message) => message.includes("poll retry exhausted"));
  assert.ok(instrumentationWarnings.length >= 1);
  const firstWarning = at(instrumentationWarnings, 0);
  const record = JSON.parse(firstWarning.slice(firstWarning.indexOf("{")));
  assert.equal(record.operation, "getSurfaceStatus");
  assert.equal(record.attempts, 3);
  assert.equal(record.category, "docker_http_error");
  assert.equal(record.status, 503);
});

test("successful ensureSurface (no retry needed) never emits the exhaustion warning", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  const { allocator } = createReadyDynamicAllocator();
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const warnings: string[] = [];
  const { controller } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    onWarn: (message) => warnings.push(message),
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_instrument_success_no_warn",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(
    warnings.filter((message) => message.includes("poll retry exhausted")).length,
    0,
    "a clean, non-retried success must never emit the exhaustion warning"
  );
});

test("a transient hiccup that recovers before the retry budget is exhausted never emits the exhaustion warning", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureCalls += 1;
      if (ensureCalls === 1) {
        throw throwingAllocatorError();
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async () => await Promise.resolve(null),
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const warnings: string[] = [];
  const { controller } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    onWarn: (message) => warnings.push(message),
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_instrument_transient_no_warn",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started", "recovers within the retry budget");
  assert.equal(ensureCalls, 2, "only 2 of the 3 available attempts were needed");
  assert.equal(
    warnings.filter((message) => message.includes("poll retry exhausted")).length,
    0,
    "a hiccup absorbed within budget must never emit the exhaustion warning — only exhaustion does"
  );
});

test("starting-surface allocator failure on every poll (in-place AND the outer reacquire) still fails closed, not an infinite loop", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: (request) => {
      ensureCalls += 1;
      throw new Error(`Docker POST /containers/create failed: connect ECONNREFUSED (attempt for ${request.surfaceId})`);
    },
    getSurfaceStatus: async () => await Promise.resolve(null),
    listSurfaces: async () => await Promise.resolve([]),
    stopSurface: async () => await Promise.resolve(null),
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_start_failed_persistent",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(
    result.status,
    "surface_failed",
    "a persistently broken allocator still fails closed, not an infinite loop"
  );
  assert.equal(
    ensureCalls,
    6,
    "bounded, never unbounded: 3 in-place poll attempts on surface 1 (default browserSurfaceStartingPollRetryAttempts=3), then 3 more on the reacquired surface 2 — each surface's budget exhaustion consuming exactly one of the two outer acquire attempts (initial + 1 reacquire)"
  );
  assert.equal(runConnectorCalls.length, 0, "connector is never spawned when the surface never starts");

  const events = listRunEvents("run_start_failed_persistent").map((e) => e.event_type);
  assert.equal(
    events.filter((event) => event === "run.browser_surface_retried").length,
    1,
    "the first (outer, reacquired) attempt emits the non-terminal sibling"
  );
  assert.equal(
    events.filter((event) => event === "run.browser_surface_failed").length,
    1,
    "the second (bounded, non-retried) attempt emits exactly one terminal failure"
  );
});

/**
 * Durable-layer counterpart to "starting-surface allocator failure
 * reacquires once and launches on the fresh surface": the event-stream
 * assertions above proved the SPINE projection is correct, but the gate
 * finding was that run_history's finalize (`UPDATE ... WHERE status =
 * 'running'`) LATCHES on the first terminal event for a run_id, so an
 * intermediate run.browser_surface_failed emitted before a successful retry
 * would durably record a recovered, record-producing run as
 * status='surface_failed', records_emitted=0 — even though the spine's
 * newest-status projection reports the run correctly. Only a real read of
 * the run_history table proves the durable projection was fixed, not just
 * the event stream.
 */
test("starting-surface allocator failure recovery durably records a succeeded run_history row with records, not a latched surface_failed", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface({ noInitialSurface: true });
  let ensureCalls = 0;
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureCalls += 1;
      if (ensureCalls === 1) {
        throw new Error("Docker POST /containers/create failed: connect ECONNREFUSED");
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async () => await Promise.resolve(null),
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const runId = "run_start_failed_recovers_durably";
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    leaseManager,
    probe,
    // The real runtime emits run.completed with the real records_emitted
    // once collection finishes. This fake stands in for that, matching the
    // pattern the existing attach-exhausted test already established at
    // this file's setup site. It deliberately skips run.started: that event
    // requires data.boot_epoch/data.seq (assertRunStartedIsStamped in
    // lib/spine.ts, stamped only after setCurrentBootEpoch, which this test
    // suite never calls) — the run-history writer's own documented
    // fallback-insert path (a terminal event with no prior started row
    // still lands, run-history-writer.ts) covers this without it.
    runConnectorImpl: async (opts) => {
      await emitSpineEvent({
        actor_id: opts.connectorId,
        actor_type: "runtime",
        data: { connector_instance_id: "managed", records_emitted: 42 },
        event_type: "run.completed",
        object_id: opts.runId ?? null,
        object_type: "run",
        run_id: opts.runId ?? null,
        scenario_id: opts.traceContext?.scenario_id ?? null,
        status: "succeeded",
        trace_id: opts.traceContext?.trace_id ?? "trace",
      });
      return {
        checkpoint_summary: null,
        records_emitted: 42,
        state: null,
        status: "succeeded",
      };
    },
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId,
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started", "the bounded reacquire recovers within the same interactive run");
  assert.equal(ensureCalls, 2, "first ensureSurface throws, second (fresh surface_id) succeeds");

  interface RunHistoryTestRow {
    readonly records_emitted: number;
    readonly run_id: string;
    readonly status: string;
  }
  const row = getDb().prepare("SELECT run_id, status, records_emitted FROM run_history WHERE run_id = ?").get(runId) as
    | RunHistoryTestRow
    | undefined;
  assert.ok(row, "run_history must have exactly one row for this run_id");
  assert.equal(runConnectorCalls.length, 1, "the connector runs exactly once, only after the retry recovers");
  assert.equal(
    row.status,
    "succeeded",
    `durable run_history must report the recovered run as succeeded, not latched at the retried attempt's surface_failed (got: ${row.status})`
  );
  assert.equal(
    row.records_emitted,
    42,
    `durable run_history must report the real record count, not 0 from the retried attempt's terminal write (got: ${row.records_emitted})`
  );

  const countRow = getDb().prepare("SELECT COUNT(*) AS n FROM run_history WHERE run_id = ?").get(runId) as {
    n: number;
  };
  assert.equal(
    countRow.n,
    1,
    "exactly one run_history row — the retried attempt must not have created or finalized its own row"
  );
});

/**
 * Reproduces the live 2026-07-31 Chase incident (run_1785523408084,
 * candidate 0c8d25c57): the bounded starting-surface retry never fired even
 * though PDPP_NEKO_SURFACE_MODE=dynamic and the allocator were both
 * correctly configured (confirmed against the live container's actual env
 * via parseNekoBrowserSurfaceRuntimeConfig). The live spine showed the
 * queuing request admitted as waiting_for_browser_surface with
 * wait_reason=capacity_full, then promoted straight to starting_surface
 * within the SAME acquire call (no separate run.browser_surface_queued
 * event) -- the inline capacity-pressure reclaim path
 * (reclaimWaitingLeaseIfNeeded -> tryPromoteReclaimedWaitingLease), which
 * hardcoded allowStartFailureRetry: false regardless of the caller's actual
 * retry-eligibility, unlike the direct dispatch path which threads the
 * caller's option through correctly.
 *
 * Setup: surfaceCap=1, one already-ready idle surface for a DIFFERENT
 * profile_key (so it's reclaimable but not reusable by this run's lease),
 * and this run's own profile has no ready idle match -- exactly the
 * precondition BrowserSurfaceLeaseManager#planCapacityPressureReclaim
 * requires (surfaceMode dynamic, waiting_for_browser_surface,
 * wait_reason capacity_full, no compatible idle surface, activeSurfaceCount
 * >= surfaceCap).
 */
/**
 * Shared setup for the capacity-pressure reclaim/promotion route: one
 * managed connector at surfaceCap=1, one already-ready idle surface under a
 * DIFFERENT profile_key (reclaimable — incompatible with the queued lease —
 * but never directly reusable), so the run under test has no ready idle
 * match of its own and must go through
 * BrowserSurfaceLeaseManager#planCapacityPressureReclaim's exact
 * precondition set (surfaceMode dynamic, waiting_for_browser_surface,
 * wait_reason capacity_full, no compatible idle surface, activeSurfaceCount
 * >= surfaceCap). makeLeaseId/makeSurfaceId are sequenced so tests can
 * assert on exact fresh-identity values across a retry.
 */
function createReclaimScenarioLeaseManager() {
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode: "dynamic",
    },
    initialSurfaces: [
      {
        backend: "neko",
        cdp_url: "http://other-managed-instance-2:9223",
        connector_id: "managed",
        created_at: "2026-05-12T11:00:00.000Z",
        health: "ready",
        last_used_at: "2026-05-12T11:00:00.000Z",
        // Distinct profile_key from this run's own connectorInstanceId
        // ("managed" -> "managed-profile") so it is reclaimable
        // (incompatible with the queued lease) but never directly reused.
        profile_key: "managed-profile:other-managed-instance-2",
        stream_base_url: "http://other-managed-instance-2:8080",
        surface_id: "surface_idle_other",
      },
    ],
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_reclaim_${leaseSeq}`;
    },
    makeSurfaceId: () => {
      surfaceSeq += 1;
      return `surface_reclaimed_${surfaceSeq}`;
    },
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
  });
}

/** Asserts the run's first spine event genuinely queued on capacity_full, matching the live incident's exact route. */
function assertReclaimRouteWasTaken(events: ReturnType<typeof listRunEvents>): void {
  const firstEvent = at(events, 0);
  const firstData = firstEvent.data as { browser_surface?: { browser_surface_wait_reason?: string } } | null;
  assert.equal(
    firstData?.browser_surface?.browser_surface_wait_reason,
    "capacity_full",
    "this run must genuinely queue on capacity first, matching the live incident's exact route"
  );
}

/**
 * Reproduces the live 2026-07-31 Chase incident (run_1785523408084,
 * candidate 0c8d25c57): the bounded starting-surface retry never fired even
 * though PDPP_NEKO_SURFACE_MODE=dynamic and the allocator were both
 * correctly configured (confirmed against the live container's actual env
 * via parseNekoBrowserSurfaceRuntimeConfig). The live spine showed the
 * queuing request admitted as waiting_for_browser_surface with
 * wait_reason=capacity_full, then promoted straight to starting_surface
 * within the SAME acquire call (no separate run.browser_surface_queued
 * event) -- the inline capacity-pressure reclaim path
 * (reclaimWaitingLeaseIfNeeded -> tryPromoteReclaimedWaitingLease), which
 * hardcoded allowStartFailureRetry: false regardless of the caller's actual
 * retry-eligibility, unlike the direct dispatch path which threads the
 * caller's option through correctly.
 */
test("capacity-pressure reclaim promotes inline to starting_surface and a transient allocator hiccup retries in place, never spraying a replacement", async (t) => {
  const leaseManager = createReclaimScenarioLeaseManager();

  let ensureCalls = 0;
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureRequests.push(request);
      ensureCalls += 1;
      if (ensureCalls === 1) {
        throw new Error("Docker POST /containers/create failed: connect ECONNREFUSED");
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return await Promise.resolve(surface ? { ...surface, health: "stopping" } : null);
    },
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const runId = "run_capacity_reclaim_start_failed";
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
    probe,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId,
  });
  await controller.drainActiveRuns(1000);

  const events = listRunEvents(runId);
  const eventTypes = events.map((e) => e.event_type);
  assert.ok(
    eventTypes.includes("run.browser_surface_requested"),
    `expected an initial request event; got ${eventTypes.join(",")}`
  );
  assertReclaimRouteWasTaken(events);

  assert.equal(result.status, "started", "the in-place poll retry must recover on the reclaim/promotion path too");
  assert.equal(ensureCalls, 2, "first ensureSurface call throws, the in-place retry's second call succeeds");
  assert.equal(
    stopRequests.length,
    1,
    "the idle other-profile surface was reclaimed exactly once by the inline reclaim — an in-place poll retry stops nothing"
  );
  assert.equal(runConnectorCalls.length, 1);

  // The in-place retry targets the SAME surface_id/lease_id the inline
  // reclaim promoted — proven empirically (not assumed) against the real
  // BrowserSurfaceLeaseManager. A transient allocator hiccup on the reclaim
  // route must not spray a second replacement container any more than it
  // does on the direct-dispatch route.
  assert.equal(at(ensureRequests, 0).surfaceId, "surface_reclaimed_1", "first (throwing) poll attempt's surface_id");
  assert.equal(
    at(ensureRequests, 1).surfaceId,
    "surface_reclaimed_1",
    "the in-place retry targets the SAME surface_id — it must never mint a replacement for a transient hiccup"
  );
  const leases = leaseManager.listLeases().filter((lease) => lease.run_id === runId);
  assert.equal(
    leases.length,
    1,
    "no second lease is created — the in-place retry never re-enters the acquire pipeline"
  );
  assert.equal(at(leases, 0).status, "released", "the run completed and its lease was released during cleanup");
  assert.equal(at(leases, 0).surface_id, "surface_reclaimed_1");

  assert.equal(
    eventTypes.filter((event) => event === "run.browser_surface_failed").length,
    0,
    "a transient hiccup absorbed in place must never emit the terminal event on the reclaim/promotion path either"
  );
  assert.equal(
    eventTypes.filter((event) => event === "run.browser_surface_retried").length,
    0,
    "the non-terminal outer-retry sibling event is reserved for a CONFIRMED-dead surface, not an in-place poll retry"
  );
});

/**
 * Durable-layer counterpart to the reclaim-route recovery test above,
 * mirroring "starting-surface allocator failure recovery durably records a
 * succeeded run_history row with records, not a latched surface_failed" for
 * the direct dispatch path. The gate-2 emit-ordering fix
 * (handleStartingSurfaceWaitForRun) is shared code, but the reclaim route
 * reaches it through a structurally different call chain
 * (reclaimWaitingLeaseIfNeeded -> tryPromoteReclaimedWaitingLease), so only
 * a real run_history read on THIS route proves the durable projection
 * is correct here too, not just on the direct path.
 */
test("capacity-pressure reclaim recovery durably records a succeeded run_history row with records, not a latched surface_failed", async (t) => {
  const leaseManager = createReclaimScenarioLeaseManager();

  let ensureCalls = 0;
  const surfaces = new Map<string, BrowserSurface>();
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: async (request) => {
      ensureCalls += 1;
      if (ensureCalls === 1) {
        throw new Error("Docker POST /containers/create failed: connect ECONNREFUSED");
      }
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return await Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => await Promise.resolve(surfaces.get(surfaceId) ?? null),
    listSurfaces: async () => await Promise.resolve([...surfaces.values()]),
    stopSurface: async (request) => await Promise.resolve(surfaces.get(request.surfaceId) ?? null),
  };
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => await Promise.resolve({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const runId = "run_capacity_reclaim_recovers_durably";
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    leaseManager,
    probe,
    // Matches the direct-path durable-history test's fake: the real
    // runtime emits run.completed with the real records_emitted once
    // collection finishes. run.started is deliberately skipped -- it
    // requires data.boot_epoch/data.seq (assertRunStartedIsStamped in
    // lib/spine.ts), stamped only after setCurrentBootEpoch, which this
    // test suite never calls -- the run-history writer's own documented
    // fallback-insert path covers a terminal event with no prior started
    // row.
    runConnectorImpl: async (opts) => {
      await emitSpineEvent({
        actor_id: opts.connectorId,
        actor_type: "runtime",
        data: { connector_instance_id: "managed", records_emitted: 17 },
        event_type: "run.completed",
        object_id: opts.runId ?? null,
        object_type: "run",
        run_id: opts.runId ?? null,
        scenario_id: opts.traceContext?.scenario_id ?? null,
        status: "succeeded",
        trace_id: opts.traceContext?.trace_id ?? "trace",
      });
      return {
        checkpoint_summary: null,
        records_emitted: 17,
        state: null,
        status: "succeeded",
      };
    },
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId,
  });
  await controller.drainActiveRuns(1000);

  assertReclaimRouteWasTaken(listRunEvents(runId));
  assert.equal(result.status, "started", "the bounded reacquire must recover on the reclaim/promotion path too");
  assert.equal(ensureCalls, 2, "first ensureSurface throws, second (fresh surface_id) succeeds");
  assert.equal(runConnectorCalls.length, 1, "the connector runs exactly once, only after the retry recovers");

  interface RunHistoryTestRow {
    readonly records_emitted: number;
    readonly run_id: string;
    readonly status: string;
  }
  const row = getDb().prepare("SELECT run_id, status, records_emitted FROM run_history WHERE run_id = ?").get(runId) as
    | RunHistoryTestRow
    | undefined;
  assert.ok(row, "run_history must have exactly one row for this run_id");
  assert.equal(
    row.status,
    "succeeded",
    `durable run_history must report the recovered reclaim-route run as succeeded, not latched at the retried attempt's surface_failed (got: ${row.status})`
  );
  assert.equal(
    row.records_emitted,
    17,
    `durable run_history must report the real record count, not 0 from the retried attempt's terminal write (got: ${row.records_emitted})`
  );

  const countRow = getDb().prepare("SELECT COUNT(*) AS n FROM run_history WHERE run_id = ?").get(runId) as {
    n: number;
  };
  assert.equal(
    countRow.n,
    1,
    "exactly one run_history row on the reclaim route too — the retried attempt must not have created or finalized its own row"
  );
});

/**
 * Reclaim-route counterpart to "starting-surface allocator failure on the
 * reacquire attempt does not retry a second time": a persistently broken
 * allocator on the capacity-pressure reclaim/promotion path must still fail
 * closed after exactly one bounded retry -- no third acquire attempt, no
 * loop, and no leaked reclaimed surface (the idle other-profile surface is
 * stopped exactly once, not once per attempt).
 */
test("capacity-pressure reclaim persistent allocator failure exhausts the in-place poll budget on each surface, then fails closed after the bounded outer reacquire, no third acquire or loop", async (t) => {
  const leaseManager = createReclaimScenarioLeaseManager();

  let ensureCalls = 0;
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const allocator: BrowserSurfaceAllocator = {
    ensureSurface: (request) => {
      ensureRequests.push(request);
      ensureCalls += 1;
      throw new Error(`Docker POST /containers/create failed: connect ECONNREFUSED (attempt for ${request.surfaceId})`);
    },
    getSurfaceStatus: async () => await Promise.resolve(null),
    listSurfaces: async () => await Promise.resolve([]),
    stopSurface: async (request) => {
      stopRequests.push(request);
      return await Promise.resolve(null);
    },
  };
  const runId = "run_capacity_reclaim_persistent_failure";
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    browserSurfaceStartingPollRetryDelayMs: 0,
    leaseManager,
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId,
  });
  await controller.drainActiveRuns(1000);

  const events = listRunEvents(runId);
  assertReclaimRouteWasTaken(events);
  assert.equal(
    result.status,
    "surface_failed",
    "a persistently broken allocator still fails closed on the reclaim route, not an infinite loop"
  );
  assert.equal(
    ensureCalls,
    6,
    "bounded, never unbounded: 3 in-place poll attempts on the reclaimed surface (default browserSurfaceStartingPollRetryAttempts=3), then 3 more on the one bounded outer reacquire's fresh surface — no third outer acquire"
  );
  assert.equal(
    stopRequests.length,
    2,
    "the idle other-profile surface is reclaimed (stopped) exactly once — no leak from a repeated reclaim per in-place poll retry — PLUS the first reclaimed surface's own abandoned container is stopped exactly once before the outer reacquire mints surface_reclaimed_2, so a persistently failing allocator cannot spray containers past the surface cap"
  );
  assert.equal(
    stopRequests.filter((request) => request.surfaceId === "surface_reclaimed_1" && request.reason === "surface_failed")
      .length,
    1,
    "the abandoned surface_reclaimed_1 container is stopped exactly once, tagged with the terminal failure reason"
  );
  assert.equal(at(ensureRequests, 0).surfaceId, "surface_reclaimed_1");
  assert.equal(at(ensureRequests, 1).surfaceId, "surface_reclaimed_1", "in-place retries target the same surface_id");
  assert.equal(at(ensureRequests, 2).surfaceId, "surface_reclaimed_1");
  assert.equal(
    at(ensureRequests, 3).surfaceId,
    "surface_reclaimed_2",
    "only once the in-place budget is exhausted does the bounded OUTER reacquire mint a fresh surface_id"
  );
  assert.equal(runConnectorCalls.length, 0, "connector is never spawned when the surface never starts");

  const eventTypes = events.map((e) => e.event_type);
  assert.equal(
    eventTypes.filter((event) => event === "run.browser_surface_retried").length,
    1,
    "exactly one non-terminal OUTER retry signal on the reclaim route, once surface 1 is confirmed dead"
  );
  assert.equal(
    eventTypes.filter((event) => event === "run.browser_surface_failed").length,
    1,
    "exactly one terminal failure on the reclaim route — the bounded outer retry does not itself retry again"
  );
});

test("boot reconciliation retires an idle stale-capability surface and recreates its profile", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface();
  const staleSurface = leaseManager.getSurface("surface_stale");
  assert.ok(staleSurface);
  const { allocator, ensureRequests, stopRequests } = createReadyDynamicAllocator([staleSurface]);
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async (surface) =>
      surface.surface_id === "surface_stale"
        ? {
            code: "browser_surface_window_settle_unavailable",
            detail: "GET http://stale:9223/pdpp/window-settle returned HTTP 404",
            ok: false as const,
          }
        : { ok: true, pageTargetCount: 1 },
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    leaseManager,
    probe,
  });

  await controller.reconcileBrowserSurfaceLeasesAfterBoot();

  assert.equal(
    leaseManager.getSurface("surface_stale"),
    undefined,
    "idle incompatible surface is evicted before reuse"
  );
  assert.deepEqual(stopRequests, [{ reason: "surface_failed", surfaceId: "surface_stale" }]);

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_recreated_profile",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(runConnectorCalls.length, 1);
  assert.equal(ensureRequests.length, 1, "the existing allocator creates a replacement on the next acquire");
  assert.equal(ensureRequests[0]?.profileKey, "managed-profile", "replacement preserves the original profile key");
});

test("boot reconciliation defers stale-capability retirement until the active run releases its lease", async (t) => {
  // Use the manager directly to exercise the same terminal release path the
  // controller uses after a connector completes. The run remains leased while
  // boot reconciliation observes its stale endpoint.
  setup(t);
  const runId = "run_active_stale_capability";
  const leaseManager = createDynamicManagerWithReadySurface({ initialActiveLease: true, runId });
  const staleSurface = leaseManager.getSurface("surface_stale");
  const [activeLease] = leaseManager.listLeases();
  assert.ok(staleSurface);
  assert.ok(activeLease);
  const { allocator, stopRequests } = createReadyDynamicAllocator([staleSurface]);
  const manager = createBrowserSurfaceManager({
    activeRunInteractions: new Map(),
    browserSurfaceAllocator: allocator,
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceLeaseStore: null,
    browserSurfaceMidWaitPollIntervalMs: undefined,
    browserSurfaceReadinessProbe: {
      probe: async () => ({
        code: "browser_surface_window_settle_unavailable",
        detail: "GET http://stale:9223/pdpp/window-settle returned HTTP 404",
        ok: false as const,
      }),
    },
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: null,
    listPersistedActiveRuns: async () => [{ run_id: runId }],
    log: { error: () => undefined, warn: () => undefined },
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => undefined,
    startupControllerRunReconciliation: Promise.resolve(),
  });

  await manager.reconcileBrowserSurfaceLeasesAfterBoot();

  assert.equal(stopRequests.length, 0, "an active run is never interrupted by boot reconciliation");
  assert.equal(leaseManager.getLease(activeLease.lease_id)?.status, "leased");
  assert.ok(leaseManager.getSurface("surface_stale"), "active run retains its surface until completion");

  await manager.releaseLease(activeLease, "managed", runId, createTraceContext());

  assert.deepEqual(stopRequests, [{ reason: "surface_failed", surfaceId: "surface_stale" }]);
  assert.equal(leaseManager.getSurface("surface_stale"), undefined, "terminal release retires the deferred surface");
});

test("typed browser_surface_attach_exhausted code on a dynamic surface after readiness passed recycles the surface, stops the allocator container, and the next run reacquires a fresh one", async (t) => {
  // Reproduces the live shape: Docker-healthy, CDP HTTP metadata (json/version,
  // json/list) answers fine, so the pre-flight readiness gate passes and
  // run.browser_surface_ready is emitted — but the underlying browser session
  // is wedged, so the connector fails before any record/progress. The
  // connector-runtime source boundary (browser-launch.ts) is the one that
  // exhausts its bounded attach-race retry budget and tags
  // connector_error.code = browser_surface_attach_exhausted; the controller
  // only ever reads that typed code.
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => ({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const leaseManager = createDynamicManagerWithReadySurface();
  const { allocator, stopRequests } = createReadyDynamicAllocator();
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    leaseManager,
    probe,
    // The real runtime (runConnector) always records its own terminal
    // run.failed spine event before its promise resolves. This fake
    // runConnectorImpl mocks the runtime's RETURN VALUE only, so it must
    // inject the same minimal terminal event the real runtime would have
    // recorded — otherwise the ordering-oracle assertion below (run.failed
    // -> run.browser_surface_invalidated -> run.browser_surface_released)
    // has nothing real to check against.
    runConnectorImpl: async (opts) => {
      assert.ok(opts.traceContext);
      await emitSpineEvent({
        actor_id: opts.connectorId,
        actor_type: "runtime",
        data: { connector_instance_id: "managed", records_emitted: 0 },
        event_type: "run.failed",
        object_id: opts.runId ?? null,
        object_type: "run",
        run_id: opts.runId ?? null,
        scenario_id: opts.traceContext.scenario_id ?? null,
        status: "failed",
        trace_id: opts.traceContext.trace_id,
      });
      return {
        checkpoint_summary: null,
        connector_error: attachExhaustedConnectorError(),
        records_emitted: 0,
        state: null,
        status: "failed",
      };
    },
  });

  const first = await controller.runNow("managed", {
    connectorInstanceId: "managed",
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_attach_exhausted_first",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(first.status, "started", "readiness passed, so the connector still spawns");
  assert.equal(runConnectorCalls.length, 1);

  const firstEvents = listRunEvents("run_attach_exhausted_first");
  const firstEventTypes = firstEvents.map((e) => e.event_type);
  assert.ok(firstEventTypes.includes("run.browser_surface_ready"), "readiness probe passed pre-flight");
  assert.ok(
    firstEventTypes.includes("run.browser_surface_invalidated"),
    "attach-exhausted recycling must emit its own typed event, not the interaction-specific run.browser_surface_lost"
  );

  // Ordering oracle: run.failed -> run.browser_surface_invalidated ->
  // run.browser_surface_released. Not mere inclusion — the actual sequence
  // matters, because the recycling decision is made from the run's already-
  // recorded terminal outcome, and the lease must still be live (not yet
  // released) when the surface is invalidated.
  const terminalSeq = firstEvents.findIndex((e) => e.event_type === "run.failed");
  const invalidatedSeq = firstEvents.findIndex((e) => e.event_type === "run.browser_surface_invalidated");
  const releasedSeq = firstEvents.findIndex((e) => e.event_type === "run.browser_surface_released");
  assert.ok(terminalSeq !== -1, `expected run.failed; got ${firstEventTypes.join(",")}`);
  assert.ok(invalidatedSeq !== -1, `expected run.browser_surface_invalidated; got ${firstEventTypes.join(",")}`);
  assert.ok(releasedSeq !== -1, `expected run.browser_surface_released; got ${firstEventTypes.join(",")}`);
  assert.ok(
    terminalSeq < invalidatedSeq,
    `run.failed (seq ${terminalSeq}) must precede run.browser_surface_invalidated (seq ${invalidatedSeq})`
  );
  assert.ok(
    invalidatedSeq < releasedSeq,
    `run.browser_surface_invalidated (seq ${invalidatedSeq}) must precede run.browser_surface_released (seq ${releasedSeq})`
  );

  const invalidatedEvent = at(firstEvents, invalidatedSeq);
  const invalidatedData = probeEventData(invalidatedEvent.data);
  assert.equal(invalidatedData.browser_surface_probe.code, "browser_surface_attach_exhausted");
  // The detail must be a stable, runtime-authored string — never the raw,
  // unbounded connector_error.message (that untrusted text is already
  // persisted once, bounded, on the run's own terminal event).
  assert.equal(invalidatedData.browser_surface_probe.detail.includes(SESSION_CLOSED_MESSAGE), false);
  assert.equal(invalidatedData.interaction_id, undefined, "this event is not interaction-specific");
  assert.equal(invalidatedData.kind, undefined, "this event is not interaction-specific");

  // The exhausted dynamic surface must be evicted from memory and the
  // allocator told to stop the underlying container — the exact mechanism
  // readiness-probe failure already uses (task 5.6 / PR #260), triggered
  // here from the typed terminal connector-error code instead of a
  // pre-flight probe.
  assert.equal(leaseManager.getSurface("surface_stale"), undefined, "attach-exhausted surface must be evicted");
  assert.equal(stopRequests.length, 1);
  assert.equal(at(stopRequests, 0).surfaceId, "surface_stale");
  assert.equal(at(stopRequests, 0).reason, "surface_failed");

  // A follow-up run for the same connector must NOT re-lease the recycled
  // surface; it must acquire a fresh dynamic surface.
  const second = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_attach_exhausted_second",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(second.status, "started");
  assert.equal(runConnectorCalls.length, 2);
  const secondSurfaceEnv = at(runConnectorCalls, 1).browserSurfaceEnv;
  assert.ok(secondSurfaceEnv);
  assert.equal(
    secondSurfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL,
    "http://surface_dynamic_1:9223",
    "follow-up run must acquire a freshly-allocated surface, not the recycled one"
  );
});

// Table-driven negatives: every case below is a dynamic-surface run that
// must NOT recycle the surface. Sharing one setup/assert shape keeps the
// distinctions (why each one is a negative) visible without duplicating the
// fixture wiring per case.
const DYNAMIC_SURFACE_NON_RECYCLE_CASES = [
  {
    connectorError: () => ordinaryRetryableConnectorError(),
    name: "the exact session-closed error string WITHOUT the typed browser_surface_attach_exhausted code",
    reason: "no typed code means no surface recycling, regardless of message text",
    recordsEmitted: 0,
    runId: "run_untyped_code",
  },
  {
    connectorError: () => ({
      code: "credential_rejected",
      message: "credential rejected by provider",
      retryable: false,
    }),
    name: "an unrelated connector failure (credential rejection)",
    reason: "an unrelated connector failure must not recycle the surface",
    recordsEmitted: 0,
    runId: "run_unrelated_failure",
  },
  {
    connectorError: () => attachExhaustedConnectorError(),
    name: "a mid-run failure that already made progress (records_emitted > 0), even with the typed code",
    reason: "post-progress failures are out of scope for this pre-progress recycling",
    recordsEmitted: 42,
    runId: "run_post_progress_failure",
  },
];

for (const testCase of DYNAMIC_SURFACE_NON_RECYCLE_CASES) {
  test(`${testCase.name} does not recycle the surface`, async (t) => {
    const probe: BrowserSurfaceReadinessProbe = {
      probe: async () => ({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
    };
    const leaseManager = createDynamicManagerWithReadySurface();
    const { allocator, stopRequests } = createReadyDynamicAllocator();
    const { controller } = setup(t, {
      browserSurfaceAllocator: allocator,
      leaseManager,
      probe,
      runConnectorImpl: () => ({
        checkpoint_summary: null,
        connector_error: testCase.connectorError(),
        records_emitted: testCase.recordsEmitted,
        state: null,
        status: "failed",
      }),
    });

    const result = await controller.runNow("managed", {
      manifest: MANIFEST,
      ownerToken: "owner-token",
      runId: testCase.runId,
    });
    await controller.drainActiveRuns(1000);

    assert.equal(result.status, "started");
    assert.equal(stopRequests.length, 0, testCase.reason);
    assert.notEqual(leaseManager.getSurface("surface_stale"), undefined, "the surface must remain leaseable");

    const events = listRunEvents(testCase.runId).map((e) => e.event_type);
    assert.ok(!events.includes("run.browser_surface_invalidated"));
  });
}

test("typed browser_surface_attach_exhausted code on a STATIC surface does not recycle or stop the surface", async (t) => {
  const probe: BrowserSurfaceReadinessProbe = {
    probe: async () => ({ browserVersion: "Chrome/124.0", ok: true, pageTargetCount: 1 }),
  };
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const allocator: BrowserSurfaceAllocator = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    ensureSurface: async () => {
      throw new Error("static mode must not call ensureSurface");
    },
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [],
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    stopSurface: async (request) => {
      stopRequests.push(request);
      return null;
    },
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    probe,
    runConnectorImpl: () => ({
      checkpoint_summary: null,
      connector_error: attachExhaustedConnectorError(),
      records_emitted: 0,
      state: null,
      status: "failed" as const,
    }),
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_static_attach_exhausted",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(runConnectorCalls.length, 1);
  assert.equal(stopRequests.length, 0, "static/operator-owned surfaces must never be stopped/destroyed");

  const events = listRunEvents("run_static_attach_exhausted").map((e) => e.event_type);
  assert.ok(!events.includes("run.browser_surface_invalidated"), "no surface-recycling event for a static surface");

  // The static surface must still be leaseable by a follow-up run — it was
  // never evicted.
  const second = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_static_after_attach_exhausted",
  });
  await controller.drainActiveRuns(1000);
  assert.equal(second.status, "started");
  assert.equal(runConnectorCalls.length, 2);
  const secondSurfaceEnv = at(runConnectorCalls, 1).browserSurfaceEnv;
  assert.ok(secondSurfaceEnv);
  assert.equal(
    secondSurfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL,
    "http://127.0.0.1:9222",
    "the same static surface must be reused, not replaced"
  );
});

test("probe disabled (null) preserves legacy behavior: connector spawned, no probe events", async (t) => {
  const { controller, runConnectorCalls } = setup(t, {});

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_disabled",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(runConnectorCalls.length, 1);
  const events = listRunEvents("run_disabled").map((e) => e.event_type);
  assert.ok(!events.includes("run.browser_surface_ready"));
  assert.ok(!events.includes("run.browser_surface_probe_failed"));
});

// ─── Restart-lease-promotion: connectorInstanceId survives an empty
// pendingBrowserSurfaceLaunches Map (the in-memory launch-options Map is
// always empty on a fresh process, so promoteBrowserSurfaceLease must
// restore connectorInstanceId from the persisted lease's surface_subject_id
// rather than let it collapse to connector_id) ──────────────────────────────

interface PromotionHarnessOptions {
  connectorId?: string;
  pendingBrowserSurfaceLaunches?: Map<string, RunNowOptions>;
  surfaceSubjectId?: string;
}

function setupPromotionHarness({
  connectorId = "other-managed",
  surfaceSubjectId,
  pendingBrowserSurfaceLaunches = new Map(),
}: PromotionHarnessOptions = {}) {
  const surface: BrowserSurface = {
    backend: "neko",
    cdp_url: "http://127.0.0.1:9222",
    connector_id: connectorId,
    created_at: "2026-05-12T11:00:00.000Z",
    health: "ready",
    last_used_at: "2026-05-12T11:00:00.000Z",
    profile_key: "managed-profile",
    stream_base_url: "http://127.0.0.1:8080",
    // Static-mode initial-surface compatibility (#isCompatibleInitialSurface)
    // requires exactly this id.
    surface_id: "neko-static",
    ...(surfaceSubjectId ? { surface_subject_id: surfaceSubjectId } : {}),
  };
  const lease = {
    connector_id: connectorId,
    expires_at: "2026-05-12T12:40:02.000Z",
    fencing_token: 0,
    lease_id: "lease_queued",
    priority_class: "interactive" as const,
    profile_key: "managed-profile",
    requested_at: "2026-05-12T12:10:02.000Z",
    run_id: "run_after_restart",
    status: "waiting_for_browser_surface" as const,
    wait_reason: "capacity_full" as const,
    ...(surfaceSubjectId ? { surface_subject_id: surfaceSubjectId } : {}),
  };
  const leaseManager = new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set([connectorId]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      staticCdpHttpUrl: "http://127.0.0.1:9222",
      staticProfileKey: "managed-profile",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      surfaceCap: 1,
      surfaceMode: "static",
    },
    initialLeases: [lease],
    initialSurfaces: [surface],
    makeSurfaceId: () => "neko-static",
    nextFencingToken: () => 7,
    // Fixed clock inside the lease's [requested_at, expires_at) window so
    // pumpQueuedLeases promotes rather than expiring the queued lease.
    now: () => new Date("2026-05-12T12:10:03.000Z"),
  });

  const calls: { connectorId: string; options: RunNowOptions }[] = [];
  const manager = createBrowserSurfaceManager({
    activeRunInteractions: new Map(),
    browserSurfaceAllocator: null,
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceLeaseStore: null,
    browserSurfaceMidWaitPollIntervalMs: undefined,
    browserSurfaceReadinessProbe: null,
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: null,
    listPersistedActiveRuns: async () => [],
    log: { error: () => undefined, warn: () => undefined },
    pendingBrowserSurfaceLaunches,
    resolveOwnerSubjectIdForConnectorInstance: async (connectorInstanceId) =>
      new Set([connectorId, surfaceSubjectId, "live-instance-from-memory"]).has(connectorInstanceId)
        ? "owner_restart_fixture"
        : null,
    scheduleRun: (schedConnectorId, options) => {
      calls.push({ connectorId: schedConnectorId, options });
    },
    startupControllerRunReconciliation: Promise.resolve(),
  });

  return { calls, leaseManager, manager };
}

test("restart promotion restores connectorInstanceId from the persisted lease's surface_subject_id", async () => {
  const { calls, manager } = setupPromotionHarness({
    connectorId: "other-managed",
    surfaceSubjectId: "other-managed-instance-2",
  });

  await manager.promoteBrowserSurfaceLeasesAfterBoot();

  assert.equal(calls.length, 1);
  const firstCall = at(calls, 0);
  assert.equal(firstCall.connectorId, "other-managed");
  assert.equal(firstCall.options.runId, "run_after_restart");
  assert.equal(firstCall.options.ownerSubjectId, "owner_restart_fixture");
  assert.equal(
    firstCall.options.connectorInstanceId,
    "other-managed-instance-2",
    "connectorInstanceId must be restored from the persisted lease's surface_subject_id, not collapse to connector_id"
  );
});

test("restart promotion falls back to connector_id for a connector-wide lease (no surface_subject_id)", async () => {
  const { calls, manager } = setupPromotionHarness({ connectorId: "managed" });

  await manager.promoteBrowserSurfaceLeasesAfterBoot();

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).options.connectorInstanceId,
    "managed",
    "a connector-wide lease (no surface_subject_id) must resolve connectorInstanceId to connector_id, preserving connector-wide semantics"
  );
});

test("live (non-restart) promotion prefers a surviving pendingBrowserSurfaceLaunches entry over the persisted lease", async () => {
  const { calls, manager } = setupPromotionHarness({
    connectorId: "other-managed",
    pendingBrowserSurfaceLaunches: new Map([
      ["run_after_restart", { connectorInstanceId: "live-instance-from-memory", runId: "run_after_restart" }],
    ]),
    surfaceSubjectId: "stale-persisted-instance",
  });

  await manager.promoteBrowserSurfaceLeasesAfterBoot();

  assert.equal(calls.length, 1);
  assert.equal(
    at(calls, 0).options.connectorInstanceId,
    "live-instance-from-memory",
    "a surviving in-memory launch entry must win over the persisted-lease fallback"
  );
});
