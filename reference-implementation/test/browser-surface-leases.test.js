import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  projectBrowserSurfaceLease,
} from "@opendatalabs/remote-surface/leases";
import {
  DEFAULT_NEKO_LEASE_SWEEP_INTERVAL_MS,
  DEFAULT_NEKO_READINESS_TIMEOUT_MS,
  browserSurfaceLeaseEnv,
  parseNekoBrowserSurfaceLeaseConfig,
  parseNekoBrowserSurfaceRuntimeConfig,
} from "../runtime/browser-surface-leases.ts";

function config(overrides = {}) {
  return {
    managedConnectors: new Set(["chatgpt", "gmail"]),
    surfaceCap: 1,
    staticProfileKey: "chatgpt",
    staticCdpHttpUrl: "http://neko:9222",
    staticStreamBaseUrl: "http://neko:8080",
    leaseWaitTimeoutMs: 60_000,
    idleTtlMs: 300_000,
    defaultPriorityClass: "background",
    priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
    surfaceMode: "static",
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

// Ported from @opendatalabs/remote-surface's own
// `src/leases/surface-lease-manager.test.ts` (commit closing the
// account-isolation gap — see the package's dynamic-mode capacity-pressure
// reclaim and account-isolation regressions). Kept minimal: only the pieces
// `FakeBrowserSurfaceAllocator` needs for the three ported scenarios below.
class FakeBrowserSurfaceAllocator {
  #surfaces = new Map();

  async ensureSurface(request) {
    const surface = this.#surfaces.get(request.surfaceId) ?? {
      surface_id: request.surfaceId,
      backend: "neko",
      profile_key: request.profileKey,
      connector_id: request.connectorId,
      cdp_url: "",
      stream_base_url: "",
      health: "starting",
      created_at: "2026-05-12T12:00:00.000Z",
      last_used_at: "2026-05-12T12:00:00.000Z",
      ...(request.accountKey ? { account_key: request.accountKey } : {}),
      container_id: `container_${request.surfaceId}`,
    };
    this.#surfaces.set(request.surfaceId, surface);
    return surface;
  }

  async getSurfaceStatus(surfaceId) {
    return this.#surfaces.get(surfaceId) ?? null;
  }

  async stopSurface() {
    return null;
  }

  async listSurfaces() {
    return [...this.#surfaces.values()];
  }

  setReady(surfaceId) {
    const surface = this.#surfaces.get(surfaceId);
    assert.ok(surface);
    this.#surfaces.set(surfaceId, {
      ...surface,
      cdp_url: `http://${surfaceId}:9222`,
      stream_base_url: `http://${surfaceId}:8080`,
      health: "ready",
    });
  }
}

test("compatible idle surface is leased and projected for connector launch", () => {
  const initialSurfaces = [
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
  ];
  const { manager: leases } = manager({ initialSurfaces });

  const result = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });

  assert.equal(result.lease.status, "leased");
  assert.equal(result.lease.surface_id, "neko-static");
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
    PDPP_BROWSER_SURFACE_ID: "neko-static",
    PDPP_BROWSER_SURFACE_REMOTE_CDP_URL: "http://neko:9222",
    PDPP_BROWSER_SURFACE_STREAM_BASE_URL: "http://neko:8080",
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

// The three tests below replace a single 0.3.0-era "priority then FIFO
// determines release pump ordering" test that asserted release-time
// promotion across three *different* `accountKey`s on one static surface.
// Under 0.3.1's account-isolation contract that scenario is not just
// outdated, it is impossible to express honestly through the public API:
// `#findPendingDuplicate` collapses same-(connector,profile,account,subject)
// pending acquires into one lease (proven below), and a released surface's
// `account_key` now gates which queued lease can reuse it (also proven
// below), so a single static surface released by an account-less lease can
// never promote a queued lease for a *different* account — there is nowhere
// left for that lease to go but to keep waiting. Contorting the input
// (fabricating distinct connector ids to dodge the dedupe, or omitting
// accountKey to dodge isolation) would just re-encode the pre-isolation
// behavior under a different name.
//
// Ported from @opendatalabs/remote-surface's own
// `src/leases/surface-lease-manager.test.ts` (the commit that closed the
// account-isolation gap replaced its own now-obsolete FIFO test the same
// way — priority/FIFO is proven in dynamic mode via the capacity-pressure
// reclaim path, and two new tests pin account isolation directly). Verified
// against the installed `@opendatalabs/remote-surface@0.3.1` package before
// porting.
test("capacity-full request queues and reclaim-driven pump promotes by priority then FIFO", async () => {
  // surfaceCap 1, dynamic mode: `first` occupies the only slot. Releasing it
  // leaves the surface idle but still counted against the cap (see
  // #surfaceConsumesCapacity — only "unhealthy"/"stopping" surfaces are
  // excluded), so freeing the slot for a *different* profile goes through
  // the capacity-pressure reclaim path, which is exactly the mechanism this
  // exercises.
  const ctx = manager({ config: { surfaceMode: "dynamic", staticProfileKey: undefined, surfaceCap: 1 } });
  const { manager: leases } = ctx;

  const first = leases.acquire({ connectorId: "chatgpt", runId: "run_1", profileKey: "chatgpt" });
  const allocator = new FakeBrowserSurfaceAllocator();
  await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  assert.ok(first.lease.surface_id);
  allocator.setReady(first.lease.surface_id);
  const readyFirst = await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  const released = leases.release({ leaseId: readyFirst.lease.lease_id, fencingToken: readyFirst.lease.fencing_token });
  assert.equal(released.released, true);
  assert.equal(leases.getSurface(first.lease.surface_id ?? "")?.health, "ready");

  // Distinct profile_key (not distinct account_key) keeps `low`/`high` from
  // being coalesced as pending duplicates of each other, without relying on
  // cross-account surface sharing (accounts are isolated — see the tests
  // below). Neither is compatible with the idle `first` surface (different
  // profile_key), so both queue on capacity_full.
  const low = leases.acquire({ connectorId: "chatgpt", runId: "run_low", profileKey: "profile_low" });
  ctx.advance(1);
  const high = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_high",
    profileKey: "profile_high",
    priorityClass: "interactive",
  });
  assert.equal(low.lease.status, "waiting_for_browser_surface");
  assert.equal(high.lease.status, "waiting_for_browser_surface");

  // `high` (interactive) outranks `low` (background), so the
  // reclaim planner must pick `high`'s lease as the one to serve, and
  // completing that reclaim must promote `high`, not `low`, even though
  // `low` queued first.
  const planned = leases.planCapacityPressureReclaim(high.lease.lease_id);
  assert.equal(planned?.surface_id, first.lease.surface_id);
  const reclaimed = leases.completeCapacityPressureReclaim(planned?.surface_id ?? "");

  assert.equal(reclaimed.promoted?.run_id, "run_high");
  assert.equal(reclaimed.promoted?.status, "starting_surface");
  assert.notEqual(reclaimed.promoted?.surface_id, first.lease.surface_id);
  assert.equal(leases.getLease(low.lease.lease_id)?.status, "waiting_for_browser_surface");
});

test("account isolation: same profile and subject with distinct non-null account_key does not dedupe at acquire", () => {
  const { manager: leases } = manager({ config: { surfaceMode: "dynamic", staticProfileKey: undefined, surfaceCap: 2 } });

  const accountA = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_a",
    profileKey: "chatgpt",
    surfaceSubjectId: "owner_1",
    accountKey: "account_a",
  });
  const accountB = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_b",
    profileKey: "chatgpt",
    surfaceSubjectId: "owner_1",
    accountKey: "account_b",
  });

  // Same profile_key and same surface_subject_id, only account_key differs.
  // These must be treated as two distinct pending requests, not collapsed
  // into a single duplicate lease.
  assert.notEqual(accountA.lease.lease_id, accountB.lease.lease_id);
  assert.equal(accountB.duplicateOf, undefined);
  assert.equal(accountA.lease.status, "starting_surface");
  assert.equal(accountB.lease.status, "starting_surface");
  assert.notEqual(accountA.lease.surface_id, accountB.lease.surface_id);
});

test("account isolation: idle surface from one account is never reused by a same-profile-and-subject lease from another account", async () => {
  const ctx = manager({ config: { surfaceMode: "dynamic", staticProfileKey: undefined } });
  const { manager: leases } = ctx;

  const first = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_1",
    profileKey: "chatgpt",
    surfaceSubjectId: "owner_1",
    accountKey: "account_a",
  });
  const allocator = new FakeBrowserSurfaceAllocator();
  await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  assert.ok(first.lease.surface_id);
  allocator.setReady(first.lease.surface_id);
  const readyFirst = await leases.ensureStartingSurfaceReady({ leaseId: first.lease.lease_id, allocator });
  assert.equal(readyFirst.surface?.account_key, "account_a");

  const otherAccount = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_2",
    profileKey: "chatgpt",
    surfaceSubjectId: "owner_1",
    accountKey: "account_b",
  });
  // Same profile_key and surface_subject_id as `first`, only account_key
  // differs — must queue as its own lease (not dedupe against `first`) and
  // must observe capacity as full rather than being held as compatible.
  assert.notEqual(otherAccount.lease.lease_id, first.lease.lease_id);
  assert.equal(otherAccount.duplicateOf, undefined);
  assert.equal(otherAccount.lease.status, "waiting_for_browser_surface");
  assert.equal(otherAccount.lease.wait_reason, "capacity_full");

  const released = leases.release({ leaseId: readyFirst.lease.lease_id, fencingToken: readyFirst.lease.fencing_token });

  // Capacity is now idle, but the idle surface belongs to account_a. It must
  // never be handed to a queued lease for account_b even though profile_key
  // and surface_subject_id both match — this is the account-isolation
  // guarantee itself: a released surface never promotes a queued lease for
  // a different account.
  assert.equal(released.promoted, undefined);
  assert.equal(leases.getLease(otherAccount.lease.lease_id)?.status, "waiting_for_browser_surface");
  assert.equal(leases.listSurfaces()[0]?.active_lease_id, undefined);

  const sameAccountReacquire = leases.acquire({
    connectorId: "chatgpt",
    runId: "run_3",
    profileKey: "chatgpt",
    surfaceSubjectId: "owner_1",
    accountKey: "account_a",
  });
  assert.equal(sameAccountReacquire.lease.status, "leased");
  assert.equal(sameAccountReacquire.lease.surface_id, first.lease.surface_id);
});

test("restart reconciliation keeps active leased run intact", () => {
  const { manager: leases } = manager({
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        active_lease_id: "lease_active",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_active",
        surface_id: "neko-static",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_active",
        status: "leased",
        priority_class: "interactive",
        requested_at: "2026-05-12T11:00:00.000Z",
        leased_at: "2026-05-12T11:00:01.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart({ activeRunIds: new Set(["run_active"]) });

  assert.equal(reconciled.activeLeased.length, 1);
  assert.equal(leases.getLease("lease_active").status, "leased");
  assert.equal(leases.getSurface("neko-static").active_lease_id, "lease_active");
});

test("restart reconciliation releases stale healthy lease and preserves surface", () => {
  const { manager: leases } = manager({
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        active_lease_id: "lease_stale",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_stale",
        surface_id: "neko-static",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_stale",
        status: "leased",
        priority_class: "interactive",
        requested_at: "2026-05-12T11:00:00.000Z",
        leased_at: "2026-05-12T11:00:01.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.released.length, 1);
  assert.equal(leases.getLease("lease_stale").status, "released");
  assert.equal(leases.getSurface("neko-static").active_lease_id, undefined);
});

test("restart reconciliation expires leased run when surface is missing", () => {
  const { manager: leases } = manager({
    initialLeases: [
      {
        lease_id: "lease_missing",
        surface_id: "surface_missing",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_missing",
        status: "leased",
        priority_class: "interactive",
        requested_at: "2026-05-12T11:00:00.000Z",
        leased_at: "2026-05-12T11:00:01.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.expired.length, 1);
  assert.equal(leases.getLease("lease_missing").status, "expired");
});

test("restart reconciliation marks unhealthy leased surface failed without deleting surface", () => {
  const { manager: leases } = manager({
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "unhealthy",
        active_lease_id: "lease_unhealthy",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_unhealthy",
        surface_id: "neko-static",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_unhealthy",
        status: "leased",
        priority_class: "interactive",
        requested_at: "2026-05-12T11:00:00.000Z",
        leased_at: "2026-05-12T11:00:01.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.surfaceFailed.length, 1);
  assert.equal(leases.getLease("lease_unhealthy").status, "surface_failed");
  assert.equal(leases.getLease("lease_unhealthy").wait_reason, "surface_unhealthy");
  assert.equal(leases.getSurface("neko-static").health, "unhealthy");
  assert.equal(leases.getSurface("neko-static").active_lease_id, undefined);
});

test("restart reconciliation preserves queued run within wait policy", () => {
  const { manager: leases } = manager({
    initialLeases: [
      {
        lease_id: "lease_queued",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_queued",
        status: "waiting_for_browser_surface",
        wait_reason: "capacity_full",
        priority_class: "background",
        requested_at: "2026-05-12T11:59:59.000Z",
        expires_at: "2026-05-12T12:01:00.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.queued.length, 1);
  assert.equal(leases.getLease("lease_queued").status, "waiting_for_browser_surface");
});

test("restart reconciliation defers queued run past wait policy", () => {
  const { manager: leases } = manager({
    initialLeases: [
      {
        lease_id: "lease_timeout",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_timeout",
        status: "waiting_for_browser_surface",
        wait_reason: "capacity_full",
        priority_class: "background",
        requested_at: "2026-05-12T11:00:00.000Z",
        expires_at: "2026-05-12T11:59:59.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.deferred.length, 1);
  assert.equal(leases.getLease("lease_timeout").status, "deferred");
  assert.equal(leases.getLease("lease_timeout").wait_reason, "lease_wait_timeout");
});

test("restart reconciliation defers incompatible static queued profile", () => {
  const { manager: leases } = manager({
    config: { surfaceMode: "static", staticProfileKey: "chatgpt", surfaceCap: 1 },
    initialLeases: [
      {
        lease_id: "lease_static",
        connector_id: "gmail",
        profile_key: "gmail",
        run_id: "run_static",
        status: "waiting_for_browser_surface",
        wait_reason: "capacity_full",
        priority_class: "background",
        requested_at: "2026-05-12T11:59:59.000Z",
        expires_at: "2026-05-12T12:01:00.000Z",
        fencing_token: 10,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.deferred.length, 1);
  assert.equal(leases.getLease("lease_static").status, "deferred");
  assert.equal(leases.getLease("lease_static").wait_reason, "incompatible_static_profile");
});

test("restart reconciliation promotes queued-but-not-started run after stale release", () => {
  const { manager: leases } = manager({
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        active_lease_id: "lease_stale",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_stale",
        surface_id: "neko-static",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_stale",
        status: "leased",
        priority_class: "interactive",
        requested_at: "2026-05-12T11:00:00.000Z",
        leased_at: "2026-05-12T11:00:01.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 10,
      },
      {
        lease_id: "lease_waiting",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_waiting",
        status: "waiting_for_browser_surface",
        wait_reason: "capacity_full",
        priority_class: "background",
        requested_at: "2026-05-12T11:00:02.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 11,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart();

  assert.equal(reconciled.released.length, 1);
  assert.equal(reconciled.promoted.length, 1);
  assert.equal(reconciled.promoted[0].lease_id, "lease_waiting");
  assert.equal(leases.getLease("lease_waiting").status, "leased");
  assert.equal(leases.getSurface("neko-static").active_lease_id, "lease_waiting");
});

test("restart reconciliation can defer queue promotion until runtime URLs are ready", () => {
  const { manager: leases } = manager({
    initialSurfaces: [
      {
        surface_id: "neko-static",
        backend: "neko",
        profile_key: "chatgpt",
        connector_id: "chatgpt",
        cdp_url: "http://neko:9222",
        stream_base_url: "http://neko:8080",
        health: "ready",
        active_lease_id: "lease_stale",
        created_at: "2026-05-12T11:00:00.000Z",
        last_used_at: "2026-05-12T11:00:00.000Z",
      },
    ],
    initialLeases: [
      {
        lease_id: "lease_stale",
        surface_id: "neko-static",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_stale",
        status: "leased",
        priority_class: "interactive",
        requested_at: "2026-05-12T11:00:00.000Z",
        leased_at: "2026-05-12T11:00:01.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 10,
      },
      {
        lease_id: "lease_waiting",
        connector_id: "chatgpt",
        profile_key: "chatgpt",
        run_id: "run_waiting",
        status: "waiting_for_browser_surface",
        wait_reason: "capacity_full",
        priority_class: "background",
        requested_at: "2026-05-12T11:00:02.000Z",
        expires_at: "2026-05-12T12:05:00.000Z",
        fencing_token: 11,
      },
    ],
  });

  const reconciled = leases.reconcileAfterRestart({ promoteQueued: false });

  assert.equal(reconciled.released.length, 1);
  assert.equal(reconciled.promoted.length, 0);
  assert.equal(leases.getLease("lease_waiting").status, "waiting_for_browser_surface");

  const promoted = leases.pumpQueuedLeases();
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].lease_id, "lease_waiting");
  assert.equal(leases.getLease("lease_waiting").status, "leased");
  assert.equal(leases.getSurface("neko-static").active_lease_id, "lease_waiting");
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

test("config parser matches canonical connector URLs and short runtime ids", () => {
  const parsed = parseNekoBrowserSurfaceLeaseConfig({
    PDPP_NEKO_MANAGED_CONNECTORS: "https://registry.pdpp.org/connectors/chatgpt/",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
    PDPP_NEKO_BASE_URL: "http://neko:8080",
  });

  assert.equal(parsed.managedConnectors.has("https://registry.pdpp.org/connectors/chatgpt/"), true);
  assert.equal(parsed.managedConnectors.has("https://registry.pdpp.org/connectors/chatgpt"), true);
  assert.equal(parsed.managedConnectors.has("chatgpt"), true);
  assert.equal(parsed.staticProfileKey, "chatgpt");

  const unrelatedUrl = parseNekoBrowserSurfaceLeaseConfig({
    PDPP_NEKO_MANAGED_CONNECTORS: "https://registry.pdpp.org/not-connectors/chatgpt/",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
    PDPP_NEKO_BASE_URL: "http://neko:8080",
  });

  assert.equal(unrelatedUrl.managedConnectors.has("chatgpt"), false);
  assert.equal(unrelatedUrl.staticProfileKey, "https://registry.pdpp.org/not-connectors/chatgpt/");

  const unknownFirstPartyUrl = parseNekoBrowserSurfaceLeaseConfig({
    PDPP_NEKO_MANAGED_CONNECTORS: "https://registry.pdpp.org/connectors/not-real",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
    PDPP_NEKO_BASE_URL: "http://neko:8080",
  });

  assert.equal(unknownFirstPartyUrl.managedConnectors.has("not-real"), false);
  assert.equal(unknownFirstPartyUrl.staticProfileKey, "https://registry.pdpp.org/connectors/not-real");
});

test("runtime config parser preserves static default and exposes lease config", () => {
  const parsed = parseNekoBrowserSurfaceRuntimeConfig({
    PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
    PDPP_NEKO_BASE_URL: "http://neko:8080",
  });

  assert.equal(parsed.dynamic, undefined);
  assert.equal(parsed.leaseConfig.surfaceMode, "static");
  assert.equal(parsed.leaseConfig.staticProfileKey, "chatgpt");
  assert.equal(parsed.leaseConfig.staticCdpHttpUrl, "http://neko:9222");
});

test("runtime config parser does not require dynamic settings when no n.eko connectors are managed", () => {
  const parsed = parseNekoBrowserSurfaceRuntimeConfig({});

  assert.equal(parsed.dynamic, undefined);
  assert.equal(parsed.leaseConfig.surfaceMode, "dynamic");
  assert.equal(parsed.leaseConfig.surfaceCap, 0);
  assert.equal(parsed.leaseConfig.managedConnectors.size, 0);
});

test("runtime config parser defaults the periodic sweep interval and honors an override", () => {
  const defaulted = parseNekoBrowserSurfaceRuntimeConfig({});
  assert.equal(defaulted.leaseSweepIntervalMs, DEFAULT_NEKO_LEASE_SWEEP_INTERVAL_MS);

  const overridden = parseNekoBrowserSurfaceRuntimeConfig({
    PDPP_NEKO_LEASE_SWEEP_INTERVAL_MS: "5000",
  });
  assert.equal(overridden.leaseSweepIntervalMs, 5000);
});

test("runtime config parser supports explicit dynamic one-connector mode", () => {
  const parsed = parseNekoBrowserSurfaceRuntimeConfig({
    PDPP_NEKO_SURFACE_MODE: "dynamic",
    PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
    PDPP_NEKO_SURFACE_CAP: "2",
    PDPP_NEKO_ALLOCATOR_URL: "http://neko-allocator:7345",
    PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
  });

  assert.equal(parsed.leaseConfig.surfaceMode, "dynamic");
  assert.equal(parsed.leaseConfig.surfaceCap, 2);
  assert.equal(parsed.leaseConfig.staticProfileKey, undefined);
  assert.equal(parsed.leaseConfig.staticCdpHttpUrl, undefined);
  assert.deepEqual(parsed.dynamic, {
    allocatorUrl: "http://neko-allocator:7345/",
    profileStoragePolicy: "persistent",
    profileStorageRoot: "/var/lib/pdpp/neko-profiles",
    readinessTimeoutMs: DEFAULT_NEKO_READINESS_TIMEOUT_MS,
  });
});

test("dynamic runtime config rejects unsafe static settings", () => {
  const baseEnv = {
    PDPP_NEKO_SURFACE_MODE: "dynamic",
    PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_ALLOCATOR_URL: "http://neko-allocator:7345",
    PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
  };

  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_CDP_HTTP_URL: "http://neko:9222",
      }),
    /PDPP_NEKO_CDP_HTTP_URL is static-only/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_BASE_URL: "http://neko:8080/neko",
      }),
    /PDPP_NEKO_BASE_URL is static-only/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_STATIC_PROFILE_KEY: "chatgpt",
      }),
    /PDPP_NEKO_STATIC_PROFILE_KEY is static-only/,
  );
});

test("dynamic runtime config validates cap and readiness timeout", () => {
  const baseEnv = {
    PDPP_NEKO_SURFACE_MODE: "dynamic",
    PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
    PDPP_NEKO_ALLOCATOR_URL: "http://neko-allocator:7345",
    PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
  };

  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_SURFACE_CAP: "0",
      }),
    /PDPP_NEKO_SURFACE_CAP must be an integer >= 1/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_SURFACE_CAP: "1",
        PDPP_NEKO_READINESS_TIMEOUT_MS: "0",
      }),
    /PDPP_NEKO_READINESS_TIMEOUT_MS must be an integer >= 1/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_SURFACE_CAP: "1",
        PDPP_NEKO_READINESS_TIMEOUT_MS: "1.5",
      }),
    /PDPP_NEKO_READINESS_TIMEOUT_MS must be a non-negative integer/,
  );
});

test("dynamic runtime config requires allocator and persistent profile storage settings", () => {
  const baseEnv = {
    PDPP_NEKO_SURFACE_MODE: "dynamic",
    PDPP_NEKO_MANAGED_CONNECTORS: "chatgpt",
    PDPP_NEKO_SURFACE_CAP: "1",
    PDPP_NEKO_ALLOCATOR_URL: "http://neko-allocator:7345",
    PDPP_NEKO_PROFILE_STORAGE_POLICY: "persistent",
    PDPP_NEKO_PROFILE_STORAGE_ROOT: "/var/lib/pdpp/neko-profiles",
  };

  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_ALLOCATOR_URL: "",
      }),
    /PDPP_NEKO_ALLOCATOR_URL is required/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_PROFILE_STORAGE_POLICY: "ephemeral",
      }),
    /PDPP_NEKO_PROFILE_STORAGE_POLICY must be one of: persistent/,
  );
  assert.throws(
    () =>
      parseNekoBrowserSurfaceRuntimeConfig({
        ...baseEnv,
        PDPP_NEKO_PROFILE_STORAGE_ROOT: "",
      }),
    /PDPP_NEKO_PROFILE_STORAGE_ROOT is required/,
  );
});
