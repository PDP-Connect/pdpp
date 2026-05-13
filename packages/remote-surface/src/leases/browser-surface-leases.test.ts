import assert from "node:assert/strict";
import test from "node:test";

import {
  type BrowserSurface,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseConfig,
  BrowserSurfaceLeaseManager,
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
});

test("capacity-full request queues and release pumps by priority then FIFO", () => {
  const ctx = manager();
  const { leases } = ctx;

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
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

  const released = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });

  assert.equal(low.lease.status, "waiting_for_browser_surface");
  assert.equal(high.lease.status, "waiting_for_browser_surface");
  assert.equal(released.promoted?.run_id, "run_high");
  assert.equal(leases.listSurfaces().length, 1);
});

test("stale release fencing cannot release a promoted lease", () => {
  const { leases } = manager();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });
  leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });
  const stale = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });

  assert.equal(queued.lease.status, "waiting_for_browser_surface");
  assert.equal(stale.released, false);
  assert.equal(stale.stale, true);
  assert.equal(leases.getLease(queued.lease.lease_id)?.status, "leased");
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
