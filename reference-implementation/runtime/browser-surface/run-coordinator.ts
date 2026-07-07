// Browser-surface lease-management subsystem for the controller.
//
// Extracted from controller.ts: all ~29 functions that manage the lifecycle of
// browser-surface leases (acquire, release, probe, reconcile, cancel, expire,
// cleanup) live here. They previously closed over factory locals; they now
// receive shared state through an explicit deps object so the boundary is
// visible at the call site.
//
// Public API: createBrowserSurfaceManager(deps) → BrowserSurfaceManager
// Only the functions controller.ts calls from OUTSIDE this cluster are
// exported on the returned object. Internal helpers are private.

import {
  type BrowserSurface,
  type BrowserSurfaceAllocator,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseManager,
  type BrowserSurfaceProjection,
  projectBrowserSurfaceLease,
} from "@opendatalabs/remote-surface/leases";
import { createTraceContext, emitSpineEvent, type SpineTraceContext } from "../../lib/spine.ts";
import type { BrowserSurfaceLeaseStore } from "../../server/stores/browser-surface-lease-store.ts";
import { browserSurfaceLeaseEnv } from "../browser-surface-leases.ts";
import {
  type BrowserSurfaceReadinessProbe,
  type BrowserSurfaceReadinessProbeResult,
  createMidWaitSurfaceLossDetector,
} from "../browser-surface-readiness.ts";
import type { ConnectorManifest, RunNowOptions, RunNowResult } from "../run-contracts.ts";
import { readBrowserSurfaceProfileKey } from "./profile-key.ts";

// ─── Internal types ──────────────────────────────────────────────────────────

interface ControllerLogger {
  error?: (message: string) => void;
  warn?: (message: string) => void;
}

interface RuntimeInteraction {
  readonly kind: string;
  readonly request_id: string;
  readonly stream?: string | null;
}

interface InteractionResponse {
  data?: Record<string, unknown>;
  readonly request_id: string;
  readonly status: "cancelled" | "success";
  readonly type: "INTERACTION_RESPONSE";
}

interface PendingInteraction {
  readonly interaction_id: string;
  readonly kind: string;
  readonly resolve: (response: InteractionResponse) => void;
  readonly stream: string | null;
}

interface ActiveRunInteraction {
  connector_id: string;
  pending: PendingInteraction | null;
}

// Shared no-op allocator used when no real BrowserSurfaceAllocator is wired.
const UNCONFIGURED_BROWSER_SURFACE_ALLOCATOR: BrowserSurfaceAllocator = {
  ensureSurface: () => Promise.reject(new Error("browser surface allocator is not configured")),
  getSurfaceStatus: () => Promise.resolve(null),
  stopSurface: () => Promise.resolve(null),
  listSurfaces: () => Promise.resolve([]),
};

// ─── Context types passed through acquisition pipeline ───────────────────────

export interface ManagedSurfaceContext {
  readonly automationMetadata: Pick<RunNowResult, "automation_mode" | "automation_summary" | "trigger_kind">;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly manifest: ConnectorManifest;
  readonly options: RunNowOptions;
  readonly runId: string;
  readonly traceContext: SpineTraceContext;
}

interface ManagedSurfaceEarlyReturn {
  readonly kind: "early_return";
  readonly result: RunNowResult;
}

interface ManagedSurfaceReady {
  readonly env: Record<string, string> | null;
  readonly kind: "ready";
  readonly lease: BrowserSurfaceLease | null;
}

type ManagedSurfaceAcquireResult = ManagedSurfaceEarlyReturn | ManagedSurfaceReady;

interface ReclaimResolution {
  readonly earlyReturn?: ManagedSurfaceEarlyReturn;
  readonly env: Record<string, string> | null;
  readonly lease: BrowserSurfaceLease;
}

// ─── Deps object ─────────────────────────────────────────────────────────────

export interface BrowserSurfaceManagerDeps {
  readonly activeRunInteractions: Map<string, ActiveRunInteraction>;
  readonly browserSurfaceAllocator: BrowserSurfaceAllocator | null;
  readonly browserSurfaceLeaseManager: BrowserSurfaceLeaseManager | null;
  readonly browserSurfaceLeaseStore: BrowserSurfaceLeaseStore | null;
  readonly browserSurfaceMidWaitPollIntervalMs: number | undefined;
  readonly browserSurfaceReadinessProbe: BrowserSurfaceReadinessProbe | null;
  readonly browserSurfaceReadinessTimeoutMs: number | undefined;
  readonly listPersistedActiveRuns: () => Promise<ReadonlyArray<{ run_id: string }>>;
  readonly log: ControllerLogger;
  readonly pendingBrowserSurfaceLaunches: Map<string, RunNowOptions>;
  /**
   * Fire-and-forget: schedule a run via the controller. The controller
   * implements this as detachControllerTask(runNow(connectorId, options).catch(onFailure)).
   * The onFailure callback is invoked when the runNow throws so the
   * browser-surface manager can handle deferred-lease emit/persist without
   * needing a direct reference to runNow.
   */
  readonly scheduleRun: (
    connectorId: string,
    options: RunNowOptions,
    onFailure: (err: unknown) => Promise<void>
  ) => void;
  readonly startupControllerRunReconciliation: Promise<void>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface BrowserSurfaceManager {
  /** Acquire (or queue/defer) a managed browser-surface lease for a run. */
  acquireManagedBrowserSurfaceForRun(ctx: ManagedSurfaceContext): Promise<ManagedSurfaceAcquireResult>;
  /** Cancel the browser-surface lease for a waiting/queued run. */
  cancelBrowserSurfaceRun(runId: string): Promise<BrowserSurfaceProjection | null>;
  /** Stop idle surfaces and promote any queued waiters. */
  cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]>;
  /** Emit a browser-surface lease spine event (used by respondToInteraction). */
  emitLeaseEvent(
    eventType: string,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    lease: BrowserSurfaceLease
  ): Promise<void>;
  /** Expire timed-out waiters and promote queued leases. */
  expireBrowserSurfaceWaits(): Promise<BrowserSurfaceProjection[]>;
  /** Promote boot-time queued leases after the listener is up. */
  promoteBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  /** Reconcile leases against the allocator and persisted active runs after a restart. */
  reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  /**
   * Release a lease, swallowing errors. Covers both the pre-spawn failure path
   * (registerActiveRunBookkeeping) and the post-run cleanup path (finalizeRunCleanup).
   */
  releaseLease(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<void>;
  /** Wrap an interaction handler with mid-wait browser-surface loss detection. */
  wrapInteractionHandlerWithSurfaceLossDetection(
    runId: string,
    connectorId: string,
    traceContext: SpineTraceContext,
    handler: (interaction: unknown) => Promise<unknown>
  ): (interaction: unknown) => Promise<unknown>;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBrowserSurfaceManager(deps: BrowserSurfaceManagerDeps): BrowserSurfaceManager {
  const {
    activeRunInteractions,
    browserSurfaceAllocator,
    browserSurfaceLeaseManager,
    browserSurfaceLeaseStore,
    browserSurfaceMidWaitPollIntervalMs,
    browserSurfaceReadinessProbe,
    browserSurfaceReadinessTimeoutMs,
    listPersistedActiveRuns,
    log,
    pendingBrowserSurfaceLaunches,
    scheduleRun,
    startupControllerRunReconciliation,
  } = deps;

  function buildRunSource(connectorId: string): { kind: "connector"; id: string } {
    return { kind: "connector", id: connectorId };
  }

  // ─── Event emission ────────────────────────────────────────────────────────

  async function emitBrowserSurfaceLeaseEvent(
    eventType: string,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    lease: BrowserSurfaceLease
  ): Promise<void> {
    try {
      await emitSpineEvent({
        event_type: eventType,
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: connectorId,
        object_type: "run",
        object_id: runId,
        status: lease.status,
        run_id: runId,
        data: {
          source: buildRunSource(connectorId),
          browser_surface: projectBrowserSurfaceLease(lease),
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit ${eventType} for ${runId}: ${message}`);
    }
  }

  async function emitBrowserSurfaceReadyEvent(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    result: Extract<BrowserSurfaceReadinessProbeResult, { ok: true }>
  ): Promise<void> {
    try {
      await emitSpineEvent({
        event_type: "run.browser_surface_ready",
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: connectorId,
        object_type: "run",
        object_id: runId,
        status: lease.status,
        run_id: runId,
        data: {
          source: buildRunSource(connectorId),
          browser_surface: projectBrowserSurfaceLease(lease),
          browser_surface_probe: {
            ok: true,
            page_target_count: result.pageTargetCount,
            ...(result.browserVersion ? { browser_version: result.browserVersion } : {}),
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_ready for ${runId}: ${message}`);
    }
  }

  async function emitBrowserSurfaceProbeFailedEvent(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    result: Extract<BrowserSurfaceReadinessProbeResult, { ok: false }>
  ): Promise<void> {
    try {
      await emitSpineEvent({
        event_type: "run.browser_surface_probe_failed",
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: connectorId,
        object_type: "run",
        object_id: runId,
        status: "surface_failed",
        run_id: runId,
        data: {
          source: buildRunSource(connectorId),
          browser_surface: projectBrowserSurfaceLease(lease),
          browser_surface_probe: {
            ok: false,
            code: result.code,
            detail: result.detail,
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_probe_failed for ${runId}: ${message}`);
    }
  }

  async function emitBrowserSurfaceLostEvent(input: {
    readonly connectorId: string;
    readonly interactionId: string;
    readonly interactionKind: string;
    readonly probeCode: string;
    readonly probeDetail: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<void> {
    try {
      await emitSpineEvent({
        event_type: "run.browser_surface_lost",
        trace_id: input.traceContext.trace_id,
        scenario_id: input.traceContext.scenario_id,
        actor_type: "runtime",
        actor_id: input.connectorId,
        object_type: "run",
        object_id: input.runId,
        status: "surface_failed",
        run_id: input.runId,
        data: {
          source: buildRunSource(input.connectorId),
          interaction_id: input.interactionId,
          kind: input.interactionKind,
          browser_surface_probe: {
            ok: false,
            code: input.probeCode,
            detail: input.probeDetail,
          },
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_lost for ${input.runId}: ${message}`);
    }
  }

  async function emitAndPersistReconciledLeases(
    leases: readonly BrowserSurfaceLease[],
    eventType: string,
    options: { readonly hydrateSurface: boolean }
  ): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    for (const lease of leases) {
      await emitBrowserSurfaceLeaseEvent(eventType, lease.connector_id, lease.run_id, createTraceContext(), lease);
      const surface =
        options.hydrateSurface && lease.surface_id
          ? browserSurfaceLeaseManager.getSurface(lease.surface_id)
          : undefined;
      await persistBrowserSurfaceLeaseMutation(lease, surface);
    }
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async function persistBrowserSurfaceLeaseMutation(
    lease: BrowserSurfaceLease,
    surface?: BrowserSurface
  ): Promise<void> {
    if (!browserSurfaceLeaseStore) {
      return;
    }
    await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
      if (surface) {
        await store.upsertSurface(surface);
      }
      await store.upsertLease(lease);
    });
  }

  async function persistInvalidatedBrowserSurface(invalidatedSurface: BrowserSurface): Promise<void> {
    if (!browserSurfaceLeaseStore) {
      return;
    }
    try {
      await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
        await store.upsertSurface({
          ...invalidatedSurface,
          health: "unhealthy",
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] persistence after surface invalidation failed: ${message}`);
    }
  }

  // ─── Allocator operations ─────────────────────────────────────────────────

  async function stopAllocatorSurfaceAfterProbeFailure(surfaceId: string, probeCode: string): Promise<void> {
    if (!browserSurfaceAllocator) {
      return;
    }
    try {
      await browserSurfaceAllocator.stopSurface({
        surfaceId,
        reason: "surface_failed",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] allocator stopSurface(${surfaceId}) after probe ${probeCode} failed: ${message}`);
    }
  }

  // ─── Surface invalidation ─────────────────────────────────────────────────

  async function invalidateBrowserSurfaceAfterProbeFailure(
    lease: BrowserSurfaceLease,
    probeCode: string
  ): Promise<void> {
    if (!(browserSurfaceLeaseManager && lease.surface_id)) {
      return;
    }
    const surfaceId = lease.surface_id;
    // Drop the in-memory surface so #findReadyIdleSurface cannot reuse it.
    // Lease release happens separately so the lease projection stays correct;
    // we explicitly do not mark this lease surface_failed here.
    const invalidated = browserSurfaceLeaseManager.invalidateSurface(surfaceId, {
      releaseLease: false,
    });
    if (invalidated.surface) {
      await persistInvalidatedBrowserSurface(invalidated.surface);
    }
    await stopAllocatorSurfaceAfterProbeFailure(surfaceId, probeCode);
  }

  // ─── Readiness probing ────────────────────────────────────────────────────

  async function performBrowserSurfaceReadinessProbe(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface | null
  ): Promise<BrowserSurfaceReadinessProbeResult> {
    if (!surface) {
      return {
        ok: false,
        code: "browser_surface_not_ready",
        detail: `lease ${lease.lease_id} references missing surface ${lease.surface_id || "(none)"}`,
      };
    }
    if (!browserSurfaceReadinessProbe) {
      return { ok: true, pageTargetCount: 0 };
    }
    try {
      return await browserSurfaceReadinessProbe.probe(surface);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        code: "browser_surface_cdp_unreachable",
        detail: `readiness probe threw: ${message}`,
      };
    }
  }

  async function runBrowserSurfaceReadinessGate(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface | null,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<BrowserSurfaceReadinessProbeResult> {
    if (!browserSurfaceReadinessProbe) {
      return { ok: true, pageTargetCount: 0 };
    }
    const result = await performBrowserSurfaceReadinessProbe(lease, surface);
    if (result.ok) {
      await emitBrowserSurfaceReadyEvent(lease, connectorId, runId, traceContext, result);
      return result;
    }
    log.warn?.(
      `[controller] browser-surface readiness probe failed for ${runId} (${connectorId}): ${result.code}: ${result.detail}`
    );
    await emitBrowserSurfaceProbeFailedEvent(lease, connectorId, runId, traceContext, result);
    // Probe failure means the in-memory surface entry is lying about
    // readiness. Evict it before releasing the lease so the next acquire
    // does not immediately re-lease the same dead surface and burn another
    // human OTP cycle. When a dynamic allocator is configured, also stop
    // the underlying container so the next acquire creates a fresh one.
    await invalidateBrowserSurfaceAfterProbeFailure(lease, result.code);
    await releaseBrowserSurfaceLease(lease, connectorId, runId, traceContext, `readiness probe failed: ${result.code}`);
    return result;
  }

  // ─── Lease lifecycle ───────────────────────────────────────────────────────

  async function waitForStartingBrowserSurface(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface }> {
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, lease);
    if (!browserSurfaceLeaseManager) {
      return { lease };
    }

    let current = lease;
    const allocator = browserSurfaceAllocator ?? UNCONFIGURED_BROWSER_SURFACE_ALLOCATOR;
    while (current.status === "starting_surface") {
      const readyResult = await browserSurfaceLeaseManager.ensureStartingSurfaceReady({
        leaseId: current.lease_id,
        allocator,
        ...(browserSurfaceReadinessTimeoutMs === undefined
          ? {}
          : { readinessTimeoutMs: browserSurfaceReadinessTimeoutMs }),
      });
      current = readyResult.lease;
      await persistBrowserSurfaceLeaseMutation(readyResult.lease, readyResult.surface);
      if (current.status !== "starting_surface") {
        return readyResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const surface = current.surface_id ? browserSurfaceLeaseManager.getSurface(current.surface_id) : undefined;
    return { lease: current, ...(surface ? { surface } : {}) };
  }

  async function reclaimCapacityAndPromoteLease(
    lease: BrowserSurfaceLease
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface; reclaimed: boolean }> {
    if (!(browserSurfaceLeaseManager && browserSurfaceAllocator)) {
      return { lease, reclaimed: false };
    }
    const reclaimable = browserSurfaceLeaseManager.planCapacityPressureReclaim(lease.lease_id);
    if (!reclaimable) {
      return { lease, reclaimed: false };
    }
    try {
      await browserSurfaceAllocator.stopSurface({
        surfaceId: reclaimable.surface_id,
        reason: "capacity_pressure",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] browser-surface capacity reclaim for ${lease.run_id} failed: ${message}`);
      return { lease, reclaimed: false };
    }

    const reclaimed = browserSurfaceLeaseManager.completeCapacityPressureReclaim(reclaimable.surface_id);
    if (reclaimed.stopped) {
      await persistBrowserSurfaceLeaseMutation(lease, reclaimed.stopped);
    }
    if (!reclaimed.promoted) {
      return { lease, reclaimed: Boolean(reclaimed.stopped) };
    }
    await persistBrowserSurfaceLeaseMutation(
      reclaimed.promoted,
      reclaimed.promoted.surface_id ? browserSurfaceLeaseManager.getSurface(reclaimed.promoted.surface_id) : undefined
    );
    const surface = reclaimed.promoted.surface_id
      ? browserSurfaceLeaseManager.getSurface(reclaimed.promoted.surface_id)
      : undefined;
    return {
      lease: reclaimed.promoted,
      ...(surface ? { surface } : {}),
      reclaimed: true,
    };
  }

  function promoteBrowserSurfaceLease(lease: BrowserSurfaceLease, reason: string): void {
    const promotedOptions = pendingBrowserSurfaceLaunches.get(lease.run_id) ?? {};
    pendingBrowserSurfaceLaunches.delete(lease.run_id);
    scheduleRun(
      lease.connector_id,
      {
        ...promotedOptions,
        runId: lease.run_id,
        priorityClass: lease.priority_class,
      },
      async (err) => {
        const deferredResult = browserSurfaceLeaseManager?.deferLeasedRun({
          leaseId: lease.lease_id,
          fencingToken: lease.fencing_token,
        });
        if (deferredResult?.lease) {
          try {
            await emitBrowserSurfaceLeaseEvent(
              "run.browser_surface_deferred",
              deferredResult.lease.connector_id,
              deferredResult.lease.run_id,
              createTraceContext(),
              deferredResult.lease
            );
            await persistBrowserSurfaceLeaseMutation(deferredResult.lease, deferredResult.surface);
          } catch {
            // Deferred-lease emit/persist is best-effort; the outer warn below
            // already captures the original promotion failure.
          }
        }
        if (deferredResult?.promoted) {
          await persistAndPromoteBrowserSurfaceLeases([deferredResult.promoted], `${reason} promotion failure`);
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[controller] browser-surface lease ${lease.lease_id} promotion failed after ${reason}: ${message}`);
      }
    );
  }

  async function persistAndPromoteBrowserSurfaceLeases(leases: BrowserSurfaceLease[], reason: string): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    for (const lease of leases) {
      await persistBrowserSurfaceLeaseMutation(
        lease,
        lease.surface_id ? browserSurfaceLeaseManager.getSurface(lease.surface_id) : undefined
      );
      promoteBrowserSurfaceLease(lease, reason);
    }
  }

  async function releaseBrowserSurfaceLease(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    reason: string
  ): Promise<void> {
    const releaseResult = browserSurfaceLeaseManager?.release({
      leaseId: lease.lease_id,
      fencingToken: lease.fencing_token,
    });
    if (releaseResult?.lease) {
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_released",
        connectorId,
        runId,
        traceContext,
        releaseResult.lease
      );
      await persistBrowserSurfaceLeaseMutation(releaseResult.lease, releaseResult.surface);
    }
    if (releaseResult?.promoted) {
      await persistAndPromoteBrowserSurfaceLeases([releaseResult.promoted], reason);
    }
  }

  // ─── Boot reconciliation ───────────────────────────────────────────────────

  async function reconcileBrowserSurfacesWithAllocatorAtBoot(): Promise<void> {
    // Before lease reconciliation, ask the allocator which dynamic surfaces
    // actually exist. A persistent surface row with health=ready from a prior
    // boot whose container has been removed must not survive into the new
    // boot's in-memory state, or the next acquire will lease a dead surface
    // and burn an owner OTP cycle.
    if (!(browserSurfaceLeaseManager && browserSurfaceAllocator)) {
      return;
    }
    try {
      const allocatorReconcile =
        await browserSurfaceLeaseManager.reconcileSurfacesWithAllocator(browserSurfaceAllocator);
      const hasPersistenceWork =
        Boolean(browserSurfaceLeaseStore) &&
        (allocatorReconcile.evicted.length > 0 || allocatorReconcile.downgraded.length > 0);
      if (hasPersistenceWork && browserSurfaceLeaseStore) {
        await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
          for (const surface of allocatorReconcile.evicted) {
            await store.upsertSurface({ ...surface, health: "unhealthy" });
          }
          for (const surface of allocatorReconcile.downgraded) {
            await store.upsertSurface(surface);
          }
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] allocator-aware surface reconciliation failed: ${message}`);
    }
  }

  // ─── Acquisition pipeline ─────────────────────────────────────────────────

  function buildBrowserSurfaceEarlyReturn(
    ctx: ManagedSurfaceContext,
    lease: BrowserSurfaceLease,
    status: NonNullable<RunNowResult["status"]>,
    surfaceOverride?: BrowserSurfaceProjection
  ): RunNowResult {
    return {
      run_id: ctx.runId,
      trace_id: ctx.traceContext.trace_id,
      status,
      browser_surface: surfaceOverride ?? projectBrowserSurfaceLease(lease),
      ...ctx.automationMetadata,
    };
  }

  async function tryPromoteReclaimedWaitingLease(
    ctx: ManagedSurfaceContext,
    reclaimedResult: { lease: BrowserSurfaceLease; surface?: BrowserSurface }
  ): Promise<ManagedSurfaceAcquireResult | null> {
    if (!browserSurfaceLeaseManager) {
      return null;
    }
    const { connectorId, runId, traceContext } = ctx;
    if (reclaimedResult.lease.status === "starting_surface") {
      return await handleStartingSurfaceWaitForRun(ctx, reclaimedResult.lease);
    }
    if (reclaimedResult.lease.status === "leased" && reclaimedResult.surface) {
      pendingBrowserSurfaceLaunches.delete(reclaimedResult.lease.run_id);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_starting",
        connectorId,
        runId,
        traceContext,
        reclaimedResult.lease
      );
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_leased",
        connectorId,
        runId,
        traceContext,
        reclaimedResult.lease
      );
      return {
        kind: "ready",
        lease: reclaimedResult.lease,
        env: browserSurfaceLeaseEnv(reclaimedResult.lease, reclaimedResult.surface),
      };
    }
    return { kind: "ready", lease: reclaimedResult.lease, env: null };
  }

  async function handleStartingSurfaceWaitForRun(
    ctx: ManagedSurfaceContext,
    startingLease: BrowserSurfaceLease
  ): Promise<ManagedSurfaceAcquireResult> {
    if (!browserSurfaceLeaseManager) {
      return { kind: "ready", lease: startingLease, env: null };
    }
    const { connectorId, runId, traceContext } = ctx;
    const readyResult = await waitForStartingBrowserSurface(startingLease, connectorId, runId, traceContext);
    if (readyResult.lease.status === "surface_failed") {
      pendingBrowserSurfaceLaunches.delete(runId);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_failed",
        connectorId,
        runId,
        traceContext,
        readyResult.lease
      );
      return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, readyResult.lease, "surface_failed") };
    }
    const readySurface =
      readyResult.surface ??
      (readyResult.lease.surface_id ? browserSurfaceLeaseManager.getSurface(readyResult.lease.surface_id) : undefined);
    if (readyResult.lease.status === "leased" && readySurface) {
      pendingBrowserSurfaceLaunches.delete(readyResult.lease.run_id);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_leased",
        connectorId,
        runId,
        traceContext,
        readyResult.lease
      );
      return {
        kind: "ready",
        lease: readyResult.lease,
        env: browserSurfaceLeaseEnv(readyResult.lease, readySurface),
      };
    }
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_deferred",
      connectorId,
      runId,
      traceContext,
      readyResult.lease
    );
    return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, readyResult.lease, "deferred") };
  }

  async function handleLeasedSurfaceForRun(
    ctx: ManagedSurfaceContext,
    leasedLease: BrowserSurfaceLease
  ): Promise<ManagedSurfaceAcquireResult> {
    if (!(browserSurfaceLeaseManager && leasedLease.surface_id)) {
      return { kind: "ready", lease: leasedLease, env: null };
    }
    const { connectorId, runId, traceContext } = ctx;
    const leasedSurface = browserSurfaceLeaseManager.getSurface(leasedLease.surface_id);
    if (!leasedSurface) {
      pendingBrowserSurfaceLaunches.delete(runId);
      if (browserSurfaceReadinessProbe) {
        await runBrowserSurfaceReadinessGate(leasedLease, null, connectorId, runId, traceContext);
        const projected = projectBrowserSurfaceLease(leasedLease);
        return {
          kind: "early_return",
          result: buildBrowserSurfaceEarlyReturn(ctx, leasedLease, "surface_failed", {
            ...projected,
            browser_surface_status: "surface_failed",
          }),
        };
      }
      await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, leasedLease);
      return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, leasedLease, "deferred") };
    }
    pendingBrowserSurfaceLaunches.delete(leasedLease.run_id);
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_starting", connectorId, runId, traceContext, leasedLease);
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_leased", connectorId, runId, traceContext, leasedLease);
    return { kind: "ready", lease: leasedLease, env: browserSurfaceLeaseEnv(leasedLease, leasedSurface) };
  }

  async function dispatchCurrentLeaseState(
    ctx: ManagedSurfaceContext,
    currentLease: BrowserSurfaceLease | null,
    leaseResult: { lease: BrowserSurfaceLease },
    envFromReclaim: Record<string, string> | null
  ): Promise<ManagedSurfaceAcquireResult> {
    if (envFromReclaim) {
      // Capacity-pressure reclaim may have already promoted and readied this lease.
      return { kind: "ready", lease: currentLease, env: envFromReclaim };
    }
    const { connectorId, runId, traceContext } = ctx;
    if (currentLease?.status === "deferred") {
      pendingBrowserSurfaceLaunches.delete(runId);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_deferred",
        connectorId,
        runId,
        traceContext,
        currentLease
      );
      return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, currentLease, currentLease.status) };
    }
    if (currentLease?.status === "starting_surface") {
      return await handleStartingSurfaceWaitForRun(ctx, currentLease);
    }
    if (currentLease?.status === "leased" && currentLease.surface_id) {
      return await handleLeasedSurfaceForRun(ctx, currentLease);
    }
    const terminalLease = currentLease ?? leaseResult.lease;
    await emitBrowserSurfaceLeaseEvent("run.browser_surface_deferred", connectorId, runId, traceContext, terminalLease);
    return { kind: "early_return", result: buildBrowserSurfaceEarlyReturn(ctx, terminalLease, "deferred") };
  }

  async function runBrowserSurfaceReadinessGateForLease(
    ctx: ManagedSurfaceContext,
    lease: BrowserSurfaceLease
  ): Promise<RunNowResult | null> {
    if (!(browserSurfaceLeaseManager && browserSurfaceReadinessProbe)) {
      return null;
    }
    const surfaceForProbe = lease.surface_id ? (browserSurfaceLeaseManager.getSurface(lease.surface_id) ?? null) : null;
    const probeResult = await runBrowserSurfaceReadinessGate(
      lease,
      surfaceForProbe,
      ctx.connectorId,
      ctx.runId,
      ctx.traceContext
    );
    if (probeResult.ok) {
      return null;
    }
    pendingBrowserSurfaceLaunches.delete(ctx.runId);
    const projected = projectBrowserSurfaceLease(lease);
    return buildBrowserSurfaceEarlyReturn(ctx, lease, "surface_failed", {
      ...projected,
      browser_surface_status: "surface_failed",
    });
  }

  async function acquireInitialBrowserSurfaceLease(
    ctx: ManagedSurfaceContext,
    priorityClass: NonNullable<RunNowOptions["priorityClass"]>
  ): Promise<ReturnType<BrowserSurfaceLeaseManager["acquire"]>> {
    if (!browserSurfaceLeaseManager) {
      throw new Error("browser surface lease manager required to acquire a managed surface lease");
    }
    const { connectorId, connectorInstanceId, manifest, runId, traceContext } = ctx;
    const profileKey = readBrowserSurfaceProfileKey(connectorId, connectorInstanceId, manifest);
    const surfaceSubjectId = connectorInstanceId === connectorId ? undefined : connectorInstanceId;
    const leaseResult = browserSurfaceLeaseManager.acquire({
      connectorId,
      runId,
      profileKey,
      ...(surfaceSubjectId ? { surfaceSubjectId } : {}),
      priorityClass,
    });
    await persistBrowserSurfaceLeaseMutation(leaseResult.lease, leaseResult.surface);
    if (leaseResult.duplicateOf && leaseResult.lease.run_id !== runId) {
      // ControllerError is imported from controller.ts; throw a plain Error
      // with the same code shape so callers can pattern-match on .code.
      const err = new Error(
        `Connector already has a pending browser-surface run: ${leaseResult.lease.run_id}`
      ) as Error & { code: string; runId: string };
      err.code = "run_browser_surface_queued";
      err.runId = leaseResult.lease.run_id;
      throw err;
    }
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_requested",
      connectorId,
      runId,
      traceContext,
      leaseResult.lease
    );
    return leaseResult;
  }

  async function reclaimWaitingLeaseIfNeeded(
    ctx: ManagedSurfaceContext,
    initialLease: BrowserSurfaceLease
  ): Promise<ReclaimResolution> {
    if (initialLease.status !== "waiting_for_browser_surface") {
      return { env: null, lease: initialLease };
    }
    const reclaimedResult = await reclaimCapacityAndPromoteLease(initialLease);
    const reclaimed = reclaimedResult.lease;
    if (reclaimed.run_id !== ctx.runId || reclaimed.status === "waiting_for_browser_surface") {
      return { env: null, lease: initialLease };
    }
    const promoted = await tryPromoteReclaimedWaitingLease(ctx, reclaimedResult);
    if (!promoted) {
      return { env: null, lease: initialLease };
    }
    if (promoted.kind === "early_return") {
      return { earlyReturn: promoted, env: null, lease: initialLease };
    }
    return { env: promoted.env, lease: promoted.lease ?? initialLease };
  }

  function queueWaitingBrowserSurfaceLaunch(
    ctx: ManagedSurfaceContext,
    priorityClass: NonNullable<RunNowOptions["priorityClass"]>
  ): void {
    const { connectorInstanceId, manifest, runId, traceContext, options } = ctx;
    pendingBrowserSurfaceLaunches.set(runId, {
      connectorInstanceId,
      manifest,
      priorityClass,
      runId,
      traceContext,
      ...(options.ownerToken ? { ownerToken: options.ownerToken } : {}),
      ...(options.rsUrl ? { rsUrl: options.rsUrl } : {}),
    });
  }

  function shouldRetryReadinessFailure(): boolean {
    return Boolean(browserSurfaceAllocator && browserSurfaceLeaseManager?.config.surfaceMode === "dynamic");
  }

  function requireBrowserSurfaceLeaseManager(): BrowserSurfaceLeaseManager {
    if (!browserSurfaceLeaseManager) {
      throw new Error("browser surface lease manager required");
    }
    return browserSurfaceLeaseManager;
  }

  // ─── Public API implementation ────────────────────────────────────────────

  async function acquireManagedBrowserSurfaceAttempt(
    ctx: ManagedSurfaceContext,
    priorityClass: NonNullable<RunNowOptions["priorityClass"]>,
    options: { readonly allowReadinessRetry: boolean }
  ): Promise<ManagedSurfaceAcquireResult> {
    const leaseManager = requireBrowserSurfaceLeaseManager();
    const leaseResult = await acquireInitialBrowserSurfaceLease(ctx, priorityClass);
    const reclaim = await reclaimWaitingLeaseIfNeeded(ctx, leaseResult.lease);
    if (reclaim.earlyReturn) {
      return reclaim.earlyReturn;
    }

    const refreshedLease = leaseManager.getLease(reclaim.lease.lease_id) ?? reclaim.lease;
    if (refreshedLease.status === "waiting_for_browser_surface") {
      queueWaitingBrowserSurfaceLaunch(ctx, priorityClass);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_queued",
        ctx.connectorId,
        ctx.runId,
        ctx.traceContext,
        refreshedLease
      );
      return {
        kind: "early_return",
        result: buildBrowserSurfaceEarlyReturn(ctx, refreshedLease, refreshedLease.status),
      };
    }

    const dispatchResult = await dispatchCurrentLeaseState(ctx, refreshedLease, leaseResult, reclaim.env);
    if (dispatchResult.kind === "early_return") {
      return dispatchResult;
    }

    // Preflight readiness gate. The allocator + lease manager have agreed the
    // surface is "leased + ready", but that's bookkeeping — it has not proven
    // the CDP target is alive RIGHT NOW. Probe before we hand env to the
    // connector and ask the human for an OTP. On failure, emit a typed event,
    // release the lease, and return surface_failed.
    return await resolveBrowserSurfaceReadinessForDispatch(ctx, priorityClass, dispatchResult, options);
  }

  async function resolveBrowserSurfaceReadinessForDispatch(
    ctx: ManagedSurfaceContext,
    priorityClass: NonNullable<RunNowOptions["priorityClass"]>,
    dispatchResult: ManagedSurfaceReady,
    options: { readonly allowReadinessRetry: boolean }
  ): Promise<ManagedSurfaceAcquireResult> {
    if (!(dispatchResult.lease && dispatchResult.env)) {
      return dispatchResult;
    }
    const failureResult = await runBrowserSurfaceReadinessGateForLease(ctx, dispatchResult.lease);
    if (!failureResult) {
      return dispatchResult;
    }
    if (options.allowReadinessRetry && shouldRetryReadinessFailure()) {
      return await acquireManagedBrowserSurfaceAttempt(ctx, priorityClass, { allowReadinessRetry: false });
    }
    return { kind: "early_return", result: failureResult };
  }

  async function acquireManagedBrowserSurfaceForRun(ctx: ManagedSurfaceContext): Promise<ManagedSurfaceAcquireResult> {
    if (!browserSurfaceLeaseManager) {
      return { kind: "ready", lease: null, env: null };
    }
    await expireBrowserSurfaceWaitsWithoutPromotion();
    const priorityClass = ctx.options.priorityClass ?? "owner_interactive";
    return await acquireManagedBrowserSurfaceAttempt(ctx, priorityClass, { allowReadinessRetry: true });
  }

  async function cancelBrowserSurfaceRun(runId: string): Promise<BrowserSurfaceProjection | null> {
    if (!browserSurfaceLeaseManager) {
      return null;
    }
    const cancelResult = browserSurfaceLeaseManager.cancelAndPump(runId);
    if (!cancelResult.lease) {
      return null;
    }
    pendingBrowserSurfaceLaunches.delete(runId);
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_cancelled",
      cancelResult.lease.connector_id,
      cancelResult.lease.run_id,
      createTraceContext(),
      cancelResult.lease
    );
    await persistBrowserSurfaceLeaseMutation(cancelResult.lease, cancelResult.surface);
    if (cancelResult.promoted) {
      await persistAndPromoteBrowserSurfaceLeases([cancelResult.promoted], "browser-surface cancellation");
    }
    return projectBrowserSurfaceLease(cancelResult.lease);
  }

  async function cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]> {
    if (!(browserSurfaceLeaseManager && browserSurfaceAllocator)) {
      return [];
    }
    const cleanupResult = await browserSurfaceLeaseManager.cleanupIdleSurfaces(browserSurfaceAllocator);
    if (browserSurfaceLeaseStore && cleanupResult.stopped.length > 0) {
      await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
        for (const surface of cleanupResult.stopped) {
          await store.upsertSurface(surface);
        }
      });
    }
    await persistAndPromoteBrowserSurfaceLeases(cleanupResult.promoted, "browser-surface idle cleanup");
    return cleanupResult.promoted.map((lease) => projectBrowserSurfaceLease(lease));
  }

  async function expireBrowserSurfaceWaitsWithoutPromotion(): Promise<BrowserSurfaceLease[]> {
    if (!browserSurfaceLeaseManager) {
      return [];
    }
    const deferred = browserSurfaceLeaseManager.expireWaitingLeases();
    for (const lease of deferred) {
      pendingBrowserSurfaceLaunches.delete(lease.run_id);
      await emitBrowserSurfaceLeaseEvent(
        "run.browser_surface_deferred",
        lease.connector_id,
        lease.run_id,
        createTraceContext(),
        lease
      );
      await persistBrowserSurfaceLeaseMutation(lease);
    }
    return deferred;
  }

  async function expireBrowserSurfaceWaits(): Promise<BrowserSurfaceProjection[]> {
    if (!browserSurfaceLeaseManager) {
      return [];
    }
    const deferred = await expireBrowserSurfaceWaitsWithoutPromotion();
    await persistAndPromoteBrowserSurfaceLeases(
      browserSurfaceLeaseManager.pumpQueuedLeases(),
      "browser-surface timeout"
    );
    return deferred.map((lease) => projectBrowserSurfaceLease(lease));
  }

  async function reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void> {
    await startupControllerRunReconciliation;
    if (!browserSurfaceLeaseManager) {
      return;
    }
    await reconcileBrowserSurfacesWithAllocatorAtBoot();
    const activeRunIds = new Set((await listPersistedActiveRuns()).map((row) => row.run_id));
    const reconciled = browserSurfaceLeaseManager.reconcileAfterRestart({ activeRunIds, promoteQueued: false });
    await emitAndPersistReconciledLeases(reconciled.released, "run.browser_surface_released", { hydrateSurface: true });
    await emitAndPersistReconciledLeases(reconciled.expired, "run.browser_surface_expired", { hydrateSurface: false });
    await emitAndPersistReconciledLeases(reconciled.deferred, "run.browser_surface_deferred", {
      hydrateSurface: false,
    });
    await emitAndPersistReconciledLeases(reconciled.surfaceFailed, "run.browser_surface_failed", {
      hydrateSurface: true,
    });
  }

  async function promoteBrowserSurfaceLeasesAfterBoot(): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    await persistAndPromoteBrowserSurfaceLeases(
      browserSurfaceLeaseManager.pumpQueuedLeases(),
      "post-listener boot reconciliation"
    );
  }

  async function releaseLease(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ): Promise<void> {
    try {
      await releaseBrowserSurfaceLease(lease, connectorId, runId, traceContext, `${runId} release`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to persist browser-surface lease release for ${runId}: ${message}`);
    }
  }

  function wrapInteractionHandlerWithSurfaceLossDetection(
    runId: string,
    connectorId: string,
    traceContext: SpineTraceContext,
    handler: (interaction: unknown) => Promise<unknown>
  ): (interaction: unknown) => Promise<unknown> {
    if (!(browserSurfaceReadinessProbe && browserSurfaceLeaseManager)) {
      return handler;
    }
    return (rawInteraction: unknown) => {
      const interaction = rawInteraction as RuntimeInteraction;

      // Only monitor interactions where the browser surface is part of the
      // response path. Non-browser otp/credentials interactions fall through
      // below because they have no leased surface for this run.
      if (!(interaction.kind === "manual_action" || interaction.kind === "otp")) {
        return handler(rawInteraction);
      }

      const lease = browserSurfaceLeaseManager
        .listLeases()
        .find((candidate: BrowserSurfaceLease) => candidate.run_id === runId && candidate.status === "leased");
      const surface = lease?.surface_id ? browserSurfaceLeaseManager.getSurface(lease.surface_id) : null;

      if (!(lease && surface)) {
        return handler(rawInteraction);
      }

      const detector = createMidWaitSurfaceLossDetector(
        surface,
        browserSurfaceReadinessProbe,
        browserSurfaceMidWaitPollIntervalMs === undefined ? {} : { pollIntervalMs: browserSurfaceMidWaitPollIntervalMs }
      );

      const responsePromise = Promise.resolve(handler(rawInteraction)).finally(() => {
        detector.cancel();
      });

      const lostResponse: Promise<unknown> = detector.lossPromise.then((failure) => {
        // Clear the pending interaction entry BEFORE resolving so any
        // in-flight respondToInteraction call gets no_pending_interaction.
        const currentEntry = activeRunInteractions.get(runId);
        const cancelledResponse = {
          type: "INTERACTION_RESPONSE",
          request_id: interaction.request_id,
          status: "cancelled",
        } as const;
        if (currentEntry?.pending?.interaction_id === interaction.request_id) {
          const pending = currentEntry.pending;
          currentEntry.pending = null;
          pending.resolve(cancelledResponse);
        }

        // Best-effort fire-and-forget: emission failure must not resolve the
        // interaction with an error.
        emitBrowserSurfaceLostEvent({
          connectorId,
          interactionId: interaction.request_id,
          interactionKind: interaction.kind,
          probeCode: failure.code,
          probeDetail: failure.detail,
          runId,
          traceContext,
        }).catch(() => {
          // Already logs internally.
        });

        return cancelledResponse;
      });

      return Promise.race([responsePromise, lostResponse]);
    };
  }

  return {
    acquireManagedBrowserSurfaceForRun,
    cancelBrowserSurfaceRun,
    cleanupIdleBrowserSurfaces,
    emitLeaseEvent: emitBrowserSurfaceLeaseEvent,
    expireBrowserSurfaceWaits,
    promoteBrowserSurfaceLeasesAfterBoot,
    reconcileBrowserSurfaceLeasesAfterBoot,
    releaseLease,
    wrapInteractionHandlerWithSurfaceLossDetection,
  };
}
