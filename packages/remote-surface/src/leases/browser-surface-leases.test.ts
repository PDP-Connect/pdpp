import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseConfig,
  BrowserSurfaceLeaseManager,
  type EnsureBrowserSurfaceRequest,
  type StopBrowserSurfaceRequest,
  DEFAULT_NEKO_PRIORITY_RANKS,
  projectBrowserSurfaceLease,
} from "./browser-surface-leases.ts";

function config(overrides: Partial<BrowserSurfaceLeaseConfig> = {}): BrowserSurfaceLeaseConfig {
  return {
    managedConnectors: new Set(["chatgpt"]),
    surfaceCap: 1,
    staticCdpHttpUrl: "http://neko:9222",
    staticStreamBaseUrl: "http://neko:8080",
    leaseWaitTimeoutMs: 60_000,
    idleTtlMs: 300_000,
    defaultPriorityClass: "scheduled_refresh" as const,
    priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
    surfaceMode: "dynamic" as const,
    ...overrides,
  };
}

function manager(options: {
  config?: Partial<BrowserSurfaceLeaseConfig>;
  initialSurfaces?: readonly BrowserSurface[];
  initialLeases?: readonly BrowserSurfaceLease[];
} = {}) {
  let nowMs = Date.parse("2026-05-12T12:00:00.000Z");
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  const managerOptions = {
    config: config(options.config),
    now: () => new Date(nowMs),
    makeLeaseId: () => `lease_${++leaseSeq}`,
    makeSurfaceId: () => `surface_${++surfaceSeq}`,
    nextFencingToken: () => ++tokenSeq,
    ...(options.initialSurfaces ? { initialSurfaces: options.initialSurfaces } : {}),
    ...(options.initialLeases ? { initialLeases: options.initialLeases } : {}),
  };
  const leases = new BrowserSurfaceLeaseManager(managerOptions);
  return {
    advance(ms: number) {
      nowMs += ms;
    },
    leases,
  };
}

class FakeBrowserSurfaceAllocator implements BrowserSurfaceAllocator {
  readonly #surfaces = new Map<string, BrowserSurface>();
  readonly ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  readonly stopRequests: StopBrowserSurfaceRequest[] = [];

  failEnsure = false;
  failStop = false;
  stopBarrier: Promise<void> | null = null;
  returnStoppedAsReady = false;

  async ensureSurface(request: EnsureBrowserSurfaceRequest): Promise<BrowserSurface> {
    this.ensureRequests.push(request);
    if (this.failEnsure) {
      throw new Error("allocator failed");
    }
    const surface = this.#surfaces.get(request.surfaceId) ?? {
      surface_id: request.surfaceId,
      backend: "neko" as const,
      profile_key: request.profileKey,
      connector_id: request.connectorId,
      cdp_url: "",
      stream_base_url: "",
      health: "starting" as const,
      created_at: "2026-05-12T12:00:00.000Z",
      last_used_at: "2026-05-12T12:00:00.000Z",
      ...(request.accountKey ? { account_key: request.accountKey } : {}),
      container_id: `container_${request.surfaceId}`,
    };
    this.#surfaces.set(request.surfaceId, surface);
    return surface;
  }

  async getSurfaceStatus(surfaceId: string): Promise<BrowserSurface | null> {
    return this.#surfaces.get(surfaceId) ?? null;
  }

  async stopSurface(request: StopBrowserSurfaceRequest): Promise<BrowserSurface | null> {
    this.stopRequests.push(request);
    if (this.failStop) {
      throw new Error("allocator stop failed");
    }
    await this.stopBarrier;
    const surface = this.#surfaces.get(request.surfaceId);
    if (!surface) {
      return null;
    }
    const stopped = this.returnStoppedAsReady ? surface : { ...surface, health: "stopping" as const };
    this.#surfaces.set(request.surfaceId, stopped);
    return stopped;
  }

  async listSurfaces(): Promise<BrowserSurface[]> {
    return [...this.#surfaces.values()];
  }

  setReady(surfaceId: string): void {
    const surface = this.#surfaces.get(surfaceId);
    assert.ok(surface);
    this.#surfaces.set(surfaceId, {
      ...surface,
      cdp_url: `http://${surfaceId}:9222`,
      stream_base_url: `http://${surfaceId}:8080`,
      health: "ready",
    });
  }

  setUnhealthy(surfaceId: string): void {
    const surface = this.#surfaces.get(surfaceId);
    assert.ok(surface);
    this.#surfaces.set(surfaceId, { ...surface, health: "unhealthy" });
  }

  setSurface(surface: BrowserSurface): void {
    this.#surfaces.set(surface.surface_id, surface);
  }
}

test("compatible idle surface is leased and projected", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_idle",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
  });

  const result = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });

  assert.equal(result.lease.status, "leased");
  assert.equal(result.lease.surface_id, "surface_idle");
  assert.equal(result.surface?.active_lease_id, "lease_1");
  assert.deepEqual(projectBrowserSurfaceLease(result.lease), {
    pending_run_id: "run_1",
    browser_surface_status: "leased",
    browser_surface_lease_id: "lease_1",
    browser_surface_profile_key: "chatgpt",
  });
  assert.equal(leases.planCapacityPressureReclaim(result.lease.lease_id), undefined);
});

test("capacity-pressure planner preserves compatible idle reuse", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_compatible",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
  });

  const result = leases.acquire({ connectorId: "chatgpt", runId: "run_compatible", profileKey: "chatgpt" });

  assert.equal(result.lease.status, "leased");
  assert.equal(leases.planCapacityPressureReclaim(result.lease.lease_id), undefined);
});

test("capacity-pressure reclaim stops one incompatible idle dynamic surface and promotes waiter", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_idle",
        backend: "neko",
        profile_key: "old_profile",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
  });

  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_queued", profileKey: "new_profile" });
  const planned = leases.planCapacityPressureReclaim(queued.lease.lease_id);
  const reclaimed = leases.completeCapacityPressureReclaim(planned?.surface_id ?? "");

  assert.equal(queued.lease.status, "waiting_for_browser_surface");
  assert.equal(planned?.surface_id, "surface_idle");
  assert.equal(reclaimed.stopped?.health, "stopping");
  assert.equal(reclaimed.stopped?.active_lease_id, undefined);
  assert.equal(reclaimed.promoted?.lease_id, queued.lease.lease_id);
  assert.equal(reclaimed.promoted?.status, "starting_surface");
  assert.equal(leases.getSurface("surface_idle")?.health, "stopping");
  assert.equal(leases.getLease(queued.lease.lease_id)?.status, "starting_surface");
});

test("dynamic mode ignores persisted static surface rows from a previous boot", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
  });

  const result = leases.acquire({ connectorId: "chatgpt", runId: "run_dynamic", profileKey: "chatgpt" });

  assert.equal(leases.getSurface("neko-static"), undefined);
  assert.equal(result.lease.status, "starting_surface");
  assert.equal(result.lease.surface_id, "surface_1");
  assert.equal(result.surface?.health, "starting");
});

test("dynamic capacity starts a surface before it becomes leased", async () => {
  const { leases } = manager();
  const allocator = new FakeBrowserSurfaceAllocator();

  const acquired = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });

  assert.equal(acquired.lease.status, "starting_surface");
  assert.equal(acquired.lease.wait_reason, "surface_starting");
  assert.equal(acquired.surface?.health, "starting");
  assert.equal(leases.listSurfaces().length, 1);

  const stillStarting = await leases.ensureStartingSurfaceReady({ leaseId: acquired.lease.lease_id, allocator });
  assert.equal(stillStarting.lease.status, "starting_surface");
  assert.equal(allocator.ensureRequests.length, 1);
  assert.ok(acquired.lease.surface_id);
  allocator.setReady(acquired.lease.surface_id);

  const ready = await leases.ensureStartingSurfaceReady({ leaseId: acquired.lease.lease_id, allocator });

  assert.equal(ready.lease.status, "leased");
  assert.equal(ready.surface?.health, "ready");
  assert.equal(ready.surface?.active_lease_id, acquired.lease.lease_id);
  assert.equal(ready.surface?.cdp_url, `http://${acquired.lease.surface_id}:9222`);
});

test("starting dynamic surfaces count against cap until ready or unhealthy", async () => {
  const { leases } = manager({ config: { surfaceCap: 2 } });
  const allocator = new FakeBrowserSurfaceAllocator();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "profile_1" });
  const second = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "profile_2" });
  const third = leases.acquire({ connectorId: "chatgpt", runId: "run_3", profileKey: "profile_3" });

  assert.equal(first.lease.status, "starting_surface");
  assert.equal(second.lease.status, "starting_surface");
  assert.equal(third.lease.status, "waiting_for_browser_surface");
  assert.equal(third.lease.wait_reason, "capacity_full");

  assert.ok(first.lease.surface_id);
  await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  allocator.setUnhealthy(first.lease.surface_id);
  const failed = await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  assert.equal(failed.lease.status, "surface_failed");

  assert.equal(leases.pumpQueuedLeases().length, 0);
  assert.equal(leases.getLease(third.lease.lease_id)?.status, "waiting_for_browser_surface");
});

test("allocator startup failure marks the lease as surface_failed", async () => {
  const { leases } = manager();
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.failEnsure = true;
  const acquired = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });

  const failed = await leases.ensureStartingSurfaceReady({ leaseId: acquired.lease.lease_id, allocator });

  assert.equal(failed.lease.status, "surface_failed");
  assert.equal(failed.lease.wait_reason, "surface_start_failed");
  assert.equal(failed.surface?.health, "unhealthy");
});

test("readiness timeout marks the lease as surface_failed", async () => {
  const ctx = manager();
  const { leases } = ctx;
  const allocator = new FakeBrowserSurfaceAllocator();
  const acquired = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  ctx.advance(1_001);

  const failed = await leases.ensureStartingSurfaceReady({
    leaseId: acquired.lease.lease_id,
    allocator,
    readinessTimeoutMs: 1_000,
  });

  assert.equal(failed.lease.status, "surface_failed");
  assert.equal(failed.lease.wait_reason, "surface_readiness_timeout");
  assert.equal(failed.surface?.health, "unhealthy");
});

test("capacity-full request queues and release pumps by priority then FIFO", async () => {
  const ctx = manager();
  const { leases } = ctx;

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const allocator = new FakeBrowserSurfaceAllocator();
  await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  assert.ok(first.lease.surface_id);
  allocator.setReady(first.lease.surface_id);
  const readyFirst = await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  const low = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_low",
    profileKey: "chatgpt",
    accountKey: "low",
  });
  ctx.advance(1);
  const high = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_high",
    profileKey: "chatgpt",
    accountKey: "high",
    priorityClass: "owner_interactive",
  });

  const released = leases.release({ leaseId: readyFirst.lease.lease_id, fencingToken: readyFirst.lease.fencing_token });

  assert.equal(low.lease.status, "waiting_for_browser_surface");
  assert.equal(high.lease.status, "waiting_for_browser_surface");
  assert.equal(released.promoted?.run_id, "run_high");
  assert.equal(leases.listSurfaces().length, 1);
});

test("stale release fencing cannot release a promoted lease", async () => {
  const { leases } = manager();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const allocator = new FakeBrowserSurfaceAllocator();
  await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  assert.ok(first.lease.surface_id);
  allocator.setReady(first.lease.surface_id);
  const readyFirst = await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });
  leases.release({ leaseId: readyFirst.lease.lease_id, fencingToken: readyFirst.lease.fencing_token });
  const stale = leases.release({ leaseId: readyFirst.lease.lease_id, fencingToken: readyFirst.lease.fencing_token });

  assert.equal(queued.lease.status, "waiting_for_browser_surface");
  assert.equal(stale.released, false);
  assert.equal(stale.stale, true);
  assert.equal(leases.getLease(queued.lease.lease_id)?.status, "leased");
});

test("failed idle cleanup keeps surface counted against cap and does not promote queued leases", async () => {
  const idleSurface: BrowserSurface = {
    surface_id: "surface_idle",
    backend: "neko",
    profile_key: "idle_profile",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
  };
  const { leases } = manager({
    initialSurfaces: [idleSurface],
    initialLeases: [
      {
        lease_id: "lease_waiting",
        connector_id: "chatgpt",
        profile_key: "queued_profile",
        run_id: "run_waiting",
        status: "waiting_for_browser_surface",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T12:00:00.000Z",
        expires_at: "2026-05-12T12:01:00.000Z",
        fencing_token: 1,
        wait_reason: "capacity_full",
      },
    ],
  });
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.setSurface({ ...idleSurface, active_lease_id: "stale_lease" });
  allocator.returnStoppedAsReady = true;
  allocator.failStop = true;

  await assert.rejects(() => leases.cleanupIdleSurfaces(allocator), /allocator stop failed/);

  assert.equal(allocator.stopRequests.length, 1);
  assert.equal(leases.getSurface("surface_idle")?.health, "ready");
  assert.equal(leases.getLease("lease_waiting")?.status, "waiting_for_browser_surface");
  assert.deepEqual(leases.pumpQueuedLeases(), []);
  assert.equal(leases.getLease("lease_waiting")?.status, "waiting_for_browser_surface");
  assert.equal(leases.listSurfaces().length, 1);
});

test("successful idle cleanup deletes surface and promotes queued leases", async () => {
  const idleSurface: BrowserSurface = {
    surface_id: "surface_idle",
    backend: "neko",
    profile_key: "idle_profile",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
  };
  const { leases } = manager({
    initialSurfaces: [idleSurface],
    initialLeases: [
      {
        lease_id: "lease_waiting",
        connector_id: "chatgpt",
        profile_key: "queued_profile",
        run_id: "run_waiting",
        status: "waiting_for_browser_surface",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T12:00:00.000Z",
        expires_at: "2026-05-12T12:01:00.000Z",
        fencing_token: 1,
        wait_reason: "capacity_full",
      },
    ],
  });
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.setSurface(idleSurface);

  const result = await leases.cleanupIdleSurfaces(allocator);

  assert.equal(allocator.stopRequests.length, 1);
  assert.deepEqual(
    allocator.stopRequests.map((request) => request.reason),
    ["idle_ttl"],
  );
  assert.equal(result.stopped[0]?.surface_id, "surface_idle");
  assert.equal(result.stopped[0]?.health, "stopping");
  assert.equal(result.stopped[0]?.active_lease_id, undefined);
  assert.equal(result.promoted[0]?.lease_id, "lease_waiting");
  assert.equal(result.promoted[0]?.status, "starting_surface");
  assert.equal(leases.getSurface("surface_idle"), undefined);
  assert.equal(leases.getLease("lease_waiting")?.status, "starting_surface");
  assert.equal(leases.listSurfaces().length, 1);
});

test("pending idle cleanup keeps surface counted until allocator confirms stop", async () => {
  const idleSurface: BrowserSurface = {
    surface_id: "surface_idle",
    backend: "neko",
    profile_key: "idle_profile",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
  };
  const { leases } = manager({ initialSurfaces: [idleSurface] });
  const allocator = new FakeBrowserSurfaceAllocator();
  let unblockStop!: () => void;
  allocator.setSurface(idleSurface);
  allocator.stopBarrier = new Promise((resolve) => {
    unblockStop = resolve;
  });

  const cleanup = leases.cleanupIdleSurfaces(allocator);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(allocator.stopRequests.length, 1);

  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_waiting", profileKey: "queued_profile" });
  assert.equal(queued.lease.status, "waiting_for_browser_surface");
  assert.equal(queued.lease.wait_reason, "capacity_full");
  assert.equal(leases.getSurface("surface_idle")?.health, "ready");
  assert.deepEqual(leases.pumpQueuedLeases(), []);

  unblockStop();
  const result = await cleanup;

  assert.equal(result.stopped[0]?.health, "stopping");
  assert.equal(result.promoted[0]?.lease_id, queued.lease.lease_id);
  assert.equal(result.promoted[0]?.status, "starting_surface");
  assert.equal(leases.getSurface("surface_idle"), undefined);
  assert.equal(leases.getLease(queued.lease.lease_id)?.status, "starting_surface");
});

test("restart reconciliation defers expired queued leases", () => {
  const { leases } = manager({
    config: { leaseWaitTimeoutMs: 10 },
    initialLeases: [
      {
        lease_id: "lease_waiting",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_waiting",
        status: "waiting_for_browser_surface",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T11:00:00.000Z",
        expires_at: "2026-05-12T11:00:00.010Z",
        fencing_token: 1,
        wait_reason: "capacity_full",
      },
    ],
  });

  const result = leases.reconcileAfterRestart();

  assert.equal(result.deferred.length, 1);
  assert.equal(result.deferred[0]?.status, "deferred");
  assert.equal(result.deferred[0]?.wait_reason, "lease_wait_timeout");
});

test("dynamic boot drops leases for persisted static surfaces filtered from initial state", () => {
  const { leases } = manager({
    config: { surfaceMode: "dynamic" },
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        active_lease_id: "lease_static",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_static",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_static",
        status: "leased",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T12:00:00.000Z",
        expires_at: "2026-05-12T12:01:00.000Z",
        surface_id: "neko-static",
        fencing_token: 1,
      },
    ],
  });

  assert.equal(leases.getSurface("neko-static"), undefined);
  assert.equal(leases.getLease("lease_static"), undefined);
});
