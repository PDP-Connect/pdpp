import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-controller-bsl-"));
  return path.join(dir, "pdpp.sqlite");
}

function createSchedulerStore(calls) {
  const activeRuns = new Map();
  return {
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
  const { surfaceCap = 1, leaseWaitTimeoutMs = 300_000, now = () => new Date("2026-05-12T12:00:00.000Z") } = options;
  const staticProfileKey = Object.hasOwn(options, "staticProfileKey") ? options.staticProfileKey : "managed-profile";
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed", "other-managed"]),
      surfaceCap,
      staticProfileKey,
      staticCdpHttpUrl: "http://127.0.0.1:9222/json/version",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs,
      idleTtlMs: 600_000,
      defaultPriorityClass: "scheduled_refresh",
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
    persistActiveRun: 0,
    registerNonce: 0,
    runConnector: 0,
    runConnectorOpts: [],
  };
  const controller = createController({
    browserSurfaceAllocator,
    browserSurfaceLeaseManager: manager,
    browserSurfaceLeaseStore,
    browserSurfaceReadinessTimeoutMs,
    connectorPathResolver,
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(calls),
    streamingTargetNonceHooks: {
      registerNonce: () => {
        calls.registerNonce += 1;
      },
      clearNonce: () => {},
    },
    runConnectorImpl: (opts) => {
      calls.runConnector += 1;
      calls.runConnectorOpts.push(opts);
      return runConnectorImpl
        ? runConnectorImpl(opts)
        : Promise.resolve({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
    },
  });
  return { calls, controller, manager };
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
  const { calls, controller } = setup(t, {
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
  assert.equal(calls.persistActiveRun, 0);
  assert.equal(listRunEventTypes("run_dynamic_blocked").includes("run.started"), false);
  assert.equal(listRunEventTypes("run_dynamic_blocked").includes("run.browser_surface_leased"), false);

  blocked.unblock();
  const result = await runPromise;
  await controller.drainActiveRuns(1000);

  assert.equal(result.status, "started");
  assert.equal(calls.runConnector, 1);
  assert.ok(listRunEventTypes("run_dynamic_blocked").includes("run.browser_surface_leased"));
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

test("dynamic capacity-pressure stop failure leaves distinct-profile run queued", async (t) => {
  const allocator = createStopFailingAllocator();
  const { calls, controller, manager } = setup(t, {
    manager: createDynamicManager({ surfaceCap: 1 }),
    browserSurfaceAllocator: allocator,
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
  assert.deepEqual(allocator.stopRequests.map((request) => request.reason), ["capacity_pressure"]);
  assert.equal(allocator.ensureRequests.length, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(manager.getSurface("surface_1").health, "ready");
  assert.equal(manager.getLease("lease_2").status, "waiting_for_browser_surface");
  assert.equal(controller.getActiveRun("other-managed"), null);
  assert.equal(listRunEventTypes("run_stop_failure_second").includes("run.started"), false);
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
        priority_class: "owner_interactive",
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
  const { calls, controller, manager } = setup(t, {
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
  assert.equal(calls.persistActiveRun, 0);
  assert.ok(events.some((event) => event.event_type === "run.browser_surface_failed"));
  assert.equal(events.some((event) => event.event_type === "run.started"), false);
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

test("managed cap-full second connector queues without active-run, nonce, or spawn side effects", async (t) => {
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
  const queued = await controller.runNow("other-managed", {
    manifest: OTHER_MANAGED_MANIFEST,
    ownerToken: "owner-token",
    runId: "run_second",
  });

  assert.equal(queued.status, "waiting_for_browser_surface");
  assert.equal(queued.browser_surface.browser_surface_wait_reason, "capacity_full");
  assert.equal(manager.getLease("lease_2").priority_class, "owner_interactive");
  assert.equal(calls.persistActiveRun, 1);
  assert.equal(calls.registerNonce, 1);
  assert.equal(calls.runConnector, 1);
  assert.equal(controller.getActiveRun("managed").run_id, "run_first");
  assert.equal(controller.getActiveRun("other-managed"), null);
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

test("incompatible static profile defers without active-run, nonce, or spawn side effects", async (t) => {
  const { calls, controller } = setup(t, {
    manager: createManager({ staticProfileKey: "other-profile" }),
  });

  const result = await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_deferred",
  });

  assert.equal(result.status, "deferred");
  assert.equal(result.browser_surface.browser_surface_wait_reason, "incompatible_static_profile");
  assert.equal(calls.persistActiveRun, 0);
  assert.equal(calls.registerNonce, 0);
  assert.equal(calls.runConnector, 0);
  assert.equal(controller.getActiveRun("managed"), null);
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
