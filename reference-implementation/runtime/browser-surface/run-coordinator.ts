// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  // biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
} from "@opendatalabs/remote-surface/leases";
import { createTraceContext, emitSpineEvent, type SpineTraceContext } from "../../lib/spine.ts";
import type { BrowserSurfaceLeaseStore } from "../../server/stores/browser-surface-lease-store.ts";
import type { BrowserSurfaceReplacementReceiptStore } from "../../server/stores/browser-surface-replacement-ledger-store.ts";
import { browserSurfaceLeaseEnv } from "../browser-surface-leases.ts";
import {
  type BrowserSurfaceReadinessProbe,
  type BrowserSurfaceReadinessProbeResult,
  createMidWaitSurfaceLossDetector,
} from "../browser-surface-readiness.ts";
import type { ConnectorManifest, RunNowOptions, RunNowResult } from "../run-contracts.ts";
import { readBrowserSurfaceProfileKey } from "./profile-key.ts";
import { createReplacementLifecycleHooks } from "./replacement-lifecycle-hooks.ts";
import { connectorRetainsSurfaceProcess } from "./retained-surface-connectors.ts";
import { createWindowSettleReconciliation } from "./window-settle-reconciliation.ts";

// ─── Internal types ──────────────────────────────────────────────────────────

/** run_id/lease_id context threaded into wrapAllocatorWithTransientPollRetry's exhaustion warning. leaseId is a thunk because the same wrapper instance outlives lease reacquisition within one starting-surface wait loop. */
export interface TransientPollRetryContext {
  readonly leaseId: () => string;
  readonly runId: string;
}

// Fleet-scale bound: a live deployment can accumulate hundreds of historical
// unhealthy/no-lease durable rows (each one a past surface_failed/host-loss
// terminalization). Reprocessing all of them every sweep tick (default 30s)
// would mean unbounded sequential allocator.stopSurface calls per tick. Each
// retired row transitions out of the "unhealthy, no lease" eligibility set
// (to "stopping") the moment its stop succeeds OR the allocator confirms it
// is already gone, so a small per-tick batch still converges over a few
// ticks without needing new pagination machinery in the store.
const MAX_ORPHAN_SURFACE_RETIREMENTS_PER_SWEEP = 5;

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
  listSurfaces: () => Promise.resolve([]),
  stopSurface: () => Promise.resolve(null),
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

interface AllocatorSurfaceReconciliation {
  readonly downgraded: readonly BrowserSurface[];
  readonly evicted: readonly BrowserSurface[];
}

// ─── Phase-scoped (mid-run) browser-surface acquisition ──────────────────────
//
// A `surfaceScope: "phase"` connector (browser-surface-policy.ts) does not
// hold a managed surface for its whole run — it asks for one only while it
// actually needs a browser, for a bounded phase inside an otherwise
// browser-free run (e.g. Slack's ~4 gap streams near the end of a ~1h run).
//
// `BrowserSurfaceLeaseManager.acquire()` keys non-terminal duplicate
// detection AND `cancelAndPump(runId)` off the exact `runId` on the request
// (surface-lease-manager.js:260-264). A phase lease MUST NOT reuse the run's
// own `runId`: doing so would return the run's own lease (no independent
// capacity for the phase) and would make the run-level cancel/cleanup path
// terminate a lease that a concurrent phase request is still using. Deriving
// a distinct per-run session id gives the phase lease its own identity in the
// lease manager while keeping it addressable from the one real `runId` the
// controller/connector both know.
export function browserSurfacePhaseSessionId(runId: string): string {
  return `${runId}#browser-phase`;
}

export type PhaseSurfaceAcquireUnavailableReason = "capacity_full" | "not_managed" | "surface_failed" | "timeout";

export type PhaseSurfaceAcquireResult =
  | {
      readonly kind: "granted";
      readonly leaseId: string;
      readonly profileKey: string;
      readonly remoteCdpUrl: string;
      readonly streamBaseUrl: string;
      readonly surfaceId: string;
    }
  | { readonly kind: "unavailable"; readonly reason: PhaseSurfaceAcquireUnavailableReason };

export interface PhaseSurfaceAcquireInput {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly runId: string;
  readonly traceContext: SpineTraceContext;
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
  /** Bounded retry attempts for a capacity-pressure reclaim's allocator stop call. Defaults to 3. */
  readonly browserSurfaceReclaimRetryAttempts?: number;
  /** Delay between reclaim retry attempts. Defaults to 250ms. Tests inject 0. */
  readonly browserSurfaceReclaimRetryDelayMs?: number;
  readonly browserSurfaceReplacementReceiptStore: BrowserSurfaceReplacementReceiptStore | null;
  /**
   * Bounded per-call retry attempts for a single starting-surface allocator
   * poll (`ensureSurface`/`getSurfaceStatus`) before that poll's error is
   * allowed to reach remote-surface's `ensureStartingSurfaceReady`, which
   * treats ANY thrown error as definitive surface death and immediately,
   * irrevocably terminalizes the lease to `surface_failed` with no
   * distinction between "this container is dead" and "one HTTP call to the
   * allocator hiccuped." Defaults to 3. Both allocator calls are read-only or
   * idempotent-on-existing-container (see `ensureSurface`'s
   * inspect-existing-then-reuse branch in `neko-surface-allocator-server.ts`),
   * so retrying in place is safe and mints no new surface.
   */
  readonly browserSurfaceStartingPollRetryAttempts?: number;
  /** Delay between starting-surface poll retry attempts. Defaults to 250ms. Tests inject 0. */
  readonly browserSurfaceStartingPollRetryDelayMs?: number;
  readonly listPersistedActiveRuns: () => Promise<
    ReadonlyArray<{ readonly connector_instance_id?: string | null; readonly run_id: string }>
  >;
  readonly log: ControllerLogger;
  /** Injectable clock for orphan-surface idle-TTL staleness checks. Defaults to Date.now. */
  readonly nowMs?: () => number;
  readonly pendingBrowserSurfaceLaunches: Map<string, RunNowOptions>;
  /**
   * Resolves the durable owner of an admitted connection when a process restart
   * has discarded the in-memory launch options. A persisted lease records the
   * exact connection but deliberately not an owner-token-derived guess.
   */
  readonly resolveOwnerSubjectIdForConnectorInstance?: (connectorInstanceId: string) => Promise<string | null>;
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
  /** Injectable sleep, so tests can avoid real wall-clock delay. Defaults to setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly startupControllerRunReconciliation: Promise<void>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface BrowserSurfaceManager {
  /**
   * Acquire a bounded, phase-scoped managed browser surface for a run that
   * does not hold a run-level lease (`surfaceScope: "phase"`). Idempotent per
   * run: a repeat call while a phase lease is already live for this `runId`
   * returns the SAME grant rather than acquiring a second lease. Never
   * blocks the run waiting for capacity — a `waiting_for_browser_surface`
   * outcome resolves `{kind:"unavailable", reason:"capacity_full"}` instead
   * of queuing.
   */
  acquireManagedBrowserSurfaceForPhase: (input: PhaseSurfaceAcquireInput) => Promise<PhaseSurfaceAcquireResult>;
  /** Acquire (or queue/defer) a managed browser-surface lease for a run. */
  acquireManagedBrowserSurfaceForRun: (ctx: ManagedSurfaceContext) => Promise<ManagedSurfaceAcquireResult>;
  /** Cancel the browser-surface lease for a waiting/queued run. */
  cancelBrowserSurfaceRun: (runId: string) => Promise<BrowserSurfaceProjection | null>;
  /** Stop idle surfaces and promote any queued waiters. */
  cleanupIdleBrowserSurfaces: () => Promise<BrowserSurfaceProjection[]>;
  /** Emit a browser-surface lease spine event (used by respondToInteraction). */
  emitLeaseEvent: (
    eventType: string,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    lease: BrowserSurfaceLease
  ) => Promise<void>;
  /** Expire timed-out waiters and promote queued leases. */
  expireBrowserSurfaceWaits: () => Promise<BrowserSurfaceProjection[]>;
  /** Promote boot-time queued leases after the listener is up. */
  promoteBrowserSurfaceLeasesAfterBoot: () => Promise<void>;
  /** Reconcile leases against the allocator and persisted active runs after a restart. */
  reconcileBrowserSurfaceLeasesAfterBoot: () => Promise<void>;
  /**
   * Recycle a managed dynamic surface after a run's terminal connector
   * error carries the typed attach-exhausted disposition (readiness
   * passed, then the surface wedged before any record/progress, and the
   * connector-runtime source boundary exhausted its bounded attach-race
   * retry budget). No-op for a static/operator-owned surface or a lease
   * with no surface. Call before releaseLease so the next acquire cannot
   * re-lease the same surface.
   */
  recycleAttachExhaustedManagedSurfaceAfterRun: (input: {
    readonly connectorId: string;
    readonly lease: BrowserSurfaceLease | null;
    readonly probeCode: string;
    readonly probeDetail: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }) => Promise<void>;
  /**
   * Release a lease, swallowing errors. Covers both the pre-spawn failure path
   * (registerActiveRunBookkeeping) and the post-run cleanup path (finalizeRunCleanup).
   */
  releaseLease: (
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext
  ) => Promise<void>;
  /**
   * Release this run's phase-scoped browser surface, if any. No-op when no
   * phase lease is tracked for `runId` (never acquired, already released, or
   * a stale/duplicate call) — the ownership record is deleted BEFORE the
   * fenced release call so a concurrent duplicate call cannot double-release.
   * Never throws; swallows and logs like `releaseLease`. Safe to call
   * unconditionally as a run-cleanup backstop.
   */
  releaseManagedBrowserSurfaceForPhase: (runId: string) => Promise<void>;
  /**
   * Independent periodic sweep: reconciles surfaces against the allocator,
   * expires + promotes past-TTL waiting leases, and retries capacity-pressure
   * reclaim for anything still queued afterward. Reentrancy-guarded — an
   * overlapping call while a sweep is in flight is a no-op. Never mutates an
   * active leased run.
   */
  sweepBrowserSurfaceLeases: () => Promise<void>;
  /** Wrap an interaction handler with mid-wait browser-surface loss detection. */
  wrapInteractionHandlerWithSurfaceLossDetection: (
    runId: string,
    connectorId: string,
    traceContext: SpineTraceContext,
    handler: (interaction: unknown) => Promise<unknown>
  ) => (interaction: unknown) => Promise<unknown>;
}

// ─── Transient poll retry (module-level; exported ONLY for relative test
// import — not re-exported from index.ts or any package barrel) ────────────

/**
 * Wraps a starting-surface allocator so a single transient
 * `ensureSurface`/`getSurfaceStatus` failure cannot reach
 * remote-surface's `ensureStartingSurfaceReady`, which treats ANY thrown
 * error as definitive surface death and immediately, irrevocably
 * terminalizes the lease to `surface_failed` (bare `catch {}`, no
 * distinction between "container is actually dead" and "one HTTP call to
 * the allocator hiccuped mid-boot"). This is the fix for the 2026-07-31
 * Amazon Personal canary (run_1785535443538): two consecutive ~1s-fast
 * allocator throws terminalized the run while the SAME two surfaces it had
 * already minted went on to become healthy moments later — proving the
 * throws were transient poll hiccups, not real container death.
 *
 * Both wrapped calls are safe to retry in place against the SAME
 * `surfaceId`: `ensureSurface`'s existing-container branch
 * (`neko-surface-allocator-server.ts`'s `#findOwnedContainer` ->
 * inspect-and-reuse) is idempotent, and `getSurfaceStatus` is a pure read.
 * Neither call creates a new container on retry, so this keeps ownership
 * of the one replacement surface through its readiness lifecycle instead
 * of minting additional containers per hiccup. Bounded to `attempts`
 * (default 3) consecutive failures; only after that budget is exhausted
 * does the error reach the package and the lease manager's own
 * terminal-lease bookkeeping, which is unchanged and still fails closed
 * for a genuinely dead surface.
 *
 * Module-level and exported (not through any barrel/index.ts) purely so
 * `test/controller-browser-surface-readiness.test.ts` can import it by
 * relative path and exercise the exhaustion-warning behavior directly,
 * without the full controller/lease-manager path — remote-surface's
 * ensureStartingSurfaceReady swallows any thrown error into an untyped
 * surface_failed with no retained detail, so that path alone cannot prove
 * the original error's identity survives a throwing logger/getter/
 * serializer. This is the ONLY function production code calls for this
 * retry — createBrowserSurfaceManager's internal call site below invokes
 * this exact export, not a duplicate.
 */
export function wrapAllocatorWithTransientPollRetry(
  allocator: BrowserSurfaceAllocator,
  context: TransientPollRetryContext,
  deps: {
    attempts: number;
    delayMs: number;
    log: ControllerLogger;
    sleep: (ms: number) => Promise<void>;
  }
): BrowserSurfaceAllocator {
  async function withRetry<T>(operation: string, surfaceId: string, call: () => Promise<T>): Promise<T> {
    const attempts = Math.max(1, deps.attempts);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Bounded sequential retry against the same surface; concurrency would multiply allocator load, not help it.
        return await call();
      } catch (err) {
        lastError = err;
        if (attempt < attempts && deps.delayMs > 0) {
          await deps.sleep(deps.delayMs);
        }
      }
    }
    // The diagnostic is telemetry, not a retry decision: it must never be
    // able to prevent or alter this rethrow, no matter what a hostile
    // caught value's property getters do, what JSON.stringify does on a
    // cyclic/throwing toJSON, or whether the injected logger itself
    // throws. try/catch/ignore around the ENTIRE emit call is the only
    // way to guarantee that — see the 2026-08-01 gate revision.
    try {
      emitExhaustedTransientPollRetryWarning({
        attempts,
        context,
        error: lastError,
        log: deps.log,
        operation,
        surfaceId,
      });
    } catch {
      // Telemetry must never interfere with the exhausted-retry rethrow below.
    }
    throw lastError;
  }
  return {
    ensureSurface: (request) => withRetry("ensureSurface", request.surfaceId, () => allocator.ensureSurface(request)),
    getSurfaceStatus: (surfaceId) =>
      withRetry("getSurfaceStatus", surfaceId, () => allocator.getSurfaceStatus(surfaceId)),
    listSurfaces: () => allocator.listSurfaces(),
    stopSurface: (request) => allocator.stopSurface(request),
  };
}

/**
 * Emits exactly one bounded, allowlisted warning per exhausted
 * ensureSurface/getSurfaceStatus retry budget, immediately before the
 * error reaches remote-surface's ensureStartingSurfaceReady (whose bare
 * catch{} erases it into an untyped surface_start_failed with no
 * operation, HTTP status, client code, category, or retryable bit — see
 * the 2026-08-01 Amazon UAT root-cause gate). Every field is normalized
 * through a closed known-value/type constraint (readKnownErrorCode,
 * readKnownErrorCategory, readBoolean, readHttpStatus, readKnownErrorName)
 * derived from the actual allocator error contracts
 * (NekoSurfaceAllocatorError's client `code`, NekoSurfaceAllocatorServiceError's
 * server `code`, and the server's categoryForError/retryableForCategory
 * union) rather than accepting any scalar shape. An unrecognized value
 * for a closed field becomes null, not a pass-through — this is what
 * stops a hostile caught object like `{ code: "Bearer secret-token-xyz" }`
 * from leaking, since regex redaction cannot enumerate every possible
 * secret shape but a closed enum can only ever emit one of its known
 * members. The caller wraps this whole function in try/catch so a
 * throwing getter or throwing JSON.stringify can never block the
 * exhausted-retry rethrow.
 */
function emitExhaustedTransientPollRetryWarning(input: {
  attempts: number;
  context: TransientPollRetryContext;
  error: unknown;
  log: ControllerLogger;
  operation: string;
  surfaceId: string;
}): void {
  const { attempts, context, error, log, operation, surfaceId } = input;
  const record = {
    attempts,
    category: readKnownErrorCategory(error),
    code: readKnownErrorCode(error),
    error_name: readKnownErrorName(error),
    lease_id: context.leaseId(),
    operation,
    retryable: readBoolean(error, "retryable"),
    run_id: context.runId,
    status: readHttpStatus(error),
    surface_id: surfaceId,
  };
  log.warn?.(`[controller] browser-surface allocator poll retry exhausted: ${JSON.stringify(record)}`);
}

/**
 * The full closed set of `code` values across both real allocator error
 * contracts this wrapper can ever catch: the HTTP client's
 * NekoSurfaceAllocatorError (@opendatalabs/remote-surface's
 * allocator-client.ts) and the server-side
 * NekoSurfaceAllocatorServiceError (neko-surface-allocator-server.ts),
 * whose `code` a directly-injected/in-process allocator could also throw.
 * Any other value — including a plausible-looking string that isn't one
 * of these exact members — normalizes to null.
 */
const KNOWN_ALLOCATOR_ERROR_CODES: ReadonlySet<string> = new Set([
  // client: NekoSurfaceAllocatorError["code"]
  "allocator_http_error",
  "allocator_fetch_error",
  "allocator_timeout",
  "allocator_malformed_response",
  // server: NekoSurfaceAllocatorServiceError["code"]
  "bad_request",
  "docker_http_error",
  "docker_malformed_response",
  "docker_request_failed",
  "foreign_resource",
  "not_found",
  "port_capacity_exhausted",
  "readiness_failed",
]);

/**
 * The closed set of `category` values the allocator's HTTP handler ever
 * computes (neko-surface-allocator-server.ts's categoryForError): every
 * NekoSurfaceAllocatorServiceError code, plus the literal "unknown"
 * fallback for a non-service error. Any other value normalizes to null.
 */
const KNOWN_ALLOCATOR_ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  "bad_request",
  "docker_http_error",
  "docker_malformed_response",
  "docker_request_failed",
  "foreign_resource",
  "not_found",
  "port_capacity_exhausted",
  "readiness_failed",
  "unknown",
]);

/** Error class names actually thrown on this path. Any other value normalizes to null. */
const KNOWN_ALLOCATOR_ERROR_NAMES: ReadonlySet<string> = new Set([
  "Error",
  "TypeError",
  "NekoSurfaceAllocatorError",
  "NekoSurfaceAllocatorServiceError",
]);

function readErrorProperty(error: unknown, field: string): unknown {
  if (!(error && typeof error === "object")) {
    return;
  }
  try {
    return (error as Record<string, unknown>)[field];
  } catch {
    // A hostile caught value's getter for this property may itself throw;
    // that must normalize to "unknown" (undefined), not propagate.
    // biome-ignore lint/complexity/noUselessReturn: required by TypeScript noImplicitReturns — the try branch returns a value, so this branch must too.
    return;
  }
}

function readKnownErrorCode(error: unknown): string | null {
  const value = readErrorProperty(error, "code");
  return typeof value === "string" && KNOWN_ALLOCATOR_ERROR_CODES.has(value) ? value : null;
}

function readKnownErrorCategory(error: unknown): string | null {
  const value = readErrorProperty(error, "category");
  return typeof value === "string" && KNOWN_ALLOCATOR_ERROR_CATEGORIES.has(value) ? value : null;
}

function readKnownErrorName(error: unknown): string | null {
  const value = readErrorProperty(error, "name");
  return typeof value === "string" && KNOWN_ALLOCATOR_ERROR_NAMES.has(value) ? value : null;
}

/** Strict boolean type constraint — a truthy/falsy non-boolean (e.g. a string) normalizes to null, never coerced. */
function readBoolean(error: unknown, field: string): boolean | null {
  const value = readErrorProperty(error, field);
  return typeof value === "boolean" ? value : null;
}

/** Bounded to the valid HTTP status-code integer range; any other numeric value (or non-number) normalizes to null. */
function readHttpStatus(error: unknown): number | null {
  const value = readErrorProperty(error, "status");
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value >= 100 && value <= 599 ? value : null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createBrowserSurfaceManager(deps: BrowserSurfaceManagerDeps): BrowserSurfaceManager {
  const {
    activeRunInteractions,
    browserSurfaceAllocator,
    browserSurfaceLeaseManager,
    browserSurfaceLeaseStore,
    browserSurfaceReplacementReceiptStore,
    browserSurfaceMidWaitPollIntervalMs,
    browserSurfaceReadinessProbe,
    browserSurfaceReadinessTimeoutMs,
    browserSurfaceReclaimRetryAttempts = 3,
    browserSurfaceReclaimRetryDelayMs = 250,
    browserSurfaceStartingPollRetryAttempts = 3,
    browserSurfaceStartingPollRetryDelayMs = 250,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    nowMs = () => Date.now(),
    listPersistedActiveRuns,
    log,
    pendingBrowserSurfaceLaunches,
    resolveOwnerSubjectIdForConnectorInstance = async () => null,
    scheduleRun,
    startupControllerRunReconciliation,
  } = deps;
  const replacementHooks = createReplacementLifecycleHooks({
    allocator: browserSurfaceAllocator,
    leaseStore: browserSurfaceLeaseStore,
    log,
    receiptStore: browserSurfaceReplacementReceiptStore,
  });
  const { allocator: replacementAwareAllocator } = replacementHooks;
  const connectorInstanceIdByRunId = new Map<string, string>();
  // Per-derived-session-id ownership token for the CURRENT invocation of
  // withPhaseSessionIdentity holding that session id's connectorInstanceIdByRunId
  // entry. Overlapping calls for the SAME sessionId (a release racing a
  // reacquire for the same run) each get a distinct token; an invocation's
  // finally only deletes the shared cache entry if this map still names ITS
  // token as current owner, so a slower invocation's stale cleanup can never
  // delete or shadow a newer invocation's freshly-installed identity.
  const phaseSessionIdentityOwnerBySessionId = new Map<string, symbol>();
  // Ownership record for phase-scoped (mid-run) browser-surface leases, keyed
  // by the REAL run id (not the derived session id). Tracks exactly which
  // lease this run currently holds, the connector instance it was granted
  // under (so release resolves the SAME identity acquisition cached — not
  // the connector type), and the fencing token it was granted under, so
  // `releaseManagedBrowserSurfaceForPhase` can release the right lease and a
  // stale/duplicate release call cannot free a different one.
  const phaseLeasesByRunId = new Map<
    string,
    {
      readonly connectorId: string;
      readonly connectorInstanceId: string;
      readonly fencingToken: number;
      readonly leaseId: string;
    }
  >();
  let browserSurfaceSweepInFlight = false;
  const windowSettleReconciliation = createWindowSettleReconciliation({
    invalidateDeferredLease: invalidateBrowserSurfaceAfterProbeFailure,
    invalidateIdleSurface: invalidateIdleSurfaceAfterProbeFailure,
    leaseManager: browserSurfaceLeaseManager,
    log,
    readinessProbe: browserSurfaceReadinessProbe,
    shouldReconcile: shouldRetryReadinessFailure,
  });

  function buildRunSource(connectorId: string): { kind: "connector"; id: string } {
    return { id: connectorId, kind: "connector" };
  }

  function buildReadyProbePayload(result: Extract<BrowserSurfaceReadinessProbeResult, { ok: true }>): {
    ok: true;
    page_target_count: number;
    browser_version?: string;
  } {
    return {
      ok: true,
      page_target_count: result.pageTargetCount,
      ...(result.browserVersion ? { browser_version: result.browserVersion } : {}),
    };
  }

  function findSurfaceForLease(lease: BrowserSurfaceLease): BrowserSurface | undefined {
    if (!(browserSurfaceLeaseManager && lease.surface_id)) {
      return;
    }
    return browserSurfaceLeaseManager.getSurface(lease.surface_id);
  }

  function readinessTimeoutOptions(): { readonly readinessTimeoutMs?: number } {
    if (browserSurfaceReadinessTimeoutMs === undefined) {
      return {};
    }
    return { readinessTimeoutMs: browserSurfaceReadinessTimeoutMs };
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
      const connectorInstanceId = await requireConnectorInstanceIdForRun(runId);
      await emitSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          browser_surface: projectBrowserSurfaceLease(lease),
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
          source: buildRunSource(connectorId),
        },
        event_type: eventType,
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: lease.status,
        trace_id: traceContext.trace_id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit ${eventType} for ${runId}: ${message}`);
    }
  }

  async function requireConnectorInstanceIdForRun(runId: string): Promise<string> {
    const known = connectorInstanceIdByRunId.get(runId);
    if (known) {
      return known;
    }
    const row = (await listPersistedActiveRuns()).find((candidate) => candidate.run_id === runId);
    const connectorInstanceId = row?.connector_instance_id;
    if (typeof connectorInstanceId !== "string" || connectorInstanceId.length === 0) {
      throw new Error(
        `browser-surface run ${runId} has no persisted connector_instance_id; refusing to persist an unbound run event.`
      );
    }
    connectorInstanceIdByRunId.set(runId, connectorInstanceId);
    return connectorInstanceId;
  }

  async function emitBrowserSurfaceReadyEvent(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    result: Extract<BrowserSurfaceReadinessProbeResult, { ok: true }>
  ): Promise<void> {
    try {
      const connectorInstanceId = await requireConnectorInstanceIdForRun(runId);
      await emitSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          browser_surface: projectBrowserSurfaceLease(lease),
          browser_surface_probe: buildReadyProbePayload(result),
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
          source: buildRunSource(connectorId),
        },
        event_type: "run.browser_surface_ready",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: lease.status,
        trace_id: traceContext.trace_id,
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
      const connectorInstanceId = await requireConnectorInstanceIdForRun(runId);
      await emitSpineEvent({
        actor_id: connectorId,
        actor_type: "runtime",
        data: {
          browser_surface: projectBrowserSurfaceLease(lease),
          browser_surface_probe: {
            code: result.code,
            detail: result.detail,
            ok: false,
          },
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
          source: buildRunSource(connectorId),
        },
        event_type: "run.browser_surface_probe_failed",
        object_id: runId,
        object_type: "run",
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        status: "surface_failed",
        trace_id: traceContext.trace_id,
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
      const connectorInstanceId = await requireConnectorInstanceIdForRun(input.runId);
      await emitSpineEvent({
        actor_id: input.connectorId,
        actor_type: "runtime",
        data: {
          browser_surface_probe: {
            code: input.probeCode,
            detail: input.probeDetail,
            ok: false,
          },
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
          interaction_id: input.interactionId,
          kind: input.interactionKind,
          source: buildRunSource(input.connectorId),
        },
        event_type: "run.browser_surface_lost",
        object_id: input.runId,
        object_type: "run",
        run_id: input.runId,
        scenario_id: input.traceContext.scenario_id,
        status: "surface_failed",
        trace_id: input.traceContext.trace_id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_lost for ${input.runId}: ${message}`);
    }
  }

  /**
   * Typed post-run counterpart to `run.browser_surface_probe_failed`. Unlike
   * `run.browser_surface_lost`, this carries no `interaction_id`/`kind` —
   * there is no interaction here; the surface was recycled because the run's
   * terminal connector error carried the typed attach-exhausted
   * disposition, not from a mid-wait interaction probe. Fabricating
   * interaction fields on the interaction-specific event would misrepresent
   * what happened, so this is a distinct, narrower event.
   */
  async function emitBrowserSurfaceInvalidatedEvent(input: {
    readonly connectorId: string;
    readonly lease: BrowserSurfaceLease;
    readonly probeCode: string;
    readonly probeDetail: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<void> {
    try {
      const connectorInstanceId = await requireConnectorInstanceIdForRun(input.runId);
      await emitSpineEvent({
        actor_id: input.connectorId,
        actor_type: "runtime",
        data: {
          browser_surface: projectBrowserSurfaceLease(input.lease),
          browser_surface_probe: {
            code: input.probeCode,
            detail: input.probeDetail,
            ok: false,
          },
          connection_id: connectorInstanceId,
          connector_instance_id: connectorInstanceId,
          source: buildRunSource(input.connectorId),
        },
        event_type: "run.browser_surface_invalidated",
        object_id: input.runId,
        object_type: "run",
        run_id: input.runId,
        scenario_id: input.traceContext.scenario_id,
        status: "surface_failed",
        trace_id: input.traceContext.trace_id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to emit run.browser_surface_invalidated for ${input.runId}: ${message}`);
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
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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
    if (!replacementAwareAllocator) {
      return;
    }
    try {
      await replacementAwareAllocator.stopSurface({
        reason: "surface_failed",
        surfaceId,
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

  async function invalidateIdleSurfaceAfterProbeFailure(surface: BrowserSurface, probeCode: string): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    const invalidated = browserSurfaceLeaseManager.invalidateSurface(surface.surface_id, {
      releaseLease: false,
    });
    if (invalidated.surface) {
      await persistInvalidatedBrowserSurface(invalidated.surface);
    }
    await stopAllocatorSurfaceAfterProbeFailure(surface.surface_id, probeCode);
  }

  /**
   * A managed surface can pass pre-flight readiness (`run.browser_surface_ready`)
   * and still wedge mid-run: the allocator/CDP-metadata endpoints keep
   * answering, but the connector's attach-session work fails before any
   * record or progress. Unlike a probe failure, nothing re-probes this
   * surface proactively — the connector-runtime source boundary
   * (`connectOverCdpWithRetry`) is the one that discovers its bounded
   * attach-race retry budget is exhausted, and tags that fact with a stable
   * `connector_error.code`. This is the post-run counterpart to
   * `invalidateBrowserSurfaceAfterProbeFailure`: same eviction/allocator-stop
   * mechanism, triggered from a different (post-run, typed-code) signal.
   *
   * Only a `dynamic`-mode surface is recycled. A `static` (operator-owned)
   * surface is not ours to destroy — the run still gets the existing
   * `retry_by_runtime` classification and retry budget, but the surface
   * itself is left alone so it fails safely rather than destructively.
   */
  async function recycleAttachExhaustedManagedSurfaceAfterRun(input: {
    readonly connectorId: string;
    readonly lease: BrowserSurfaceLease | null;
    readonly probeCode: string;
    readonly probeDetail: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<void> {
    const { connectorId, lease, probeCode, probeDetail, runId, traceContext } = input;
    if (!(lease?.surface_id && shouldRetryReadinessFailure())) {
      return;
    }
    await invalidateBrowserSurfaceAfterProbeFailure(lease, probeCode);
    await emitBrowserSurfaceInvalidatedEvent({
      connectorId,
      lease,
      probeCode,
      probeDetail,
      runId,
      traceContext,
    });
  }

  // ─── Readiness probing ────────────────────────────────────────────────────

  async function performBrowserSurfaceReadinessProbe(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface | null
  ): Promise<BrowserSurfaceReadinessProbeResult> {
    if (!surface) {
      return {
        code: "browser_surface_not_ready",
        detail: `lease ${lease.lease_id} references missing surface ${lease.surface_id || "(none)"}`,
        ok: false,
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
        code: "browser_surface_cdp_unreachable",
        detail: `readiness probe threw: ${message}`,
        ok: false,
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
      await replacementHooks.recordBrowserGeneration(lease, surface, connectorId, runId, result);
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
    const allocator = wrapAllocatorWithTransientPollRetry(
      replacementAwareAllocator ?? UNCONFIGURED_BROWSER_SURFACE_ALLOCATOR,
      { leaseId: () => current.lease_id, runId },
      { attempts: browserSurfaceStartingPollRetryAttempts, delayMs: browserSurfaceStartingPollRetryDelayMs, log, sleep }
    );
    while (current.status === "starting_surface") {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const readyResult = await ensureStartingBrowserSurfaceReady(browserSurfaceLeaseManager, current, allocator);
      current = readyResult.lease;
      if (current.status !== "starting_surface") {
        return readyResult;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const surface = findSurfaceForLease(current);
    return { lease: current, ...(surface ? { surface } : {}) };
  }

  async function ensureStartingBrowserSurfaceReady(
    leaseManager: BrowserSurfaceLeaseManager,
    lease: BrowserSurfaceLease,
    allocator: BrowserSurfaceAllocator
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface }> {
    const readyResult = await leaseManager.ensureStartingSurfaceReady({
      allocator,
      leaseId: lease.lease_id,
      ...readinessTimeoutOptions(),
    });
    await persistBrowserSurfaceLeaseMutation(readyResult.lease, readyResult.surface);
    return readyResult;
  }

  /**
   * Bounded retry/backoff around the allocator's stopSurface call for a
   * capacity-pressure reclaim. A single transient DELETE timeout must not
   * permanently strand the queued lease's only reclaim attempt (see the
   * 2026-07-10 capacity incident: one allocator timeout, no retry, no
   * cross-run trigger — the lease sat past its own expires_at unswept).
   * Emits run.browser_surface_reclaim_retry on each retry attempt (not on
   * the first try) so a retry is observable evidence distinct from a
   * terminal defer or a successful promotion.
   */
  async function announceReclaimRetry(lease: BrowserSurfaceLease): Promise<void> {
    await emitBrowserSurfaceLeaseEvent(
      "run.browser_surface_reclaim_retry",
      lease.connector_id,
      lease.run_id,
      createTraceContext(),
      lease
    );
    if (browserSurfaceReclaimRetryDelayMs > 0) {
      await sleep(browserSurfaceReclaimRetryDelayMs);
    }
  }

  /** One allocator stopSurface attempt. Returns the caught error message, or undefined on success. */
  async function attemptStopSurface(surface: BrowserSurface): Promise<string | undefined> {
    try {
      await replacementAwareAllocator?.stopSurface({
        reason: "capacity_pressure",
        surfaceId: surface.surface_id,
      });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    // biome-ignore lint/complexity/noUselessReturn: required by TypeScript noImplicitReturns to make the successful empty result explicit.
    return;
  }

  async function stopSurfaceRetryStep(
    surface: BrowserSurface,
    lease: BrowserSurfaceLease,
    attempt: number,
    attempts: number
  ): Promise<{ ok: boolean; lastMessage?: string }> {
    const errorMessage = await attemptStopSurface(surface);
    if (errorMessage === undefined) {
      return { ok: true };
    }
    if (attempt >= attempts) {
      return { lastMessage: errorMessage, ok: false };
    }
    await announceReclaimRetry(lease);
    return stopSurfaceRetryStep(surface, lease, attempt + 1, attempts);
  }

  async function stopSurfaceWithRetry(surface: BrowserSurface, lease: BrowserSurfaceLease): Promise<{ ok: boolean }> {
    if (!replacementAwareAllocator) {
      return { ok: false };
    }
    const attempts = Math.max(1, browserSurfaceReclaimRetryAttempts);
    const result = await stopSurfaceRetryStep(surface, lease, 1, attempts);
    if (!result.ok) {
      log.warn?.(
        `[controller] browser-surface capacity reclaim for ${lease.run_id} failed after ${attempts} attempt(s): ${result.lastMessage}`
      );
    }
    return { ok: result.ok };
  }

  async function persistCapacityPressureReclaim(
    lease: BrowserSurfaceLease,
    reclaimed: ReturnType<BrowserSurfaceLeaseManager["completeCapacityPressureReclaim"]>
  ): Promise<void> {
    if (reclaimed.stopped) {
      await persistBrowserSurfaceLeaseMutation(lease, reclaimed.stopped);
    }
    if (reclaimed.promoted) {
      await persistBrowserSurfaceLeaseMutation(reclaimed.promoted, findSurfaceForLease(reclaimed.promoted));
    }
  }

  function buildCapacityPressureReclaimResult(
    lease: BrowserSurfaceLease,
    reclaimed: ReturnType<BrowserSurfaceLeaseManager["completeCapacityPressureReclaim"]>
  ): { lease: BrowserSurfaceLease; surface?: BrowserSurface; reclaimed: boolean } {
    if (!reclaimed.promoted) {
      return { lease, reclaimed: Boolean(reclaimed.stopped) };
    }
    const surface = findSurfaceForLease(reclaimed.promoted);
    return {
      lease: reclaimed.promoted,
      ...(surface ? { surface } : {}),
      reclaimed: true,
    };
  }

  async function reclaimCapacityAndPromoteLease(
    lease: BrowserSurfaceLease
  ): Promise<{ lease: BrowserSurfaceLease; surface?: BrowserSurface; reclaimed: boolean }> {
    if (!(browserSurfaceLeaseManager && replacementAwareAllocator)) {
      return { lease, reclaimed: false };
    }
    const reclaimable = browserSurfaceLeaseManager.planCapacityPressureReclaim(lease.lease_id);
    if (!reclaimable) {
      return { lease, reclaimed: false };
    }
    const stopResult = await stopSurfaceWithRetry(reclaimable, lease);
    if (!stopResult.ok) {
      return { lease, reclaimed: false };
    }
    const reclaimed = browserSurfaceLeaseManager.completeCapacityPressureReclaim(reclaimable.surface_id);
    await persistCapacityPressureReclaim(lease, reclaimed);
    return buildCapacityPressureReclaimResult(lease, reclaimed);
  }

  async function promoteBrowserSurfaceLease(lease: BrowserSurfaceLease, reason: string): Promise<void> {
    const promotedOptions = pendingBrowserSurfaceLaunches.get(lease.run_id);
    pendingBrowserSurfaceLaunches.delete(lease.run_id);
    // Mirrors the inverse encoding in acquireInitialBrowserSurfaceLease
    // (surfaceSubjectId = connectorInstanceId === connectorId ? undefined : connectorInstanceId):
    // when the in-memory launch options were lost (e.g. a process restart),
    // reconstruct connectorInstanceId from the persisted lease's
    // surface_subject_id instead of letting it silently default to the
    // connector-wide connector_id.
    const connectorInstanceId = promotedOptions?.connectorInstanceId ?? lease.surface_subject_id ?? lease.connector_id;
    const ownerSubjectId =
      promotedOptions?.ownerSubjectId ?? (await resolveOwnerSubjectIdForConnectorInstance(connectorInstanceId));
    if (!ownerSubjectId) {
      throw new Error(`browser-surface promotion has no owner for admitted connection ${connectorInstanceId}`);
    }
    scheduleRun(
      lease.connector_id,
      {
        ...promotedOptions,
        connectorInstanceId,
        ownerSubjectId,
        priorityClass: lease.priority_class,
        runId: lease.run_id,
      },
      async (err) => handleBrowserSurfacePromotionFailure(lease, reason, err)
    );
  }

  async function emitAndPersistDeferredPromotionLease(
    deferredResult: ReturnType<BrowserSurfaceLeaseManager["deferLeasedRun"]> | undefined
  ): Promise<void> {
    if (!deferredResult?.lease) {
      return;
    }
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

  async function promoteLeaseDeferredAfterPromotionFailure(
    deferredResult: ReturnType<BrowserSurfaceLeaseManager["deferLeasedRun"]> | undefined,
    reason: string
  ): Promise<void> {
    if (!deferredResult?.promoted) {
      return;
    }
    await persistAndPromoteBrowserSurfaceLeases([deferredResult.promoted], `${reason} promotion failure`);
  }

  async function handleBrowserSurfacePromotionFailure(
    lease: BrowserSurfaceLease,
    reason: string,
    err: unknown
  ): Promise<void> {
    const deferredResult = browserSurfaceLeaseManager?.deferLeasedRun({
      fencingToken: lease.fencing_token,
      leaseId: lease.lease_id,
    });
    await emitAndPersistDeferredPromotionLease(deferredResult);
    await promoteLeaseDeferredAfterPromotionFailure(deferredResult, reason);
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[controller] browser-surface lease ${lease.lease_id} promotion failed after ${reason}: ${message}`);
  }

  async function persistAndPromoteBrowserSurfaceLeases(leases: BrowserSurfaceLease[], reason: string): Promise<void> {
    if (!browserSurfaceLeaseManager) {
      return;
    }
    for (const lease of leases) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await persistBrowserSurfaceLeaseMutation(
        lease,
        lease.surface_id ? browserSurfaceLeaseManager.getSurface(lease.surface_id) : undefined
      );
      await promoteBrowserSurfaceLease(lease, reason);
    }
  }

  async function releaseBrowserSurfaceLease(
    lease: BrowserSurfaceLease,
    connectorId: string,
    runId: string,
    traceContext: SpineTraceContext,
    reason: string
  ): Promise<void> {
    await windowSettleReconciliation.retireDeferredLease(lease);
    const releaseResult = browserSurfaceLeaseManager?.release({
      fencingToken: lease.fencing_token,
      leaseId: lease.lease_id,
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

  async function persistAllocatorSurfaceReconciliation(
    allocatorReconcile: AllocatorSurfaceReconciliation
  ): Promise<void> {
    if (!browserSurfaceLeaseStore) {
      return;
    }
    if (allocatorReconcile.evicted.length === 0 && allocatorReconcile.downgraded.length === 0) {
      return;
    }
    await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
      for (const surface of externalLossBoundaryRepresentatives(allocatorReconcile.evicted)) {
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve receipt and projection ordering.
        await replacementHooks.recordExternalSurfaceLoss(surface);
      }
      for (const surface of allocatorReconcile.evicted) {
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve receipt and projection ordering.
        await store.upsertSurface({ ...surface, health: "unhealthy" });
      }
      for (const surface of allocatorReconcile.downgraded) {
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        await store.upsertSurface(surface);
      }
    });
  }

  function isLiveExternalLossCandidate(surface: BrowserSurface): boolean {
    // Boot and periodic reconciliation must still evict every allocator-dead
    // row so historical capacity cannot be reused. Only a surface that was
    // ready immediately before that eviction is a fresh, observable host-loss
    // boundary. Re-emitting a receipt for already unhealthy or stopping
    // history would manufacture a pending successor and hide its prior
    // terminal evidence.
    return surface.health === "ready";
  }

  function externalLossBoundaryRepresentatives(surfaces: readonly BrowserSurface[]): BrowserSurface[] {
    // Allocator reconciliation can return duplicate persisted rows for one
    // connection/profile scope. Those rows describe one observed loss
    // boundary, not independent replacements. Electing the lexical first
    // surface ID makes that durable receipt identity stable across allocator
    // enumeration order while every evicted row is still persisted unhealthy.
    const elected = new Map<string, BrowserSurface>();
    for (const surface of surfaces) {
      if (!isLiveExternalLossCandidate(surface)) {
        continue;
      }
      const scope = JSON.stringify([
        surface.surface_subject_id ?? surface.connector_id,
        surface.surface_subject_id ?? null,
        surface.profile_key,
      ]);
      const current = elected.get(scope);
      if (!current || surface.surface_id.localeCompare(current.surface_id) < 0) {
        elected.set(scope, surface);
      }
    }
    return [...elected.values()].sort((left, right) => left.surface_id.localeCompare(right.surface_id));
  }

  async function reconcileBrowserSurfacesWithAllocatorAtBoot(): Promise<void> {
    // Before lease reconciliation, ask the allocator which dynamic surfaces
    // actually exist. A persistent surface row with health=ready from a prior
    // boot whose container has been removed must not survive into the new
    // boot's in-memory state, or the next acquire will lease a dead surface
    // and burn an owner OTP cycle.
    if (!(browserSurfaceLeaseManager && replacementAwareAllocator)) {
      return;
    }
    try {
      const allocatorReconcile =
        await browserSurfaceLeaseManager.reconcileSurfacesWithAllocator(replacementAwareAllocator);
      await persistAllocatorSurfaceReconciliation(allocatorReconcile);
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
      browser_surface: surfaceOverride ?? projectBrowserSurfaceLease(lease),
      run_id: ctx.runId,
      status,
      trace_id: ctx.traceContext.trace_id,
      ...ctx.automationMetadata,
    };
  }

  async function tryPromoteReclaimedWaitingLease(
    ctx: ManagedSurfaceContext,
    reclaimedResult: { lease: BrowserSurfaceLease; surface?: BrowserSurface },
    options: { readonly allowStartFailureRetry: boolean }
  ): Promise<ManagedSurfaceAcquireResult | null> {
    if (!browserSurfaceLeaseManager) {
      return null;
    }
    const { connectorId, runId, traceContext } = ctx;
    if (reclaimedResult.lease.status === "starting_surface") {
      return await handleStartingSurfaceWaitForRun(ctx, reclaimedResult.lease, options);
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
        env: browserSurfaceLeaseEnv(reclaimedResult.lease, reclaimedResult.surface),
        kind: "ready",
        lease: reclaimedResult.lease,
      };
    }
    return { env: null, kind: "ready", lease: reclaimedResult.lease };
  }

  async function handleStartingSurfaceWaitForRun(
    ctx: ManagedSurfaceContext,
    startingLease: BrowserSurfaceLease,
    options: { readonly allowStartFailureRetry: boolean }
  ): Promise<ManagedSurfaceAcquireResult> {
    if (!browserSurfaceLeaseManager) {
      return { env: null, kind: "ready", lease: startingLease };
    }
    const { connectorId, runId, traceContext } = ctx;
    const readyResult = await waitForStartingBrowserSurface(startingLease, connectorId, runId, traceContext);
    if (readyResult.lease.status === "surface_failed") {
      pendingBrowserSurfaceLaunches.delete(runId);
      // The allocator's ensureSurface/getSurfaceStatus call threw (Docker
      // daemon hiccup, transient allocator timeout, etc) and remote-surface's
      // lease manager collapses that into a bare surface_failed/
      // surface_start_failed terminal lease with no error detail attached —
      // see the 2026-07-31 USAA incident (alternating fail/succeed/fail
      // across otherwise-identical acquires against the same profile_key,
      // each against a freshly allocator-minted surface_id). A fresh acquire
      // for the same profile always gets a brand-new surface_id
      // (#resolveNewLease never reuses a non-ready surface), so retrying once
      // cannot loop against the same dead container. Bounded to one retry,
      // and only for a dynamic allocator-backed surface — a static/operator-
      // owned surface has no allocator to retry against.
      //
      // The retry decision MUST be resolved before emitting any terminal
      // event: run.browser_surface_failed is in RUN_TERMINAL_EVENT_TYPES
      // (lib/spine.ts) and latches run_history's status='running' finalize
      // (run-history-writer.ts) — emitting it on an attempt that then
      // recovers would durably record a succeeded, record-producing run as a
      // zero-record failure. run.browser_surface_retried is deliberately a
      // non-terminal sibling (absent from every terminal allowlist) so the
      // dead surface_id stays observable without poisoning run_history.
      if (options.allowStartFailureRetry && shouldRetryReadinessFailure()) {
        // remote-surface's ensureStartingSurfaceReady abandons the surface
        // row in place on a terminal surface_failed (its own bare `catch {}`
        // never calls stopSurface) — it only stops tracking the surface in
        // its own accounting, it does not stop the underlying container. The
        // fresh acquire below always mints a brand-new surface_id against a
        // brand-new container, so without an explicit stop here, each failed
        // attempt leaves its container running: N failed attempts strand N
        // containers, silently exceeding PDPP_NEKO_SURFACE_CAP (see the
        // 2026-07-31 Amazon canary incident, where two consecutive
        // surface_failed attempts left both containers running — both went
        // Docker-healthy minutes later, well inside the readiness budget,
        // proving they were never actually dead). Reuse the same
        // invalidate+stop path probe failures already use so the abandoned
        // container is reclaimed before the retry mints a replacement.
        await invalidateBrowserSurfaceAfterProbeFailure(readyResult.lease, "surface_start_failed");
        await emitBrowserSurfaceLeaseEvent(
          "run.browser_surface_retried",
          connectorId,
          runId,
          traceContext,
          readyResult.lease
        );
        return await acquireManagedBrowserSurfaceAttempt(ctx, startingLease.priority_class, {
          allowReadinessRetry: false,
        });
      }
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
        env: browserSurfaceLeaseEnv(readyResult.lease, readySurface),
        kind: "ready",
        lease: readyResult.lease,
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
      return { env: null, kind: "ready", lease: leasedLease };
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
    return { env: browserSurfaceLeaseEnv(leasedLease, leasedSurface), kind: "ready", lease: leasedLease };
  }

  async function dispatchCurrentLeaseState(
    ctx: ManagedSurfaceContext,
    currentLease: BrowserSurfaceLease | null,
    leaseResult: { lease: BrowserSurfaceLease },
    envFromReclaim: Record<string, string> | null,
    options: { readonly allowStartFailureRetry: boolean }
  ): Promise<ManagedSurfaceAcquireResult> {
    if (envFromReclaim) {
      // Capacity-pressure reclaim may have already promoted and readied this lease.
      return { env: envFromReclaim, kind: "ready", lease: currentLease };
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
      return await handleStartingSurfaceWaitForRun(ctx, currentLease, options);
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
      profileKey,
      runId,
      ...(surfaceSubjectId ? { surfaceSubjectId } : {}),
      priorityClass,
      retainSurfaceProcess: connectorRetainsSurfaceProcess(connectorId),
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
    initialLease: BrowserSurfaceLease,
    options: { readonly allowStartFailureRetry: boolean }
  ): Promise<ReclaimResolution> {
    if (initialLease.status !== "waiting_for_browser_surface") {
      return { env: null, lease: initialLease };
    }
    const reclaimedResult = await reclaimCapacityAndPromoteLease(initialLease);
    const reclaimed = reclaimedResult.lease;
    if (reclaimed.run_id !== ctx.runId || reclaimed.status === "waiting_for_browser_surface") {
      return { env: null, lease: initialLease };
    }
    const promoted = await tryPromoteReclaimedWaitingLease(ctx, reclaimedResult, options);
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
      ...(options.ownerSubjectId ? { ownerSubjectId: options.ownerSubjectId } : {}),
      ...(options.rsUrl ? { rsUrl: options.rsUrl } : {}),
    });
  }

  function shouldRetryReadinessFailure(): boolean {
    return Boolean(replacementAwareAllocator && browserSurfaceLeaseManager?.config.surfaceMode === "dynamic");
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
    const reclaim = await reclaimWaitingLeaseIfNeeded(ctx, leaseResult.lease, {
      allowStartFailureRetry: options.allowReadinessRetry,
    });
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

    const dispatchResult = await dispatchCurrentLeaseState(ctx, refreshedLease, leaseResult, reclaim.env, {
      allowStartFailureRetry: options.allowReadinessRetry,
    });
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
    connectorInstanceIdByRunId.set(ctx.runId, ctx.connectorInstanceId);
    if (!browserSurfaceLeaseManager) {
      return { env: null, kind: "ready", lease: null };
    }
    await expireBrowserSurfaceWaitsWithoutPromotion();
    const priorityClass = ctx.options.priorityClass ?? "interactive";
    return await acquireManagedBrowserSurfaceAttempt(ctx, priorityClass, { allowReadinessRetry: true });
  }

  function grantFromPhaseLease(
    lease: BrowserSurfaceLease,
    env: Record<string, string> | null
  ): PhaseSurfaceAcquireResult {
    // The reused acquisition path already proved `lease` is "leased" with a
    // live surface whenever it hands back a non-null `env` (see
    // handleStartingSurfaceWaitForRun / handleLeasedSurfaceForRun) — env is
    // built from browserSurfaceLeaseEnv(lease, surface), so both keys below
    // are always present on a granted lease. The runtime check exists only
    // to satisfy noUncheckedIndexedAccess without a non-null assertion.
    const remoteCdpUrl = env?.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL;
    const streamBaseUrl = env?.PDPP_BROWSER_SURFACE_STREAM_BASE_URL;
    if (!(remoteCdpUrl && streamBaseUrl && lease.surface_id)) {
      return { kind: "unavailable", reason: "surface_failed" };
    }
    return {
      kind: "granted",
      leaseId: lease.lease_id,
      profileKey: lease.profile_key,
      remoteCdpUrl,
      streamBaseUrl,
      surfaceId: lease.surface_id,
    };
  }

  // Maps the reused run-acquisition path's early-return statuses onto the
  // phase contract's typed unavailable reasons. `deferred` / `cancelled` /
  // an absent lease all collapse to the closest phase-shaped reason: the
  // phase request never queues (see the `waiting_for_browser_surface` guard
  // in acquireManagedBrowserSurfaceForPhase below, which intercepts capacity
  // pressure before it reaches this early-return path), so anything else
  // reaching here is the acquisition path independently deciding it cannot
  // serve this request right now.
  function phaseUnavailableReasonForEarlyReturn(result: RunNowResult): PhaseSurfaceAcquireUnavailableReason {
    if (result.status === "surface_failed") {
      return "surface_failed";
    }
    return "capacity_full";
  }

  // Idempotent-acquire arm: a connector that asks twice for the same phase
  // (e.g. a retried request after a lost response) gets back the SAME grant
  // rather than a second lease. Returns null when there is nothing reusable,
  // having first dropped the stale ownership record so the caller can acquire
  // fresh.
  function reusablePhaseGrant(runId: string): PhaseSurfaceAcquireResult | null {
    const existing = phaseLeasesByRunId.get(runId);
    if (!existing) {
      return null;
    }
    const lease = browserSurfaceLeaseManager?.getLease(existing.leaseId);
    const surface =
      lease?.status === "leased" && lease.surface_id ? browserSurfaceLeaseManager?.getSurface(lease.surface_id) : null;
    if (lease && surface) {
      return grantFromPhaseLease(lease, browserSurfaceLeaseEnv(lease, surface));
    }
    phaseLeasesByRunId.delete(runId);
    return null;
  }

  // Single bounded-lifecycle rule for the derived session id's identity
  // cache entry, shared by both acquire and release: insert it up front,
  // run `body`, then evict it in a `finally` UNLESS `body` reports the
  // identity must outlive this call (a granted acquisition, whose eventual
  // release is the only other reader). Every early-return/failure branch of
  // acquisition and every branch of release — including "no lease found" —
  // falls through this same `finally`, so a future branch added to either
  // function cannot silently reintroduce the leak: it would have to
  // deliberately opt out via `keepAfterReturn`.
  //
  // Ownership-token guarded: two invocations can legitimately overlap for
  // the SAME sessionId (a release racing a reacquire for the same run, or
  // two overlapping failed acquires). Each invocation mints its own token
  // and installs it as the current owner in
  // phaseSessionIdentityOwnerBySessionId. The `finally` only deletes the
  // shared connectorInstanceIdByRunId entry (and its own ownership record)
  // if that map still names THIS invocation's token as current owner —
  // otherwise a newer, still-live invocation already overwrote both maps
  // with its own identity/token, and this (older, now-finishing) invocation
  // must leave that newer state completely untouched.
  async function withPhaseSessionIdentity<T>(
    sessionId: string,
    connectorInstanceId: string,
    body: () => Promise<{ result: T; keepAfterReturn: boolean }>
  ): Promise<T> {
    const ownershipToken = Symbol("phaseSessionIdentityOwner");
    connectorInstanceIdByRunId.set(sessionId, connectorInstanceId);
    phaseSessionIdentityOwnerBySessionId.set(sessionId, ownershipToken);
    let keepAfterReturn = false;
    try {
      const { keepAfterReturn: shouldKeep, result } = await body();
      keepAfterReturn = shouldKeep;
      return result;
    } finally {
      if (!keepAfterReturn && phaseSessionIdentityOwnerBySessionId.get(sessionId) === ownershipToken) {
        connectorInstanceIdByRunId.delete(sessionId);
        phaseSessionIdentityOwnerBySessionId.delete(sessionId);
      }
    }
  }

  async function acquireManagedBrowserSurfaceForPhase(
    input: PhaseSurfaceAcquireInput
  ): Promise<PhaseSurfaceAcquireResult> {
    const { connectorId, connectorInstanceId, runId, traceContext } = input;
    if (!browserSurfaceLeaseManager?.isManagedConnector(connectorId)) {
      return { kind: "unavailable", reason: "not_managed" };
    }
    const reused = reusablePhaseGrant(runId);
    if (reused) {
      return reused;
    }

    const sessionId = browserSurfacePhaseSessionId(runId);
    return await withPhaseSessionIdentity(sessionId, connectorInstanceId, async () => {
      await expireBrowserSurfaceWaitsWithoutPromotion();
      const phaseCtx: ManagedSurfaceContext = {
        automationMetadata: {},
        connectorId,
        connectorInstanceId,
        manifest: {},
        // Phase leases take an ordinary transient slot — retainSurfaceProcess
        // is never set for a phase acquire (contract fact 2: the phase
        // primitive is a lifecycle wrapper, not new capacity math).
        options: {},
        runId: sessionId,
        traceContext,
      };
      const attempt = await acquireManagedBrowserSurfaceAttempt(phaseCtx, "interactive", { allowReadinessRetry: true });
      if (attempt.kind === "early_return") {
        if (attempt.result.status === "waiting_for_browser_surface") {
          // Never block the run waiting for capacity. Cancel the just-queued
          // wait immediately rather than leaving a phantom waiter behind for
          // this session id.
          await cancelBrowserSurfaceRun(sessionId);
          return { keepAfterReturn: false, result: { kind: "unavailable", reason: "capacity_full" } };
        }
        return {
          keepAfterReturn: false,
          result: { kind: "unavailable", reason: phaseUnavailableReasonForEarlyReturn(attempt.result) },
        };
      }
      if (!(attempt.lease && attempt.env)) {
        return { keepAfterReturn: false, result: { kind: "unavailable", reason: "surface_failed" } };
      }
      // Granted: the identity must outlive this call for the eventual
      // release to resolve run.browser_surface_released against it. Persist
      // connectorInstanceId (not just connectorId) — they can legitimately
      // differ, and release must resolve the SAME identity this acquisition
      // was granted under, not the connector type.
      phaseLeasesByRunId.set(runId, {
        connectorId,
        connectorInstanceId,
        fencingToken: attempt.lease.fencing_token,
        leaseId: attempt.lease.lease_id,
      });
      return { keepAfterReturn: true, result: grantFromPhaseLease(attempt.lease, attempt.env) };
    });
  }

  async function releaseManagedBrowserSurfaceForPhase(runId: string): Promise<void> {
    const entry = phaseLeasesByRunId.get(runId);
    if (!entry) {
      return;
    }
    // Delete FIRST so a concurrent or duplicate release call (e.g. the
    // connector's own release racing the run-cleanup backstop) sees no
    // entry and no-ops, rather than both racing the same fenced release.
    phaseLeasesByRunId.delete(runId);
    const sessionId = browserSurfacePhaseSessionId(runId);
    await withPhaseSessionIdentity(sessionId, entry.connectorInstanceId, async () => {
      const lease = browserSurfaceLeaseManager?.getLease(entry.leaseId);
      if (!lease) {
        return { keepAfterReturn: false, result: undefined };
      }
      // Release using the RECORDED fencing token, not the live lease's current
      // one: if this lease has since been reassigned to a new generation, a
      // release carrying the old token is rejected as stale by the lease
      // manager instead of freeing someone else's active grant.
      const leaseAtGrant: BrowserSurfaceLease = { ...lease, fencing_token: entry.fencingToken };
      try {
        await releaseBrowserSurfaceLease(
          leaseAtGrant,
          entry.connectorId,
          sessionId,
          createTraceContext(),
          `${sessionId} phase release`
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[controller] failed to release phase browser-surface lease for ${runId}: ${message}`);
      }
      // A phase has a bounded end: once release (successful or not) has run,
      // this is the LAST reader of the session identity, so it does not
      // outlive this call — unlike the run-level path, which keeps its
      // connector-instance record for the run's whole remaining lifetime.
      return { keepAfterReturn: false, result: undefined };
    });
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
    if (!(browserSurfaceLeaseManager && replacementAwareAllocator)) {
      return [];
    }
    const cleanupResult = await browserSurfaceLeaseManager.cleanupIdleSurfaces(replacementAwareAllocator);
    if (browserSurfaceLeaseStore && cleanupResult.stopped.length > 0) {
      await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
        for (const surface of cleanupResult.stopped) {
          // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
          await store.upsertSurface(surface);
        }
      });
    }
    await persistAndPromoteBrowserSurfaceLeases(cleanupResult.promoted, "browser-surface idle cleanup");
    return cleanupResult.promoted.map((lease) => projectBrowserSurfaceLease(lease));
  }

  /**
   * Retire a durable browser_surfaces row that is health="unhealthy", has no
   * active lease, and has aged past idleTtlMs since last_used_at — even
   * though the row is no longer (or never was) present in the lease
   * manager's in-memory map. This is the fix for the 2026-07-31 orphan-
   * capacity incident: reconcileSurfacesWithAllocator's own eviction branch
   * (`live.health === "unhealthy"` -> invalidateSurface) removes a wedged
   * surface from `#surfaces` and persists it "unhealthy", but
   * invalidateSurface never calls allocator.stopSurface — and
   * cleanupIdleSurfaces only ever considers surfaces still present in
   * `#surfaces` at health "ready". Once a surface reaches persisted
   * "unhealthy" with no lease, no other code path in this file or in
   * @opendatalabs/remote-surface ever calls stopSurface for it, so its
   * allocator container (and the host port/capacity slot it holds) leaks
   * forever. This reads the durable store directly — not the manager's
   * `#surfaces` map — because the whole point is to catch rows the manager
   * has already forgotten about.
   */
  async function retireOrphanedUnhealthyBrowserSurfaces(): Promise<void> {
    if (!(browserSurfaceLeaseStore && replacementAwareAllocator && browserSurfaceLeaseManager)) {
      return;
    }
    const { idleTtlMs, surfaceMode } = browserSurfaceLeaseManager.config;
    if (surfaceMode !== "dynamic") {
      return;
    }
    const now = nowMs();
    const persistedSurfaces = await browserSurfaceLeaseStore.listSurfaces();
    const orphans = persistedSurfaces
      .filter(
        (surface) =>
          surface.backend === "neko" &&
          surface.health === "unhealthy" &&
          !surface.active_lease_id &&
          !surface.retained &&
          now - Date.parse(surface.last_used_at) >= idleTtlMs
      )
      // Deterministic, stable ordering (oldest-stale first, surface_id as a
      // tiebreaker) so a fleet with more orphans than one tick's budget
      // makes visible forward progress across ticks instead of the same
      // prefix winning a race against store ordering every time, and so the
      // most-overdue rows are retired first.
      .sort(
        (left, right) =>
          Date.parse(left.last_used_at) - Date.parse(right.last_used_at) ||
          left.surface_id.localeCompare(right.surface_id)
      )
      .slice(0, MAX_ORPHAN_SURFACE_RETIREMENTS_PER_SWEEP);
    for (const orphan of orphans) {
      // One orphan's allocator failure must not block the rest of this
      // tick's bounded batch — retireOrphanedUnhealthyBrowserSurface already
      // catches and logs per-item, leaving a failed row untouched (still
      // "unhealthy", still eligible) so it is naturally retried on the next
      // tick without any separate retry bookkeeping.
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await retireOrphanedUnhealthyBrowserSurface(orphan);
    }
  }

  async function retireOrphanedUnhealthyBrowserSurface(orphan: BrowserSurface): Promise<void> {
    if (!(browserSurfaceLeaseStore && replacementAwareAllocator && browserSurfaceLeaseManager)) {
      return;
    }
    // The manager may still independently track this surface_id (e.g. this
    // exact tick's own reconcileSurfacesWithAllocator pass has not yet run,
    // or the row predates this manager instance's boot). Only ever act when
    // the manager agrees no non-terminal lease owns it — never race a live
    // starting_surface/leased ownership, matching cleanupIdleSurfaces' own
    // active_lease_id guard plus the equivalent check for a not-yet-leased
    // starting_surface.
    const trackedSurface = browserSurfaceLeaseManager.getSurface(orphan.surface_id);
    if (trackedSurface?.active_lease_id) {
      return;
    }
    const ownsNonTerminalLease = browserSurfaceLeaseManager
      .listLeases()
      .some(
        (lease) =>
          lease.surface_id === orphan.surface_id && (lease.status === "starting_surface" || lease.status === "leased")
      );
    if (ownsNonTerminalLease) {
      return;
    }
    try {
      const stopped = await replacementAwareAllocator.stopSurface({
        reason: "reconcile",
        surfaceId: orphan.surface_id,
      });
      await browserSurfaceLeaseStore.withLeaseTransaction(async (store) => {
        await store.upsertSurface({
          ...(stopped ?? orphan),
          backend: "neko",
          connector_id: orphan.connector_id,
          health: "stopping",
          profile_key: orphan.profile_key,
          surface_id: orphan.surface_id,
        });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] orphan surface retirement stopSurface(${orphan.surface_id}) failed: ${message}`);
    }
  }

  async function expireBrowserSurfaceWaitsWithoutPromotion(): Promise<BrowserSurfaceLease[]> {
    if (!browserSurfaceLeaseManager) {
      return [];
    }
    const deferred = browserSurfaceLeaseManager.expireWaitingLeases();
    for (const lease of deferred) {
      pendingBrowserSurfaceLaunches.delete(lease.run_id);
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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

  /**
   * Independent periodic sweep. Composes four already-correct operations
   * that previously only ran boot-once (allocator reconcile), on-demand via
   * an explicit controller call with no periodic caller (idle cleanup — see
   * the 2026-07-31 stale-capacity incident below), or as a lazy side effect
   * of an unrelated run's acquire (expiry) — see the 2026-07-10 capacity
   * incident: a queued lease sat 5+ minutes past its own expires_at because
   * nothing revisited it on a wall clock, and a stale ready surface over an
   * exited container kept inflating the capacity count between restarts.
   * This function is the sole periodic caller of all four; reentrancy-guarded
   * so an overlapping tick is a no-op, and it never touches an active leased
   * run (none of the composed operations mutate a leased lease unless the
   * allocator itself reports the surface gone/unhealthy).
   *
   * Idle cleanup runs FIRST, before expiry/reclaim: it is the cheapest and
   * most direct way to free a poisoned capacity slot (stop-and-promote, no
   * allocator stopSurface retry budget, no reclaim-compatibility check), so
   * running it first means expiry/reclaim only have to work on whatever
   * idle cleanup could not already resolve. `cleanupIdleBrowserSurfaces`
   * itself calls `persistAndPromoteBrowserSurfaceLeases`, which deletes each
   * promoted lease's `run_id` from `pendingBrowserSurfaceLaunches` as part of
   * promotion — so a lease this pass promotes is no longer
   * `waiting_for_browser_surface` by the time `expireBrowserSurfaceWaits`/
   * `sweepReclaimStillQueuedLeases` run later in the same tick, and cannot be
   * promoted a second time.
   *
   * 2026-07-31 stale-capacity incident: the upstream remote-surface fix
   * (widening `cleanupIdleSurfaces` past health "ready" so a surface stuck
   * below "ready" with no active lease is reapable — see
   * @opendatalabs/remote-surface commits 020f6a0/5705fba) was correct but
   * inert in production: `cleanupIdleBrowserSurfaces` was only ever exposed
   * on the Controller interface for on-demand/manual invocation and had NO
   * periodic caller anywhere in this codebase, so the widened reap logic was
   * unreachable on the periodic path and two >35-minute-old terminal Amazon
   * surfaces stayed live and capacity-counted after deploy. Composing it
   * into this sweep is the fix.
   */
  /** Re-attempt capacity-pressure reclaim for one still-queued lease during a sweep tick. No-op if it settled since the queued snapshot was taken. */
  async function sweepReclaimStillQueuedLease(
    leaseManager: BrowserSurfaceLeaseManager,
    leaseId: string
  ): Promise<void> {
    const current = leaseManager.getLease(leaseId);
    if (current?.status !== "waiting_for_browser_surface") {
      return;
    }
    const reclaimedResult = await reclaimCapacityAndPromoteLease(current);
    if (!reclaimedResult.reclaimed) {
      return;
    }
    await persistBrowserSurfaceLeaseMutation(reclaimedResult.lease, reclaimedResult.surface);
    if (reclaimedResult.lease.status !== "waiting_for_browser_surface") {
      await promoteBrowserSurfaceLease(reclaimedResult.lease, "browser-surface periodic sweep");
    }
  }

  async function sweepReclaimStillQueuedLeases(leaseManager: BrowserSurfaceLeaseManager): Promise<void> {
    const stillQueuedIds = leaseManager
      .listLeases()
      .filter((lease) => lease.status === "waiting_for_browser_surface" && lease.wait_reason === "capacity_full")
      .map((lease) => lease.lease_id);
    for (const leaseId of stillQueuedIds) {
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      await sweepReclaimStillQueuedLease(leaseManager, leaseId);
    }
  }

  async function sweepBrowserSurfaceLeases(): Promise<void> {
    if (!browserSurfaceLeaseManager || browserSurfaceSweepInFlight) {
      return;
    }
    browserSurfaceSweepInFlight = true;
    try {
      await reconcileBrowserSurfacesWithAllocatorAtBoot();
      await cleanupIdleBrowserSurfaces();
      await retireOrphanedUnhealthyBrowserSurfaces();
      await expireBrowserSurfaceWaits();
      await sweepReclaimStillQueuedLeases(browserSurfaceLeaseManager);
    } finally {
      browserSurfaceSweepInFlight = false;
    }
  }

  async function reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void> {
    await startupControllerRunReconciliation;
    if (!browserSurfaceLeaseManager) {
      return;
    }
    await reconcileBrowserSurfacesWithAllocatorAtBoot();
    const activeRows = await listPersistedActiveRuns();
    // A phase lease is keyed by a derived session id
    // (browserSurfacePhaseSessionId), never a real persisted run_id, so it
    // must be treated as active whenever its parent run is active. Without
    // this, reconcileAfterRestart (surface-lease-manager.js:553-560) treats
    // the phase lease's session id as absent from activeRunIds and silently
    // releases a surface a phase is still using (AM-1).
    const activeRunIds = new Set(activeRows.flatMap((row) => [row.run_id, browserSurfacePhaseSessionId(row.run_id)]));
    const reconciled = browserSurfaceLeaseManager.reconcileAfterRestart({ activeRunIds, promoteQueued: false });
    await emitAndPersistReconciledLeases(reconciled.released, "run.browser_surface_released", { hydrateSurface: true });
    await emitAndPersistReconciledLeases(reconciled.expired, "run.browser_surface_expired", { hydrateSurface: false });
    await emitAndPersistReconciledLeases(reconciled.deferred, "run.browser_surface_deferred", {
      hydrateSurface: false,
    });
    await emitAndPersistReconciledLeases(reconciled.surfaceFailed, "run.browser_surface_failed", {
      hydrateSurface: true,
    });
    await windowSettleReconciliation.reconcileAtBoot(activeRunIds);
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

  function isBrowserSurfaceInteraction(interaction: RuntimeInteraction): boolean {
    return interaction.kind === "manual_action" || interaction.kind === "otp";
  }

  function findLeasedSurfaceForInteraction(
    leaseManager: BrowserSurfaceLeaseManager,
    runId: string
  ): { readonly lease: BrowserSurfaceLease; readonly surface: BrowserSurface } | null {
    const lease = leaseManager
      .listLeases()
      .find((candidate: BrowserSurfaceLease) => candidate.run_id === runId && candidate.status === "leased");
    if (!lease?.surface_id) {
      return null;
    }
    const surface = leaseManager.getSurface(lease.surface_id);
    return surface ? { lease, surface } : null;
  }

  function midWaitSurfaceLossDetectorOptions(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface,
    connectorId: string,
    runId: string
  ): {
    readonly onProbeResult: (result: BrowserSurfaceReadinessProbeResult) => Promise<void>;
    readonly pollIntervalMs?: number;
  } {
    if (browserSurfaceMidWaitPollIntervalMs === undefined) {
      return {
        onProbeResult: (result) => replacementHooks.recordBrowserGeneration(lease, surface, connectorId, runId, result),
      };
    }
    return {
      onProbeResult: (result) => replacementHooks.recordBrowserGeneration(lease, surface, connectorId, runId, result),
      pollIntervalMs: browserSurfaceMidWaitPollIntervalMs,
    };
  }

  function cancelPendingSurfaceInteraction(runId: string, interaction: RuntimeInteraction): InteractionResponse {
    const currentEntry = activeRunInteractions.get(runId);
    const cancelledResponse: InteractionResponse = {
      request_id: interaction.request_id,
      status: "cancelled",
      type: "INTERACTION_RESPONSE",
    };
    if (currentEntry?.pending?.interaction_id === interaction.request_id) {
      // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
      const pending = currentEntry.pending;
      currentEntry.pending = null;
      pending.resolve(cancelledResponse);
    }
    return cancelledResponse;
  }

  function handleBrowserSurfaceLossDuringInteraction(
    failure: Extract<BrowserSurfaceReadinessProbeResult, { ok: false }>,
    runId: string,
    connectorId: string,
    traceContext: SpineTraceContext,
    interaction: RuntimeInteraction
  ): InteractionResponse {
    // Clear the pending interaction entry BEFORE resolving so any in-flight
    // respondToInteraction call gets no_pending_interaction.
    const cancelledResponse = cancelPendingSurfaceInteraction(runId, interaction);

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
  }

  function monitorBrowserSurfaceInteraction(
    lease: BrowserSurfaceLease,
    surface: BrowserSurface,
    probe: BrowserSurfaceReadinessProbe,
    runId: string,
    connectorId: string,
    traceContext: SpineTraceContext,
    interaction: RuntimeInteraction,
    handler: (interaction: unknown) => Promise<unknown>,
    rawInteraction: unknown
  ): Promise<unknown> {
    const detector = createMidWaitSurfaceLossDetector(
      surface,
      probe,
      midWaitSurfaceLossDetectorOptions(lease, surface, connectorId, runId)
    );
    const responsePromise = Promise.resolve(handler(rawInteraction)).finally(() => {
      detector.cancel();
    });
    const lostResponse = detector.lossPromise.then((failure) =>
      handleBrowserSurfaceLossDuringInteraction(failure, runId, connectorId, traceContext, interaction)
    );
    return Promise.race([responsePromise, lostResponse]);
  }

  function wrapInteractionHandlerWithSurfaceLossDetection(
    runId: string,
    connectorId: string,
    traceContext: SpineTraceContext,
    handler: (interaction: unknown) => Promise<unknown>
  ): (interaction: unknown) => Promise<unknown> {
    const readinessProbe = browserSurfaceReadinessProbe;
    const leaseManager = browserSurfaceLeaseManager;
    if (!(readinessProbe && leaseManager)) {
      return handler;
    }
    return (rawInteraction: unknown) => {
      const interaction = rawInteraction as RuntimeInteraction;

      // Only monitor interactions where the browser surface is part of the
      // response path. Non-browser otp/credentials interactions fall through
      // below because they have no leased surface for this run.
      if (!isBrowserSurfaceInteraction(interaction)) {
        return handler(rawInteraction);
      }

      const leasedSurface = findLeasedSurfaceForInteraction(leaseManager, runId);
      if (!leasedSurface) {
        return handler(rawInteraction);
      }
      return monitorBrowserSurfaceInteraction(
        leasedSurface.lease,
        leasedSurface.surface,
        readinessProbe,
        runId,
        connectorId,
        traceContext,
        interaction,
        handler,
        rawInteraction
      );
    };
  }

  return {
    acquireManagedBrowserSurfaceForPhase,
    acquireManagedBrowserSurfaceForRun,
    cancelBrowserSurfaceRun,
    cleanupIdleBrowserSurfaces,
    emitLeaseEvent: emitBrowserSurfaceLeaseEvent,
    expireBrowserSurfaceWaits,
    promoteBrowserSurfaceLeasesAfterBoot,
    reconcileBrowserSurfaceLeasesAfterBoot,
    recycleAttachExhaustedManagedSurfaceAfterRun,
    releaseLease,
    releaseManagedBrowserSurfaceForPhase,
    sweepBrowserSurfaceLeases,
    wrapInteractionHandlerWithSurfaceLossDetection,
  };
}
