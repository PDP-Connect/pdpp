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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { BrowserSurfaceLeaseManager, DEFAULT_NEKO_PRIORITY_RANKS } from "../runtime/browser-surface-leases.ts";
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

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdpp-controller-rdy-"));
  return path.join(dir, "pdpp.sqlite");
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

function createManagerWithReadySurface() {
  let leaseSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      managedConnectors: new Set(["managed"]),
      surfaceCap: 1,
      staticProfileKey: "managed-profile",
      staticCdpHttpUrl: "http://127.0.0.1:9222",
      staticStreamBaseUrl: "http://127.0.0.1:8080",
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 600_000,
      defaultPriorityClass: "scheduled_refresh",
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
}

function setup(t, { probe, leaseManager } = {}) {
  closeDb();
  initDb(tempDbPath());
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });

  const runConnectorCalls = [];
  const controller = createController({
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
