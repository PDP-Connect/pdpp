// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression tests for the production defect that killed run_1788035484871
 * 49 seconds in: a transient `browser_surface_window_settle_unavailable`
 * readiness probe tore down the browser surface WHILE the owner was using it
 * to answer an assist, cancelling the interaction and failing the run before
 * he could act.
 *
 * The window-settle read is the only probe failure that does not prove the
 * browser is gone: `probeBrowserSurfaceReadinessOverHttp` checks json/version,
 * json/list and a live CDP page-target command FIRST, so a window-settle
 * failure means the browser answered every liveness check moments earlier and
 * merely reported `settled:false` (or timed out on its own 5s budget) while
 * the window was mid-resize — exactly what an owner driving the page causes.
 *
 * These tests pin, across all three `invalidateBrowserSurfaceAfterProbeFailure`
 * call sites:
 *
 *   - a window-settle failure with an assist OPEN defers teardown,
 *   - a window-settle failure with NO assist open still tears down (the real
 *     protection against re-leasing a dead surface is preserved),
 *   - genuinely-dead probe codes tear down even with an assist open,
 *   - the deferred surface is retired at terminal lease release (no leak),
 *   - a deferred surface is never handed to a new run while deferred,
 *   - the deferral is bounded and cannot pin a surface indefinitely.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_PRIORITY_RANKS,
  type EnsureBrowserSurfaceRequest,
  type StopBrowserSurfaceRequest,
  // biome-ignore lint/correctness/noUnresolvedImports: the test runner resolves this runtime fixture import outside Biome static resolution.
} from "@opendatalabs/remote-surface/leases";
import { createTraceContext } from "../lib/spine.ts";
import { createBrowserSurfaceManager } from "../runtime/browser-surface/run-coordinator.ts";
import type { BrowserSurfaceReadinessProbeCode } from "../runtime/browser-surface-readiness.ts";

const WINDOW_SETTLE = "browser_surface_window_settle_unavailable";
const RUN_ID = "run_1788035484871";
const SURFACE_ID = "surface_owner_assist";
const LEASE_ID = "lease_owner_assist";

/** Mirror of the controller's unexported ActiveRunInteraction/PendingInteraction shape. */
interface FixturePendingInteraction {
  readonly interaction_id: string;
  readonly kind: string;
  readonly resolve: (response: unknown) => void;
  readonly stream: string | null;
}
interface FixtureActiveRunInteraction {
  connector_id: string;
  pending: FixturePendingInteraction | null;
}

/**
 * The owner's assist, exactly as `brokerInteraction` registers it: a pending
 * entry on the run, cleared only when the owner answers or it is cancelled.
 */
function activeRunInteractionsWithOpenAssist(runId = RUN_ID): Map<string, FixtureActiveRunInteraction> {
  return new Map<string, FixtureActiveRunInteraction>([
    [
      runId,
      {
        connector_id: "managed",
        pending: {
          interaction_id: "req_owner_assist_1",
          kind: "manual_action",
          resolve: () => undefined,
          stream: null,
        },
      },
    ],
  ]);
}

/** A run that is active but has no unanswered owner interaction. */
function activeRunInteractionsWithNoAssist(runId = RUN_ID): Map<string, FixtureActiveRunInteraction> {
  return new Map<string, FixtureActiveRunInteraction>([[runId, { connector_id: "managed", pending: null }]]);
}

function createLeasedDynamicManager(runId = RUN_ID) {
  let surfaceSeq = 0;
  let tokenSeq = 1;
  return new BrowserSurfaceLeaseManager({
    config: {
      defaultPriorityClass: "background",
      idleTtlMs: 600_000,
      leaseWaitTimeoutMs: 60_000,
      managedConnectors: new Set(["managed"]),
      priorityRanks: DEFAULT_NEKO_PRIORITY_RANKS,
      surfaceCap: 1,
      surfaceMode: "dynamic",
    },
    initialLeases: [
      {
        connector_id: "managed",
        expires_at: "2026-05-12T13:00:00.000Z",
        fencing_token: 1,
        lease_id: LEASE_ID,
        leased_at: "2026-05-12T11:00:01.000Z",
        priority_class: "background" as const,
        profile_key: "managed-profile",
        requested_at: "2026-05-12T11:00:00.000Z",
        run_id: runId,
        status: "leased" as const,
        surface_id: SURFACE_ID,
      },
    ],
    initialSurfaces: [
      {
        active_lease_id: LEASE_ID,
        backend: "neko",
        cdp_url: "http://owner-assist:9223",
        connector_id: "managed",
        created_at: "2026-05-12T11:00:00.000Z",
        health: "ready",
        last_used_at: "2026-05-12T11:00:00.000Z",
        profile_key: "managed-profile",
        stream_base_url: "http://owner-assist:8080",
        surface_id: SURFACE_ID,
      },
    ],
    makeLeaseId: () => {
      tokenSeq += 1;
      return `lease_new_${tokenSeq}`;
    },
    makeSurfaceId: () => {
      surfaceSeq += 1;
      return `surface_new_${surfaceSeq}`;
    },
    nextFencingToken: () => {
      tokenSeq += 1;
      return tokenSeq;
    },
    now: () => new Date("2026-05-12T12:00:00.000Z"),
  });
}

function createRecordingAllocator(initialSurfaces: readonly BrowserSurface[] = []) {
  const surfaces = new Map<string, BrowserSurface>(initialSurfaces.map((s) => [s.surface_id, s]));
  const ensureRequests: EnsureBrowserSurfaceRequest[] = [];
  const stopRequests: StopBrowserSurfaceRequest[] = [];
  const allocator: BrowserSurfaceAllocator = {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract.
    ensureSurface: async (request) => {
      ensureRequests.push(request);
      const surface: BrowserSurface = {
        backend: "neko",
        cdp_url: `http://${request.surfaceId}:9223`,
        connector_id: request.connectorId,
        created_at: "2026-05-12T12:00:01.000Z",
        health: "ready",
        last_used_at: "2026-05-12T12:00:01.000Z",
        profile_key: request.profileKey,
        stream_base_url: `http://${request.surfaceId}:8080`,
        surface_id: request.surfaceId,
      };
      surfaces.set(request.surfaceId, surface);
      return surface;
    },
    getSurfaceStatus: async (surfaceId) => surfaces.get(surfaceId) ?? null,
    listSurfaces: async () => [...surfaces.values()],
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract.
    stopSurface: async (request) => {
      stopRequests.push(request);
      const surface = surfaces.get(request.surfaceId) ?? null;
      surfaces.delete(request.surfaceId);
      return surface ? { ...surface, health: "stopping" } : null;
    },
  };
  return { allocator, ensureRequests, stopRequests };
}

interface HarnessOptions {
  readonly activeRunInteractions?: Map<string, FixtureActiveRunInteraction>;
  readonly assistDeferralGraceMs?: number;
  readonly now?: () => number;
  readonly probeCode?: BrowserSurfaceReadinessProbeCode;
  readonly runId?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const runId = options.runId ?? RUN_ID;
  const leaseManager = createLeasedDynamicManager(runId);
  const leasedSurface = leaseManager.getSurface(SURFACE_ID);
  assert.ok(leasedSurface);
  const { allocator, ensureRequests, stopRequests } = createRecordingAllocator([leasedSurface]);
  const probeCode = options.probeCode ?? WINDOW_SETTLE;
  const warnings: string[] = [];

  const manager = createBrowserSurfaceManager({
    activeRunInteractions: (options.activeRunInteractions ??
      activeRunInteractionsWithOpenAssist(runId)) as unknown as Parameters<
      typeof createBrowserSurfaceManager
    >[0]["activeRunInteractions"],
    browserSurfaceAllocator: allocator,
    ...(options.assistDeferralGraceMs === undefined
      ? {}
      : { browserSurfaceAssistDeferralGraceMs: options.assistDeferralGraceMs }),
    browserSurfaceLeaseManager: leaseManager,
    browserSurfaceLeaseStore: null,
    browserSurfaceMidWaitPollIntervalMs: undefined,
    browserSurfaceReadinessProbe: {
      probe: () =>
        Promise.resolve({
          code: probeCode,
          detail: `n.eko allocator ${probeCode} for ${SURFACE_ID}`,
          ok: false as const,
        }),
    },
    browserSurfaceReadinessTimeoutMs: undefined,
    browserSurfaceReplacementReceiptStore: null,
    listPersistedActiveRuns: async () => [{ run_id: runId }],
    log: {
      error: () => undefined,
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    ...(options.now ? { now: options.now } : {}),
    pendingBrowserSurfaceLaunches: new Map(),
    scheduleRun: () => undefined,
    startupControllerRunReconciliation: Promise.resolve(),
  });

  const lease = leaseManager.getLease(LEASE_ID);
  assert.ok(lease);
  return { allocator, ensureRequests, lease, leaseManager, manager, runId, stopRequests, warnings };
}

/**
 * Drives call site 3 — `recycleAttachExhaustedManagedSurfaceAfterRun`, the
 * post-run typed-code path. Call sites 1 and 2 (the readiness-retry path and
 * the readiness gate) both funnel through the same
 * `invalidateBrowserSurfaceAfterProbeFailure` guard; this is the site reachable
 * from the manager's public API without spawning a connector child.
 */
function recycleAfterRun(
  harness: ReturnType<typeof createHarness>,
  probeCode: BrowserSurfaceReadinessProbeCode = WINDOW_SETTLE
) {
  return harness.manager.recycleAttachExhaustedManagedSurfaceAfterRun({
    connectorId: "managed",
    lease: harness.lease,
    probeCode,
    probeDetail: `n.eko allocator ${probeCode}`,
    runId: harness.runId,
    traceContext: createTraceContext(),
  });
}

test("owner mid-assist: a transient window-settle probe failure must not tear down the browser he is using", async () => {
  const harness = createHarness();

  await recycleAfterRun(harness);

  assert.deepEqual(harness.stopRequests, [], "the allocator must not stop a surface the owner is driving");
  assert.ok(
    harness.leaseManager.getSurface(SURFACE_ID),
    "the surface must survive so the owner can finish answering the assist"
  );
  assert.equal(harness.leaseManager.getLease(LEASE_ID)?.status, "leased");
  assert.ok(
    harness.warnings.some((w) => w.includes("deferring teardown") && w.includes(SURFACE_ID)),
    `expected a deferral warning; got: ${harness.warnings.join(" | ")}`
  );
});

test("no assist open: a window-settle probe failure still tears the surface down immediately", async () => {
  const harness = createHarness({ activeRunInteractions: activeRunInteractionsWithNoAssist() });

  await recycleAfterRun(harness);

  assert.deepEqual(
    harness.stopRequests,
    [{ reason: "surface_failed", surfaceId: SURFACE_ID }],
    "an idle dead surface must still be evicted so the next acquire cannot re-lease it"
  );
  assert.equal(harness.leaseManager.getSurface(SURFACE_ID), undefined);
});

test("run with no interaction bookkeeping at all: window-settle failure tears the surface down", async () => {
  const harness = createHarness({ activeRunInteractions: new Map() });

  await recycleAfterRun(harness);

  assert.deepEqual(harness.stopRequests, [{ reason: "surface_failed", surfaceId: SURFACE_ID }]);
});

test("owner mid-assist: a genuinely dead surface is still torn down, so he is not left staring at a broken page", async () => {
  for (const deadCode of [
    "browser_surface_cdp_unreachable",
    "browser_surface_cdp_disconnected",
    "browser_surface_page_stale",
    "browser_surface_probe_timeout",
    "browser_surface_not_ready",
  ] as const) {
    const harness = createHarness({ probeCode: deadCode });

    // biome-ignore lint/performance/noAwaitInLoops: Each probe code needs its own harness and assertion; the cases are independent but must stay individually attributable.
    await recycleAfterRun(harness, deadCode);

    assert.deepEqual(
      harness.stopRequests,
      [{ reason: "surface_failed", surfaceId: SURFACE_ID }],
      `${deadCode} proves the browser is gone and must never be deferred`
    );
  }
});

test("deferred surface is retired at terminal lease release, so a dead surface cannot leak", async () => {
  const harness = createHarness();

  await recycleAfterRun(harness);
  assert.deepEqual(harness.stopRequests, [], "precondition: teardown was deferred");

  await harness.manager.releaseLease(harness.lease, "managed", harness.runId, createTraceContext());

  assert.deepEqual(
    harness.stopRequests,
    [{ reason: "surface_failed", surfaceId: SURFACE_ID }],
    "the run ending must collect the deferred surface"
  );
  assert.equal(harness.leaseManager.getSurface(SURFACE_ID), undefined, "the deferred surface is gone after release");
});

test("a deferred surface is never re-leased to a new run: release retires it before it can be acquired", async () => {
  const harness = createHarness();

  await recycleAfterRun(harness);
  await harness.manager.releaseLease(harness.lease, "managed", harness.runId, createTraceContext());

  // The retirement runs BEFORE the lease release inside releaseLease, so the
  // surface is out of the manager by the time any new acquire could see it.
  assert.equal(
    harness.leaseManager.getSurface(SURFACE_ID),
    undefined,
    "a deferred-but-dead surface must not be visible to a new run"
  );
  assert.equal(
    harness.leaseManager.listSurfaces().some((s) => s.surface_id === SURFACE_ID),
    false,
    "the retired surface must not appear in the acquirable inventory"
  );
});

test("assist deferral is bounded: once the grace window is exhausted a still-failing surface is retired", async () => {
  let clock = 1_000_000;
  const harness = createHarness({ assistDeferralGraceMs: 60_000, now: () => clock });

  await recycleAfterRun(harness);
  assert.deepEqual(harness.stopRequests, [], "first failure inside the grace window defers");

  // The owner never answers and the connector never bounded the wait. The
  // surface must not stay pinned forever.
  clock += 60_001;
  await recycleAfterRun(harness);

  assert.deepEqual(
    harness.stopRequests,
    [{ reason: "surface_failed", surfaceId: SURFACE_ID }],
    "an exhausted grace window must retire the surface even with the assist still open"
  );
  assert.ok(
    harness.warnings.some((w) => w.includes("assist deferral grace exhausted")),
    `expected a grace-exhausted warning; got: ${harness.warnings.join(" | ")}`
  );
});

test("assist deferral can be disabled with a zero grace window", async () => {
  const harness = createHarness({ assistDeferralGraceMs: 0 });

  await recycleAfterRun(harness);

  assert.deepEqual(harness.stopRequests, [{ reason: "surface_failed", surfaceId: SURFACE_ID }]);
});
