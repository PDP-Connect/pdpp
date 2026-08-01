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
import { closeDb, initDb } from "../server/db.ts";
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
    log: { error: () => undefined, warn: () => undefined },
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => undefined,
    startupControllerRunReconciliation: Promise.resolve(),
  });
  return { allocator, leaseManager, manager };
}

function phaseInput(runId: string, connectorId = "slack") {
  return {
    connectorId,
    connectorInstanceId: connectorId,
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
