// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-grade tests for bounded mid-run "phase-scoped" browser-surface
 * leases (see the bounded-browser-phase contract). Exercises
 * `createBrowserSurfaceManager` directly (imitating
 * controller-browser-surface-readiness.test.ts's ~line 1881 pattern) against
 * a real `BrowserSurfaceLeaseManager` with a fake allocator, so capacity,
 * fencing, and boot-reconciliation are the REAL lease-layer logic, not a
 * mock.
 *
 * Invariants covered (see bounded-browser-phase-contract):
 *   I1 — distinct session key, independent capacity from a run-level lease.
 *   I3 — fenced release: a stale ownership record cannot free a newer lease.
 *   I4 — no leak on cleanup; idempotent release.
 *   I5 — cap fairness: a phase acquire never blocks/queues past capacity.
 *   I6 — run-level connectors are unchanged (see browser-surface-policy.test.ts
 *        for the pure accessor assertions).
 *   I8 — AM-1 regression guard: boot reconciliation must not release a live
 *        phase lease whose parent run is still active.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  type BrowserSurfaceLease,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  type EnsureBrowserSurfaceRequest,
  type StopBrowserSurfaceRequest,
  // biome-ignore lint/correctness/noUnresolvedImports: workspace package subpath is available to the test runtime.
} from "@opendatalabs/remote-surface/leases";
import { createTraceContext } from "../lib/spine.ts";
import {
  browserSurfacePhaseSessionId,
  createBrowserSurfaceManager,
} from "../runtime/browser-surface/run-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

function tempDbPath(): string {
  return makeTemporaryDbPath("pdpp-browser-surface-phase-");
}

interface CreateManagerOptions {
  leaseWaitTimeoutMs?: number;
  managedConnectors?: Set<string>;
  surfaceCap?: number;
}

// Mirrors controller-browser-surface-leases.test.ts's createDynamicManager:
// deterministic ids/tokens, frozen clock, dynamic (allocator-backed) mode so
// the phase acquire actually round-trips through the fake allocator below.
function createManager(options: CreateManagerOptions = {}): BrowserSurfaceLeaseManager {
  const {
    managedConnectors = new Set(["slack"]),
    surfaceCap = 2,
    leaseWaitTimeoutMs = 300_000,
  } = options;
  let leaseSeq = 0;
  let surfaceSeq = 0;
  let tokenSeq = 0;
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs,
      managedConnectors,
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap,
      surfaceMode: "dynamic",
    },
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
    now: () => new Date("2026-07-31T12:00:00.000Z"),
  });
}

// Same fake allocator shape as controller-browser-surface-leases.test.ts's
// createReadyAllocator: resolves ensureSurface immediately as "ready" and
// records every ensure/stop call so tests can assert exactly how many
// surfaces were minted.
function createReadyAllocator(): BrowserSurfaceAllocator & {
  ensureRequests: EnsureBrowserSurfaceRequest[];
  stopRequests: StopBrowserSurfaceRequest[];
} {
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const surfaces = new Map<string, BrowserSurface>();
  return {
    ensureRequests,
    ensureSurface: (request) => {
      ensureRequests.push(request);
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://127.0.0.1:9222/${request.surfaceId}`,
        connector_id: request.connectorId,
        created_at: "2026-07-31T12:00:00.000Z",
        health: "ready",
        last_used_at: "2026-07-31T12:00:00.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://127.0.0.1:8080/${request.surfaceId}`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return Promise.resolve(surface);
    },
    getSurfaceStatus: async (surfaceId) => surfaces.get(surfaceId) ?? null,
    listSurfaces: async () => [...surfaces.values()],
    stopRequests,
    stopSurface: (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return Promise.resolve(surface);
    },
  };
}

interface SetupOptions {
  leaseManager?: BrowserSurfaceLeaseManager;
  listPersistedActiveRuns?: () => Promise<ReadonlyArray<{ readonly run_id: string }>>;
  warnCalls?: string[];
}

// The allocator is a required, separately-constructed argument (rather than
// an optional field defaulted inside setup()) so callers that need to
// inspect a concrete fake allocator's extra fields (ensureRequests,
// stopRequests) keep that concrete type — setup() never widens it back to
// the bare BrowserSurfaceAllocator interface.
function setup<TAllocator extends BrowserSurfaceAllocator>(
  t: TestContext,
  allocator: TAllocator,
  options: SetupOptions = {}
) {
  closeDb();
  initDb(tempDbPath());
  t.after(() => closeDb());

  const leaseManager = options.leaseManager ?? createManager();
  const manager = createBrowserSurfaceManager({
    activeRunInteractions: new Map(),
    browserSurfaceAllocator: allocator,
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceLeaseStore: null,
    browserSurfaceMidWaitPollIntervalMs: undefined,
    browserSurfaceReadinessProbe: null,
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: null,
    listPersistedActiveRuns: options.listPersistedActiveRuns ?? (async () => []),
    log: {
      error: () => undefined,
      warn: (message: string) => {
        options.warnCalls?.push(message);
      },
    },
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => undefined,
    startupControllerRunReconciliation: Promise.resolve(),
  });
  return { allocator, leaseManager, manager };
}

function phaseInput(runId: string, connectorId = "slack", connectorInstanceId = connectorId) {
  return {
    connectorId,
    connectorInstanceId,
    runId,
    traceContext: createTraceContext(),
  };
}

// ─── I1: distinct session key / independent capacity ───────────────────────

test("I1: phase acquire uses a session id distinct from the run id, not a duplicateOf collision", async (t) => {
  const { leaseManager, manager } = setup(t, createReadyAllocator());

  const result = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));

  assert.equal(result.kind, "granted");
  const sessionId = browserSurfacePhaseSessionId("run_x");
  assert.equal(sessionId, "run_x#browser-phase");

  const leases = leaseManager.listLeases();
  assert.equal(leases.length, 1, "exactly one lease created for the phase acquire");
  const [phaseLease] = leases;
  assert.ok(phaseLease);
  assert.equal(phaseLease.run_id, sessionId, "lease is keyed by the derived session id, not the bare run id");
  assert.notEqual(phaseLease.run_id, "run_x");
});

test("I1: a phase acquire succeeds while a DIFFERENT run holds a run-level lease (independent capacity)", async (t) => {
  const leaseManager = createManager({ managedConnectors: new Set(["slack"]), surfaceCap: 2 });
  const { manager } = setup(t, createReadyAllocator(), { leaseManager });

  // Simulate another run's run-level lease directly against the same lease
  // manager instance (independent of the phase manager under test), using
  // the manager's own acquire() so it is subject to the SAME capacity/dedup
  // rules a phase acquire would be.
  const runLevelResult = leaseManager.acquire({
    connectorId: "slack",
    profileKey: "slack-profile",
    runId: "run_other",
  });
  assert.equal(runLevelResult.duplicateOf, undefined, "the run-level acquire itself must not collide with anything");

  const phaseResult = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));

  assert.equal(
    phaseResult.kind,
    "granted",
    "phase acquire for a distinct run must succeed even though run_other already holds a lease " +
      "(if the phase session id collided with run_x's own run id space, or shared identity with " +
      "run_other, this would either duplicate or starve)"
  );
  assert.equal(leaseManager.listLeases().length, 2, "two independent leases: one run-level, one phase-scoped");
});

// ─── I3: fenced release ─────────────────────────────────────────────────────

test("I3: a stale ownership record from a previously-cancelled lease does not resurrect or disturb a subsequently-acquired phase lease", async (t) => {
  const { leaseManager, manager } = setup(t, createReadyAllocator());

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");
  assert.ok(granted.kind === "granted");
  const firstLeaseId = granted.leaseId;
  const sessionId = browserSurfacePhaseSessionId("run_x");

  // The phase lease is torn down through a DIFFERENT path than
  // releaseManagedBrowserSurfaceForPhase (e.g. an operator-triggered
  // cancelAndPump against the phase session id). The lease reaches a
  // terminal status ("cancelled") through that path, while the manager's
  // phaseLeasesByRunId ownership map still has a (now stale) entry pointing
  // at this lease_id and fencing token.
  const cancelResult = leaseManager.cancelAndPump(sessionId);
  assert.ok(cancelResult.lease);
  assert.equal(leaseManager.getLease(firstLeaseId)?.status, "cancelled", "cancel terminalizes the lease in place");

  // A fresh phase lease is then acquired for the SAME run (e.g. the next
  // bounded phase). It gets a brand-new lease_id.
  const second = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(second.kind, "granted");
  assert.ok(second.kind === "granted");
  const secondLeaseId = second.leaseId;
  assert.notEqual(secondLeaseId, firstLeaseId);
  assert.equal(leaseManager.getLease(secondLeaseId)?.status, "leased");

  // The run-cleanup backstop later calls releaseManagedBrowserSurfaceForPhase
  // unconditionally. By now phaseLeasesByRunId's entry for "run_x" was
  // overwritten by the SECOND acquire, so this call targets the second
  // (currently live) lease_id/fencing token, not the already-cancelled
  // first one. It must not throw, and it must release exactly the second
  // lease.
  await assert.doesNotReject(() => manager.releaseManagedBrowserSurfaceForPhase("run_x"));

  assert.equal(
    leaseManager.getLease(secondLeaseId)?.status,
    "released",
    "releaseManagedBrowserSurfaceForPhase must release the CURRENT ownership record's lease (the second, live one)"
  );
  assert.equal(
    leaseManager.getLease(firstLeaseId)?.status,
    "cancelled",
    "the already-cancelled first lease must be left exactly as cancelAndPump left it — untouched by this later release call"
  );
});

test("I3: a release call for a DIFFERENT run's phase lease cannot free this run's live lease", async (t) => {
  const { leaseManager, manager } = setup(t, createReadyAllocator());

  const ownLease = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(ownLease.kind, "granted");
  assert.ok(ownLease.kind === "granted");

  const otherLease = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_y"));
  assert.equal(otherLease.kind, "granted");
  assert.ok(otherLease.kind === "granted");

  // Releasing run_y's phase lease must be scoped ONLY to run_y's ownership
  // record — it must not read or clear run_x's entry in the same
  // phaseLeasesByRunId map (they are keyed by distinct real run ids).
  await manager.releaseManagedBrowserSurfaceForPhase("run_y");

  assert.equal(leaseManager.getLease(otherLease.leaseId)?.status, "released");
  assert.equal(
    leaseManager.getLease(ownLease.leaseId)?.status,
    "leased",
    "releasing a different run's phase lease must not disturb this run's still-live lease"
  );
});

test("I3: release call carries the fencing token recorded AT GRANT TIME, not whatever the live lease holds when release runs", async (t) => {
  const { leaseManager, manager } = setup(t, createReadyAllocator());

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");
  assert.ok(granted.kind === "granted");
  const leaseId = granted.leaseId;
  const grantedFencingToken = leaseManager.getLease(leaseId)?.fencing_token;
  assert.ok(typeof grantedFencingToken === "number");

  // Spy on the REAL lease manager's release() to capture the exact
  // fencingToken argument releaseManagedBrowserSurfaceForPhase passes,
  // then bump the live lease's token afterward so "recorded at grant time"
  // and "the lease's live token right now" are provably different values.
  // If the guard were dropped (release reading `lease.fencing_token` off
  // the CURRENT live lease instead of the token captured in
  // phaseLeasesByRunId at grant time), the captured call argument below
  // would equal the bumped value, not the original grant-time value.
  let capturedFencingToken: number | undefined;
  const originalRelease = leaseManager.release.bind(leaseManager);
  leaseManager.release = (request) => {
    capturedFencingToken = request.fencingToken;
    return originalRelease(request);
  };

  const bumpedToken = grantedFencingToken + 999;
  const liveLease = leaseManager.getLease(leaseId);
  assert.ok(liveLease);
  // BrowserSurfaceLease fields are readonly at the type level but the
  // manager's internal map is a plain mutable structure at runtime; renew()
  // is the only public mutator available and it does not touch
  // fencing_token, so directly overwrite the object field to simulate the
  // live lease's token having moved on, exactly like the "reassigned to a
  // new generation" scenario the source comment describes.
  Object.assign(liveLease, { fencing_token: bumpedToken });

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");

  assert.equal(
    capturedFencingToken,
    grantedFencingToken,
    "release() must be called with the token recorded at grant time, not the lease's mutated live token"
  );
  assert.notEqual(capturedFencingToken, bumpedToken);
  // The live lease's token no longer matches what was recorded at grant
  // time (we forced that divergence above), so the lease manager's own
  // fence correctly rejects this release as stale and leaves the lease
  // "leased" rather than terminalizing it — proving the recorded-token
  // guard is actually load-bearing, not merely passed through unchecked.
  assert.equal(
    leaseManager.getLease(leaseId)?.status,
    "leased",
    "a release carrying the stale grant-time token must be rejected by the lease manager's own fence, not silently succeed"
  );
});

// ─── I4: no leak on cleanup / idempotent release ───────────────────────────

test("I4: releaseManagedBrowserSurfaceForPhase transitions the phase lease to a terminal status", async (t) => {
  const { leaseManager, manager } = setup(t, createReadyAllocator());

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");
  assert.ok(granted.kind === "granted");
  assert.equal(leaseManager.getLease(granted.leaseId)?.status, "leased");

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");

  assert.equal(
    leaseManager.getLease(granted.leaseId)?.status,
    "released",
    "the phase lease must reach a terminal status after release — a lease left 'leased' is a capacity leak"
  );
});

test("I4: releaseManagedBrowserSurfaceForPhase is a silent no-op with no phase lease tracked", async () => {
  const leaseManager = createManager();
  const manager = createBrowserSurfaceManager({
    activeRunInteractions: new Map(),
    browserSurfaceAllocator: createReadyAllocator(),
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceLeaseStore: null,
    browserSurfaceMidWaitPollIntervalMs: undefined,
    browserSurfaceReadinessProbe: null,
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: null,
    listPersistedActiveRuns: async () => [],
    log: { error: () => undefined, warn: () => undefined },
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => undefined,
    startupControllerRunReconciliation: Promise.resolve(),
  });

  // No DB needed here: no phase lease was ever tracked for "run_never_acquired",
  // so the function must return before any event-emitting/persistence code
  // that would need a live DB connection runs at all.
  await assert.doesNotReject(() => manager.releaseManagedBrowserSurfaceForPhase("run_never_acquired"));
  assert.equal(leaseManager.listLeases().length, 0, "no lease was created or touched");
});

test("I4: releasing twice in a row for the same run is idempotent (second call throws nothing, no double release)", async (t) => {
  const { leaseManager, manager } = setup(t, createReadyAllocator());

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");
  assert.ok(granted.kind === "granted");

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");
  assert.equal(leaseManager.getLease(granted.leaseId)?.status, "released");

  await assert.doesNotReject(() => manager.releaseManagedBrowserSurfaceForPhase("run_x"));
  assert.equal(leaseManager.getLease(granted.leaseId)?.status, "released", "still released, not double-processed");
});

// ─── I5: cap fairness / never blocks the run ───────────────────────────────

test("I5: with cap fully consumed, a phase acquire resolves unavailable/capacity_full — never queues, never bypasses the cap", async (t) => {
  const leaseManager = createManager({ managedConnectors: new Set(["slack", "other"]), surfaceCap: 1 });
  const { allocator, manager } = setup(t, createReadyAllocator(), { leaseManager });

  // Consume the only capacity slot with an unrelated run-level lease and a
  // real ready surface, exactly like controller-browser-surface-leases.test.ts's
  // surfaceCap: 1 contention pattern.
  const occupying = leaseManager.acquire({ connectorId: "other", profileKey: "other-profile", runId: "run_occupying" });
  assert.equal(occupying.lease.status, "starting_surface");
  await leaseManager.ensureStartingSurfaceReady({ allocator, leaseId: occupying.lease.lease_id });
  assert.equal(leaseManager.getLease(occupying.lease.lease_id)?.status, "leased");
  assert.equal(allocator.ensureRequests.length, 1, "exactly one surface minted for the occupying lease");

  const result = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));

  assert.deepEqual(
    result,
    { kind: "unavailable", reason: "capacity_full" },
    "cap is fully consumed, so the phase acquire must resolve unavailable/capacity_full, not queue or hang"
  );
  assert.equal(
    allocator.ensureRequests.length,
    1,
    "no extra surface was created for the phase request — the cap was never bypassed"
  );

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const phantomWaiter = leaseManager
    .listLeases()
    .find((lease) => lease.run_id === sessionId && lease.status === "waiting_for_browser_surface");
  assert.equal(
    phantomWaiter,
    undefined,
    "no phantom waiting_for_browser_surface lease is left behind for the phase session id after the call returns"
  );
});

// ─── I8: AM-1 regression guard ─────────────────────────────────────────────

test("I8 (AM-1 regression guard): boot reconciliation must NOT release a live phase lease whose parent run is active", async (t) => {
  const leaseManager = createManager();
  const runId = "run_x";
  const sessionId = browserSurfacePhaseSessionId(runId);

  // A live phase lease exists for run_x, exactly as it would mid-phase.
  const acquireResult = leaseManager.acquire({ connectorId: "slack", profileKey: "slack-profile", runId: sessionId });
  const allocator = createReadyAllocator();
  await leaseManager.ensureStartingSurfaceReady({ allocator, leaseId: acquireResult.lease.lease_id });
  assert.equal(leaseManager.getLease(acquireResult.lease.lease_id)?.status, "leased");

  const { manager } = setup(t, allocator, {
    leaseManager,
    // listPersistedActiveRuns returns the REAL run id ONLY — never the
    // derived phase session id. This is exactly the persisted-store shape:
    // a phase lease's session id is NEVER a real DB run_id.
    listPersistedActiveRuns: async () => [{ run_id: runId }],
  });

  await manager.reconcileBrowserSurfaceLeasesAfterBoot();

  // This is the AM-1 defect: if browserSurfacePhaseSessionId(row.run_id) were
  // dropped from the activeRunIds set built in reconcileBrowserSurfaceLeasesAfterBoot,
  // the lease manager's reconcileAfterRestart would see sessionId absent from
  // activeRunIds and release this still-live lease.
  assert.equal(
    leaseManager.getLease(acquireResult.lease.lease_id)?.status,
    "leased",
    "a controller restart mid-phase must not release a live phase lease for an active run"
  );
});

test("I8 (inverse): boot reconciliation DOES reconcile away a phase lease whose parent run is NOT active", async (t) => {
  const leaseManager = createManager();
  const runId = "run_orphaned";
  const sessionId = browserSurfacePhaseSessionId(runId);

  const acquireResult = leaseManager.acquire({ connectorId: "slack", profileKey: "slack-profile", runId: sessionId });
  const allocator = createReadyAllocator();
  await leaseManager.ensureStartingSurfaceReady({ allocator, leaseId: acquireResult.lease.lease_id });
  assert.equal(leaseManager.getLease(acquireResult.lease.lease_id)?.status, "leased");

  const { manager } = setup(t, allocator, {
    leaseManager,
    // No active runs at all — run_orphaned is gone (e.g. its run completed
    // and was cleaned up, or crashed, before the phase lease was released),
    // so its derived phase session id must NOT be treated as active either.
    listPersistedActiveRuns: async () => [],
  });

  await manager.reconcileBrowserSurfaceLeasesAfterBoot();

  assert.equal(
    leaseManager.getLease(acquireResult.lease.lease_id)?.status,
    "released",
    "the guard must not blanket-preserve every phase lease — only ones whose parent run is still active"
  );
});

test("I8: a phase lease for one run is preserved while a DIFFERENT inactive run's phase lease is reconciled away", async (t) => {
  const leaseManager = createManager({ surfaceCap: 2 });
  const activeRunId = "run_active";
  const activeSessionId = browserSurfacePhaseSessionId(activeRunId);
  const inactiveRunId = "run_inactive";
  const inactiveSessionId = browserSurfacePhaseSessionId(inactiveRunId);

  const allocator = createReadyAllocator();
  const activeAcquire = leaseManager.acquire({
    connectorId: "slack",
    profileKey: "slack-profile-active",
    runId: activeSessionId,
  });
  await leaseManager.ensureStartingSurfaceReady({ allocator, leaseId: activeAcquire.lease.lease_id });
  const inactiveAcquire = leaseManager.acquire({
    connectorId: "slack",
    profileKey: "slack-profile-inactive",
    runId: inactiveSessionId,
  });
  await leaseManager.ensureStartingSurfaceReady({ allocator, leaseId: inactiveAcquire.lease.lease_id });
  assert.equal(leaseManager.getLease(activeAcquire.lease.lease_id)?.status, "leased");
  assert.equal(leaseManager.getLease(inactiveAcquire.lease.lease_id)?.status, "leased");

  const { manager } = setup(t, allocator, {
    leaseManager,
    listPersistedActiveRuns: async () => [{ run_id: activeRunId }],
  });

  await manager.reconcileBrowserSurfaceLeasesAfterBoot();

  assert.equal(
    leaseManager.getLease(activeAcquire.lease.lease_id)?.status,
    "leased",
    "the active run's phase lease survives boot reconciliation"
  );
  assert.equal(
    leaseManager.getLease(inactiveAcquire.lease.lease_id)?.status,
    "released",
    "the inactive run's phase lease is still reconciled away — the guard is selective, not blanket"
  );
});

// ─── I9: release must retain identity to emit run.browser_surface_released ─

test("I9 (regression): releaseManagedBrowserSurfaceForPhase both terminalizes the lease AND successfully emits run.browser_surface_released, without corrupting the parent run's own history", async (t) => {
  const warnCalls: string[] = [];
  // listPersistedActiveRuns mirrors the real persisted-store shape: rows are
  // keyed by the REAL run_id only ("run_x"), never the derived phase session
  // id ("run_x#browser-phase"). This is exactly the shape that forced
  // requireConnectorInstanceIdForRun's fallback lookup to miss and throw
  // when the in-memory connectorInstanceIdByRunId cache entry for the
  // session id was cleared before the release's event emission ran.
  const { leaseManager, manager } = setup(t, createReadyAllocator(), {
    listPersistedActiveRuns: async () => [{ run_id: "run_x" }],
    warnCalls,
  });

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");
  assert.ok(granted.kind === "granted");

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");

  assert.equal(
    leaseManager.getLease(granted.leaseId)?.status,
    "released",
    "the DB-visible lease must still transition to released (this half already worked pre-fix)"
  );
  assert.deepEqual(
    warnCalls,
    [],
    "the release must not fall back to swallowing a 'refusing to persist an unbound run event' failure — " +
      "the phase session id's connector_instance_id must still be resolvable while the release's own " +
      "run.browser_surface_released emission is in flight"
  );

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const releasedRows = getDb()
    .prepare("SELECT data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.browser_surface_released'")
    .all(sessionId) as { data_json: string }[];
  assert.equal(
    releasedRows.length,
    1,
    "run.browser_surface_released must actually be persisted for the phase session id"
  );
  const [releasedRow] = releasedRows;
  assert.ok(releasedRow);
  const releasedData = JSON.parse(releasedRow.data_json);
  assert.equal(
    releasedData.connector_instance_id,
    "slack",
    "the emitted event must carry the resolved connector_instance_id, not an unbound/null identity"
  );

  // The phase session id ("run_x#browser-phase") is a distinct run_id from
  // the parent ("run_x") in every event/history row — asserting the parent's
  // own run_id has no phase-release row proves this fix does not leak the
  // phase's identity resolution into the parent run's history.
  const parentRows = getDb()
    .prepare("SELECT 1 FROM spine_events WHERE run_id = ? AND event_type = 'run.browser_surface_released'")
    .all("run_x");
  assert.equal(
    parentRows.length,
    0,
    "the parent run's own event history must not gain a browser_surface_released row from the phase release"
  );
});

// ─── I10-I14: identity cache must not leak past ANY unsuccessful path ──────
//
// Probe: emitLeaseEvent (exported on the manager, backed by the same
// requireConnectorInstanceIdForRun guard as every other lease event) is
// called directly for the derived session id, with listPersistedActiveRuns
// stubbed to return NOTHING — so the fallback lookup can never resolve it.
// If the in-memory identity cache still has an entry for this session id
// (i.e. it leaked), the emit call resolves silently. If it was correctly
// evicted, the emit call warns with the "refusing to persist an unbound
// run event" guard message, proving no stale identity survived.
async function probeSessionIdentityLeaked(
  manager: ReturnType<typeof createBrowserSurfaceManager>,
  sessionId: string,
  warnCalls: string[]
): Promise<boolean> {
  const before = warnCalls.length;
  await manager.emitLeaseEvent(
    "run.browser_surface_released",
    "slack",
    sessionId,
    createTraceContext(),
    // Field values are irrelevant to this probe: requireConnectorInstanceIdForRun
    // is consulted before the lease payload is ever serialized.
    { fencing_token: 0, run_id: sessionId, status: "released" } as BrowserSurfaceLease
  );
  return warnCalls.length === before;
}

test("I10 (regression): a capacity_full early return evicts the phase session identity, not just the phantom waiter", async (t) => {
  const warnCalls: string[] = [];
  const leaseManager = createManager({ managedConnectors: new Set(["slack", "other"]), surfaceCap: 1 });
  const { allocator, manager } = setup(t, createReadyAllocator(), { leaseManager, warnCalls });

  const occupying = leaseManager.acquire({ connectorId: "other", profileKey: "other-profile", runId: "run_occupying" });
  await leaseManager.ensureStartingSurfaceReady({ allocator, leaseId: occupying.lease.lease_id });

  const result = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.deepEqual(result, { kind: "unavailable", reason: "capacity_full" });

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const leaked = await probeSessionIdentityLeaked(manager, sessionId, warnCalls);
  assert.equal(
    leaked,
    false,
    "capacity_full must evict the session identity cache entry, not just cancel the phantom waiter lease"
  );
});

test("I11 (regression): a non-capacity early-return (ensureSurface failure) evicts the phase session identity", async (t) => {
  const warnCalls: string[] = [];
  // An allocator whose ensureSurface always rejects drives
  // acquireManagedBrowserSurfaceAttempt to its early_return branch via a
  // surface-start failure — distinct from I10's capacity/waiting early
  // return and I12's "resolved but incomplete lease/env" branch.
  const failingAllocator: BrowserSurfaceAllocator = {
    ensureSurface: () => Promise.reject(new Error("simulated ensureSurface failure")),
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [],
    stopSurface: async () => null,
  };
  const { manager } = setup(t, failingAllocator, { warnCalls });

  const result = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(result.kind, "unavailable");

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const leaked = await probeSessionIdentityLeaked(manager, sessionId, warnCalls);
  assert.equal(leaked, false, "an early-return/failure from a failing allocator must evict the session identity");
});

test("I12 (regression): a granted attempt missing lease/env (surface_failed) evicts the phase session identity", async (t) => {
  const warnCalls: string[] = [];
  const leaseManager = createManager();
  // An allocator whose ensureSurface never settles ready-with-env is out of
  // scope for this harness (BrowserSurfaceLeaseManager's own attempt loop
  // requires a real surface); instead simulate the "attempt resolved but
  // lease/env came back incomplete" branch directly via a lease manager
  // stubbed to return a starting (non-leased, non-early-return) status that
  // acquireManagedBrowserSurfaceAttempt maps to a missing lease/env. This
  // reuses the SAME allocator that fails ensureSurface, which drives
  // acquireManagedBrowserSurfaceAttempt to its "not (lease && env)" branch
  // instead of the early_return branch (distinguishing this from I11).
  const flakyAllocator: BrowserSurfaceAllocator = {
    ensureSurface: (request) =>
      Promise.resolve({
        backend: "neko",
        cdp_url: "",
        connector_id: request.connectorId,
        created_at: "2026-07-31T12:00:00.000Z",
        health: "unhealthy",
        last_used_at: "2026-07-31T12:00:00.000Z",
        profile_key: request.profileKey,
        stream_base_url: "",
        surface_id: request.surfaceId,
      }),
    getSurfaceStatus: async () => null,
    listSurfaces: async () => [],
    stopSurface: async () => null,
  };
  const { manager } = setup(t, flakyAllocator, { leaseManager, warnCalls });

  const result = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(result.kind, "unavailable");

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const leaked = await probeSessionIdentityLeaked(manager, sessionId, warnCalls);
  assert.equal(leaked, false, "a granted attempt missing lease/env must evict the session identity, not retain it");
});

test("I13 (regression): releasing a phase whose lease has already disappeared (external removal) still evicts the phase session identity", async (t) => {
  const warnCalls: string[] = [];
  const leaseManager = createManager();
  const { manager } = setup(t, createReadyAllocator(), { leaseManager, warnCalls });

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");
  assert.ok(granted.kind === "granted");

  // BrowserSurfaceLeaseManager never actually removes a lease_id from its
  // own map once created (terminal leases stay retrievable, by design, for
  // audit/fencing purposes) — so the ONLY way releaseManagedBrowserSurfaceForPhase's
  // `getLease(entry.leaseId)` legitimately returns undefined is a lookup
  // failure at the boundary itself. Stub getLease (same monkeypatch
  // technique the I3 fencing-token test above uses on release()) to
  // reproduce exactly that boundary condition without fabricating an
  // otherwise-unreachable internal state.
  const originalGetLease = leaseManager.getLease.bind(leaseManager);
  leaseManager.getLease = (leaseId) => (leaseId === granted.leaseId ? undefined : originalGetLease(leaseId));

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const leaked = await probeSessionIdentityLeaked(manager, sessionId, warnCalls);
  assert.equal(
    leaked,
    false,
    "the missing-lease release branch must still evict the session identity, not leave it cached forever"
  );
});

test("I14 (regression): a normal successful release evicts the phase session identity after the release event resolves", async (t) => {
  const warnCalls: string[] = [];
  const { manager } = setup(t, createReadyAllocator(), {
    listPersistedActiveRuns: async () => [{ run_id: "run_x" }],
    warnCalls,
  });

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x"));
  assert.equal(granted.kind, "granted");

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");
  assert.deepEqual(
    warnCalls,
    [],
    "the release's own event emission must have resolved cleanly (identity present then)"
  );

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const leaked = await probeSessionIdentityLeaked(manager, sessionId, warnCalls);
  assert.equal(
    leaked,
    false,
    "after a normal release completes, the session identity must be evicted — it must not persist indefinitely"
  );
});

// ─── I15-I16: connectorInstanceId identity + ownership-safe cleanup ───────
//
// Gate REVISE #2 found two defects the probe above could not distinguish
// (phaseInput deliberately made connectorId === connectorInstanceId, and
// the identity-cache helper's set/delete were unconditional):
//   1. Release resolved the phase's connectorId, not its connectorInstanceId
//      — silently wrong whenever a connector's instance id differs from its
//      connector type (the real production shape; see runtime/index.ts's
//      resolvedConnectorInstanceId).
//   2. withPhaseSessionIdentity's cache set/delete were not ownership-aware:
//      an overlapping release/reacquire for the SAME run could have the
//      slower invocation's cleanup delete or shadow the other's identity.

test("I15 (regression): release resolves the phase's connectorInstanceId, not its connectorId, when they differ", async (t) => {
  const { manager } = setup(t, createReadyAllocator(), {
    listPersistedActiveRuns: async () => [{ run_id: "run_x" }],
  });

  const granted = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x", "slack", "cin_42"));
  assert.equal(granted.kind, "granted");

  await manager.releaseManagedBrowserSurfaceForPhase("run_x");

  const sessionId = browserSurfacePhaseSessionId("run_x");
  const releasedRows = getDb()
    .prepare("SELECT data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.browser_surface_released'")
    .all(sessionId) as { data_json: string }[];
  assert.equal(releasedRows.length, 1, "run.browser_surface_released must be persisted for the phase session id");
  const [releasedRow] = releasedRows;
  assert.ok(releasedRow);
  const releasedData = JSON.parse(releasedRow.data_json);
  assert.equal(
    releasedData.connector_instance_id,
    "cin_42",
    "release must resolve the phase's connectorInstanceId (cin_42), not its connectorId (slack) — these are " +
      "DISTINCT identities in production (runtime/index.ts's resolvedConnectorInstanceId), and confusing them " +
      "would misattribute the released-surface event to the wrong connection"
  );
  assert.notEqual(
    releasedData.connector_instance_id,
    "slack",
    "the connectorId must never leak into the connector_instance_id field"
  );
});

test("I16 (regression): an overlapping release racing a reacquire for the SAME run cannot delete or overwrite the newer identity", async (t) => {
  const warnCalls: string[] = [];
  const leaseManager = createManager({ managedConnectors: new Set(["slack", "other"]), surfaceCap: 2 });
  const { manager } = setup(t, createReadyAllocator(), {
    leaseManager,
    listPersistedActiveRuns: async () => [{ run_id: "run_x" }],
    warnCalls,
  });

  // First phase: connector "slack", instance "cin_slack_1".
  const firstGrant = await manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x", "slack", "cin_slack_1"));
  assert.equal(firstGrant.kind, "granted");
  assert.ok(firstGrant.kind === "granted");

  // Deterministic interleaving, no timers/sleeps: withPhaseSessionIdentity's
  // cache writes (set the identity + mint this invocation's ownership
  // token) happen SYNCHRONOUSLY before either call's first await. Starting
  // release A without awaiting it, then immediately starting reacquire B
  // (also not yet awaited) reproduces gate REVISE #2's exact window: A's
  // identity/token installs first, then — before A's async body resumes —
  // B's acquire runs its synchronous prefix and installs its OWN identity/
  // token for the same sessionId, overwriting A's. Only once both have run
  // their synchronous prefixes do we await them to completion, at which
  // point A's finally must observe it no longer owns the shared entry.
  const releasePromise = manager.releaseManagedBrowserSurfaceForPhase("run_x");
  const acquirePromise = manager.acquireManagedBrowserSurfaceForPhase(phaseInput("run_x", "other", "cin_other_2"));

  const [, secondGrant] = await Promise.all([releasePromise, acquirePromise]);

  // The corruption this test guards against happens DURING the race itself
  // (B's own acquire-time run.browser_surface_starting/leased events),
  // not only in the final release event — an unguarded shared cache would
  // have A's finally delete the entry out from under B's still-in-flight
  // acquire, so B's own starting/leased emissions fail with "refusing to
  // persist an unbound run event" even though B's acquisition itself still
  // reports "granted". Assert the whole race produced zero such failures
  // before checking anything else.
  assert.deepEqual(
    warnCalls,
    [],
    "B's acquire-time event emissions (starting/leased) must not fail with the refusing-to-persist-an-unbound-" +
      `run-event guard due to A's release deleting the shared identity cache entry out from under B's ` +
      `still-in-flight acquire; got: ${JSON.stringify(warnCalls)}`
  );

  assert.equal(secondGrant.kind, "granted");
  assert.ok(secondGrant.kind === "granted");
  assert.notEqual(
    secondGrant.leaseId,
    firstGrant.leaseId,
    "reacquire B must have been granted a genuinely new lease, not A's stale one"
  );

  // B's phase lease must still be live: A's release finishing after B's
  // reacquire must not have torn down B's lease. Un-guarded (gate REVISE
  // #2's defect), the shared identity cache could be left empty or pointing
  // at A's stale identity after A's finally ran last — this assertion also
  // guards the pre-existing per-lease_id fencing invariant (I3).
  assert.equal(
    leaseManager.getLease(secondGrant.leaseId)?.status,
    "leased",
    "A's release finishing after B's reacquire must not release B's lease"
  );

  // Probe B's identity cache entry DIRECTLY, before B's own release runs:
  // this is the moment the unguarded pre-revision helper would have already
  // been corrupted — either wiped by A's unconditional delete, or never
  // properly holding B's identity at all. listPersistedActiveRuns is
  // stubbed above to resolve run_id "run_x" (never the session id), so a
  // cache HIT (leaked === true, meaning "identity still found cached" in
  // this probe's polarity — see probeSessionIdentityLeaked above, where
  // I10-I14 want the OPPOSITE outcome, eviction) is the correct/desired
  // result here: B's identity must still be live in the cache.
  const sessionId = browserSurfacePhaseSessionId("run_x");
  const leaked = await probeSessionIdentityLeaked(manager, sessionId, warnCalls);
  assert.equal(
    leaked,
    true,
    "B's identity cache entry must survive A's finally intact — an unguarded shared delete would wipe it " +
      "(probe would then warn / return leaked===false) right after the race, before B's own release ever runs"
  );

  // Release B for real and confirm B's OWN identity (cin_other_2, never
  // A's cin_slack_1 and never the bare connectorId "other") is what gets
  // persisted to run.browser_surface_released — proving the cache held B's
  // identity throughout, never an empty entry A's finally deleted out from
  // under B, nor A's stale identity.
  await manager.releaseManagedBrowserSurfaceForPhase("run_x");

  const releasedRows = getDb()
    .prepare(
      "SELECT data_json FROM spine_events WHERE run_id = ? AND event_type = 'run.browser_surface_released' ORDER BY event_seq"
    )
    .all(sessionId) as { data_json: string }[];
  const identities = releasedRows.map((row) => JSON.parse(row.data_json).connector_instance_id);
  assert.ok(
    identities.includes("cin_other_2"),
    `B's release must persist B's own connector_instance_id (cin_other_2); got ${JSON.stringify(identities)}`
  );
  assert.ok(
    !(identities.includes("cin_slack_1") || identities.includes("other")),
    `B's release event must never carry A's stale identity (cin_slack_1) or a bare connectorId ("other"); got ${JSON.stringify(identities)}`
  );
});
