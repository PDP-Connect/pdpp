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
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { makeTemporaryDbPath } from "./helpers/temp-dir.js";
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "@opendatalabs/remote-surface/leases";
import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { createTraceContext, emitSpineEvent } from "../lib/spine.ts";
import { createBrowserSurfaceManager } from "../runtime/browser-surface/run-coordinator.ts";
import { createSqliteBrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import { getDefaultBrowserSurfaceReplacementReceiptStore } from "../server/stores/browser-surface-replacement-ledger-store.ts";

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

function tempDbPath() {
  return makeTemporaryDbPath("pdpp-controller-rdy-");
}

function createSchedulerStore() {
  const activeRuns = new Map();
  return {
    listActiveRuns: () => [...activeRuns.values()],
    upsertActiveRun: (record) => {
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

function createManagerWithReadySurface(surfaceOverrides = {}) {
  let leaseSeq = 0;
  let tokenSeq = 0;
  const manager = new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed"]),
      surfaceCap: 1,
      staticProfileKey: "managed-profile",
      staticCdpHttpUrl: "http://127.0.0.1:9222",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 600_000,
      defaultPriorityClass: "background",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: "static",
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_static`,
    nextFencingToken: () => ++tokenSeq,
    initialSurfaces: [
      {
        surface_id: "surface_static",
        backend: "neko",
        profile_key: "managed-profile",
        connector_id: "managed",
        cdp_url: "http://127.0.0.1:9222",
        stream_base_url: "http://127.0.0.1:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
  });
  if (Object.keys(surfaceOverrides).length > 0) {
    const getSurface = manager.getSurface.bind(manager);
    manager.getSurface = (surfaceId) => {
      const surface = getSurface(surfaceId);
      return surface ? { ...surface, ...surfaceOverrides } : surface;
    };
  }
  return manager;
}

function createDynamicManagerWithReadySurface({ initialActiveLease = false, runId = "run_dynamic_1" } = {}) {
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed"]),
      surfaceCap: 1,
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 600_000,
      defaultPriorityClass: "background",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: "dynamic",
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_dynamic_${++surfaceSeq}`,
    nextFencingToken: () => ++tokenSeq,
    initialSurfaces: [
      {
        surface_id: "surface_stale",
        backend: "neko",
        profile_key: "managed-profile",
        connector_id: "managed",
        cdp_url: "http://stale:9223",
        stream_base_url: "http://stale:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
        ...(initialActiveLease ? { active_lease_id: "lease_dynamic_1" } : {}),
      },
    ],
    initialLeases: initialActiveLease
      ? [
          {
            lease_id: "lease_dynamic_1",
            surface_id: "surface_stale",
            connector_id: "managed",
            profile_key: "managed-profile",
            run_id: runId,
            status: "leased",
            priority_class: "background",
            requested_at: "2026-05-12T11:00:00.000Z",
            leased_at: "2026-05-12T11:00:01.000Z",
            fencing_token: 1,
          },
        ]
      : undefined,
  });
}

function createReadyDynamicAllocator(initialSurfaces = []) {
  const surfaces = new Map(initialSurfaces.map((surface) => [surface.surface_id, surface]));
  const ensureRequests = [];
  const stopRequests = [];
  return {
    allocator: {
      ensureSurface: async (request) => {
        ensureRequests.push(request);
        const surface = {
          surface_id: request.surfaceId,
          backend: "neko",
          profile_key: request.profileKey,
          connector_id: request.connectorId,
          cdp_url: `http://${request.surfaceId}:9223`,
          stream_base_url: `http://${request.surfaceId}:8080`,
          health: "ready",
          created_at: "2026-05-12T12:00:01.000Z",
          last_used_at: "2026-05-12T12:00:01.000Z",
          ...(request.surfaceSubjectId ? { surface_subject_id: request.surfaceSubjectId } : {}),
        };
        surfaces.set(request.surfaceId, surface);
        return surface;
      },
      getSurfaceStatus: async (surfaceId) => surfaces.get(surfaceId) ?? null,
      stopSurface: async (request) => {
        stopRequests.push(request);
        const surface = surfaces.get(request.surfaceId) ?? null;
        surfaces.delete(request.surfaceId);
        return surface ? { ...surface, health: "stopping" } : null;
      },
      listSurfaces: async () => [...surfaces.values()],
    },
    ensureRequests,
    stopRequests,
  };
}

function setup(t, { browserSurfaceAllocator, browserSurfaceLeaseStore, probe, leaseManager, runConnectorImpl } = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const runConnectorCalls = [];
  const controller = createController({
    ...(browserSurfaceAllocator ? { browserSurfaceAllocator } : {}),
    ...(browserSurfaceLeaseStore ? { browserSurfaceLeaseStore } : {}),
    browserSurfaceLeaseManager: leaseManager || createManagerWithReadySurface(),
    browserSurfaceReadinessProbe: probe,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: (opts) => {
      runConnectorCalls.push(opts);
      if (runConnectorImpl) {
        return Promise.resolve(runConnectorImpl(opts));
      }
      return Promise.resolve({
        status: "completed",
        records_emitted: 0,
        state: null,
        checkpoint_summary: null,
      });
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
  return { message: SESSION_CLOSED_MESSAGE, code: BROWSER_SURFACE_ATTACH_EXHAUSTED_CODE, retryable: true };
}

function ordinaryRetryableConnectorError() {
  // Same exact error text as the attach-exhausted shape, but WITHOUT the
  // typed code — simulates a connector that classified the failure as
  // retryable for a different reason, or an older connector build that
  // predates this code. The controller must key off the typed code, not
  // off the message text, so this must NOT trigger surface recycling.
  return { message: SESSION_CLOSED_MESSAGE, retryable: true };
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

test("readiness probe success: connector spawned with surface env and run.browser_surface_ready emitted", async (t) => {
  const probeCalls = [];
  const probe = {
    probe: async (surface) => {
      probeCalls.push(surface);
      return { ok: true, pageTargetCount: 1, browserVersion: "Chrome/124.0" };
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
  assert.equal(probeCalls[0].health, "ready");
  assert.equal(probeCalls[0].cdp_url, "http://127.0.0.1:9222");
  assert.equal(runConnectorCalls.length, 1);

  const surfaceEnv = runConnectorCalls[0].browserSurfaceEnv;
  assert.ok(surfaceEnv);
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REQUIRED, "neko");
  assert.equal(surfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL, "http://127.0.0.1:9222");

  const events = listRunEvents("run_ok").map((e) => e.event_type);
  assert.ok(events.includes("run.browser_surface_ready"), `events were: ${events.join(",")}`);
  const ready = listRunEvents("run_ok").find((e) => e.event_type === "run.browser_surface_ready");
  assert.equal(ready.data.browser_surface_probe.ok, true);
  assert.equal(ready.data.browser_surface_probe.page_target_count, 1);
  assert.equal(ready.data.browser_surface_probe.browser_version, "Chrome/124.0");
});

test("static managed readiness defaults the durable replacement store without an allocator", async (t) => {
  const leaseStore = createSqliteBrowserSurfaceLeaseStore();
  let resolveRun;
  const runDone = new Promise((resolve) => {
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
        ok: true,
        pageTargetCount: 1,
        browserGenerationHash: "b".repeat(64),
      }),
    },
    runConnectorImpl: () => runDone,
  });
  await leaseStore.upsertSurface({
    surface_id: "neko-static",
    backend: "neko",
    profile_key: "managed-profile",
    connector_id: "managed",
    cdp_url: "http://127.0.0.1:9222",
    stream_base_url: "http://127.0.0.1:8080",
    health: "ready",
    container_id: "static-container",
    browser_generation_hash: "a".repeat(64),
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
  });
  await controller.runNow("managed", {
    manifest: MANIFEST,
    ownerToken: "owner-token",
    runId: "run_static_generation",
  });
  const receipts = await getDefaultBrowserSurfaceReplacementReceiptStore().list();
  assert.deepEqual(
    receipts.filter((receipt) => receipt.surface_id === "neko-static").map((receipt) => receipt.phase),
    ["started", "completed"],
  );
  assert.equal(
    receipts.find((receipt) => receipt.surface_id === "neko-static" && receipt.phase === "completed")
      ?.cause,
    "same_container_browser_generation_change",
  );
  assert.equal((await leaseStore.getSurface("neko-static")).browser_generation_hash, "b".repeat(64));
  resolveRun({ status: "completed", records_emitted: 0, state: null, checkpoint_summary: null });
  await controller.drainActiveRuns(1000);
});

test("readiness probe failure: missing leased surface is typed and does not spawn connector", async (t) => {
  const leaseManager = createManagerWithReadySurface();
  leaseManager.getSurface = () => undefined;
  const { controller, runConnectorCalls } = setup(t, {
    leaseManager,
    probe: {
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
    (e) => e.event_type === "run.browser_surface_probe_failed",
  );
  assert.ok(probeEvent);
  assert.equal(probeEvent.data.browser_surface_probe.code, "browser_surface_not_ready");
  assert.match(probeEvent.data.browser_surface_probe.detail, /missing surface/);
});

test("readiness probe failure: surface_failed returned, connector NOT spawned, typed event emitted, lease released", async (t) => {
  const probe = {
    probe: async () => ({
      ok: false,
      code: "browser_surface_cdp_disconnected",
      detail: "GET http://127.0.0.1:9222/json/version returned HTTP 503",
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
  assert.equal(probeEvent.data.browser_surface_probe.ok, false);
  assert.equal(probeEvent.data.browser_surface_probe.code, "browser_surface_cdp_disconnected");
  assert.match(probeEvent.data.browser_surface_probe.detail, /HTTP 503/);

  // Lease must be released so a follow-up run can acquire a new surface.
  const releaseEvent = events.find((e) => e.event_type === "run.browser_surface_released");
  assert.ok(releaseEvent, "lease must be released after probe failure");
});

test("probe that throws is mapped to browser_surface_cdp_unreachable rather than crashing the run", async (t) => {
  const probe = {
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
  assert.equal(probeEvent.data.browser_surface_probe.code, "browser_surface_cdp_unreachable");
  assert.match(probeEvent.data.browser_surface_probe.detail, /kernel said no/);
});

test("readiness probe failure evicts the stale in-memory surface so the next acquire cannot relay-fail", async (t) => {
  // Construction guarantee: when a probe says the leased surface is dead, the
  // lease manager must not keep that surface in memory with `health: ready`
  // and hand it to the next acquire. Otherwise we burn another OTP cycle
  // against the same dead CDP socket. This regression is the exact failure
  // mode observed in run_1779900509276 against USAA.
  const probe = {
    probe: async () => ({
      ok: false,
      code: "browser_surface_cdp_unreachable",
      detail: "GET http://stale:9223/json/version failed: fetch failed",
    }),
  };
  const leaseManager = createManagerWithReadySurface();
  const { controller, runConnectorCalls } = setup(t, { probe, leaseManager });

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
  const probe = {
    probe: async () => ({
      ok: false,
      code: "browser_surface_cdp_unreachable",
      detail: "GET http://dynamic-stale:9223/json/version failed: fetch failed",
    }),
  };
  const leaseManager = createManagerWithReadySurface();
  const stopRequests = [];
  const allocator = {
    ensureSurface: async () => ({
      surface_id: "surface_static",
      backend: "neko",
      profile_key: "managed-profile",
      connector_id: "managed",
      cdp_url: "http://127.0.0.1:9222",
      stream_base_url: "http://127.0.0.1:8080",
      health: "ready",
      created_at: "2026-05-12T11:00:00.000Z",
      last_used_at: "2026-05-12T11:00:00.000Z",
    }),
    getSurfaceStatus: async () => null,
    stopSurface: async (request) => {
      stopRequests.push(request);
      return null;
    },
    listSurfaces: async () => [],
  };
  const { controller, runConnectorCalls } = setup(t, { probe, leaseManager });
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

  const otherCalls = [];
  const c2 = createController({
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceReadinessProbe: probe,
    browserSurfaceAllocator: allocator,
    connectorPathResolver: () => "/tmp/connector.js",
    logger: { error: () => {}, warn: () => {} },
    schedulerStore: createSchedulerStore(),
    streamingTargetNonceHooks: {
      registerNonce: () => {},
      clearNonce: () => {},
    },
    runConnectorImpl: (opts) => {
      otherCalls.push(opts);
      return Promise.resolve({
        status: "completed",
        records_emitted: 0,
        state: null,
        checkpoint_summary: null,
      });
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
  assert.equal(stopRequests[0]?.surfaceId, "neko-static");
  assert.equal(
    stopRequests[0]?.reason,
    "surface_failed",
    "stop reason must be 'surface_failed' so the allocator removes the dead container",
  );
});

test("readiness probe failure on a stale dynamic surface reacquires once and launches on the fresh surface", async (t) => {
  const probeCalls = [];
  const probe = {
    probe: async (surface) => {
      probeCalls.push(surface);
      if (surface.surface_id === "surface_stale") {
        return {
          ok: false,
          code: "browser_surface_cdp_unreachable",
          detail: "GET http://stale:9223/json/version failed: fetch failed",
        };
      }
      return { ok: true, pageTargetCount: 1, browserVersion: "Chrome/124.0" };
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
  assert.equal(probeCalls[0].surface_id, "surface_stale");
  assert.equal(probeCalls[1].surface_id, "surface_dynamic_1");
  assert.equal(stopRequests.length, 1);
  assert.equal(stopRequests[0]?.surfaceId, "surface_stale");
  assert.equal(stopRequests[0]?.reason, "surface_failed");
  assert.equal(runConnectorCalls.length, 1);
  assert.equal(
    runConnectorCalls[0].browserSurfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL,
    "http://surface_dynamic_1:9223",
  );

  const events = listRunEvents("run_dynamic_reacquire").map((e) => e.event_type);
  assert.equal(events.filter((event) => event === "run.browser_surface_requested").length, 2);
  assert.equal(events.filter((event) => event === "run.browser_surface_leased").length, 2);
  assert.equal(events.filter((event) => event === "run.browser_surface_probe_failed").length, 1);
  assert.equal(events.filter((event) => event === "run.browser_surface_ready").length, 1);
});

test("boot reconciliation retires an idle stale-capability surface and recreates its profile", async (t) => {
  const leaseManager = createDynamicManagerWithReadySurface();
  const staleSurface = leaseManager.getSurface("surface_stale");
  assert.ok(staleSurface);
  const { allocator, ensureRequests, stopRequests } = createReadyDynamicAllocator([staleSurface]);
  const probe = {
    probe: async (surface) =>
      surface.surface_id === "surface_stale"
        ? {
            ok: false,
            code: "browser_surface_window_settle_unavailable",
            detail: "GET http://stale:9223/pdpp/window-settle returned HTTP 404",
          }
        : { ok: true, pageTargetCount: 1 },
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    leaseManager,
    probe,
  });

  await controller.reconcileBrowserSurfaceLeasesAfterBoot();

  assert.equal(leaseManager.getSurface("surface_stale"), undefined, "idle incompatible surface is evicted before reuse");
  assert.deepEqual(stopRequests, [{ surfaceId: "surface_stale", reason: "surface_failed" }]);

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
  const activeLease = leaseManager.listLeases()[0];
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
        ok: false,
        code: "browser_surface_window_settle_unavailable",
        detail: "GET http://stale:9223/pdpp/window-settle returned HTTP 404",
      }),
    },
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: null,
    listPersistedActiveRuns: async () => [{ run_id: runId }],
    log: { error: () => {}, warn: () => {} },
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => {},
    startupControllerRunReconciliation: Promise.resolve(),
  });

  await manager.reconcileBrowserSurfaceLeasesAfterBoot();

  assert.equal(stopRequests.length, 0, "an active run is never interrupted by boot reconciliation");
  assert.equal(leaseManager.getLease(activeLease.lease_id)?.status, "leased");
  assert.ok(leaseManager.getSurface("surface_stale"), "active run retains its surface until completion");

  await manager.releaseLease(activeLease, "managed", runId, createTraceContext());

  assert.deepEqual(stopRequests, [{ surfaceId: "surface_stale", reason: "surface_failed" }]);
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
  const probe = {
    probe: async () => ({ ok: true, pageTargetCount: 1, browserVersion: "Chrome/124.0" }),
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
      await emitSpineEvent({
        event_type: "run.failed",
        trace_id: opts.traceContext.trace_id,
        scenario_id: opts.traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: opts.connectorId,
        object_type: "run",
        object_id: opts.runId,
        status: "failed",
        run_id: opts.runId,
        data: { records_emitted: 0 },
      });
      return {
        status: "failed",
        records_emitted: 0,
        state: null,
        checkpoint_summary: null,
        connector_error: attachExhaustedConnectorError(),
      };
    },
  });

  const first = await controller.runNow("managed", {
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
    "attach-exhausted recycling must emit its own typed event, not the interaction-specific run.browser_surface_lost",
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

  const invalidatedEvent = firstEvents[invalidatedSeq];
  assert.equal(invalidatedEvent.data.browser_surface_probe.code, "browser_surface_attach_exhausted");
  // The detail must be a stable, runtime-authored string — never the raw,
  // unbounded connector_error.message (that untrusted text is already
  // persisted once, bounded, on the run's own terminal event).
  assert.equal(invalidatedEvent.data.browser_surface_probe.detail.includes(SESSION_CLOSED_MESSAGE), false);
  assert.equal(invalidatedEvent.data.interaction_id, undefined, "this event is not interaction-specific");
  assert.equal(invalidatedEvent.data.kind, undefined, "this event is not interaction-specific");

  // The exhausted dynamic surface must be evicted from memory and the
  // allocator told to stop the underlying container — the exact mechanism
  // readiness-probe failure already uses (task 5.6 / PR #260), triggered
  // here from the typed terminal connector-error code instead of a
  // pre-flight probe.
  assert.equal(leaseManager.getSurface("surface_stale"), undefined, "attach-exhausted surface must be evicted");
  assert.equal(stopRequests.length, 1);
  assert.equal(stopRequests[0]?.surfaceId, "surface_stale");
  assert.equal(stopRequests[0]?.reason, "surface_failed");

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
  assert.equal(
    runConnectorCalls[1].browserSurfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL,
    "http://surface_dynamic_1:9223",
    "follow-up run must acquire a freshly-allocated surface, not the recycled one",
  );
});

// Table-driven negatives: every case below is a dynamic-surface run that
// must NOT recycle the surface. Sharing one setup/assert shape keeps the
// distinctions (why each one is a negative) visible without duplicating the
// fixture wiring per case.
const DYNAMIC_SURFACE_NON_RECYCLE_CASES = [
  {
    name: "the exact session-closed error string WITHOUT the typed browser_surface_attach_exhausted code",
    runId: "run_untyped_code",
    recordsEmitted: 0,
    connectorError: () => ordinaryRetryableConnectorError(),
    reason: "no typed code means no surface recycling, regardless of message text",
  },
  {
    name: "an unrelated connector failure (credential rejection)",
    runId: "run_unrelated_failure",
    recordsEmitted: 0,
    connectorError: () => ({ message: "credential rejected by provider", code: "credential_rejected", retryable: false }),
    reason: "an unrelated connector failure must not recycle the surface",
  },
  {
    name: "a mid-run failure that already made progress (records_emitted > 0), even with the typed code",
    runId: "run_post_progress_failure",
    recordsEmitted: 42,
    connectorError: () => attachExhaustedConnectorError(),
    reason: "post-progress failures are out of scope for this pre-progress recycling",
  },
];

for (const testCase of DYNAMIC_SURFACE_NON_RECYCLE_CASES) {
  test(`${testCase.name} does not recycle the surface`, async (t) => {
    const probe = {
      probe: async () => ({ ok: true, pageTargetCount: 1, browserVersion: "Chrome/124.0" }),
    };
    const leaseManager = createDynamicManagerWithReadySurface();
    const { allocator, stopRequests } = createReadyDynamicAllocator();
    const { controller } = setup(t, {
      browserSurfaceAllocator: allocator,
      leaseManager,
      probe,
      runConnectorImpl: () => ({
        status: "failed",
        records_emitted: testCase.recordsEmitted,
        state: null,
        checkpoint_summary: null,
        connector_error: testCase.connectorError(),
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
  const probe = {
    probe: async () => ({ ok: true, pageTargetCount: 1, browserVersion: "Chrome/124.0" }),
  };
  const stopRequests = [];
  const allocator = {
    ensureSurface: async () => {
      throw new Error("static mode must not call ensureSurface");
    },
    getSurfaceStatus: async () => null,
    stopSurface: async (request) => {
      stopRequests.push(request);
      return null;
    },
    listSurfaces: async () => [],
  };
  const { controller, runConnectorCalls } = setup(t, {
    browserSurfaceAllocator: allocator,
    probe,
    runConnectorImpl: () => ({
      status: "failed",
      records_emitted: 0,
      state: null,
      checkpoint_summary: null,
      connector_error: attachExhaustedConnectorError(),
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
  assert.equal(
    runConnectorCalls[1].browserSurfaceEnv.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL,
    "http://127.0.0.1:9222",
    "the same static surface must be reused, not replaced",
  );
});

test("probe disabled (null) preserves legacy behavior: connector spawned, no probe events", async (t) => {
  const { controller, runConnectorCalls } = setup(t, { probe: null });

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
