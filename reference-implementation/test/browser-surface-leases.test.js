import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  browserSurfaceLeaseEnv,
  parseNekoBrowserSurfaceLeaseConfig,
  projectBrowserSurfaceLease,
} from "../runtime/browser-surface-leases.ts";

function config(overrides = {}) {
  return {
    managedConnectors: new Set(["chatgpt", "gmail"]),
    surfaceCap: 1,
    staticProfileKey: undefined,
    staticCdpHttpUrl: "http://neko:9222",
    staticStreamBaseUrl: "http://neko:8080",
    leaseWaitTimeoutMs: 60_000,
    idleTtlMs: 300_000,
    defaultPriorityClass: "scheduled_refresh",
    priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
    surfaceMode: "dynamic",
    ...overrides,
  };
}

function manager(options = {}) {
  let nowMs = Date.parse("2026-05-12T12:00:00.000Z");
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  const m = new BrowserSurfaceLeaseManager({
    config: config(options.config),
    now: () => new Date(nowMs),
    makeLeaseId: () => {
      leaseSeq += 1;
      return `lease_${leaseSeq}`;
    },
    makeSurfaceId: () => {
      surfaceSeq += 1;
      return `surface_${surfaceSeq}`;
    },
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    initialSurfaces: options.initialSurfaces,
    initialLeases: options.initialLeases,
  });
  return {
    manager: m,
    advance(ms) {
      nowMs += ms;
    },
  };
}

test("compatible idle surface is leased and projected for connector launch", () => {
  const initialSurfaces = [
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
  ];
  const { manager: leases } = manager({ initialSurfaces });

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
  assert.deepEqual(browserSurfaceLeaseEnv(result.lease, result.surface), {
    PDPP_BROWSER_SURFACE_REQUIRED: "neko",
    PDPP_BROWSER_SURFACE_LEASE_ID: "lease_1",
    PDPP_BROWSER_SURFACE_PROFILE_KEY: "chatgpt",
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://neko:9222",
  });
});

test("static incompatible profile defers instead of waiting forever", () => {
  const { manager: leases } = manager({
    config: { surfaceMode: "static", staticProfileKey: "chatgpt", surfaceCap: 1 },
  });

  const result = leases.acquire({ connectorId: "gmail", runId: "run_gmail", profileKey: "gmail" });

  assert.equal(result.lease.status, "deferred");
  assert.equal(result.lease.wait_reason, "incompatible_static_profile");
  assert.equal(leases.listSurfaces().length, 0);
});

test("capacity-full request queues before connector launch", () => {
  const { manager: leases } = manager();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const second = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });

  assert.equal(first.lease.status, "leased");
  assert.equal(second.lease.status, "waiting_for_browser_surface");
  assert.equal(second.lease.wait_reason, "capacity_full");
  assert.equal(leases.listSurfaces().length, 1);
});

test("duplicate pending run handling returns existing non-terminal lease", () => {
  const { manager: leases } = manager();

  leases.acquire({ connectorId: "chatgpt", runId: "run_active", profileKey: "chatgpt" });
  const pending = leases.acquire({ connectorId: "chatgpt", runId: "run_pending", profileKey: "chatgpt" });
  const sameRun = leases.acquire({ connectorId: "chatgpt", runId: "run_pending", profileKey: "chatgpt" });
  const sameConnectorProfile = leases.acquire({ connectorId: "chatgpt", runId: "run_duplicate", profileKey: "chatgpt" });

  assert.equal(pending.lease.status, "waiting_for_browser_surface");
  assert.equal(sameRun.duplicateOf?.lease_id, pending.lease.lease_id);
  assert.equal(sameConnectorProfile.duplicateOf?.lease_id, pending.lease.lease_id);
  assert.equal(leases.listLeases().length, 2);
});

test("cancellation marks queued lease terminal and prevents promotion", () => {
  const { manager: leases } = manager();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });

  const cancelled = leases.cancel("run_2");
  const released = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });

  assert.equal(queued.lease.status, "waiting_for_browser_surface");
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(released.promoted, undefined);
  assert.equal(leases.getLease(queued.lease.lease_id)?.status, "cancelled");
});

test("timeout defers queued lease with runtime resource wait reason", () => {
  const ctx = manager({ config: { leaseWaitTimeoutMs: 10 } });
  const { manager: leases } = ctx;

  leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });
  ctx.advance(11);

  const expired = leases.expireWaitingLeases();

  assert.equal(expired.length, 1);
  assert.equal(expired[0].lease_id, queued.lease.lease_id);
  assert.equal(expired[0].status, "deferred");
  assert.equal(expired[0].wait_reason, "lease_wait_timeout");
});

test("release is fenced and pumps the next compatible queued lease", () => {
  const { manager: leases } = manager();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });
  const released = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });

  assert.equal(released.released, true);
  assert.equal(released.promoted?.lease_id, queued.lease.lease_id);
  assert.equal(released.promoted?.status, "leased");
  assert.equal(leases.getSurface(first.lease.surface_id)?.active_lease_id, queued.lease.lease_id);
});

test("stale release fencing cannot release a newer lease", () => {
  const { manager: leases } = manager();

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const queued = leases.acquire({ connectorId: "chatgpt", runId: "run_2", profileKey: "chatgpt" });
  leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });
  const stale = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });

  assert.equal(stale.released, false);
  assert.equal(stale.stale, true);
  assert.equal(leases.getLease(queued.lease.lease_id)?.status, "leased");
  assert.equal(leases.getSurface(first.lease.surface_id)?.active_lease_id, queued.lease.lease_id);
});

test("concurrent final-slot acquisition cannot exceed cap", async () => {
  const { manager: leases } = manager();

  const results = await Promise.all([
    Promise.resolve().then(() => leases.acquire({ connectorId: "chatgpt", runId: "run_a", profileKey: "chatgpt" })),
    Promise.resolve().then(() => leases.acquire({ connectorId: "chatgpt", runId: "run_b", profileKey: "chatgpt" })),
  ]);

  assert.equal(results.filter((result) => result.lease.status === "leased").length, 1);
  assert.equal(results.filter((result) => result.lease.status === "waiting_for_browser_surface").length, 1);
  assert.equal(leases.listSurfaces().length, 1);
});

test("priority then FIFO determines release pump ordering", () => {
  const ctx = manager();
  const { manager: leases } = ctx;

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const lowA = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_low_a",
    profileKey: "chatgpt",
    accountKey: "account_a",
    priorityClass: "scheduled_refresh",
  });
  ctx.advance(1);
  const high = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_high",
    profileKey: "chatgpt",
    accountKey: "account_b",
    priorityClass: "owner_interactive",
  });
  ctx.advance(1);
  const lowB = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_low_b",
    profileKey: "chatgpt",
    accountKey: "account_c",
    priorityClass: "scheduled_refresh",
  });

  const releasedFirst = leases.release({ leaseId: first.lease.lease_id, fencingToken: first.lease.fencing_token });
  const releasedHigh = leases.release({
    leaseId: releasedFirst.promoted.lease_id,
    fencingToken: releasedFirst.promoted.fencing_token,
  });
  const releasedLowA = leases.release({
    leaseId: releasedHigh.promoted.lease_id,
    fencingToken: releasedHigh.promoted.fencing_token,
  });

  assert.equal(lowA.lease.status, "waiting_for_browser_surface");
  assert.equal(high.lease.status, "waiting_for_browser_surface");
  assert.equal(lowB.lease.status, "waiting_for_browser_surface");
  assert.equal(releasedFirst.promoted?.run_id, "run_high");
  assert.equal(releasedHigh.promoted?.run_id, "run_low_a");
  assert.equal(releasedLowA.promoted?.run_id, "run_low_b");
});

test("config parser validates managed policy and defaults static single connector profile", () => {
  const parsed = parseNekoBrowserSurfaceLeaseConfig({
    PDPP_NEKO_MANAGED_CONNECTORS: " chatgpt, chatgpt ",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
    PDPP_NEKO_BASE_URL: "http://neko:8080",
  });

  assert.equal(parsed.managedConnectors.has("chatgpt"), true);
  assert.equal(parsed.managedConnectors.size, 1);
  assert.equal(parsed.surfaceCap, 1);
  assert.equal(parsed.staticProfileKey, "chatgpt");
  assert.equal(parsed.surfaceMode, "static");
  assert.throws(
    () =>
      parseNekoBrowserSurfaceLeaseConfig({
        PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
        PDPP_NEKO_SURFACE_CAP: "2",
        PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
        PDPP_NEKO_BASE_URL: "http://neko:8080",
      }),
    /exactly 1/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceLeaseConfig({
        PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
        PDPP_NEKO_SURFACE_CAP: "1",
        PDPP_NEKO_BASE_URL: "http://neko:8080",
      }),
    /PDPP_NEKO_CDP_HTTP_URL/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceLeaseConfig({
        PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
        PDPP_NEKO_SURFACE_CAP: "1",
        PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
      }),
    /PDPP_NEKO_BASE_URL/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceLeaseConfig({
        PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt,gmail",
        PDPP_NEKO_SURFACE_CAP: "1",
      }),
    /PDPP_NEKO_STATIC_PROFILE_KEY/,
  );
});
