// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { makeTemporaryDbPath } from "./helpers/temp-dir.js";
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "@opendatalabs/remote-surface/leases";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";

const MANIFEST = {
  connector_id: "managed",
  name: "Managed",
  version: "1.0.0",
  streams: [],
  capabilities: {
    browser_surface: {
      profile_key: "managed-profile",
    },
  },
};

const OTHER_MANAGED_MANIFEST = {
  ...MANIFEST,
  connector_id: "other-managed",
  name: "Other Managed",
  capabilities: {
    browser_surface: {
      profile_key: "managed-profile",
    },
  },
};

const DISTINCT_PROFILE_MANIFEST = {
  ...OTHER_MANAGED_MANIFEST,
  capabilities: {
    browser_surface: {
      profile_key: "other-managed-profile",
    },
  },
};

function tempDbPath() {
  return makeTemporaryDbPath("pdpp-controller-bsl-");
}

function createSchedulerStore(calls) {
  const activeRuns = new Map();
  const store = {
    activeRuns,
    listActiveRuns: () => [...activeRuns.values()],
    upsertActiveRun: (record) => {
      calls.persistActiveRun += 1;
      activeRuns.set(record.run_id, record);
    },
    deleteActiveRun: (_connectorId, runId) => {
      activeRuns.delete(runId);
    },
    getSchedule: () => null,
    listSchedules: () => [],
    updateSchedule: () => {},
    createSchedule: () => {},
    setScheduleEnabled: () => {},
    deleteSchedule: () => {},
  };
  return store;
}

function createDurableConflictSchedulerStore(existingRow) {
  return {
    appendRunHistory: () => {},
    createSchedule: () => {},
    deleteActiveRun: () => {},
    deleteSchedule: () => {},
    getActiveRun: () => (existingRow ? { ...existingRow } : null),
    getSchedule: () => null,
    listActiveRuns: () => (existingRow ? [{ ...existingRow }] : []),
    listLastRunTimes: () => [],
    listRunHistory: () => [],
    listSchedules: () => [],
    setScheduleEnabled: () => {},
    updateSchedule: () => {},
    upsertActiveRun: () => false,
    upsertLastRunTime: () => {},
  };
}

function createMemoryBrowserSurfaceLeaseStore({ surfaces = [], leases = [] } = {}) {
  const surfaceRows = new Map(surfaces.map((surface) => [surface.surface_id, surface]));
  const leaseRows = new Map(leases.map((lease) => [lease.lease_id, lease]));
  const terminalStatuses = new Set(["released", "expired", "deferred", "cancelled", "surface_failed"]);
  const store = {
    surfaces: surfaceRows,
    leases: leaseRows,
    upsertSurface: async (surface) => {
      surfaceRows.set(surface.surface_id, surface);
      return surface;
    },
    upsertLease: async (lease) => {
      leaseRows.set(lease.lease_id, lease);
      return lease;
    },
    getSurface: async (surfaceId) => surfaceRows.get(surfaceId) ?? null,
    getLease: async (leaseId) => leaseRows.get(leaseId) ?? null,
    listSurfaces: async () => [...surfaceRows.values()].sort((a, b) => a.surface_id.localeCompare(b.surface_id)),
    listNonTerminalLeases: async () => [...leaseRows.values()].filter((lease) => !terminalStatuses.has(lease.status)),
    repairStaleSurfaceActiveLeases: async () => {
      for (const [surfaceId, surface] of surfaceRows) {
        const activeLeaseId = surface.active_lease_id;
        const activeLease = activeLeaseId ? leaseRows.get(activeLeaseId) : null;
        if (!activeLease || activeLease.surface_id !== surfaceId || terminalStatuses.has(activeLease.status)) {
          const updated = { ...surface };
          delete updated.active_lease_id;
          surfaceRows.set(surfaceId, updated);
        }
      }
    },
    updateLeaseTerminal: async (leaseId, status, options = {}) => {
      const lease = leaseRows.get(leaseId);
      if (!lease) return null;
      const updated = {
        ...lease,
        status,
        ...(options.releasedAt ? { released_at: options.releasedAt } : {}),
        ...(options.waitReason ? { wait_reason: options.waitReason } : {}),
      };
      leaseRows.set(leaseId, updated);
      return updated;
    },
    clearSurfaceActiveLease: async (surfaceId) => {
      const surface = surfaceRows.get(surfaceId);
      if (!surface) return null;
      const updated = { ...surface };
      delete updated.active_lease_id;
      surfaceRows.set(surfaceId, updated);
      return updated;
    },
    withLeaseTransaction: async (fn) => fn(store),
  };
  return store;
}

function createManager(options = {}) {
  const {
    managedConnectors = new Set(["managed", "other-managed"]),
    surfaceCap = 1,
    leaseWaitTimeoutMs = 300_000,
    now = () => new Date("2026-05-12T12:00:00.000Z"),
  } = options;
  const staticProfileKey = Object.hasOwn(options, "staticProfileKey") ? options.staticProfileKey : "managed-profile";
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors,
      surfaceCap,
      staticProfileKey,
      staticCdpHttpUrl: "http://127.0.0.1:9222/json/version",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs,
      idleTtlMs: 600_000,
      defaultPriorityClass: "background",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: staticProfileKey ? "static" : "dynamic",
    },
    now,
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_${++surfaceSeq}`,
    nextFencingToken: () => ++tokenSeq,
  });
}

function createDynamicManager(options = {}) {
  return createManager({ ...options, staticProfileKey: undefined });
}

function createReadyAllocator() {
  const ensureRequests = [];
  const stopRequests = [];
  const surfaces = new Map();
  return {
    ensureRequests,
    stopRequests,
    ensureSurface: async (request) => {
      ensureRequests.push(request);
      const surface = {
        surface_id: request.surfaceId,
        backend: "neko",
        profile_key: request.profileKey,
        connector_id: request.connectorId,
        cdp_url: `http://127.0.0.1:9222/${request.surfaceId}`,
        stream_base_url: `http://127.0.0.1:8080/${request.surfaceId}`,
        health: "ready",
        created_at: "2026-05-12T12:00:00.000Z",
        last_used_at: "2026-05-12T12:00:00.000Z",
      };
      surfaces.set(request.surfaceId, surface);
      return surface;
    },
    getSurfaceStatus: async (surfaceId) => surfaces.get(surfaceId) ?? null,
    stopSurface: async (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return surface;
    },
    listSurfaces: async () => [...surfaces.values()],
  };
}

function createFailingAllocator() {
  return {
    ensureSurface: async () => {
      throw new Error("allocator failed");
    },
    getSurfaceStatus: async () => null,
    stopSurface: async () => null,
    listSurfaces: async () => [],
  };
}

function createStopFailingAllocator() {
  const allocator = createReadyAllocator();
  return {
    ...allocator,
    stopSurface: async (request) => {
      allocator.stopRequests.push(request);
      throw new Error("allocator stop failed");
    },
  };
}

function createBlockedAllocator() {
  let unblock;
  const ready = new Promise((resolve) => {
    unblock = resolve;
  });
  return {
    allocator: {
      ensureSurface: async (request) => {
        await ready;
        return {
          surface_id: request.surfaceId,
          backend: "neko",
          profile_key: request.profileKey,
          connector_id: request.connectorId,
          cdp_url: `http://127.0.0.1:9222/${request.surfaceId}`,
          stream_base_url: `http://127.0.0.1:8080/${request.surfaceId}`,
          health: "ready",
          created_at: "2026-05-12T12:00:00.000Z",
          last_used_at: "2026-05-12T12:00:00.000Z",
        };
      },
      getSurfaceStatus: async (surfaceId) => ({
        surface_id: surfaceId,
        backend: "neko",
        profile_key: "managed-profile",
        connector_id: "managed",
        cdp_url: `http://127.0.0.1:9222/${surfaceId}`,
        stream_base_url: `http://127.0.0.1:8080/${surfaceId}`,
        health: "ready",
        created_at: "2026-05-12T12:00:00.000Z",
        last_used_at: "2026-05-12T12:00:00.000Z",
      }),
      stopSurface: async () => null,
      listSurfaces: async () => [],
    },
    unblock,
  };
}

function setup(
  t,
  {
    manager = createManager(),
    browserSurfaceAllocator,
    browserSurfaceLeaseStore,
    browserSurfaceReadinessTimeoutMs,
    browserSurfaceReclaimRetryAttempts,
    browserSurfaceReclaimRetryDelayMs = 0,
    beforeBrowserSurfaceLeaseRelease,
    maxRunWallClockMs,
    runConnectorImpl,
    connectorPathResolver = () => "/tmp/connector.js",
  } = {},
) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const calls = {
    clearNonce: 0,
    persistActiveRun: 0,
    registerNonce: 0,
    runConnector: 0,
    runConnectorOpts: [],
  };
  const schedulerStore = createSchedulerStore(calls);
  const controller = createController({
    browserSurfaceAllocator,
    browserSurfaceLeaseManager: manager,
    browserSurfaceLeaseStore,
    browserSurfaceReadinessTimeoutMs,
    beforeBrowserSurfaceLeaseRelease,
    ...(browserSurfaceReclaimRetryAttempts !== undefined ? { browserSurfaceReclaimRetryAttempts } : {}),
    browserSurfaceReclaimRetryDelayMs,
    connectorPathResolver,
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs,
    schedulerStore,
    streamingTargetNonceHooks: {
      registerNonce: () => {
        calls.registerNonce += 1;
      },
      clearNonce: () => {
        calls.clearNonce += 1;
      },
    },
    runConnectorImpl: (opts) => {
      calls.runConnector += 1;
      calls.runConnectorOpts.push(opts);
      return runConnectorImpl
        ? runConnectorImpl(opts)
        : Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
    },
  });
  return { calls, controller, manager, schedulerStore };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function listRunEventTypes(runId) {
  return getDb()
    .prepare("SELECT event_type FROM spine_events WHERE run_id = ? ORDER BY event_seq")
    .all(runId)
    .map((row) => row.event_type);
}

function listRunEvents(runId) {
  return getDb()
    .prepare("SELECT event_type, status, data_json FROM spine_events WHERE run_id = ? ORDER BY event_seq")
    .all(runId)
    .map((row) => ({
      event_type: row.event_type,
      status: row.status,
      data: row.data_json ? JSON.parse(row.data_json) : null,
    }));
}

test("managed free surface leases and spawns with browser-surface env", async (t) => {
  const { calls, controller, manager } = setup(t);

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_free",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.run_id, "run_free");
  assert.equal(result.status, "started");
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.registerNonce, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_REQUIRED, "neko");
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_LEASE_ID, "lease_1");
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_PROFILE_KEY, "managed-profile");
  assert.equal(manager.getLease("lease_1").status, "released");
});

test("watchdog cleanup keeps a managed lease unavailable until the presentation terminalizer settles", async (t) => {
  let releasePresentation;
  let terminalizerStarted = false;
  const presentationBarrier = new Promise((resolve) => {
    releasePresentation = resolve;
  });
  const { controller, manager } = setup(t, {
    browserSurfaceAllocator: createReadyAllocator(),
    manager: createDynamicManager(),
    maxRunWallClockMs: 10,
    beforeBrowserSurfaceLeaseRelease: async () => {
      terminalizerStarted = true;
      await presentationBarrier;
    },
    runConnectorImpl: () => new Promise(() => {}),
  });

  await controller.runNow("managed", { manifest: MANIFEST, ownerToken: "owner-token", runId: "run_watchdog_restore" });
  await waitFor(() => terminalizerStarted, "watchdog cleanup should enter the presentation terminalizer");
  assert.equal(manager.getLease("lease_1").status, "leased");

  releasePresentation();
  await waitFor(() => manager.getLease("lease_1").status === "released", "lease releases after presentation terminalizer");
});

test("ordinary connector completion keeps a managed lease unavailable until the presentation terminalizer settles", async (t) => {
  let releasePresentation;
  let terminalizerStarted = false;
  const presentationBarrier = new Promise((resolve) => {
    releasePresentation = resolve;
  });
  const { controller, manager } = setup(t, {
    browserSurfaceAllocator: createReadyAllocator(),
    manager: createDynamicManager(),
    beforeBrowserSurfaceLeaseRelease: async () => {
      terminalizerStarted = true;
      await presentationBarrier;
    },
  });

  await controller.runNow("managed", { manifest: MANIFEST, ownerToken: "owner-token", runId: "run_completion_restore" });
  await waitFor(() => terminalizerStarted, "ordinary completion should enter the presentation terminalizer");
  assert.equal(manager.getLease("lease_1").status, "leased");

  releasePresentation();
  await waitFor(() => manager.getLease("lease_1").status === "released", "lease releases after ordinary completion terminalizer");
});

test("ordinary connector failure keeps a managed lease unavailable until the presentation terminalizer settles", async (t) => {
  let releasePresentation;
  let terminalizerStarted = false;
  const presentationBarrier = new Promise((resolve) => {
    releasePresentation = resolve;
  });
  const { controller, manager } = setup(t, {
    browserSurfaceAllocator: createReadyAllocator(),
    manager: createDynamicManager(),
    beforeBrowserSurfaceLeaseRelease: async () => {
      terminalizerStarted = true;
      await presentationBarrier;
    },
    runConnectorImpl: () => Promise.reject(new Error("connector child exited")),
  });

  await controller.runNow("managed", { manifest: MANIFEST, ownerToken: "owner-token", runId: "run_failure_restore" });
  await waitFor(() => terminalizerStarted, "ordinary child failure should enter the presentation terminalizer");
  assert.equal(manager.getLease("lease_1").status, "leased");

  releasePresentation();
  await waitFor(() => manager.getLease("lease_1").status === "released", "lease releases after ordinary failure terminalizer");
});

test("durable active-run row blocks managed manual and recovery admission before browser-surface acquisition", async (t) => {
  const allocator = createReadyAllocator();
  const manager = createManager();
  const durableRow = {
    connector_id: "managed",
    connector_instance_id: "managed",
    run_generation: 1,
    run_id: "run_existing_conflict",
    scenario_id: "scn_existing_conflict",
    started_at: "2026-05-12T12:00:00.000Z",
    trace_id: "trc_existing_conflict",
  };
  let runConnectorCalled = false;
  const controller = createController({
    browserSurfaceAllocator: allocator,
    browserSurfaceLeaseManager: manager,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createDurableConflictSchedulerStore(durableRow),
    runConnectorImpl: () => {
      runConnectorCalled = true;
      return Promise.resolve({ status: "succeeded", records_emitted: 0 });
    },
  });

  await assert.rejects(
    () =>
      controller.runNow("managed", {
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_manual_conflict",
        triggerKind: "manual",
      }),
    (err) => err.code === "run_already_active" && err.runId === "run_existing_conflict",
  );

  await assert.rejects(
    () =>
      controller.runNow("managed", {
        manifest: MANIFEST,
        ownerToken: "owner-token",
        recoveryContinuationDepth: 1,
        recoveryOnly: true,
        runId: "run_recovery_conflict",
        triggerKind: "manual",
      }),
    (err) => err.code === "run_already_active" && err.runId === "run_existing_conflict",
  );

  assert.equal(runConnectorCalled, false, "durable conflict must block connector launch");
  assert.equal(allocator.ensureRequests.length, 0, "durable conflict must block browser-surface acquisition");
  assert.equal(manager.listLeases().length, 0, "durable conflict must not create a lease");
});

test("canonical-url configured managed connector leases short-id run", async (t) => {
  const manager = createManager({
    managedConnectors: new Set(["https://registry.pdpp.org/connectors/chatgpt", "chatgpt"]),
    staticProfileKey: "chatgpt",
  });
  const { calls, controller, manager: leases } = setup(t, { manager });
  const manifest = {
    ...MANIFEST,
    connector_id: "chatgpt",
    name: "ChatGPT",
    capabilities: {},
  };

  const result = await controller.runNow("chatgpt", {
    manifest,
    ownerToken: "owner-token",
    runId: "run_canonical_url_short_id",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(calls.runConnector, 1);
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_REQUIRED, "neko");
  assert.equal(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_PROFILE_KEY, "chatgpt");
  assert.equal(leases.getLease("lease_1").connector_id, "chatgpt");
  assert.ok(listRunEventTypes("run_canonical_url_short_id").includes("run.browser_surface_requested"));
});

test("managed run emits browser-surface requested before starting before leased", async (t) => {
  const { controller } = setup(t);

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_starting_event",
  });
  await controller.drainActiveRuns(1000);
  await waitFor(
    () => listRunEventTypes("run_starting_event").includes("run.browser_surface_leased"),
    "browser-surface leased event should be emitted"
  );

  const eventTypes = listRunEventTypes("run_starting_event");
  assert.ok(eventTypes.includes("run.browser_surface_requested"));
  assert.ok(eventTypes.includes("run.browser_surface_starting"));
  assert.ok(
    eventTypes.indexOf("run.browser_surface_requested") < eventTypes.indexOf("run.browser_surface_starting"),
    "requested event should precede starting event"
  );
  assert.ok(
    eventTypes.indexOf("run.browser_surface_starting") < eventTypes.indexOf("run.browser_surface_leased"),
    "starting event should precede leased event"
  );
  if (eventTypes.includes("run.started")) {
    assert.ok(
      eventTypes.indexOf("run.browser_surface_leased") < eventTypes.indexOf("run.started"),
      "leased event should precede run.started"
    );
  }
});

test("dynamic starting surface does not spawn connector or emit run.started before readiness", async (t) => {
  const manager = createDynamicManager();
  const blocked = createBlockedAllocator();
  const { calls, controller, schedulerStore } = setup(t, {
    manager,
    browserSurfaceAllocator: blocked.allocator,
  });

  const runPromise = controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dynamic_blocked",
  });
  await waitFor(
    () => listRunEventTypes("run_dynamic_blocked").includes("run.browser_surface_starting"),
    "dynamic run should emit starting before waiting for readiness"
  );

  assert.equal(calls.runConnector, 0);
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(schedulerStore.listActiveRuns().length, 1);
  assert.equal(listRunEventTypes("run_dynamic_blocked").includes("run.started"), false);
  assert.equal(listRunEventTypes("run_dynamic_blocked").includes("run.browser_surface_leased"), false);

  blocked.unblock();
  const result = await runPromise;
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(calls.runConnector, 1);
  assert.ok(listRunEventTypes("run_dynamic_blocked").includes("run.browser_surface_leased"));
  assert.equal(schedulerStore.listActiveRuns().length, 0);
});

test("dynamic immediate-ready allocator leases then starts connector", async (t) => {
  const { calls, controller, manager } = setup(t, {
    manager: createDynamicManager(),
    browserSurfaceAllocator: createReadyAllocator(),
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dynamic_ready",
  });
  await controller.drainActiveRuns(1000);

  const eventTypes = listRunEventTypes("run_dynamic_ready");
  assert.equal(result.status, "started");
  assert.equal(calls.runConnector, 1);
  assert.equal(manager.getLease("lease_1").status, "released");
  assert.ok(eventTypes.indexOf("run.browser_surface_leased") < eventTypes.indexOf("run.started") || !eventTypes.includes("run.started"));
});

test("dynamic managed runs with distinct profile keys allocate separate ready surfaces", async (t) => {
  let releaseFirst;
  const allocator = createReadyAllocator();
  const manager = createDynamicManager({ surfaceCap: 2 });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_distinct_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, browserSurfaceAllocator: allocator, runConnectorImpl });

  const first = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_distinct_first",
  });
  const second = await controller.runNow("other-managed", {
    manifest: DISTINCT_PROFILE_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_distinct_second",
  });
  await waitFor(() => calls.runConnector === 2, "both distinct-profile dynamic runs should spawn under cap 2");

  assert.equal(first.status, "started");
  assert.equal(second.status, "started");
  assert.deepEqual(
    allocator.ensureRequests.map((request) => request.profileKey),
    ["managed-profile", "other-managed-profile"]
  );
  assert.equal(new Set(allocator.ensureRequests.map((request) => request.surfaceId)).size, 2);
  assert.notEqual(calls.runConnectorOpts[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_ID, calls.runConnectorOpts[1].browserSurfaceEnv.PDPP_BROWSER_SURFACE_ID);
  assert.deepEqual(
    calls.runConnectorOpts.map((opts) => opts.browserSurfaceEnv.PDPP_BROWSER_SURFACE_PROFILE_KEY),
    ["managed-profile", "other-managed-profile"]
  );

  releaseFirst();
  await controller.drainActiveRuns(1000);
  assert.equal(manager.getLease("lease_1").status, "released");
  assert.equal(manager.getLease("lease_2").status, "released");
});

test("dynamic capacity pressure stops incompatible idle surface and starts distinct-profile run", async (t) => {
  const allocator = createReadyAllocator();
  const browserSurfaceLeaseStore = createMemoryBrowserSurfaceLeaseStore();
  const { calls, controller, manager } = setup(t, {
    manager: createDynamicManager({ surfaceCap: 1 }),
    browserSurfaceAllocator: allocator,
    browserSurfaceLeaseStore,
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_pressure_first",
  });
  await controller.drainActiveRuns(1000);

  const result = await controller.runNow("other-managed", {
    manifest: DISTINCT_PROFILE_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_pressure_second",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.deepEqual(allocator.stopRequests.map((request) => request.reason), ["capacity_pressure"]);
  assert.deepEqual(allocator.stopRequests.map((request) => request.surfaceId), ["surface_1"]);
  assert.deepEqual(
    allocator.ensureRequests.map((request) => request.profileKey),
    ["managed-profile", "other-managed-profile"]
  );
  assert.equal(calls.runConnector, 2);
  assert.equal(manager.getSurface("surface_1").health, "stopping");
  assert.equal(manager.getLease("lease_2").status, "released");
  assert.equal((await browserSurfaceLeaseStore.getSurface("surface_1")).health, "stopping");
  assert.ok(listRunEventTypes("run_pressure_second").includes("run.browser_surface_starting"));
  assert.ok(listRunEventTypes("run_pressure_second").includes("run.browser_surface_leased"));
});

test("dynamic capacity-pressure stop failure retries a bounded number of times, then leaves distinct-profile run queued", async (t) => {
  const allocator = createStopFailingAllocator();
  const { calls, controller, manager } = setup(t, {
    manager: createDynamicManager({ surfaceCap: 1 }),
    browserSurfaceAllocator: allocator,
    browserSurfaceReclaimRetryAttempts: 3,
    browserSurfaceReclaimRetryDelayMs: 0,
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stop_failure_first",
  });
  await controller.drainActiveRuns(1000);

  const queued = await controller.runNow("other-managed", {
    manifest: DISTINCT_PROFILE_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stop_failure_second",
  });

  assert.equal(queued.status, "waiting_for_browser_surface");
  assert.equal(queued.browser_surface.browser_surface_wait_reason, "capacity_full");
  // Every attempt in the allocator's stop call failed, so the bounded retry
  // exhausts all 3 configured attempts before giving up — a single transient
  // failure alone (the 2026-07-10 incident) must not be the end of the story.
  assert.deepEqual(
    allocator.stopRequests.map((request) => request.reason),
    ["capacity_pressure", "capacity_pressure", "capacity_pressure"]
  );
  assert.equal(allocator.ensureRequests.length, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(manager.getSurface("surface_1").health, "ready");
  assert.equal(manager.getLease("lease_2").status, "waiting_for_browser_surface");
  assert.equal(controller.getActiveRun("other-managed"), null);
  assert.equal(listRunEventTypes("run_stop_failure_second").includes("run.started"), false);
  // Two retries were attempted (attempts 2 and 3), each observable as a
  // distinct reclaim-retry event before the reclaim was ultimately abandoned.
  assert.equal(
    listRunEventTypes("run_stop_failure_second").filter((type) => type === "run.browser_surface_reclaim_retry").length,
    2
  );
});

test("dynamic capacity-pressure stop failure recovers on retry and promotes the queued run", async (t) => {
  const allocator = createStopFailingAllocator();
  let attempts = 0;
  const originalStopSurface = allocator.stopSurface;
  allocator.stopSurface = async (request) => {
    attempts += 1;
    if (attempts < 2) {
      return originalStopSurface(request);
    }
    allocator.stopRequests.push(request);
    return { ...request, surface_id: request.surfaceId, backend: "neko", health: "stopping" };
  };
  const { calls, controller, manager } = setup(t, {
    manager: createDynamicManager({ surfaceCap: 1 }),
    browserSurfaceAllocator: allocator,
    browserSurfaceReclaimRetryAttempts: 3,
    browserSurfaceReclaimRetryDelayMs: 0,
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stop_recovery_first",
  });
  await controller.drainActiveRuns(1000);

  await controller.runNow("other-managed", {
    manifest: DISTINCT_PROFILE_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stop_recovery_second",
  });

  // First attempt failed, second attempt (the retry) succeeded: the reclaim
  // completed and the queued lease promoted within the same acquire call —
  // no owner intervention, no separate sweep tick needed for this case.
  assert.equal(attempts, 2);
  assert.equal(calls.runConnector, 2);
  assert.equal(manager.getLease("lease_2").status, "leased");
  assert.equal(
    listRunEventTypes("run_stop_recovery_second").filter((type) => type === "run.browser_surface_reclaim_retry").length,
    1
  );
});

test("dynamic cap queues distinct-profile managed run, then promotes after incompatible idle cleanup", async (t) => {
  let releaseFirst;
  let now = new Date("2026-05-12T12:00:00.000Z");
  const allocator = createReadyAllocator();
  const manager = createDynamicManager({ surfaceCap: 1, leaseWaitTimeoutMs: 1_800_000, now: () => now });
  const browserSurfaceLeaseStore = createMemoryBrowserSurfaceLeaseStore();
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_dynamic_cap_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, browserSurfaceAllocator: allocator, browserSurfaceLeaseStore, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dynamic_cap_first",
  });
  const queued = await controller.runNow("other-managed", {
    manifest: DISTINCT_PROFILE_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dynamic_cap_second",
  });

  assert.equal(queued.status, "waiting_for_browser_surface");
  assert.equal(queued.browser_surface.browser_surface_wait_reason, "capacity_full");
  assert.equal(calls.runConnector, 1);
  assert.equal(allocator.ensureRequests.length, 1);
  assert.equal(allocator.ensureRequests[0].profileKey, "managed-profile");
  assert.equal(controller.getActiveRun("other-managed"), null);
  assert.equal(listRunEventTypes("run_dynamic_cap_second").includes("run.started"), false);

  releaseFirst();
  await controller.drainActiveRuns(1000);

  assert.equal(allocator.ensureRequests.length, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(manager.getLease("lease_1").status, "released");
  assert.equal(manager.getLease("lease_2").status, "waiting_for_browser_surface");
  assert.deepEqual(manager.listSurfaces().map((surface) => ({ id: surface.surface_id, health: surface.health, profile: surface.profile_key, active: surface.active_lease_id ?? null, last: surface.last_used_at })), [
    {
      id: "surface_1",
      health: "ready",
      profile: "managed-profile",
      active: null,
      last: "2026-05-12T12:00:00.000Z",
    },
  ]);

  now = new Date("2026-05-12T12:10:01.000Z");
  const promoted = await controller.cleanupIdleBrowserSurfaces();
  assert.deepEqual(allocator.stopRequests.map((request) => request.surfaceId), ["surface_1"]);
  assert.deepEqual(manager.listSurfaces().map((surface) => surface.surface_id), ["surface_2"]);
  assert.deepEqual(promoted.map((lease) => lease.pending_run_id), ["run_dynamic_cap_second"]);
  assert.deepEqual(await browserSurfaceLeaseStore.getSurface("surface_1"), {
    surface_id: "surface_1",
    backend: "neko",
    profile_key: "managed-profile",
    connector_id: "managed",
    cdp_url: "http://127.0.0.1:9222/surface_1",
    stream_base_url: "http://127.0.0.1:8080/surface_1",
    health: "stopping",
    created_at: "2026-05-12T12:00:00.000Z",
    last_used_at: "2026-05-12T12:10:01.000Z",
  });
  assert.equal((await browserSurfaceLeaseStore.getLease("lease_2")).status, "starting_surface");
  assert.equal((await browserSurfaceLeaseStore.getSurface("surface_2")).health, "starting");

  await waitFor(() => allocator.ensureRequests.length === 2, "queued dynamic run should allocate after idle cleanup frees cap");
  await waitFor(() => calls.runConnector === 2, "queued dynamic run should spawn after allocator readiness");
  await controller.drainActiveRuns(1000);

  assert.deepEqual(allocator.stopRequests.map((request) => request.surfaceId), ["surface_1"]);
  assert.deepEqual(
    allocator.ensureRequests.map((request) => request.profileKey),
    ["managed-profile", "other-managed-profile"]
  );
  assert.equal(manager.getLease("lease_2").status, "released");
  assert.ok(listRunEventTypes("run_dynamic_cap_second").includes("run.browser_surface_starting"));
  assert.ok(listRunEventTypes("run_dynamic_cap_second").includes("run.browser_surface_leased"));
  assert.equal(calls.runConnectorOpts[1].runId, "run_dynamic_cap_second");
});

test("persisted stopping dynamic surface does not consume cap after rehydration", async () => {
  const store = createMemoryBrowserSurfaceLeaseStore({
    surfaces: [
      {
        surface_id: "surface_stopped",
        backend: "neko",
        profile_key: "managed-profile",
        connector_id: "managed",
        cdp_url: "http://127.0.0.1:9222/surface_stopped",
        stream_base_url: "http://127.0.0.1:8080/surface_stopped",
        health: "stopping",
        created_at: "2026-05-12T12:00:00.000Z",
        last_used_at: "2026-05-12T12:10:01.000Z",
      },
    ],
    leases: [
      {
        lease_id: "lease_waiting",
        connector_id: "other-managed",
        profile_key: "other-managed-profile",
        run_id: "run_after_restart",
        status: "waiting_for_browser_surface",
        priority_class: "interactive",
        requested_at: "2026-05-12T12:10:02.000Z",
        expires_at: "2026-05-12T12:40:02.000Z",
        fencing_token: 0,
        wait_reason: "capacity_full",
      },
    ],
  });
  const manager = new BrowserSurfaceLeaseManager({
    config: createDynamicManager({ surfaceCap: 1 }).config,
    initialSurfaces: await store.listSurfaces(),
    initialLeases: await store.listNonTerminalLeases(),
    now: () => new Date("2026-05-12T12:10:03.000Z"),
    makeSurfaceId: () => "surface_promoted",
    nextFencingToken: () => 7,
  });

  const promoted = manager.pumpQueuedLeases();

  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].lease_id, "lease_waiting");
  assert.equal(promoted[0].status, "starting_surface");
  assert.equal(promoted[0].surface_id, "surface_promoted");
  assert.deepEqual(
    manager.listSurfaces().map((surface) => ({ id: surface.surface_id, health: surface.health })),
    [
      { id: "surface_stopped", health: "stopping" },
      { id: "surface_promoted", health: "starting" },
    ]
  );
});

test("dynamic allocator failure emits browser-surface failed without spawning connector", async (t) => {
  const { calls, controller, manager, schedulerStore } = setup(t, {
    manager: createDynamicManager(),
    browserSurfaceAllocator: createFailingAllocator(),
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_dynamic_failed",
  });

  const events = listRunEvents("run_dynamic_failed");
  assert.equal(result.status, "surface_failed");
  assert.equal(manager.getLease("lease_1").status, "surface_failed");
  assert.equal(calls.runConnector, 0);
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.clearNonce, 1);
  assert.equal(schedulerStore.listActiveRuns().length, 0);
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_failed"));
  assert.equal(events.some((event) => event.event_type === "run.started"), false);
});

test("dynamic allocator failure clears the reservation and admits the next run", async (t) => {
  const { calls, controller, schedulerStore } = setup(t, {
    manager: createDynamicManager(),
    browserSurfaceAllocator: createFailingAllocator(),
  });

  const failed = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_allocator_failure",
  });

  assert.equal(failed.status, "surface_failed");
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.clearNonce, 1);
  assert.equal(schedulerStore.listActiveRuns().length, 0);
  assert.equal(controller.getActiveRun("managed"), null);

  const recoveryController = createController({
    browserSurfaceAllocator: createReadyAllocator(),
    browserSurfaceLeaseManager: createDynamicManager(),
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore,
    streamingTargetNonceHooks: {
      registerNonce: () => {
        calls.registerNonce += 1;
      },
      clearNonce: () => {
        calls.clearNonce += 1;
      },
    },
    runConnectorImpl: (opts) => {
      calls.runConnector += 1;
      calls.runConnectorOpts.push(opts);
      return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
    },
  });

  const admitted = await recoveryController.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_allocator_recovery",
  });
  await recoveryController.drainActiveRuns(1000);

  assert.equal(admitted.status, "started");
  assert.equal(calls.runConnector, 1);
  assert.equal(calls.persistActiveRun, 2);
  assert.equal(calls.clearNonce, 2);
  assert.equal(schedulerStore.listActiveRuns().length, 0);
});

test("managed run emits browser-surface cancelled when manual action is cancelled", async (t) => {
  const runConnectorImpl = async (opts) => {
    const response = await opts.onInteraction({
      kind: "manual_action",
      request_id: "int_cancel_surface",
      message: "cancel me",
    });
    return { status: response.status, records_emitted: 0, state: null, checkpoint_summary: null };
  };
  const { controller } = setup(t, { runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_cancel_event",
  });
  await waitFor(
    () => controller.getPendingInteraction("run_cancel_event")?.interaction_id === "int_cancel_surface",
    "manual action should become pending"
  );
  controller.respondToInteraction("run_cancel_event", {
    interaction_id: "int_cancel_surface",
    status: "cancelled",
  });
  await controller.drainActiveRuns(1000);
  await waitFor(
    () => listRunEventTypes("run_cancel_event").includes("run.browser_surface_cancelled"),
    "browser-surface cancelled event should be emitted"
  );
});

test("managed cap-full second connector queues and clears its transient reservation", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller, schedulerStore } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  const queued = await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_second",
  });

  assert.equal(queued.status, "waiting_for_browser_surface");
  assert.equal(queued.browser_surface.browser_surface_wait_reason, "capacity_full");
  assert.equal(manager.getLease("lease_2").priority_class, "interactive");
  assert.equal(calls.persistActiveRun, 2);
  assert.equal(calls.registerNonce, 2);
  assert.equal(calls.clearNonce, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(controller.getActiveRun("managed").run_id, "run_first");
  assert.equal(controller.getActiveRun("other-managed"), null);
  assert.deepEqual(
    schedulerStore.listActiveRuns().map((row) => row.run_id),
    ["run_first"]
  );
  assert.deepEqual(controller.listBrowserSurfaceRunProjections().find((run) => run.pending_run_id === "run_second"), {
    connector_id: "other-managed",
    pending_run_id: "run_second",
    browser_surface_status: "waiting_for_browser_surface",
    browser_surface_lease_id: "lease_2",
    browser_surface_profile_key: "managed-profile",
    browser_surface_wait_reason: "capacity_full",
  });

  releaseFirst();
  await waitFor(() => calls.runConnector === 2, "queued browser-surface run should be promoted and spawned");
  await controller.drainActiveRuns(1000);
  assert.equal(manager.getLease("lease_2").status, "released");
  assert.equal(controller.getActiveRun("other-managed"), null);
});

test("queued browser-surface cancellation emits event and promotes next waiter", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_cancelled_waiter",
  });

  const cancelled = await controller.cancelBrowserSurfaceRun("run_cancelled_waiter");

  assert.equal(cancelled?.browser_surface_status, "cancelled");
  assert.equal(manager.getLease("lease_2").status, "cancelled");
  assert.ok(listRunEventTypes("run_cancelled_waiter").includes("run.browser_surface_cancelled"));

  releaseFirst();
  await controller.drainActiveRuns(1000);
  assert.equal(calls.runConnector, 1);
});

test("queued browser-surface timeout emits deferred event without connector failure", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile", leaseWaitTimeoutMs: 0 });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { calls, controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_timed_out_waiter",
  });
  const expired = await controller.expireBrowserSurfaceWaits();

  assert.equal(expired.length, 1);
  assert.equal(expired[0].browser_surface_status, "deferred");
  assert.equal(expired[0].browser_surface_wait_reason, "lease_wait_timeout");
  const events = listRunEvents("run_timed_out_waiter");
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_deferred"));
  assert.equal(events.some((event) => event.event_type === "run.failed"), false);

  releaseFirst();
  await controller.drainActiveRuns(1000);
  assert.equal(calls.runConnector, 1);
});

test("managed acquisition expires stale queued lease before duplicate detection", async (t) => {
  let releaseFirst;
  let nowMs = Date.parse("2026-05-12T12:00:00.000Z");
  const manager = createManager({
    surfaceCap: 1,
    staticProfileKey: "managed-profile",
    leaseWaitTimeoutMs: 1000,
    now: () => new Date(nowMs),
  });
  const store = createMemoryBrowserSurfaceLeaseStore();
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller } = setup(t, { browserSurfaceLeaseStore: store, manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  const queued = await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_stale_waiter",
  });

  assert.equal(queued.status, "waiting_for_browser_surface");
  assert.equal(manager.getLease("lease_2").status, "waiting_for_browser_surface");
  assert.equal(store.leases.get("lease_2").status, "waiting_for_browser_surface");

  nowMs += 2000;
  const retry = await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_retry",
  });

  assert.equal(retry.status, "waiting_for_browser_surface");
  assert.equal(retry.browser_surface.browser_surface_lease_id, "lease_3");
  assert.equal(manager.getLease("lease_2").status, "deferred");
  assert.equal(manager.getLease("lease_2").wait_reason, "lease_wait_timeout");
  assert.equal(store.leases.get("lease_2").status, "deferred");
  assert.equal(store.leases.get("lease_2").wait_reason, "lease_wait_timeout");
  assert.ok(listRunEventTypes("run_stale_waiter").includes("run.browser_surface_deferred"));

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("promotion precondition failure defers lease instead of recording clean release", async (t) => {
  let releaseFirst;
  let promotedRunPathResolutions = 0;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller } = setup(t, {
    manager,
    runConnectorImpl,
    connectorPathResolver: (_connectorId, _manifest, options) => {
      if (options?.runId !== "run_promotion_failure") {
        return "/tmp/connector.js";
      }
      promotedRunPathResolutions += 1;
      return promotedRunPathResolutions > 1 ? null : "/tmp/connector.js";
    },
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_promotion_failure",
  });

  releaseFirst();
  await waitFor(
    () => manager.getLease("lease_2")?.status === "deferred",
    "promotion failure should terminally defer the promoted lease"
  );

  const failedLease = manager.getLease("lease_2");
  assert.equal(failedLease.status, "deferred");
  assert.equal(failedLease.wait_reason, "launch_precondition_failed");
  const events = listRunEvents("run_promotion_failure");
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_deferred"));
  assert.equal(events.some((event) => event.event_type === "run.browser_surface_released"), false);
});

test("managed connector with active run rejects without acquiring a new lease", async (t) => {
  let releaseFirst;
  const manager = createDynamicManager({ surfaceCap: 2 });
  const runConnectorImpl = () =>
    new Promise((resolve) => {
      releaseFirst = () => resolve({ status: "completed" });
    });
  const { controller } = setup(t, { manager, browserSurfaceAllocator: createReadyAllocator(), runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_active",
  });

  await assert.rejects(
    () =>
      controller.runNow("managed", {
        manifest: MANIFEST,
        ownerToken: "owner-token",
        runId: "run_duplicate",
      }),
    /Connector already has an active run/
  );

  assert.equal(manager.listLeases().length, 1);

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("duplicate queued managed connector request reports existing pending run", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile" });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller, manager: leases } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_waiting",
  });

  await assert.rejects(
    () =>
      controller.runNow("other-managed", {
        manifest: OTHER_MANAGED_MANIFEST,
        ownerToken: "owner-token",
        runId: "run_duplicate_wait",
      }),
    (err) => {
      assert.equal(err.code, "run_browser_surface_queued");
      assert.equal(err.runId, "run_waiting");
      return true;
    }
  );

  assert.equal(leases.listLeases().length, 2);

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("incompatible static profile defers and clears its transient reservation", async (t) => {
  const { calls, controller, schedulerStore } = setup(t, {
    manager: createManager({ staticProfileKey: "other-profile" }),
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_deferred",
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.browser_surface.browser_surface_wait_reason, "incompatible_static_profile");
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.registerNonce, 1);
  assert.equal(calls.clearNonce, 1);
  assert.equal(calls.runConnector, 0);
  assert.equal(controller.getActiveRun("managed"), null);
  assert.equal(schedulerStore.listActiveRuns().length, 0);
  assert.deepEqual(controller.listBrowserSurfaceRunProjections().find((run) => run.pending_run_id === "run_deferred"), {
    connector_id: "managed",
    pending_run_id: "run_deferred",
    browser_surface_status: "deferred",
    browser_surface_lease_id: "lease_1",
    browser_surface_profile_key: "managed-profile",
    browser_surface_wait_reason: "incompatible_static_profile",
  });
});

test("release frees the lease for the next managed run", async (t) => {
  const { controller, manager } = setup(t);

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_one",
  });
  await controller.drainActiveRuns(1000);

  const second = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_two",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(second.status, "started");
  assert.equal(manager.getLease("lease_1").status, "released");
  assert.equal(manager.getLease("lease_2").status, "released");
});

// ─── Periodic sweep (openspec/changes/fix-browser-surface-capacity-self-heal) ─

test("sweep terminalizes a past-TTL waiting lease with no other run acquiring anything", async (t) => {
  let releaseFirst;
  const manager = createManager({ surfaceCap: 1, staticProfileKey: "managed-profile", leaseWaitTimeoutMs: 0 });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_sweep_first") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller } = setup(t, { manager, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sweep_first",
  });
  await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sweep_waiter",
  });

  assert.equal(manager.getLease("lease_2").status, "waiting_for_browser_surface");

  // The sweep alone — not another run's acquisition — terminalizes the
  // past-TTL waiting lease. This is the exact gap the 2026-07-10 incident
  // exposed: expiry previously only happened as a side effect of some other
  // run's acquire attempt.
  await controller.sweepBrowserSurfaceLeases();

  assert.equal(manager.getLease("lease_2").status, "deferred");
  assert.equal(manager.getLease("lease_2").wait_reason, "lease_wait_timeout");
  const events = listRunEvents("run_sweep_waiter");
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_deferred"));

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("sweep reconciles a ready surface whose backing container has already exited", async (t) => {
  const allocator = createReadyAllocator();
  const manager = createDynamicManager({ surfaceCap: 3 });
  const { controller } = setup(t, { manager, browserSurfaceAllocator: allocator });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_reconcile_first",
  });
  await controller.drainActiveRuns(1000);

  assert.equal(manager.getSurface("surface_1").health, "ready");

  // Simulate the container exiting mid-uptime, discovered only by the
  // allocator's live view — the manager's in-memory copy still says "ready"
  // until something re-asks the allocator. Boot-time reconciliation would
  // have caught this only on the next restart; the periodic sweep catches it
  // without one.
  await allocator.stopSurface({ surfaceId: "surface_1", reason: "operator" });

  await controller.sweepBrowserSurfaceLeases();

  assert.equal(manager.getSurface("surface_1"), undefined);
});

test("sweep retries capacity-pressure reclaim for a lease still queued after expiry", async (t) => {
  const allocator = createStopFailingAllocator();
  let attempts = 0;
  const originalStopSurface = allocator.stopSurface;
  allocator.stopSurface = async (request) => {
    attempts += 1;
    if (attempts < 2) {
      return originalStopSurface(request);
    }
    allocator.stopRequests.push(request);
    return { ...request, surface_id: request.surfaceId, backend: "neko", health: "stopping" };
  };
  const manager = createDynamicManager({ surfaceCap: 1 });
  const { calls, controller } = setup(t, {
    manager,
    browserSurfaceAllocator: allocator,
    browserSurfaceReclaimRetryAttempts: 1,
    browserSurfaceReclaimRetryDelayMs: 0,
  });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sweep_reclaim_first",
  });
  await controller.drainActiveRuns(1000);

  await controller.runNow("other-managed", {
    manifest: DISTINCT_PROFILE_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sweep_reclaim_second",
  });

  // The acquire-path's own bounded retry (1 attempt) exhausted without
  // recovering; the lease is still queued on capacity_full.
  assert.equal(manager.getLease("lease_2").status, "waiting_for_browser_surface");
  assert.equal(calls.runConnector, 1);

  // The periodic sweep's own reclaim attempt is the retry that succeeds —
  // this is the cross-run trigger the incident's Defect A lacked: capacity
  // reclaim is no longer gated on the stranded run's own request path ever
  // running again.
  await controller.sweepBrowserSurfaceLeases();
  await waitFor(() => calls.runConnector === 2, "reclaimed lease should promote and spawn after sweep");
  await controller.drainActiveRuns(1000);

  // The default mock connector resolves immediately, so by the time the run
  // drains the lease has already completed its lifecycle to `released` —
  // the meaningful assertion is that it was NOT abandoned in
  // `waiting_for_browser_surface`/`deferred`, and the connector actually ran.
  assert.equal(manager.getLease("lease_2").status, "released");
  assert.equal(calls.runConnector, 2);
});

test("sweep never touches an active leased run", async (t) => {
  let releaseFirst;
  const allocator = createReadyAllocator();
  const manager = createDynamicManager({ surfaceCap: 1 });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_sweep_active") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller, manager: managerRef } = setup(t, { manager, browserSurfaceAllocator: allocator, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sweep_active",
  });

  assert.equal(managerRef.getLease("lease_1").status, "leased");

  await controller.sweepBrowserSurfaceLeases();

  assert.equal(managerRef.getLease("lease_1").status, "leased");
  assert.equal(managerRef.getSurface("surface_1").health, "ready");
  assert.equal(managerRef.getSurface("surface_1").active_lease_id, "lease_1");

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("sweep DOES reconcile a leased run whose surface the allocator confirms is gone — this is the deliberate dead-surface reconciliation, not an exemption violation", async (t) => {
  let releaseFirst;
  const allocator = createReadyAllocator();
  const manager = createDynamicManager({ surfaceCap: 1 });
  const runConnectorImpl = (opts) => {
    if (opts.runId === "run_sweep_dead_surface") {
      return new Promise((resolve) => {
        releaseFirst = () => resolve({ status: "completed" });
      });
    }
    return Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  };
  const { controller, manager: managerRef } = setup(t, { manager, browserSurfaceAllocator: allocator, runConnectorImpl });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_sweep_dead_surface",
  });

  assert.equal(managerRef.getLease("lease_1").status, "leased");

  // Simulate the allocator's own view of the surface disappearing (the same
  // fixture convention "sweep reconciles a ready surface whose backing
  // container has already exited" uses above): calling stopSurface directly
  // on the fake allocator removes it from the allocator's internal map, so
  // the manager's NEXT getSurfaceStatus call — inside
  // reconcileSurfacesWithAllocator — returns null, meaning "cannot prove
  // this surface is live". This is the exact live-incident shape (a ready
  // row over an exited container the manager does not yet know about).
  const surfaceStatus = await allocator.getSurfaceStatus("surface_1");
  assert.ok(surfaceStatus, "precondition: the surface is registered with the allocator before it disappears");
  await allocator.stopSurface({ surfaceId: "surface_1", reason: "operator" });

  await controller.sweepBrowserSurfaceLeases();

  // The sweep DID mutate this leased lease and surface — the requirement's
  // "SHALL NOT reclaim/expire/mutate a leased lease" scope is explicitly
  // "whose surface the allocator confirms is still live", not "any leased
  // lease unconditionally". A dead-per-allocator surface is not exempt.
  assert.equal(managerRef.getLease("lease_1").status, "surface_failed");
  assert.equal(managerRef.getSurface("surface_1"), undefined);

  releaseFirst();
  await controller.drainActiveRuns(1000);
});

test("overlapping sweep calls: the second is a no-op while the first is in flight", async (t) => {
  const allocator = createReadyAllocator();
  const manager = createDynamicManager({ surfaceCap: 3 });
  const { controller } = setup(t, { manager, browserSurfaceAllocator: allocator });

  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_overlap_first",
  });
  await controller.drainActiveRuns(1000);

  // Install the blocking override only AFTER the initial run settles — the
  // acquire path's own readiness wait already calls getSurfaceStatus once
  // per lease, so blocking from the start would hang run setup itself
  // rather than isolating the sweep's own allocator round trip.
  let unblockAllocator;
  const blockedGate = new Promise((resolve) => {
    unblockAllocator = resolve;
  });
  let getSurfaceStatusCalls = 0;
  const originalGetSurfaceStatus = allocator.getSurfaceStatus;
  allocator.getSurfaceStatus = async (surfaceId) => {
    getSurfaceStatusCalls += 1;
    if (getSurfaceStatusCalls === 1) {
      await blockedGate;
    }
    return originalGetSurfaceStatus(surfaceId);
  };

  const firstSweep = controller.sweepBrowserSurfaceLeases();
  const secondSweep = controller.sweepBrowserSurfaceLeases();

  // The second call must resolve immediately (no-op) rather than waiting on
  // the first sweep's blocked allocator round trip.
  await secondSweep;
  assert.equal(getSurfaceStatusCalls, 1);

  unblockAllocator();
  await firstSweep;
});
