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
  createSurfaceLeaseManager,
  projectBrowserSurfaceLease,
  projectSurfaceLease,
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

test("different surface subjects do not dedupe pending leases or share default profiles", () => {
  const { leases } = manager({ config: { surfaceCap: 1 } });

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", surfaceSubjectId: "owner_a" });
  const second = leases.acquire({ connectorId: "chatgpt", runId: "run_2", surfaceSubjectId: "owner_b" });
  const duplicate = leases.acquire({ connectorId: "chatgpt", runId: "run_3", surfaceSubjectId: "owner_b" });

  assert.equal(first.lease.status, "starting_surface");
  assert.equal(first.lease.profile_key, "chatgpt:owner_a");
  assert.equal(first.lease.surface_subject_id, "owner_a");
  assert.equal(first.surface?.surface_subject_id, "owner_a");
  assert.equal(second.lease.status, "waiting_for_browser_surface");
  assert.equal(second.lease.profile_key, "chatgpt:owner_b");
  assert.equal(second.lease.surface_subject_id, "owner_b");
  assert.equal(duplicate.lease.lease_id, second.lease.lease_id);
  assert.equal(duplicate.duplicateOf?.lease_id, second.lease.lease_id);
});

test("same explicit profile only reuses idle surfaces for the same subject", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_owner_a",
        backend: "neko",
        profile_key: "shared_profile",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
        surface_subject_id: "owner_a",
      },
    ],
  });

  const ownerB = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_owner_b",
    profileKey: "shared_profile",
    surfaceSubjectId: "owner_b",
  });
  const ownerA = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_owner_a",
    profileKey: "shared_profile",
    surfaceSubjectId: "owner_a",
  });

  assert.equal(ownerB.lease.status, "waiting_for_browser_surface");
  assert.equal(ownerB.lease.wait_reason, "capacity_full");
  assert.equal(ownerA.lease.status, "leased");
  assert.equal(ownerA.lease.surface_id, "surface_owner_a");
});

test("host-neutral lease API acquires, projects, cancels, and reconciles by session id", () => {
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

  const result = leases.acquireSurfaceLease({
    surfaceKind: "chatgpt",
    sessionId: "session_1",
    profileKey: "chatgpt",
  });

  assert.equal(result.lease.run_id, "session_1");
  assert.deepEqual(projectSurfaceLease(result.lease), {
    surface_session_id: "session_1",
    surface_lease_status: "leased",
    surface_lease_id: "lease_1",
    surface_profile_key: "chatgpt",
  });
  assert.deepEqual(
    leases.reconcileSurfaceSessionsAfterRestart({ activeSessionIds: new Set(["session_1"]) }).activeLeased.map(
      (lease) => lease.lease_id,
    ),
    ["lease_1"],
  );

  const cancelled = leases.cancelSurfaceSessionAndPump("session_1");
  assert.equal(cancelled.stale, false);
  assert.equal(cancelled.lease?.status, "cancelled");
});

test("legacy browser surface session API still accepts connectorId", () => {
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

  const result = leases.acquireSurfaceLease({
    connectorId: "chatgpt",
    sessionId: "session_legacy",
    profileKey: "chatgpt",
  });

  assert.equal(result.lease.connector_id, "chatgpt");
  assert.equal(result.lease.run_id, "session_legacy");

  const renewed = leases.renew({
    leaseId: result.lease.lease_id,
    fencingToken: result.lease.fencing_token,
    ttlMs: 120_000,
  });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.lease?.expires_at, "2026-05-12T12:02:00.000Z");
});

test("non-PDPP host fixture uses neutral surface lease manager terms", () => {
  const surfaceLeases = createSurfaceLeaseManager({
    config: {
      managedSurfaceKinds: new Set(["browser"]),
      surfaceCap: 1,
      staticCdpHttpUrl: "http://surface-control.local",
      staticStreamBaseUrl: "http://surface-stream.local",
      leaseWaitTimeoutMs: 60_000,
      idleTtlMs: 300_000,
      defaultPriorityClass: "scheduled_refresh",
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceMode: "dynamic",
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
    makeLeaseId: () => "lease_host_1",
    makeSurfaceId: () => "surface_host_1",
    nextFencingToken: (() => {
      let token = 0;
      return () => ++token;
    })(),
  });

  assert.equal(surfaceLeases.isManagedSurfaceKind("browser"), true);

  const acquired = surfaceLeases.acquire({
    surfaceKind: "browser",
    sessionId: "session_host_1",
    profileKey: "checkout-profile",
    sessionSubjectId: "account_123",
  });

  assert.equal(acquired.lease.leaseId, "lease_host_1");
  assert.equal(acquired.lease.surfaceKind, "browser");
  assert.equal(acquired.lease.sessionId, "session_host_1");
  assert.equal(acquired.lease.sessionSubjectId, "account_123");
  assert.equal(acquired.lease.status, "starting_surface");
  assert.equal(surfaceLeases.getLease("lease_host_1")?.sessionId, "session_host_1");

  const renewed = surfaceLeases.renewLease({
    leaseId: "lease_host_1",
    fencingToken: acquired.lease.fencingToken,
    ttlMs: 120_000,
  });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.lease?.expiresAt, "2026-05-12T12:02:00.000Z");

  const reconciled = surfaceLeases.reconcileAfterRestart({
    activeSessionIds: new Set(["session_host_1"]),
    promoteQueued: false,
  });
  assert.deepEqual(reconciled.queued.map((lease) => lease.leaseId), ["lease_host_1"]);

  const cancelled = surfaceLeases.cancelSessionAndPump("session_host_1");
  assert.equal(cancelled.stale, false);
  assert.equal(cancelled.lease?.status, "cancelled");
  assert.equal(cancelled.lease?.sessionId, "session_host_1");
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

test("boot detaches persisted active_lease_id when the active lease is no longer non-terminal", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_stale_active",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "unhealthy",
        active_lease_id: "lease_released",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_waiting",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_waiting",
        status: "waiting_for_browser_surface",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T11:00:00.000Z",
        expires_at: "2026-05-12T12:01:00.000Z",
        fencing_token: 1,
      },
    ],
  });

  assert.equal(leases.getSurface("surface_stale_active")?.active_lease_id, undefined);
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

test("unhealthy dynamic surfaces do not consume cap after startup failure", async () => {
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

  const promoted = leases.pumpQueuedLeases();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0]?.lease_id, third.lease.lease_id);
  assert.equal(promoted[0]?.status, "starting_surface");
  assert.notEqual(promoted[0]?.surface_id, failed.lease.surface_id);
  assert.equal(leases.getLease(third.lease.lease_id)?.status, "starting_surface");
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

test("boot reconciliation deterministically keeps capacity-1 retained demand in priority/FIFO order and terminalizes the rest", () => {
  // A retained connection can be acquired, queue, and the process restart
  // before it ever materializes a surface — so rehydrated non-terminal leases
  // can include retained leases still in waiting_for_browser_surface. If boot
  // reconcile requeued them as-is without re-checking the reserve, the manager
  // would come back up already overcommitted (more retained demand than
  // surfaceCap - 1), and the excess would only be caught later, one at a time,
  // whenever #pumpQueue happened to consider it — non-deterministic on
  // rehydration/iteration order. Reconcile must apply the same reserve check
  // #resolveNewLease uses, in the same priority/FIFO order #pumpQueue would
  // serve these leases, so exactly `surfaceCap - 1` retained demand survives
  // and the rest terminalizes with retained_capacity_reserved right here.
  const { leases } = manager({
    config: { surfaceCap: 3 },
    initialSurfaces: [retainedSurface({ surface_id: "surface_retained_a", profile_key: "chatgpt:acct-a" })],
    initialLeases: [
      {
        lease_id: "lease_retained_a",
        connector_id: "chatgpt",
        profile_key: "chatgpt:acct-a",
        surface_subject_id: "acct-a",
        run_id: "run_a",
        status: "leased",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T11:59:00.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 1,
        leased_at: "2026-05-12T11:59:01.000Z",
        surface_id: "surface_retained_a",
        retained: true,
      },
      // Two more retained leases persisted queued (never materialized a
      // surface before restart). Priority/FIFO order: B (owner_interactive,
      // earlier) wins the one remaining reserve slot; C (scheduled_refresh,
      // later) must terminalize.
      {
        lease_id: "lease_retained_c",
        connector_id: "chatgpt",
        profile_key: "chatgpt:acct-c",
        surface_subject_id: "acct-c",
        run_id: "run_c",
        status: "waiting_for_browser_surface",
        priority_class: "scheduled_refresh",
        requested_at: "2026-05-12T11:59:03.000Z",
        expires_at: "2026-05-12T12:05:03.000Z",
        fencing_token: 3,
        wait_reason: "capacity_full",
        retained: true,
      },
      {
        lease_id: "lease_retained_b",
        connector_id: "chatgpt",
        profile_key: "chatgpt:acct-b",
        surface_subject_id: "acct-b",
        run_id: "run_b",
        status: "waiting_for_browser_surface",
        priority_class: "owner_interactive",
        requested_at: "2026-05-12T11:59:02.000Z",
        expires_at: "2026-05-12T12:05:02.000Z",
        fencing_token: 2,
        wait_reason: "capacity_full",
        retained: true,
      },
    ],
  });

  const result = leases.reconcileAfterRestart({ promoteQueued: false });

  assert.deepEqual(result.queued.map((lease) => lease.lease_id), ["lease_retained_b"]);
  assert.equal(result.deferred.length, 1);
  assert.equal(result.deferred[0]?.lease_id, "lease_retained_c");
  assert.equal(result.deferred[0]?.wait_reason, "retained_capacity_reserved");

  assert.equal(leases.getLease("lease_retained_b")?.status, "waiting_for_browser_surface");
  assert.equal(leases.getLease("lease_retained_c")?.status, "deferred");
  assert.equal(leases.getLease("lease_retained_c")?.wait_reason, "retained_capacity_reserved");
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

test("invalidateSurface evicts an in-memory surface so the next acquire cannot reuse it", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_stale",
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

  const removed = leases.invalidateSurface("surface_stale");

  assert.equal(removed.surface?.surface_id, "surface_stale");
  assert.equal(removed.surface?.active_lease_id, undefined);
  assert.equal(leases.getSurface("surface_stale"), undefined);

  // Next acquire must NOT reuse the dead surface; it should create a new one
  // (dynamic mode) and start it.
  const result = leases.acquire({ connectorId: "chatgpt", runId: "run_after_invalidate", profileKey: "chatgpt" });
  assert.equal(result.lease.status, "starting_surface");
  assert.notEqual(result.lease.surface_id, "surface_stale");
});

test("invalidateSurface optionally fails an active lease so callers do not double-release", () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_active",
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
  const acquired = leases.acquire({ connectorId: "chatgpt", runId: "run_active", profileKey: "chatgpt" });
  assert.equal(acquired.lease.status, "leased");

  const result = leases.invalidateSurface("surface_active", { releaseLease: true });

  assert.equal(result.lease?.status, "surface_failed");
  assert.equal(result.lease?.wait_reason, "surface_unhealthy");
  assert.equal(result.surface?.active_lease_id, undefined);
  assert.equal(leases.getSurface("surface_active"), undefined);
});

test("reconcileSurfacesWithAllocator evicts a surface the allocator no longer knows about", async () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_lost",
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
  const allocator = new FakeBrowserSurfaceAllocator();
  // Allocator does NOT know about surface_lost (simulates container removed
  // while reference was down).

  const result = await leases.reconcileSurfacesWithAllocator(allocator);

  assert.equal(result.evicted.length, 1);
  assert.equal(result.evicted[0]?.surface_id, "surface_lost");
  assert.equal(leases.getSurface("surface_lost"), undefined);

  // The next acquire creates a brand new surface via the allocator path.
  const acquireResult = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_after_reconcile",
    profileKey: "chatgpt",
  });
  assert.equal(acquireResult.lease.status, "starting_surface");
  assert.notEqual(acquireResult.lease.surface_id, "surface_lost");
});

test("reconcileSurfacesWithAllocator downgrades a surface whose allocator status is not ready", async () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_warming",
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
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.setSurface({
    surface_id: "surface_warming",
    backend: "neko",
    profile_key: "chatgpt",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "starting",
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
  });

  const result = await leases.reconcileSurfacesWithAllocator(allocator);

  assert.equal(result.downgraded.length, 1);
  assert.equal(result.evicted.length, 0);
  assert.equal(leases.getSurface("surface_warming")?.health, "starting");

  // A "starting" surface should NOT be picked by #findReadyIdleSurface.
  const acquireResult = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_after_downgrade",
    profileKey: "chatgpt",
  });
  // Cap is 1, surface_warming counts against cap, so the new lease waits.
  assert.equal(acquireResult.lease.status, "waiting_for_browser_surface");
  assert.equal(acquireResult.lease.wait_reason, "capacity_full");
});

test("reconcileSurfacesWithAllocator does not let stopped surfaces consume dynamic cap", async () => {
  const { leases } = manager({
    initialSurfaces: [
      {
        surface_id: "surface_stopped",
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
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.setSurface({
    surface_id: "surface_stopped",
    backend: "neko",
    profile_key: "chatgpt",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "stopping",
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
  });

  const result = await leases.reconcileSurfacesWithAllocator(allocator);

  assert.equal(result.downgraded.length, 1);
  assert.equal(result.evicted.length, 0);
  assert.equal(leases.getSurface("surface_stopped")?.health, "stopping");

  const acquireResult = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_after_stopped_downgrade",
    profileKey: "chatgpt",
  });
  assert.equal(acquireResult.lease.status, "starting_surface");
  assert.notEqual(acquireResult.lease.surface_id, "surface_stopped");
});

test("reconcileSurfacesWithAllocator does nothing in static mode", async () => {
  const { leases } = manager({
    config: {
      surfaceMode: "static",
      surfaceCap: 1,
      staticProfileKey: "chatgpt",
      staticCdpHttpUrl: "http://neko:9222",
      staticStreamBaseUrl: "http://neko:8080",
    },
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
  const allocator = new FakeBrowserSurfaceAllocator();
  // Allocator knows nothing.

  const result = await leases.reconcileSurfacesWithAllocator(allocator);

  assert.equal(result.evicted.length, 0);
  assert.equal(result.downgraded.length, 0);
  // Static surface preserved.
  assert.equal(leases.getSurface("neko-static")?.health, "ready");
});

// ─── Credential-boundary surface process retention ─────────────────────────
// A retained surface is a credential boundary (its provider auth lives in the
// live browser process). It SHALL survive routine idle-TTL and capacity-pressure
// reap, but only while healthy, and its lease is still released after each run.

function retainedSurface(overrides: Partial<BrowserSurface> = {}): BrowserSurface {
  return {
    surface_id: "surface_retained",
    backend: "neko",
    profile_key: "chatgpt:acct-a",
    connector_id: "chatgpt",
    cdp_url: "http://neko:9222",
    stream_base_url: "http://neko:8080",
    health: "ready",
    created_at: "2026-05-12T11:00:00.000Z",
    last_used_at: "2026-05-12T11:00:00.000Z",
    retained: true,
    ...overrides,
  };
}

test("retention: idle cleanup does NOT stop a retained surface past idle TTL", async () => {
  const { leases, advance } = manager({ initialSurfaces: [retainedSurface()] });
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.setSurface(retainedSurface());

  // Age well past the 300s idle TTL.
  advance(10 * 60 * 1000);
  const result = await leases.cleanupIdleSurfaces(allocator);

  assert.equal(allocator.stopRequests.length, 0);
  assert.equal(result.stopped.length, 0);
  assert.equal(leases.getSurface("surface_retained")?.health, "ready");
});

test("retention: idle cleanup still stops an ordinary surface past idle TTL", async () => {
  const ordinary = retainedSurface({ surface_id: "surface_ordinary", profile_key: "chase", connector_id: "chase" });
  const { retained: _retained, ...ordinarySurface } = ordinary;
  const { leases, advance } = manager({ initialSurfaces: [ordinarySurface] });
  const allocator = new FakeBrowserSurfaceAllocator();
  allocator.setSurface(ordinarySurface);

  advance(10 * 60 * 1000);
  const result = await leases.cleanupIdleSurfaces(allocator);

  assert.equal(allocator.stopRequests.length, 1);
  assert.equal(allocator.stopRequests[0]?.reason, "idle_ttl");
  assert.equal(result.stopped[0]?.surface_id, "surface_ordinary");
  assert.equal(leases.getSurface("surface_ordinary"), undefined);
});

test("retention: capacity-pressure reclaim never selects a retained surface", () => {
  // Only a retained surface is idle; a new incompatible connection presses capacity.
  const { leases } = manager({ config: { surfaceCap: 1 }, initialSurfaces: [retainedSurface()] });

  const queued = leases.acquire({ connectorId: "chase", runId: "run_chase", profileKey: "chase" });
  const planned = leases.planCapacityPressureReclaim(queued.lease.lease_id);

  assert.equal(queued.lease.status, "waiting_for_browser_surface");
  assert.equal(queued.lease.wait_reason, "capacity_full");
  // Retained surface must NOT be offered as a reclaim victim; the waiter stays queued.
  assert.equal(planned, undefined);
  assert.equal(leases.getSurface("surface_retained")?.health, "ready");
});

test("retention: capacity-pressure reclaim still selects the oldest idle ordinary surface, skipping retained", () => {
  const retained = retainedSurface({ last_used_at: "2026-05-12T10:00:00.000Z" }); // older, but retained
  const ordinaryOld = retainedSurface({
    surface_id: "surface_ord_old",
    profile_key: "reddit",
    connector_id: "reddit",
    last_used_at: "2026-05-12T10:30:00.000Z",
  });
  const { retained: _r1, ...ordinaryOldSurface } = ordinaryOld;
  const { leases } = manager({ config: { surfaceCap: 2 }, initialSurfaces: [retained, ordinaryOldSurface] });

  const queued = leases.acquire({ connectorId: "amazon", runId: "run_amazon", profileKey: "amazon" });
  const planned = leases.planCapacityPressureReclaim(queued.lease.lease_id);

  // Even though the retained surface is the oldest by last_used_at, reclaim skips
  // it and picks the ordinary surface.
  assert.equal(planned?.surface_id, "surface_ord_old");
});

test("retention: a retained surface releases its lease and is reacquired without a new surface", () => {
  const { leases } = manager({ initialSurfaces: [retainedSurface()] });

  const first = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_1",
    profileKey: "chatgpt:acct-a",
    retainSurfaceProcess: true,
  });
  assert.equal(first.lease.status, "leased");
  assert.equal(first.surface?.surface_id, "surface_retained");
  assert.equal(first.surface?.retained, true);

  const released = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });
  assert.equal(released.released, true);
  // Surface remains, still retained, no active lease — reusable.
  assert.equal(leases.getSurface("surface_retained")?.retained, true);
  assert.equal(leases.getSurface("surface_retained")?.active_lease_id, undefined);

  const second = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_2",
    profileKey: "chatgpt:acct-a",
    retainSurfaceProcess: true,
  });
  assert.equal(second.lease.status, "leased");
  assert.equal(second.surface?.surface_id, "surface_retained");
  // No new surface was created.
  assert.equal(leases.listSurfaces().length, 1);
});

test("retention: a proven-dead retained surface is still recycled by invalidateSurface", () => {
  const { leases } = manager({ initialSurfaces: [retainedSurface()] });

  const leased = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_dead",
    profileKey: "chatgpt:acct-a",
    retainSurfaceProcess: true,
  });
  assert.equal(leased.lease.status, "leased");

  const invalidated = leases.invalidateSurface("surface_retained", {
    reason: "surface_unhealthy",
    releaseLease: true,
  });

  // Retention exempts only healthy surfaces: a dead CDP surface is still evicted.
  assert.equal(invalidated.surface?.surface_id, "surface_retained");
  assert.equal(leases.getSurface("surface_retained"), undefined);
  assert.equal(invalidated.lease?.status, "surface_failed");
});

test("retention: acquire without the flag does NOT create a retained surface", () => {
  const { leases } = manager({ config: { surfaceCap: 2 } });

  const optedIn = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_opt",
    profileKey: "chatgpt:acct-a",
    retainSurfaceProcess: true,
  });
  const notOptedIn = leases.acquire({ connectorId: "chase", runId: "run_plain", profileKey: "chase" });

  assert.equal(leases.getSurface(optedIn.lease.surface_id ?? "")?.retained, true);
  assert.equal(leases.getSurface(notOptedIn.lease.surface_id ?? "")?.retained, undefined);
});

test("retention: two same-connector ChatGPT connections keep independent retained surfaces", () => {
  const { leases } = manager({ config: { surfaceCap: 5 } });

  const a = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_a",
    profileKey: "chatgpt:acct-a",
    surfaceSubjectId: "acct-a",
    retainSurfaceProcess: true,
  });
  const b = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_b",
    profileKey: "chatgpt:acct-b",
    surfaceSubjectId: "acct-b",
    retainSurfaceProcess: true,
  });

  assert.notEqual(a.lease.surface_id, b.lease.surface_id);
  assert.equal(leases.getSurface(a.lease.surface_id ?? "")?.retained, true);
  assert.equal(leases.getSurface(b.lease.surface_id ?? "")?.retained, true);

  // An ordinary connection under capacity pressure must not reclaim either
  // retained surface. cap=3 is the live invariant: two retained ChatGPT surfaces
  // plus one fair transient slot.
  const tight = manager({ config: { surfaceCap: 3 } });
  tight.leases.acquire({
    connectorId: "chatgpt",
    runId: "ra",
    profileKey: "chatgpt:acct-a",
    surfaceSubjectId: "acct-a",
    retainSurfaceProcess: true,
  });
  tight.leases.acquire({
    connectorId: "chatgpt",
    runId: "rb",
    profileKey: "chatgpt:acct-b",
    surfaceSubjectId: "acct-b",
    retainSurfaceProcess: true,
  });
  // Fill the one fair transient slot with an ordinary connection, then a second
  // ordinary connection presses capacity — it must NOT reclaim a retained surface.
  tight.leases.acquire({ connectorId: "chase", runId: "rc", profileKey: "chase" });
  const waiter = tight.leases.acquire({ connectorId: "reddit", runId: "rd", profileKey: "reddit" });
  assert.equal(waiter.lease.status, "waiting_for_browser_surface");
  assert.equal(tight.leases.planCapacityPressureReclaim(waiter.lease.lease_id), undefined);
});

test("retention: creating a retained surface that would consume the fair-slot reserve is terminally deferred", () => {
  // cap=3 → at most 2 retained surfaces (reserve = 1 transient slot). A third
  // retained connection must NOT be able to create a surface; it fails with a
  // typed terminal deferral, not an indefinite capacity_full queue. This is the
  // true-demand enforcement: it fires the moment a configured retained
  // connection first materializes, regardless of prior observed surfaces.
  const { leases } = manager({ config: { surfaceCap: 3 } });
  for (const subject of ["acct-a", "acct-b"]) {
    const res = leases.acquire({
      connectorId: "chatgpt",
      runId: `run_${subject}`,
      profileKey: `chatgpt:${subject}`,
      surfaceSubjectId: subject,
      retainSurfaceProcess: true,
    });
    assert.equal(res.lease.status, "starting_surface", `${subject} should get a surface`);
  }
  const third = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_acct-c",
    profileKey: "chatgpt:acct-c",
    surfaceSubjectId: "acct-c",
    retainSurfaceProcess: true,
  });
  assert.equal(third.lease.status, "deferred");
  assert.equal(third.lease.wait_reason, "retained_capacity_reserved");
  // A non-retained connection can still take the reserved transient slot.
  const ordinary = leases.acquire({ connectorId: "chase", runId: "run_chase", profileKey: "chase" });
  assert.equal(ordinary.lease.status, "starting_surface");
});

test("retention: a second queued retained lease terminally defers at acquire against demand, not just materialized surfaces", async () => {
  // Race this closes: reserve enforcement that only counts materialized
  // retained SURFACES is blind to a retained lease that is queued but has not
  // yet created a surface. An idle ordinary surface and one active ordinary
  // surface occupy two of three cap slots, so when retained B acquires it
  // queues on ordinary capacity_full (only one retained surface — A — exists)
  // rather than hitting the reserve check by surface count alone. A
  // surface-only count would then let a third retained lease C ALSO look like
  // it has reserve headroom (still just one retained surface), so both B and C
  // would sit queued expecting the one reserved slot the invariant promises
  // only one of them can ever have. Counting nonterminal retained DEMAND
  // (surfaces + other queued retained leases) must catch this the moment C
  // acquires, before it ever enters the queue.
  const { leases } = manager({ config: { surfaceCap: 3 } });
  const allocator = new FakeBrowserSurfaceAllocator();

  const idleOrdinary = leases.acquire({ connectorId: "chase", runId: "run_chase_1", profileKey: "chase:1", accountKey: "1" });
  assert.equal(idleOrdinary.lease.status, "starting_surface");
  assert.ok(idleOrdinary.lease.surface_id);
  await leases.ensureStartingSurfaceReady({ leaseId: idleOrdinary.lease.lease_id, allocator });
  allocator.setReady(idleOrdinary.lease.surface_id!);
  const readyIdleOrdinary = await leases.ensureStartingSurfaceReady({ leaseId: idleOrdinary.lease.lease_id, allocator });
  assert.equal(readyIdleOrdinary.lease.status, "leased");
  leases.release({ leaseId: readyIdleOrdinary.lease.lease_id, fencingToken: readyIdleOrdinary.lease.fencing_token });
  // idleOrdinary's surface is now idle-but-present (still consumes cap) with
  // profile chase:1 — reclaimable by capacity pressure, but not by a same-
  // profile acquire from any of the leases below.

  const activeOrdinary = leases.acquire({ connectorId: "chase", runId: "run_chase_2", profileKey: "chase:2", accountKey: "2" });
  assert.equal(activeOrdinary.lease.status, "starting_surface");

  // Cap (3) is not yet exhausted by the two ordinary surfaces, so retained A
  // gets a surface: 2 ordinary + A = 3 active, cap reached.
  const a = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_a",
    profileKey: "chatgpt:acct-a",
    surfaceSubjectId: "acct-a",
    retainSurfaceProcess: true,
  });
  assert.equal(a.lease.status, "starting_surface");

  // Retained B: reserve check counts 1 retained surface (A) → 1+1 > 2 is false,
  // so B is NOT reserve-blocked. But capacity is full (3/3), so B queues on
  // ordinary capacity_full — this is the uncounted-demand gap.
  const b = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_b",
    profileKey: "chatgpt:acct-b",
    surfaceSubjectId: "acct-b",
    retainSurfaceProcess: true,
  });
  assert.equal(b.lease.status, "waiting_for_browser_surface");
  assert.equal(b.lease.wait_reason, "capacity_full");

  // Retained C: with demand counting, B's queued retained lease now counts as
  // demand (1 surface + 1 queued = 2) → 2+1 > 2 is true → C terminally defers
  // immediately, without ever entering the queue.
  const c = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_c",
    profileKey: "chatgpt:acct-c",
    surfaceSubjectId: "acct-c",
    retainSurfaceProcess: true,
  });
  assert.equal(c.lease.status, "deferred");
  assert.equal(c.lease.wait_reason, "retained_capacity_reserved");

  // B is still legitimately queued — it must still be promotable once a
  // transient slot genuinely frees, since it is the ONE retained lease the
  // reserve allows. Reclaim the idle ordinary surface to free that slot.
  const planned = leases.planCapacityPressureReclaim(b.lease.lease_id);
  assert.equal(planned?.surface_id, idleOrdinary.lease.surface_id);
  const reclaimed = leases.completeCapacityPressureReclaim(planned!.surface_id);
  assert.equal(reclaimed.promoted?.run_id, "run_b", "the sole reserve-eligible retained lease must still be promotable");
  assert.equal(leases.getLease(b.lease.lease_id)?.status, "starting_surface");

  // C remains terminally deferred; it must not be resurrected by B's promotion.
  assert.equal(leases.getLease(c.lease.lease_id)?.status, "deferred");
});

test("retention: reused surface rehydrated without the flag is re-healed on the retained connection's next lease", () => {
  // Simulate a restart: the surface row rehydrated WITHOUT `retained` (the
  // persistence row does not carry it). The retained connection's next run must
  // re-mark it before any reap can consider it.
  const rehydrated = retainedSurface();
  const { retained: _dropped, ...withoutFlag } = rehydrated;
  const { leases } = manager({ initialSurfaces: [withoutFlag] });
  assert.equal(leases.getSurface("surface_retained")?.retained, undefined);

  const leased = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_reheal",
    profileKey: "chatgpt:acct-a",
    retainSurfaceProcess: true,
  });
  assert.equal(leased.lease.status, "leased");
  assert.equal(leases.getSurface("surface_retained")?.retained, true);
});
