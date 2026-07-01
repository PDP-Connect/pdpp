// Runtime controller service.
//
// Owns long-lived local operator actions against the reference runtime:
//   - persisted one-per-connector schedule config (`connector_schedules` table)
//   - projections for `/_ref/schedules` reads
//   - manual `runNow(connectorId)` with per-connector active-run tracking
//     (surfaces as `POST /_ref/connectors/:connectorId/run`, including the
//     `409 run_already_active` conflict response)
//
// Full runtime orchestration (job lifecycle, connector spawn, record
// ingest, state persistence, retries) still lives in
// `runtime/index.js` / `runtime/scheduler.ts`. The controller wraps, rather
// than replaces, those concerns. Approvals and the connector inventory
// come from `server/auth.js` directly; the controller does not re-export
// them.

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserSurfaceAllocator,
  type BrowserSurfaceLease,
  type BrowserSurfaceLeaseManager,
  type BrowserSurfaceProjection,
  projectBrowserSurfaceLease,
} from "@opendatalabs/remote-surface/leases";
import { getOne, referenceQueries } from "../lib/db.ts";
import { createTraceContext, emitSpineEvent, getRunTerminalStatus, type SpineTraceContext } from "../lib/spine.ts";
import {
  approveOwnerDeviceAuthorization,
  getConnectorManifest,
  initiateOwnerDeviceAuthorization,
} from "../server/auth.js";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "../server/connector-key.js";
import { isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.js";
import { getSyncState } from "../server/records.js";
import type { BrowserSurfaceLeaseStore } from "../server/stores/browser-surface-lease-store.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.js";
import {
  type ActiveRunRecord,
  getDefaultSchedulerStore,
  type ScheduleRecord,
  type SchedulerLastRunTimeRecord,
  type SchedulerRunHistoryRecord,
  type SchedulerStore,
} from "../server/stores/scheduler-store.ts";
import { createBrowserSurfaceManager, type BrowserSurfaceReadinessProbe } from "./browser-surface/index.ts";
import { runConnector } from "./index.js";
import type { RequiredAction } from "./rendered-verdict.ts";
import {
  automaticIneligibilityReason,
  automationModeCopy,
  projectRunAutomationPolicy,
  type RunAutomationMode,
  type RunTriggerKind,
} from "./run-automation-policy.ts";
import { type SatisfactionEvidenceBag, satisfiedOwnerActions } from "./satisfaction-watcher.ts";
import type { RunRecord } from "./scheduler.ts";
import { type BackoffDecision, computeNextRunWithBackoff } from "./scheduler-backoff.ts";
import {
  computeConnectionSourcePressureCooldown,
  isSourcePressureCooldownDeferring,
  type PendingPressureGap,
  SOURCE_PRESSURE_GAP_REASONS,
  type SourcePressureCooldownDecision,
} from "./scheduler-source-pressure-cooldown.ts";

// ─── Path constants ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const REFERENCE_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, "manifests");
const SEED_CONNECTOR_PATH = join(REFERENCE_IMPL_DIR, "connectors", "seed", "index.js");
const POLYFILL_ROOT = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors");
const POLYFILL_MANIFESTS_DIR = join(POLYFILL_ROOT, "manifests");
const POLYFILL_CONNECTORS_DIR = join(POLYFILL_ROOT, "connectors");

// Hoisted so the regex compiles once per process, not once per manifest.
const JSON_EXTENSION_RE = /\.json$/;

// ─── Shared domain types ────────────────────────────────────────────────────

export type ConnectorManifest = Record<string, unknown>;

export interface ConnectorSchedulePatch {
  enabled?: boolean;
  interval_seconds: number;
  jitter_seconds?: number;
}

export interface ScheduleUpsertResult {
  readonly policy_warning: string | null;
  readonly schedule: ScheduleApi;
}

export interface ValidatedSchedulePatch {
  readonly enabled: boolean;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
}

// Domain record shapes are owned by the scheduler store; re-aliased here
// so the controller stays semantic ("a schedule", "a persisted active run")
// rather than touching SQLite-flavored row shapes directly.
type Schedule = ScheduleRecord;
type PersistedActiveRun = ActiveRunRecord;

interface TerminalRunRow {
  readonly present: 1;
}

export interface RuntimeProjection {
  readonly active_run_id: string | null;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: BrowserSurfaceProjection["browser_surface_status"];
  readonly browser_surface_wait_reason?: BrowserSurfaceProjection["browser_surface_wait_reason"];
  readonly human_attention_needed: boolean;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly last_successful_at: string | null;
  readonly pending_run_id?: string;
}

export interface SchedulerBackoffApi {
  readonly backoff_applied: boolean;
  readonly consecutive_failures: number;
  readonly next_run_at: string | null;
  readonly reason_class: string | null;
  // §10-B: `needs_attention` added — cooldown exhausted no-progress cycle budget.
  readonly recommended_health_state: "blocked" | "cooling_off" | "needs_attention" | null;
}

export interface RefreshPolicy {
  readonly assisted_after_owner_auth?: boolean;
  readonly background_safe?: boolean;
  readonly bot_detection_sensitivity?: "high" | "low" | "medium";
  readonly interaction_posture?: "credentials" | "manual_action_likely" | "none" | "otp_likely";
  readonly maximum_staleness_seconds?: number;
  readonly minimum_interval_seconds?: number;
  readonly rate_limit_sensitivity?: "high" | "low" | "medium";
  readonly rationale?: string;
  readonly recommended_interval_seconds?: number;
  readonly recommended_mode?: "automatic" | "manual" | "paused";
  readonly session_lifetime_seconds?: number;
}

export function getScheduleIneligibilityReason(policy: RefreshPolicy | null): string | null {
  return automaticIneligibilityReason(policy);
}

export interface ScheduleApi {
  readonly active_run_id: string | null;
  readonly automation_mode: RunAutomationMode;
  readonly automation_summary: string;
  readonly browser_surface_lease_id?: string;
  readonly browser_surface_profile_key?: string;
  readonly browser_surface_status?: BrowserSurfaceProjection["browser_surface_status"];
  readonly browser_surface_wait_reason?: BrowserSurfaceProjection["browser_surface_wait_reason"];
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly created_at: string;
  readonly effective_mode: "automatic" | "manual" | "paused";
  readonly enabled: boolean;
  readonly human_attention_needed: boolean;
  /**
   * Reason the persisted schedule is not eligible for automatic background
   * refresh under the connector's *current* manifest policy. Computed from
   * `recommended_policy` via the same gate the scheduler uses to skip stale
   * unsafe rows. `null` means the persisted `enabled` flag is the authority:
   * if `enabled=true` the schedule actually runs; if `enabled=false` it is
   * paused as operator intent. Set when `enabled=true` but the manifest has
   * since changed to `manual` / `paused` / `background_safe: false` — the row
   * persists as operator intent, but the runtime will not start automatic runs
   * for it. Resuming is rejected with this same reason.
   */
  readonly ineligibility_reason: string | null;
  readonly interval_seconds: number;
  readonly jitter_seconds: number;
  readonly last_error_code: string | null;
  readonly last_finished_at: string | null;
  readonly last_started_at: string | null;
  readonly last_successful_at: string | null;
  readonly minimum_interval_warning: string | null;
  readonly next_due_at: string | null;
  readonly notification_posture: "action_required" | "informational" | "none";
  readonly object: "schedule";
  readonly pending_run_id?: string;
  readonly recommended_policy: RefreshPolicy | null;
  readonly scheduler_backoff: SchedulerBackoffApi | null;
  readonly trigger_kind: "scheduled";
  readonly updated_at: string;
}

export interface ActiveRun {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  /** Monotonic fencing token: increments each time a new run is admitted for this connector_instance. */
  readonly run_generation: number;
  readonly run_id: string;
  readonly started_at: string;
  readonly trace_id: string;
}

export interface RunNowOptions {
  connectorInstanceId?: string;
  /**
   * Explicit force-override: bypass provider-pressure cooldown for this run.
   * Ordinary `Sync now` must NOT set this flag. It is reserved for a separate,
   * explicitly-named "force run despite pressure" action so the default owner
   * button cannot accidentally re-hit a hot account that is cooling off.
   */
  force?: boolean;
  manifest?: ConnectorManifest;
  ownerToken?: string;
  priorityClass?: "owner_interactive" | "scheduled_refresh";
  resources?: Readonly<Record<string, readonly string[]>>;
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  traceContext?: SpineTraceContext;
  triggerKind?: Extract<RunTriggerKind, "manual" | "webhook" | "scheduled">;
}

export interface ConnectorInstanceOptions {
  connectorInstanceId?: string;
}

export interface RunNowResult {
  readonly automation_mode?: RunAutomationMode;
  readonly automation_summary?: string;
  readonly browser_surface?: BrowserSurfaceProjection;
  readonly run_id: string;
  readonly status?: "started" | BrowserSurfaceProjection["browser_surface_status"];
  readonly trace_id: string;
  readonly trigger_kind?: RunTriggerKind;
}

export interface AutoResumeSatisfiedActionsInput {
  awaitCompletion?: boolean;
  connectorId: string;
  connectorInstanceId?: string;
  evidence: SatisfactionEvidenceBag;
  manifest?: ConnectorManifest;
  ownerToken?: string;
  requiredActions: readonly RequiredAction[];
  rsUrl?: string;
  runId?: string;
  scenarioId?: string;
  traceContext?: SpineTraceContext;
}

export interface AutoResumeSatisfiedActionsResult {
  readonly confirming_run: RunNowResult | null;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly object: "connection_self_heal";
  readonly satisfied_actions: readonly RequiredAction[];
  readonly status: "active_run_exists" | "blocked" | "no_satisfied_action" | "started";
  readonly terminal_status?: "failed" | "succeeded";
}

function buildAutoResumeRunNowOptions(
  input: AutoResumeSatisfiedActionsInput,
  connectorInstanceId: string
): RunNowOptions {
  const options: RunNowOptions = {
    connectorInstanceId,
    priorityClass: "owner_interactive",
    triggerKind: "manual",
  };
  if (input.manifest !== undefined) {
    options.manifest = input.manifest;
  }
  if (input.ownerToken !== undefined) {
    options.ownerToken = input.ownerToken;
  }
  if (input.rsUrl !== undefined) {
    options.rsUrl = input.rsUrl;
  }
  if (input.runId !== undefined) {
    options.runId = input.runId;
  }
  if (input.scenarioId !== undefined) {
    options.scenarioId = input.scenarioId;
  }
  if (input.traceContext !== undefined) {
    options.traceContext = input.traceContext;
  }
  return options;
}

function controllerErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function runAutomationMetadata(
  policy: RefreshPolicy | null,
  triggerKind: Extract<RunTriggerKind, "manual" | "webhook" | "scheduled">
): Pick<RunNowResult, "automation_mode" | "automation_summary" | "trigger_kind"> {
  const projection = projectRunAutomationPolicy({
    triggerKind,
    refreshPolicy: policy,
  });
  return {
    automation_mode: projection.automation_mode,
    automation_summary: automationModeCopy(projection.automation_mode),
    trigger_kind: projection.trigger_kind,
  };
}

export interface RunInteractionResponseInput {
  readonly data?: unknown;
  readonly interaction_id?: unknown;
  readonly status?: unknown;
}

export interface RunInteractionAck {
  readonly accepted: true;
  readonly status: "cancelled" | "success";
}

export interface CancelRunResult {
  readonly run_id: string;
  readonly status: "already_terminal" | "cancel_requested" | "no_active_run";
}

export interface PendingInteractionProjection {
  readonly connector_id: string;
  readonly interaction_id: string;
  readonly kind: string;
  readonly run_id: string;
  readonly stream: string | null;
}

export interface BrowserSurfaceRunProjection extends BrowserSurfaceProjection {
  readonly connector_id: string;
}

export type ConnectorPathResolver = (
  connectorId: string,
  manifest?: ConnectorManifest,
  options?: RunNowOptions
) => Promise<string | null> | string | null;

interface ControllerLogger {
  error?: (message: string) => void;
  warn?: (message: string) => void;
}

type RunConnectorFn = typeof runConnector;

/**
 * Hooks the controller calls to manage the per-run streaming-target
 * registration nonce that bridges Mode A (in-process runtime). The
 * controller mints a random nonce at spawn, hands it to the registry to
 * be hash-stored, threads the raw value to the connector child via env,
 * and clears it when the run ends. Decoupled from the registry's
 * concrete shape so this module does not import the registry directly.
 */
export interface RunTargetNonceHooks {
  clearNonce(args: { runId: string }): void;
  registerNonce(args: { runId: string; nonce: string }): void;
}

export interface ControllerOptions {
  asPublicUrl?: string;
  browserSurfaceAllocator?: BrowserSurfaceAllocator;
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager;
  browserSurfaceLeaseStore?: BrowserSurfaceLeaseStore;
  /**
   * Poll interval for the mid-wait surface-loss detector (ms). Defaults to
   * `DEFAULT_MID_WAIT_SURFACE_LOSS_POLL_INTERVAL_MS` (10 s). Tests set this
   * low to make detection synchronous without real timers.
   */
  browserSurfaceMidWaitPollIntervalMs?: number;
  /**
   * Optional preflight readiness probe. Production wiring installs a default
   * HTTP-based probe once the lease manager and allocator both report a
   * surface is "leased + ready", but BEFORE the connector child is spawned.
   * Failure terminates the run with `surface_failed` and a typed probe code
   * in the spine timeline, so a single failed live run yields enough evidence
   * to fix the surface before re-asking the owner for an OTP. When unset or
   * set to `null`, the gate is disabled.
   */
  browserSurfaceReadinessProbe?: BrowserSurfaceReadinessProbe | null;
  browserSurfaceReadinessTimeoutMs?: number;
  connectorPathResolver?: ConnectorPathResolver;
  // Optional durable detail-gap store override; defaults to the configured
  // storage-backed singleton. The controller reads pending *source-pressure*
  // gaps from it so the schedule projection can surface `cooling_off` honestly
  // while a connection is governed by the cross-run source-pressure cooldown.
  // Tests substitute a fake to drive the projection without DB state.
  detailGapStore?: ConnectorDetailGapReadStore;
  logger?: ControllerLogger;
  /**
   * Optional credential lifecycle transition called after a connector run that
   * actually used a stored static secret reports a definitive provider
   * rejection. The controller owns the timing because it alone knows both
   * facts: the per-run secret env was injected, and the terminal connector
   * result carried `connector_error.code === "credential_rejected"`.
   */
  markStaticSecretCredentialRejected?: MarkStaticSecretCredentialRejected;
  /**
   * Maximum wall-clock milliseconds a single run may remain active before the
   * watchdog force-finalizes it with a `run.failed` (reason: `run_timed_out`).
   * Defaults to `PDPP_MAX_RUN_WALL_CLOCK_MS` env var, or 3 600 000 ms (1 hour)
   * when neither is set. Pass `Infinity` (or set the env var to "Infinity") to
   * disable the watchdog — useful for intentionally long runs or tests that
   * drive timing themselves.
   */
  maxRunWallClockMs?: number;
  ownerClientId?: string;
  ownerSubjectId?: string;
  /**
   * Optional connection-scoped static-secret resolver. When present, the
   * controller calls it before each run to obtain the env fragment carrying
   * exactly that connection's provider secret (Gmail app password / GitHub
   * PAT), recovered from the per-connection encrypted credential store. The
   * fragment is threaded to `runConnector` as `staticSecretEnv` and merged
   * LAST over `process.env` at spawn (design Decision 5).
   *
   * Contract:
   *   - Return a non-empty env fragment when the connection has an active
   *     stored credential — the run is then scoped to that secret.
   *   - Return `null` only when the connector is not a static-secret connector
   *     or another connection-scoped setup family should handle the run.
   *   - Throw (fail closed) when a configured static-secret connection has no
   *     active recoverable credential — the run is refused rather than started
   *     with a stale or deployment-wide provider-account secret.
   *
   * Injected (not imported) so the controller stays decoupled from the
   * credential store and the connector package, matching `runConnectorImpl`.
   * Absent in pure-runtime tests; the reference server wires the real resolver.
   */
  resolveStaticSecretRunEnv?: StaticSecretRunEnvResolver;
  rsUrl?: string;
  runConnectorImpl?: RunConnectorFn;
  runtime?: unknown;
  /**
   * Mutable runtime-context bag the surrounding server populates after
   * its listeners are bound. The controller reads `rsUrl` and the new
   * `referenceBaseUrl` lazily so it picks up the realized values once
   * the AS server has actually allocated its port.
   */
  runtimeContext?: { rsUrl?: string; referenceBaseUrl?: string };
  scheduler?: unknown;
  // Optional store override; defaults to the configured storage-backed singleton.
  // Tests use this to substitute fakes without touching module-scoped state.
  schedulerStore?: SchedulerStore;
  /**
   * Optional Mode-A streaming-target nonce hooks. When present, the
   * controller mints a per-run nonce at `runNow` time, registers its
   * hash with the registry, and threads the raw nonce to the connector
   * child via `PDPP_STREAMING_REGISTRATION_TOKEN`. When absent (older
   * deployments, tests that do not exercise streaming), Mode-A
   * registration is a no-op and Mode-B continues to work via its own
   * device-exporter authority. See:
   *   reference-implementation/server/streaming/run-target-registry.js
   */
  streamingTargetNonceHooks?: RunTargetNonceHooks;
}

/**
 * Resolves the connection-scoped static-secret env fragment for one run.
 * Returns `null` only when the connector/setup family is not static-secret.
 * See `CreateControllerOptions.resolveStaticSecretRunEnv`.
 */
export type StaticSecretRunEnvResolver = (args: {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
}) => Promise<Record<string, string> | null> | Record<string, string> | null;

export type MarkStaticSecretCredentialRejected = (args: {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly reason: string | null;
  readonly rejectedAt: string;
  readonly runId: string;
}) => Promise<void> | void;

export interface Controller {
  autoResumeSatisfiedActions(input: AutoResumeSatisfiedActionsInput): Promise<AutoResumeSatisfiedActionsResult>;
  /**
   * Run-id-keyed lookup over the in-process active-run bookkeeping.
   * Returns the active-run projection while the run is in flight
   * (registered before the run-now 202 handle is returned, cleared by
   * `finalizeRunCleanup` when the run settles), or `null` when no active
   * run carries that id. Used by the `GET /_ref/runs/:runId` run-handle
   * status route; terminal runs resolve via the spine instead.
   */
  /**
   * Await a run's real terminal outcome by run_id.
   *
   * Waits for the in-flight `activeRunPromises` entry for this run to settle
   * (meaning the controller's `.finally()` cleanup chain has completed), then
   * reads the authoritative terminal status from the spine.
   *
   * Returns `"succeeded"` when the run completed successfully, `"failed"` for
   * any other terminal state (failed, cancelled, abandoned) or when the run
   * is unknown / has no spine terminal event.
   *
   * Used by the `runManagedConnectorViaController` scheduler callback to
   * record the REAL outcome of a scheduled managed-connector run instead of
   * a synthetic "succeeded" — so the scheduler's failure-streak / back-off
   * machinery fires correctly when the run actually fails.
   */
  awaitRun(runId: string): Promise<"succeeded" | "failed">;
  /**
   * The managed browser-surface lease manager the controller was built with
   * (or `undefined` when browser surfaces are disabled). Re-exported so the
   * SCHEDULER can route managed-connector runs through the warm neko lease the
   * way `runNow` does: the scheduler wiring in server/index.js keys both its
   * managed-routing seam (`runManagedConnectorViaController`) and its
   * `isManagedConnector` predicate off `controller.browserSurfaceLeaseManager`.
   * Without this re-export the property is `undefined`, the seam is wired to
   * `null`, and `isManagedConnector` is hardwired to `false` — so scheduled
   * managed-connector runs fall through to the COLD `runConnector` path
   * (empty profile, no cf_clearance) and fail the provider's bot challenge,
   * while manual `runNow` (which reads the same lease manager from its own
   * closure) succeeds. Exposing it makes scheduled runs lease the warm surface.
   */
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager | undefined;
  cancelBrowserSurfaceRun(runId: string): Promise<BrowserSurfaceProjection | null>;
  /**
   * Owner-only single-run cancellation. Aborts only the targeted run's
   * cooperative-cancel signal so the runtime terminates that connector child
   * and resolves the run terminal as `run.cancelled`. Returns a typed result
   * distinguishing a requested cancellation from a missing or already-terminal
   * run. Never touches sibling active runs.
   * See add-owner-run-cancellation-control.
   */
  cancelRun(runId: string): Promise<CancelRunResult>;
  cleanupIdleBrowserSurfaces(): Promise<BrowserSurfaceProjection[]>;
  clearNeedsHuman(connectorId: string, options?: ConnectorInstanceOptions): void;
  deleteSchedule(connectorId: string, options?: ConnectorInstanceOptions): Promise<boolean>;
  /**
   * Graceful-shutdown drain: await all in-flight `runConnector` promises,
   * bounded by `timeoutMs`. Returns a summary of which runs finished
   * cleanly vs. which timed out.
   *
   * Intended caller: the parent process's SIGTERM handler in
   * `server/index.js`. Ensures connector children have time to release
   * their Chromium contexts (Layer A `shutdown-hook.ts` in
   * `polyfill-connectors/src`) before the parent exits and closes their
   * stdio pipes. See the layered SLVP design:
   *   - Layer A (subprocess SIGTERM hook): awaits release on signal.
   *   - Layer B (this method): controller waits for children before exit.
   *   - Layer C (`profile-lock.ts`): startup cleanup of any residue from
   *     paths A/B couldn't intercept (SIGKILL, OOM, power loss).
   */
  drainActiveRuns(timeoutMs: number): Promise<DrainSummary>;
  expireBrowserSurfaceWaits(): Promise<BrowserSurfaceProjection[]>;
  findActiveRunByRunId(runId: string): ActiveRun | null;
  getActiveRun(connectorId: string, options?: ConnectorInstanceOptions): ActiveRun | null;
  getPendingInteraction(runId: string): PendingInteractionProjection | null;
  getSchedule(connectorId: string, options?: ConnectorInstanceOptions): Promise<ScheduleApi | null>;
  isNeedsHuman(connectorId: string, options?: ConnectorInstanceOptions): boolean;
  issueRuntimeOwnerToken(): Promise<string>;
  listBrowserSurfaceRunProjections(): BrowserSurfaceRunProjection[];
  listSchedules(): Promise<ScheduleApi[]>;
  markNeedsHuman(connectorId: string, options?: ConnectorInstanceOptions): void;
  promoteBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  reconcileBrowserSurfaceLeasesAfterBoot(): Promise<void>;
  respondToInteraction(runId: string, input?: RunInteractionResponseInput): RunInteractionAck;
  runNow(connectorId: string, options?: RunNowOptions): Promise<RunNowResult>;
  setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options?: ConnectorInstanceOptions
  ): Promise<ScheduleApi | null>;
  upsertSchedule(
    connectorId: string,
    input: ConnectorSchedulePatch,
    options?: ConnectorInstanceOptions
  ): Promise<ScheduleUpsertResult>;
}

export interface DrainSummary {
  readonly drained: number;
  /** Wall-clock milliseconds spent in drainActiveRuns. */
  readonly elapsedMs: number;
  readonly timedOut: number;
}

interface RuntimeInteraction {
  readonly kind: string;
  /** Human-readable description of the interaction; surfaced in ntfy push body. */
  readonly message?: string;
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

// Controller errors carry a structured `code` the HTTP layer maps into
// RFC 7807 error responses. We expose a named class so callers can do
// typed instanceof checks instead of sniffing duck-typed properties.
export class ControllerError extends Error {
  readonly code: string;
  readonly details: readonly { param: string; message: string }[] | undefined;
  /**
   * ISO timestamp of the next eligible retry window. Set on
   * `provider_pressure_cooldown` errors so the HTTP layer can surface
   * `next_eligible_at` in the error envelope without parsing the message.
   */
  readonly nextEligibleAt: string | undefined;
  /**
   * Count of pending source-pressure gaps that drove the cooldown decision.
   * Set alongside `nextEligibleAt` on `provider_pressure_cooldown` errors.
   */
  readonly pendingPressureGapCount: number | undefined;
  readonly runId: string | undefined;

  constructor(
    message: string,
    code: string,
    extra: {
      details?: readonly { param: string; message: string }[];
      nextEligibleAt?: string;
      pendingPressureGapCount?: number;
      runId?: string;
    } = {}
  ) {
    super(message);
    this.code = code;
    this.details = extra.details;
    this.nextEligibleAt = extra.nextEligibleAt;
    this.pendingPressureGapCount = extra.pendingPressureGapCount;
    this.runId = extra.runId;
    this.name = "ControllerError";
  }
}

// ─── Module-scoped state ────────────────────────────────────────────────────

const activeRuns = new Map<string, ActiveRun>();
// In-flight connector-run Promises, keyed by run_id. Settled (success or
// failure) when the connector child process has exited and the controller's
// per-run cleanup (`activeRuns.delete`, spine emit, etc.) has finished.
//
// Populated alongside `activeRuns.set` and cleared in the same `finally`
// chain. Used exclusively by `drainActiveRuns` (graceful-shutdown path)
// to await in-flight cleanup before the parent process exits. See
// docs/run-reconciliation-design-brief.md for the broader controller-
// shutdown discipline this complements.
const activeRunPromises = new Map<string, Promise<unknown>>();
// Run IDs whose runPromise has settled but whose finalizeRunCleanup may not
// have completed yet (race window) or — defensively — whose cleanup was
// skipped due to an unhandled edge. Used by the 409 guard to distinguish a
// stale in-memory entry from a genuinely live run, so a hung run that was
// force-finalized by the watchdog never permanently blocks future run-nows.
const settledRunIds = new Set<string>();
// Per-run watchdog timer handles, keyed by run_id. Armed after
// activeRunPromises.set; cleared in finalizeRunCleanup so a normal
// completion never fires the watchdog. All timers are .unref()'d so they
// don't prevent process exit during a clean shutdown.
const activeRunWatchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Monotonic run-generation fencing token, keyed by connector_instance key
// (same key as activeRuns). Incremented each time a new run is admitted for
// a connector_instance — including when a hung/stale run is reclaimed by the
// watchdog or 409-guard reconciliation. A zombie run from generation N cannot
// commit once generation N+1 is active: the commit gate checks that the run's
// generation matches the current value before writing terminal/ingest data.
// Persisted to controller_active_runs.run_generation so the fencing token
// survives through the DB layer (audit trail + crash-restart consistency).
// Keys are removed when the entry is cleaned up to avoid unbounded growth.
const runGenerations = new Map<string, number>();
// Keyed by run_id. Interaction broker state is intentionally in-memory:
// dashboard-submitted values satisfy the current live run only and are never
// persisted to `.env.local`, SQLite config/state, or spine event payloads.
const activeRunInteractions = new Map<string, ActiveRunInteraction>();
// Connectors where an automatic background run surfaced an unresolvable
// human-attention interaction. The scheduler checks this before launching
// new automatic attempts so high-friction connectors don't spam OTP/login
// requests in the background. Manual "run now" bypasses this flag.
const needsHumanAttention = new Set<string>();
interface ManifestFingerprint {
  readonly streams: string;
  readonly version: string;
}
let referenceFixtureFingerprints: Map<string, ManifestFingerprint> | null = null;
let polyfillManifestFingerprints: Map<string, ManifestFingerprint> | null = null;
let polyfillConnectorPaths: Map<string, string> | null = null;
const ABANDONED_CONTROLLER_RUN_REASON = "controller_restarted";

// Typed terminal reason for a run whose launch path threw before the
// runtime recorded any terminal event (e.g. env/spawn prep failed before
// the `run.started` emit). Closes the "phantom 202" window: a 202-returned
// run handle always resolves to a terminal spine event even when the
// connector child never started. See surface-run-handle-resolvability.
const LAUNCH_FAILED_RUN_REASON = "launch_failed";

// Bound the failure message persisted on a launch-failure terminal event.
// Launch-path errors are runtime/setup messages (binding validation, spawn
// prep), not connector output, but bound them anyway so a pathological
// error can't bloat the spine row.
const LAUNCH_FAILURE_MESSAGE_MAX = 500;

function boundedLaunchFailureMessage(message: string): string {
  return message.length > LAUNCH_FAILURE_MESSAGE_MAX ? `${message.slice(0, LAUNCH_FAILURE_MESSAGE_MAX)}…` : message;
}

function buildRunSource(connectorId: string): { kind: "connector"; id: string } {
  return { kind: "connector", id: connectorId };
}

function runtimeKey(connectorId: string, connectorInstanceId?: string | null): string {
  return connectorInstanceId || connectorId;
}

/**
 * Graceful-shutdown drain primitive — exported for direct unit testing.
 *
 * Await every Promise in `pending` (snapshotted at call time) until either
 * (a) all settle, or (b) `timeoutMs` elapses. After the deadline, returns
 * counts based on which keys remain in the *live* map — promises that
 * settled during the race were removed by their own `finally` chains.
 *
 * The Promise.race is bounded; the timeout's setTimeout is `.unref()`'d
 * so the test runner doesn't keep the event loop alive after the test
 * finishes (a hard-to-spot test hang otherwise).
 *
 * See `Controller.drainActiveRuns` and
 * docs/run-reconciliation-design-brief.md for the layered SLVP design.
 */
export async function drainPromisesWithDeadline(
  pending: Map<string, Promise<unknown>>,
  timeoutMs: number
): Promise<DrainSummary> {
  const startMs = Date.now();
  const snapshot = Array.from(pending.values());
  if (snapshot.length === 0) {
    return { drained: 0, timedOut: 0, elapsedMs: 0 };
  }
  let timeoutHandle: NodeJS.Timeout | null = null;
  const deadline = new Promise<"timeout">((resolve) => {
    timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    if (timeoutHandle.unref) {
      timeoutHandle.unref();
    }
  });
  const allSettled = Promise.allSettled(snapshot).then(() => "settled" as const);
  const outcome = await Promise.race([allSettled, deadline]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }
  const elapsedMs = Date.now() - startMs;
  if (outcome === "settled") {
    return { drained: snapshot.length, timedOut: 0, elapsedMs };
  }
  const stillPending = pending.size;
  return {
    drained: snapshot.length - stillPending,
    timedOut: stillPending,
    elapsedMs,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Connector-path discovery (cached per-process) ──────────────────────────

// A manifest fingerprint is a cheap, stable summary used to tell the
// reference fixture manifest apart from the shipped polyfill manifest when
// they share the same `connector_id`. We compare version plus the sorted
// list of declared stream names — that is enough to distinguish the two
// github.json files today without pulling in a full JSON equality check.
function fingerprintManifest(manifest: ConnectorManifest | null | undefined): ManifestFingerprint | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const version =
    typeof (manifest as { version?: unknown }).version === "string" ? (manifest as { version: string }).version : "";
  const rawStreams = (manifest as { streams?: unknown }).streams;
  const streamNames: string[] = [];
  if (Array.isArray(rawStreams)) {
    for (const stream of rawStreams) {
      const name = (stream as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name.trim()) {
        streamNames.push(name.trim());
      }
    }
  }
  streamNames.sort();
  return { version, streams: streamNames.join(",") };
}

function fingerprintsEqual(a: ManifestFingerprint | null, b: ManifestFingerprint | null): boolean {
  return !!(a && b && a.version === b.version && a.streams === b.streams);
}

function addConnectorLookupKey(keys: string[], key: unknown): void {
  if (typeof key !== "string") {
    return;
  }
  const trimmed = key.trim();
  if (trimmed && !keys.includes(trimmed)) {
    keys.push(trimmed);
  }
}

function connectorLookupKeys(connectorId: string, manifest?: ConnectorManifest | null): string[] {
  const keys: string[] = [];
  addConnectorLookupKey(keys, connectorId);
  addConnectorLookupKey(keys, canonicalConnectorKey(connectorId));
  if (manifest && typeof manifest === "object") {
    addConnectorLookupKey(keys, (manifest as { connector_id?: unknown }).connector_id);
    addConnectorLookupKey(keys, (manifest as { manifest_uri?: unknown }).manifest_uri);
    addConnectorLookupKey(keys, canonicalConnectorKeyFromManifest(manifest));
  }
  return keys;
}

function setManifestLookupAliases<T>(
  entries: Map<string, T>,
  connectorId: string,
  manifest: ConnectorManifest,
  value: T
): void {
  for (const key of connectorLookupKeys(connectorId, manifest)) {
    entries.set(key, value);
  }
}

function getFirstByConnectorLookupKey<T>(entries: ReadonlyMap<string, T>, keys: readonly string[]): T | null {
  for (const key of keys) {
    const value = entries.get(key);
    if (value !== undefined) {
      return value;
    }
  }
  return null;
}

/**
 * Read the operator-facing display name from a connector manifest, if
 * present. Falls back to the manifest's `name` field, then to null. The
 * caller is responsible for substituting `connector_id` when this returns
 * null.
 */
function readManifestDisplayName(manifest: ConnectorManifest | null | undefined): string | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const display = (manifest as { display_name?: unknown }).display_name;
  if (typeof display === "string" && display.trim()) {
    return display.trim();
  }
  const name = (manifest as { name?: unknown }).name;
  if (typeof name === "string" && name.trim()) {
    return name.trim();
  }
  return null;
}

function readManifestRefreshPolicy(manifest: ConnectorManifest | null | undefined): RefreshPolicy | null {
  if (!manifest || typeof manifest !== "object") {
    return null;
  }
  const capabilities = (manifest as { capabilities?: unknown }).capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  const policy = (capabilities as { refresh_policy?: unknown }).refresh_policy;
  return policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as RefreshPolicy) : null;
}

function loadReferenceFixtureFingerprints(): Map<string, ManifestFingerprint> {
  if (referenceFixtureFingerprints) {
    return referenceFixtureFingerprints;
  }
  const entries = new Map<string, ManifestFingerprint>();
  for (const file of readdirSync(REFERENCE_MANIFESTS_DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    try {
      const manifest = JSON.parse(
        readFileSync(join(REFERENCE_MANIFESTS_DIR, file), "utf8")
      ) as ConnectorManifest | null;
      if (!manifest || typeof manifest !== "object") {
        continue;
      }
      const connectorId = (manifest as { connector_id?: unknown } | null)?.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const fp = fingerprintManifest(manifest);
      if (fp) {
        setManifestLookupAliases(entries, connectorId.trim(), manifest, fp);
      }
    } catch {
      // Ignore malformed local fixture manifests during runtime path discovery.
    }
  }
  referenceFixtureFingerprints = entries;
  return entries;
}

function loadPolyfillConnectorPaths(): Map<string, string> {
  if (polyfillConnectorPaths) {
    return polyfillConnectorPaths;
  }
  const paths = new Map<string, string>();
  const fingerprints = new Map<string, ManifestFingerprint>();
  if (!existsSync(POLYFILL_MANIFESTS_DIR)) {
    polyfillConnectorPaths = paths;
    polyfillManifestFingerprints = fingerprints;
    return paths;
  }
  for (const file of readdirSync(POLYFILL_MANIFESTS_DIR)) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const connectorName = file.replace(JSON_EXTENSION_RE, "");
    const connectorPath = [
      join(POLYFILL_CONNECTORS_DIR, connectorName, "index.ts"),
      join(POLYFILL_CONNECTORS_DIR, connectorName, "index.js"),
    ].find((candidatePath) => existsSync(candidatePath));
    if (!connectorPath) {
      continue;
    }
    try {
      const manifest = JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, file), "utf8")) as ConnectorManifest | null;
      if (!manifest || typeof manifest !== "object") {
        continue;
      }
      const connectorId = (manifest as { connector_id?: unknown } | null)?.connector_id;
      if (typeof connectorId !== "string" || !connectorId.trim()) {
        continue;
      }
      const trimmedId = connectorId.trim();
      setManifestLookupAliases(paths, trimmedId, manifest, connectorPath);
      const fp = fingerprintManifest(manifest);
      if (fp) {
        setManifestLookupAliases(fingerprints, trimmedId, manifest, fp);
      }
    } catch {
      // Ignore malformed manifests when building the local connector-path map.
    }
  }
  polyfillConnectorPaths = paths;
  polyfillManifestFingerprints = fingerprints;
  return paths;
}

function loadPolyfillManifestFingerprints(): Map<string, ManifestFingerprint> {
  if (!polyfillManifestFingerprints) {
    loadPolyfillConnectorPaths();
  }
  return polyfillManifestFingerprints ?? new Map<string, ManifestFingerprint>();
}

// Resolve the connector-implementation path for a controller-managed run.
//
// Why this is non-trivial: the reference fixture manifests in
// reference-implementation/manifests/ and the shipped polyfill manifests in
// packages/polyfill-connectors/manifests/ can share a `connector_id`
// (for example, GitHub). The reference fixture is served by the seed
// connector at reference-implementation/connectors/seed/index.js, while
// the shipped polyfill connector lives at
// packages/polyfill-connectors/connectors/<name>/index.ts. Silently
// preferring the seed on collision caused a protocol violation: the seed
// GitHub fixture emits a `commits` PROGRESS stream that the polyfill
// manifest does not declare.
//
// Rules applied here, in order:
//   1. When the caller passes the active manifest, compare a stable
//      fingerprint (version + sorted stream names) against the on-disk
//      reference fixture and polyfill manifests for that connector_id:
//        - match polyfill → polyfill connector path;
//        - match reference → seed connector path;
//   2. No match, or no manifest provided: prefer the shipped polyfill
//      connector when it exists. Polyfill is the deployed production
//      surface; the seed is a fixture kept for explicit reference fixture
//      manifests and tests.
//   3. Fall back to the seed connector only when the reference fixture has
//      a manifest for this connector_id. Unknown ids resolve to null.
export function resolveDefaultConnectorPath(connectorId: string, manifest?: ConnectorManifest): string | null {
  const referenceFingerprints = loadReferenceFixtureFingerprints();
  const polyfillFingerprints = loadPolyfillManifestFingerprints();
  const polyfillPaths = loadPolyfillConnectorPaths();
  const lookupKeys = connectorLookupKeys(connectorId, manifest ?? null);
  const polyfillPath = getFirstByConnectorLookupKey(polyfillPaths, lookupKeys);
  const referenceFingerprint = getFirstByConnectorLookupKey(referenceFingerprints, lookupKeys);
  const polyfillFingerprint = getFirstByConnectorLookupKey(polyfillFingerprints, lookupKeys);
  const hasReferenceFixture = referenceFingerprint !== null;

  const activeFingerprint = fingerprintManifest(manifest ?? null);
  if (activeFingerprint) {
    if (polyfillPath && fingerprintsEqual(activeFingerprint, polyfillFingerprint)) {
      return polyfillPath;
    }
    if (hasReferenceFixture && fingerprintsEqual(activeFingerprint, referenceFingerprint)) {
      return SEED_CONNECTOR_PATH;
    }
  }

  if (polyfillPath) {
    return polyfillPath;
  }
  if (hasReferenceFixture) {
    return SEED_CONNECTOR_PATH;
  }
  return null;
}

// Reset cached manifest/path discovery. Tests rewrite manifest files on
// disk during setup; without a reset hook the first test's cached maps
// would mask later ones.
export function __resetControllerPathResolverCachesForTests(): void {
  referenceFixtureFingerprints = null;
  polyfillManifestFingerprints = null;
  polyfillConnectorPaths = null;
}

// ─── Schedule helpers ───────────────────────────────────────────────────────

/**
 * Per-connector projection of the durable scheduler history + last-run-time
 * tables. Built once per `listSchedules()` (or `getSchedule()`) call by
 * `loadScheduleHistoryIndex` and threaded into `getRuntimeProjection` so a
 * persisted schedule whose in-memory active-run row has already cleared
 * still surfaces honest last-run facts to the dashboard and `scheduler-
 * doctor`. The index is purely additive: when the controller knows the
 * connector is currently running, the in-memory active-run row still wins.
 */
/**
 * One pending detail-gap row as the projection consumes it. Mirrors the subset
 * of `connector_detail_gaps` (see
 * `reference-implementation/server/stores/connector-detail-gap-store.js`) that
 * the source-pressure cooldown needs. The store returns more fields; we read
 * only these.
 */
interface PendingDetailGapRow {
  readonly attempt_count?: number | null;
  readonly connector_instance_id?: string | null;
  readonly last_attempt_at?: string | null;
  readonly next_attempt_after?: string | null;
  readonly reason?: string | null;
  readonly stream?: string | null;
  readonly updated_at?: string | null;
}

/**
 * The read surface of the detail-gap store the controller depends on for the
 * cooldown projection. Kept to one method so a test fake is trivial.
 */
interface ConnectorDetailGapReadStore {
  listPendingGapsForConnector(
    connectorId: string,
    options?: { limit?: number }
  ): Promise<readonly PendingDetailGapRow[]> | readonly PendingDetailGapRow[];
}

interface ScheduleHistoryFacts {
  /** Latest durable last-run timestamp, from history or `scheduler_last_run_times`. */
  readonly lastRunTimeMs: number | null;
  /** Error/skip code for the most recent terminal row, when that row was not successful. */
  readonly latestErrorCode: string | null;
  readonly latestFinishedAt: string | null;
  /** Most recent run that actually started (status in {succeeded, failed}). */
  readonly latestStartedAt: string | null;
  readonly latestStatus: "failed" | "skipped" | "succeeded" | null;
  /** Most recent `succeeded` record's `completedAt`. */
  readonly latestSuccessfulAt: string | null;
  /**
   * Pending durable source-pressure detail gaps for this connection (reason in
   * `SOURCE_PRESSURE_GAP_REASONS`). Drives the cross-run cooldown projection so
   * the dashboard shows `cooling_off` while pressure persists instead of bare
   * green. Empty when there is no source pressure (the common case).
   */
  readonly pendingPressureGaps: readonly PendingPressureGap[];
  /** Recent durable scheduler history for this connector instance, oldest to newest. */
  readonly recentRuns: readonly SchedulerRunHistoryRecord[];
}

type ScheduleHistoryIndex = ReadonlyMap<string, ScheduleHistoryFacts>;

interface MutableScheduleHistoryFacts {
  lastRunTimeMs: number | null;
  latestErrorCode: string | null;
  latestFinishedAt: string | null;
  latestStartedAt: string | null;
  latestStatus: "failed" | "skipped" | "succeeded" | null;
  latestSuccessfulAt: string | null;
  pendingPressureGaps: PendingPressureGap[];
  recentRuns: SchedulerRunHistoryRecord[];
}

const EMPTY_SCHEDULE_HISTORY_FACTS: ScheduleHistoryFacts = {
  latestStartedAt: null,
  latestFinishedAt: null,
  latestStatus: null,
  latestSuccessfulAt: null,
  latestErrorCode: null,
  lastRunTimeMs: null,
  recentRuns: [],
  pendingPressureGaps: [],
};

const SAFE_SCHEDULER_ERROR_PREFIXES = new Set([
  "automation_policy_blocked",
  "not_ready",
  "schedule.back_off.cleared",
  "schedule.back_off.started",
  "schedule.gave_up",
  "scheduler_backoff_applied",
]);

function schedulerErrorCodeFromRecord(row: SchedulerRunHistoryRecord): string | null {
  if (row.terminalReason) {
    return row.terminalReason;
  }
  if (row.failureReason) {
    return row.failureReason;
  }
  if (!row.error) {
    return null;
  }
  const prefix = row.error.includes(":") ? row.error.slice(0, row.error.indexOf(":")) : row.error;
  if (SAFE_SCHEDULER_ERROR_PREFIXES.has(prefix)) {
    return prefix;
  }
  return "scheduler_error";
}

type EnsureScheduleFacts = (connectorKey: string) => MutableScheduleHistoryFacts;

// Distinct connector types referenced by the bounded history + last-run rows.
// These are the connectors whose durable pending pressure gaps we read for the
// cooldown projection.
function collectConnectorIds(
  history: readonly SchedulerRunHistoryRecord[],
  lastRunTimes: readonly SchedulerLastRunTimeRecord[]
): Set<string> {
  const connectorIds = new Set<string>();
  for (const row of history) {
    if (row.connectorId) {
      connectorIds.add(row.connectorId);
    }
  }
  for (const row of lastRunTimes) {
    if (row.connector_id) {
      connectorIds.add(row.connector_id);
    }
  }
  return connectorIds;
}

// Bucket pending source-pressure detail-gap rows onto their connection's facts.
// Keeps only the source-pressure reasons and maps each row to the lane-agnostic
// `PendingPressureGap` shape the cooldown consumes.
function bucketPressureGapsByInstance(
  gaps: readonly PendingDetailGapRow[],
  connectorId: string,
  ensure: EnsureScheduleFacts
): void {
  for (const gap of gaps) {
    if (typeof gap.reason !== "string" || !SOURCE_PRESSURE_GAP_REASONS.has(gap.reason)) {
      continue;
    }
    const instanceKey = gap.connector_instance_id || connectorId;
    ensure(instanceKey).pendingPressureGaps.push({
      reason: gap.reason,
      attemptCount: typeof gap.attempt_count === "number" ? gap.attempt_count : null,
      nextAttemptAfter: typeof gap.next_attempt_after === "string" ? gap.next_attempt_after : null,
      lastPressureAt:
        typeof gap.last_attempt_at === "string"
          ? gap.last_attempt_at
          : typeof gap.updated_at === "string"
            ? gap.updated_at
            : null,
    });
  }
}

function ensureScheduleHistoryFacts(
  facts: Map<string, MutableScheduleHistoryFacts>,
  connectorKey: string
): MutableScheduleHistoryFacts {
  let entry = facts.get(connectorKey);
  if (!entry) {
    entry = {
      latestStartedAt: null,
      latestFinishedAt: null,
      latestStatus: null,
      latestSuccessfulAt: null,
      latestErrorCode: null,
      lastRunTimeMs: null,
      recentRuns: [],
      pendingPressureGaps: [],
    };
    facts.set(connectorKey, entry);
  }
  return entry;
}

// Hydrate `latestFinishedAt` from the `scheduler_last_run_times` table first
// so a connector that has rolled out of the bounded history window still has
// a non-null `last_finished_at`. History rows will overwrite with a more
// precise per-status anchor when they exist.
function hydrateScheduleHistoryFromLastRunTimes(
  lastRunTimes: readonly SchedulerLastRunTimeRecord[],
  ensure: EnsureScheduleFacts
): void {
  for (const row of lastRunTimes) {
    if (!Number.isFinite(row.last_run_time_ms)) {
      continue;
    }
    const entry = ensure(row.connector_instance_id || row.connector_id);
    if (!entry.latestFinishedAt) {
      entry.latestFinishedAt = new Date(row.last_run_time_ms).toISOString();
    }
    entry.lastRunTimeMs =
      entry.lastRunTimeMs === null ? row.last_run_time_ms : Math.max(entry.lastRunTimeMs, row.last_run_time_ms);
  }
}

function bucketRecentRunsByConnector(history: readonly SchedulerRunHistoryRecord[], ensure: EnsureScheduleFacts): void {
  for (const row of history) {
    if (!row || typeof row.connectorId !== "string") {
      continue;
    }
    ensure(row.connectorInstanceId || row.connectorId).recentRuns.push(row);
  }
}

// Walk newest to oldest. The store's chronological order means the last
// array element is the newest record overall; iterating in reverse keeps
// "first sighting wins" semantics for both `latest{Started,Successful}At`
// so we never overwrite a newer fact with an older one.
function deriveLatestScheduleFacts(history: readonly SchedulerRunHistoryRecord[], ensure: EnsureScheduleFacts): void {
  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i];
    if (!row || typeof row.connectorId !== "string") {
      continue;
    }
    applyHistoryRowToScheduleFacts(ensure(row.connectorInstanceId || row.connectorId), row);
  }
}

function applyHistoryRowToScheduleFacts(entry: MutableScheduleHistoryFacts, row: SchedulerRunHistoryRecord): void {
  if (entry.latestStatus === null) {
    entry.latestStatus = row.status;
    if (row.status === "failed" || row.status === "skipped") {
      entry.latestErrorCode = schedulerErrorCodeFromRecord(row);
    }
  }
  if (!entry.latestFinishedAt || row.completedAt > entry.latestFinishedAt) {
    entry.latestFinishedAt = row.completedAt;
  }
  // Only `succeeded`/`failed` records correspond to a run that actually
  // started. `skipped` records carry a `startedAt` for bookkeeping but the
  // connector child never spawned, so we hold `last_started_at` back. This
  // is what lets the dashboard and the doctor probe distinguish "ran but is
  // currently idle" from "currently being skipped (not_ready / needs_human /
  // disabled grant)".
  if (
    entry.latestStartedAt === null &&
    (row.status === "succeeded" || row.status === "failed") &&
    typeof row.startedAt === "string"
  ) {
    entry.latestStartedAt = row.startedAt;
  }
  if (entry.latestSuccessfulAt === null && row.status === "succeeded") {
    entry.latestSuccessfulAt = row.completedAt;
  }
}

function getRuntimeProjection(
  connectorId: string,
  connectorInstanceId: string,
  browserSurfaceLeaseManager?: BrowserSurfaceLeaseManager,
  historyIndex?: ScheduleHistoryIndex
): RuntimeProjection {
  const key = runtimeKey(connectorId, connectorInstanceId);
  const active = activeRuns.get(key) || null;
  const pendingBrowserSurfaceLease = browserSurfaceLeaseManager
    ?.listLeases()
    .find(
      (lease) =>
        lease.connector_id === connectorId &&
        (lease.surface_subject_id === connectorInstanceId ||
          (!lease.surface_subject_id && connectorInstanceId === connectorId)) &&
        (lease.status === "waiting_for_browser_surface" || lease.status === "deferred")
    );
  const browserSurfaceProjection = pendingBrowserSurfaceLease
    ? projectBrowserSurfaceLease(pendingBrowserSurfaceLease)
    : null;
  const historyFacts = historyIndex?.get(key) ?? EMPTY_SCHEDULE_HISTORY_FACTS;
  if (!active) {
    return {
      active_run_id: null,
      ...(browserSurfaceProjection ?? {}),
      // No active run: durable scheduler history is the source of truth
      // for whether this connector has *ever* run. When history is empty,
      // every field stays null, preserving the "never_ran" classification
      // for genuinely never-fired schedules.
      last_started_at: historyFacts.latestStartedAt,
      last_finished_at: historyFacts.latestFinishedAt,
      last_error_code: historyFacts.latestErrorCode,
      last_successful_at: historyFacts.latestSuccessfulAt,
      human_attention_needed: needsHumanAttention.has(key),
    };
  }
  return {
    active_run_id: active.run_id,
    ...(browserSurfaceProjection ?? {}),
    // In-memory active-run row wins for `last_started_at` (so a freshly
    // dispatched run shows immediately, before history is appended), but
    // we still surface the most recent succeeded/finished facts from
    // durable history so a restart mid-run doesn't lose context.
    last_started_at: active.started_at,
    last_finished_at: historyFacts.latestFinishedAt,
    last_error_code: historyFacts.latestErrorCode,
    last_successful_at: historyFacts.latestSuccessfulAt,
    human_attention_needed: needsHumanAttention.has(key),
  };
}

/**
 * Resolve the operator-facing web base URL the click action of a ntfy
 * push should land on. Mirrors `interaction-handler.ts:resolveWebBaseUrl`
 * exactly: prefer `PDPP_WEB_BASE_URL` (operator's explicit override),
 * fall back to `PDPP_REFERENCE_ORIGIN` (the reference's own composed
 * origin), finally `http://localhost:3000` (dev default — same as the
 * polyfill connectors use). The brief explicitly accepted a small
 * duplication here over a workspace dependency.
 */
function resolveWebBaseUrl(): string {
  const explicit = process.env.PDPP_WEB_BASE_URL?.trim();
  if (explicit) {
    return explicit;
  }
  const referenceOrigin = process.env.PDPP_REFERENCE_ORIGIN?.trim();
  if (referenceOrigin) {
    return referenceOrigin;
  }
  return "http://localhost:3000";
}

/**
 * Lazy import of the ntfy adapter. Two reasons it's lazy:
 *   1. The polyfill-connectors package is loaded by the reference server
 *      at import time anyway, but doing the import here means tests that
 *      don't reach an interaction never pay the cost.
 *   2. If notify() ever throws synchronously (e.g. malformed env), the
 *      lazy boundary keeps that out of the controller's hot path.
 */
async function fireNtfy(args: {
  interaction: RuntimeInteraction;
  connectorDisplayName: string;
  runId: string;
  log: ControllerLogger;
}): Promise<void> {
  try {
    const { notify } = await import("../../packages/polyfill-connectors/src/ntfy.ts");
    const { interaction, connectorDisplayName, runId } = args;
    const message = typeof interaction.message === "string" ? interaction.message : "";
    const webBaseUrl = resolveWebBaseUrl();
    const encodedRunId = encodeURIComponent(runId);
    const encodedInteractionId = encodeURIComponent(interaction.request_id || "");
    const clickUrl =
      interaction.kind === "manual_action"
        ? `${webBaseUrl}/dashboard/runs/${encodedRunId}/stream?interaction_id=${encodedInteractionId}`
        : `${webBaseUrl}/dashboard/runs/${encodedRunId}`;
    const tags = interaction.kind === "credentials" || interaction.kind === "otp" ? ["key"] : ["construction"];
    await notify({
      title: `PDPP ${connectorDisplayName}: ${interaction.kind} needed`,
      message,
      priority: "high",
      tags,
      clickUrl,
    });
  } catch (err) {
    // ntfy is best-effort. A failure here MUST NOT block or fail the
    // interaction handling — log and continue.
    const message = err instanceof Error ? err.message : String(err);
    args.log.warn?.(`[controller] ntfy fire for run ${args.runId} failed: ${message}`);
  }
}

async function buildAttentionOutcomeRecorder(args: { runId: string; requestId: string | null }) {
  const requestId = args.requestId;
  if (!requestId) {
    return null;
  }
  const runId = args.runId;
  // Lazy import keeps the runtime startup graph small; this module is only
  // loaded when an interaction actually fires push delivery.
  const { getDefaultConnectorAttentionStore } = await import("../server/stores/connector-attention-store.js");
  const store = getDefaultConnectorAttentionStore() as {
    recordNotificationOutcomeById?: (input: {
      attentionId: string;
      outcome: string;
      reason: string | null;
      now: string;
    }) => Promise<unknown>;
  };
  if (typeof store.recordNotificationOutcomeById !== "function") {
    return null;
  }
  const recordNotificationOutcomeById = store.recordNotificationOutcomeById;
  return async ({ state, reason }: { state: string; reason: string | null }) => {
    await recordNotificationOutcomeById({
      attentionId: `att_${runId}_${requestId}`,
      outcome: state,
      reason: reason || null,
      now: new Date().toISOString(),
    });
  };
}

async function fireWebPush(args: {
  interaction: RuntimeInteraction;
  connectorDisplayName: string;
  ownerSubjectId: string;
  runId: string;
  log: ControllerLogger;
}): Promise<void> {
  try {
    const { fanoutPendingInteractionWebPush } = await import("../server/web-push-notifications.js");
    const requestId =
      typeof (args.interaction as { request_id?: unknown }).request_id === "string"
        ? (args.interaction as { request_id: string }).request_id
        : null;
    const recordOutcome = await buildAttentionOutcomeRecorder({ runId: args.runId, requestId });
    await fanoutPendingInteractionWebPush({
      interaction: args.interaction,
      connectorDisplayName: args.connectorDisplayName,
      ownerSubjectId: args.ownerSubjectId,
      runId: args.runId,
      log: args.log as Console,
      ...(recordOutcome ? { recordOutcome } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.log.warn?.(`[controller] web push fire for run ${args.runId} failed: ${message}`);
  }
}

async function fireAssistanceWebPush(args: {
  assistance: Record<string, unknown>;
  connectorDisplayName: string;
  ownerSubjectId: string;
  runId: string;
  log: ControllerLogger;
}): Promise<void> {
  try {
    const { fanoutAssistanceWebPush } = await import("../server/web-push-notifications.js");
    const requestId =
      typeof args.assistance.assistance_request_id === "string"
        ? (args.assistance.assistance_request_id as string)
        : null;
    const recordOutcome = await buildAttentionOutcomeRecorder({ runId: args.runId, requestId });
    await fanoutAssistanceWebPush({
      assistance: args.assistance,
      connectorDisplayName: args.connectorDisplayName,
      ownerSubjectId: args.ownerSubjectId,
      runId: args.runId,
      log: args.log as Console,
      ...(recordOutcome ? { recordOutcome } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.log.warn?.(`[controller] web push assistance fire for run ${args.runId} failed: ${message}`);
  }
}

function detachControllerTask(task: Promise<unknown>): void {
  task.catch(() => {
    // Best-effort controller fanout tasks log internally before settling.
  });
}

// Decide whether a manual-run progress message should fan out a nonblocking
// owner-assistance Web Push. Mirrors `shouldFanoutAssistanceProgress` in the
// server module so we can filter without paying the dynamic-import cost on
// every progress tick.
export function shouldFanoutAssistanceProgressMessage(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const m = message as Record<string, unknown>;
  if (m.type !== "ASSISTANCE") {
    return false;
  }
  if (m.response_contract !== "none") {
    return false;
  }
  if (typeof m.owner_action !== "string" || m.owner_action === "none") {
    return false;
  }
  return m.progress_posture === "running" || m.progress_posture === "blocked";
}

function brokerInteraction(
  runId: string,
  connectorId: string,
  interaction: RuntimeInteraction,
  notifyArgs?: { connectorDisplayName: string; log: ControllerLogger; ownerSubjectId: string }
): Promise<InteractionResponse> {
  return new Promise((resolve) => {
    const entry = activeRunInteractions.get(runId) ?? { connector_id: connectorId, pending: null };
    if (entry.pending) {
      resolve({
        type: "INTERACTION_RESPONSE",
        request_id: interaction.request_id,
        status: "cancelled",
      });
      return;
    }

    entry.connector_id = connectorId;
    entry.pending = {
      interaction_id: interaction.request_id,
      kind: interaction.kind,
      stream: interaction.stream || null,
      resolve,
    };
    activeRunInteractions.set(runId, entry);

    // Fire-and-forget ntfy push. Keyed off NEW pending interactions only —
    // the early-return above handles the "already pending" case before this
    // line runs. Failure of `fireNtfy` is internally swallowed to keep
    // interaction handling unaffected; we discard the promise on purpose.
    if (notifyArgs) {
      detachControllerTask(
        fireNtfy({
          interaction,
          connectorDisplayName: notifyArgs.connectorDisplayName,
          runId,
          log: notifyArgs.log,
        })
      );
      detachControllerTask(
        fireWebPush({
          interaction,
          connectorDisplayName: notifyArgs.connectorDisplayName,
          ownerSubjectId: notifyArgs.ownerSubjectId,
          runId,
          log: notifyArgs.log,
        })
      );
    }
  });
}

export function __resetControllerInteractionStateForTests(): void {
  activeRunInteractions.clear();
  activeRuns.clear();
  activeRunPromises.clear();
  settledRunIds.clear();
  for (const timer of activeRunWatchdogTimers.values()) {
    clearTimeout(timer);
  }
  activeRunWatchdogTimers.clear();
  runGenerations.clear();
  needsHumanAttention.clear();
}

export function isNeedsHumanAttention(connectorId: string, options: ConnectorInstanceOptions = {}): boolean {
  return needsHumanAttention.has(runtimeKey(connectorId, options.connectorInstanceId));
}

function validateScheduleInput(input: ConnectorSchedulePatch | null | undefined): ValidatedSchedulePatch {
  const errors: { param: string; message: string }[] = [];
  const interval = Number.parseInt(String(input?.interval_seconds), 10);
  if (!Number.isInteger(interval) || interval < 1) {
    errors.push({
      param: "interval_seconds",
      message: "interval_seconds must be a positive integer",
    });
  }

  let jitter = 0;
  if (input?.jitter_seconds !== undefined) {
    jitter = Number.parseInt(String(input.jitter_seconds), 10);
    if (!Number.isInteger(jitter) || jitter < 0) {
      errors.push({
        param: "jitter_seconds",
        message: "jitter_seconds must be a non-negative integer",
      });
    }
  }

  let enabled = true;
  if (input?.enabled !== undefined) {
    if (input.enabled === true || input.enabled === false) {
      enabled = input.enabled;
    } else {
      errors.push({ param: "enabled", message: "enabled must be a boolean" });
    }
  }

  if (errors.length) {
    throw new ControllerError("Invalid schedule body", "invalid_request", { details: errors });
  }
  return { interval_seconds: interval, jitter_seconds: jitter, enabled };
}

function computeEffectiveMode(
  schedule: Schedule,
  runtimeProjection: RuntimeProjection | null
): "automatic" | "manual" | "paused" {
  if (!schedule.enabled) {
    return "paused";
  }
  if (runtimeProjection?.human_attention_needed) {
    return "paused";
  }
  return "automatic";
}

function buildMinimumIntervalWarning(intervalSeconds: number, policy: RefreshPolicy | null): string | null {
  if (!policy) {
    return null;
  }
  const minimum = policy.minimum_interval_seconds;
  const recommended = policy.recommended_interval_seconds;
  if (minimum !== undefined && intervalSeconds < minimum) {
    return `Interval ${intervalSeconds}s is below the connector's minimum recommended interval of ${minimum}s. This may cause rate-limiting or platform blocks.`;
  }
  if (recommended !== undefined && intervalSeconds < recommended) {
    return `Interval ${intervalSeconds}s is below the connector's recommended interval of ${recommended}s.`;
  }
  return null;
}

function computeNextDueAt(schedule: Schedule, lastFinishedAt: string | null): string | null {
  if (!lastFinishedAt) {
    return null;
  }
  const lastMs = Date.parse(lastFinishedAt);
  if (!Number.isFinite(lastMs)) {
    return null;
  }
  const intervalMs = Math.max(1, schedule.interval_seconds) * 1000;
  return new Date(lastMs + intervalMs).toISOString();
}

function toBackoffRunRecord(record: SchedulerRunHistoryRecord): RunRecord {
  const runRecord = {
    attempt: record.attempt,
    checkpointSummary: record.checkpointSummary,
    completedAt: record.completedAt,
    connectorError: record.connectorError ?? null,
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    failureReason: record.failureReason ?? null,
    knownGaps: record.knownGaps,
    recordsEmitted: record.recordsEmitted,
    reportedRecordsEmitted: record.reportedRecordsEmitted ?? null,
    runId: record.runId ?? null,
    source: {
      id: typeof record.source.id === "string" ? record.source.id : record.connectorId,
      kind: "connector" as const,
    },
    startedAt: record.startedAt,
    status: record.status,
    terminalReason: (record.terminalReason ?? null) as Exclude<RunRecord["terminalReason"], undefined>,
    traceId: record.traceId ?? null,
  };
  return record.error === undefined ? runRecord : { ...runRecord, error: record.error };
}

/**
 * §10-B: consecutive no-progress cooldown-cycle count for a connection, from the
 * max recovery attempt_count across its pending source-pressure gaps. The
 * attempt_count increments once per cooldown cycle that fails to recover the gap
 * and resets to 0 when the gap recovers (the pressure set empties), so it equals
 * "consecutive cycles with zero gap recovery" — the §10-B escalation trigger.
 */
function maxPressureGapAttemptCount(gaps: readonly PendingPressureGap[]): number {
  let max = 0;
  for (const gap of gaps ?? []) {
    const attempt = typeof gap?.attemptCount === "number" && Number.isFinite(gap.attemptCount) ? gap.attemptCount : 0;
    if (attempt > max) {
      max = attempt;
    }
  }
  return max;
}

function buildSchedulerBackoffApi(
  schedule: Schedule,
  facts: ScheduleHistoryFacts,
  ineligibilityReason: string | null
): SchedulerBackoffApi | null {
  if (!schedule.enabled || ineligibilityReason) {
    return null;
  }
  const lastRunTimeMs =
    facts.lastRunTimeMs ??
    (facts.latestFinishedAt && Number.isFinite(Date.parse(facts.latestFinishedAt))
      ? Date.parse(facts.latestFinishedAt)
      : null);
  if (lastRunTimeMs === null) {
    return null;
  }
  const intervalMs = Math.max(1, schedule.interval_seconds) * 1000;
  // Cross-path success recovery: surface the most recent genuine success so the
  // back-off gate clears a stale streak even when that success was recorded by
  // a path whose record has rolled off the bounded `recentRuns` window (or, on
  // a fresh boot, before the scheduler re-appended it). `latestSuccessfulAt`
  // already accounts for every success in `scheduler_run_history`; passing it
  // explicitly keeps this read-model's `consecutive_failures` honest with the
  // same semantic the runtime scheduler now applies. `null` → legacy behaviour.
  const lastSuccessAtMs =
    facts.latestSuccessfulAt && Number.isFinite(Date.parse(facts.latestSuccessfulAt))
      ? Date.parse(facts.latestSuccessfulAt)
      : null;
  const decision: BackoffDecision = computeNextRunWithBackoff(
    facts.recentRuns.map(toBackoffRunRecord),
    intervalMs,
    lastRunTimeMs,
    { lastSuccessAtMs }
  );

  // Blend in the cross-run source-pressure cooldown. A connection can have no
  // failure streak (so `decision.backoffApplied` is false) yet still carry
  // pending pressure gaps — without this blend the dashboard would render bare
  // green while the scheduler is deferring the run. The two governors are
  // combined conservatively: take whichever defers the next run further, and
  // never downgrade a `blocked` failure state (a chronic failure is stronger
  // than a recoverable cooldown).
  // §10-B no-progress escalation is now WIRED into the dashboard projection
  // (was dead before — neither call site passed the profile). Resolve the
  // connector's cooldown profile (never null) and feed the consecutive
  // no-progress cycle count, derived from the pending pressure gaps' max
  // recovery attempt_count (it increments once per unrecovered cooldown cycle
  // and resets when the gap recovers). This threads ADDITIVELY: it only sharpens
  // `recommended_health_state` (cooling_off → needs_attention for a dead-but-
  // 429ing provider), never the dispatch decision.
  const consecutiveCooldownCycles = maxPressureGapAttemptCount(facts.pendingPressureGaps);
  const cooldown: SourcePressureCooldownDecision = computeConnectionSourcePressureCooldown(
    schedule.connector_id,
    facts.pendingPressureGaps,
    intervalMs,
    lastRunTimeMs,
    { consecutiveCooldownCycles }
  );

  return mergeBackoffAndCooldown(decision, cooldown);
}

/**
 * Merge the failure-back-off decision and the source-pressure cooldown into a
 * single `SchedulerBackoffApi`. The dashboard consumes only this shape, so the
 * merge is where cross-run pressure becomes an honest `cooling_off` pill.
 */
function mergeBackoffAndCooldown(
  decision: BackoffDecision,
  cooldown: SourcePressureCooldownDecision
): SchedulerBackoffApi {
  const backoffNextMs = Date.parse(decision.nextRunAt);
  const cooldownNextMs = Date.parse(cooldown.nextRunAt);
  const cooldownDefersNow = isSourcePressureCooldownDeferring(cooldown);
  // Whichever governor pushes the next attempt out further wins the timestamp.
  const cooldownDefersFurther =
    cooldownDefersNow &&
    Number.isFinite(cooldownNextMs) &&
    (!Number.isFinite(backoffNextMs) || cooldownNextMs >= backoffNextMs);
  const nextRunAt = cooldownDefersFurther ? cooldown.nextRunAt : decision.nextRunAt;

  // `blocked` (chronic failure) is the strongest state and is never softened.
  // §10-B: `needs_attention` from the cooldown governor (dead-but-429ing
  // provider exhausted its maxCooldownCycles budget) surfaces here — it is
  // stronger than plain `cooling_off` but weaker than `blocked`.
  // Otherwise, if either governor is cooling, surface `cooling_off`.
  let recommendedHealthState: SchedulerBackoffApi["recommended_health_state"];
  if (decision.recommendedHealthState === "blocked") {
    recommendedHealthState = "blocked";
  } else if (cooldown.recommendedHealthState === "needs_attention") {
    // §10-B escalation: cooldown has exhausted its no-progress cycle budget.
    recommendedHealthState = "needs_attention";
  } else if (decision.recommendedHealthState === "cooling_off" || cooldownDefersNow) {
    recommendedHealthState = "cooling_off";
  } else {
    recommendedHealthState = null;
  }

  // Preserve the failure reason class when back-off is engaged; otherwise, when
  // the cooldown is the sole driver, label it so the dashboard/audit can
  // distinguish a source-pressure pause from a failure streak.
  let reasonClass = decision.reasonClass;
  if (!decision.backoffApplied && cooldownDefersNow) {
    reasonClass = "source_pressure";
  }

  return {
    backoff_applied: decision.backoffApplied || cooldownDefersNow,
    consecutive_failures: decision.consecutiveFailures,
    next_run_at: nextRunAt,
    reason_class: reasonClass,
    recommended_health_state: recommendedHealthState,
  };
}

function scheduleToApi(
  schedule: Schedule | null,
  runtimeProjection: RuntimeProjection | null = null,
  policy: RefreshPolicy | null = null,
  historyFacts: ScheduleHistoryFacts = EMPTY_SCHEDULE_HISTORY_FACTS
): ScheduleApi | null {
  if (!schedule) {
    return null;
  }
  const effectiveMode = computeEffectiveMode(schedule, runtimeProjection);
  const humanAttentionNeeded = runtimeProjection?.human_attention_needed ?? false;
  const automationPolicy = projectRunAutomationPolicy({
    triggerKind: "scheduled",
    refreshPolicy: policy,
    humanAttentionNeeded,
  });
  const minimumIntervalWarning = buildMinimumIntervalWarning(schedule.interval_seconds, policy);
  // If the row is enabled but the connector's current manifest policy makes
  // automatic runs ineligible, surface the same reason the controller uses
  // when rejecting create/resume and the scheduler uses when skipping. This
  // keeps persisted operator intent visible while making it explicit that
  // the row will not actually run under the current policy.
  const ineligibilityReason = schedule.enabled ? getScheduleIneligibilityReason(policy) : null;
  // Projected next-due timestamp: `last_finished_at + interval_seconds`.
  // The runtime scheduler computes the real dispatch instant from its own
  // back-off state machine, which can push next-due further out under a
  // failing streak; this projection is the floor under those decisions and
  // is honest about "we ran X seconds ago, the row is not yet due to fire
  // again". `null` only when there is no persisted last-run anchor at all,
  // which the doctor / dashboard read as "never_ran".
  //
  // When `ineligibilityReason` is set, the scheduler manager filters this
  // connector out of the runnable set: no automatic run will fire under
  // the current manifest policy. Suppressing `next_due_at` here keeps the
  // schedule envelope honest (operators are not told a row will fire at
  // some future timestamp that the runtime has no intention of honoring),
  // and pairs with `last_error_code` suppression below: the gate is the
  // current authoritative status, not whatever historical failure code
  // happens to sit at the top of the persisted history.
  const lastFinishedAt = runtimeProjection?.last_finished_at || null;
  const nextDueAt = schedule.enabled && !ineligibilityReason ? computeNextDueAt(schedule, lastFinishedAt) : null;
  const schedulerBackoff = buildSchedulerBackoffApi(schedule, historyFacts, ineligibilityReason);
  // Historical run timestamps (`last_started_at`, `last_finished_at`,
  // `last_successful_at`) remain truthful audit anchors and stay surfaced
  // even for a gated row -- they describe what already happened, not
  // what is about to happen. `last_error_code`, however, advertises a
  // *current* failure mode to the dashboard amber chip and the doctor
  // JSON. Once a manifest gate has taken over as the active reason the
  // row will not run, the prior `schedule.gave_up` / `not_ready` /
  // backoff code is stale operator-misleading state: it implies the
  // scheduler is still actively failing this connector when in fact it
  // has been administratively benched. Suppress it for ineligible rows.
  const lastErrorCode = ineligibilityReason ? null : runtimeProjection?.last_error_code || null;
  return {
    object: "schedule",
    connector_id: schedule.connector_id,
    connector_instance_id: schedule.connector_instance_id,
    automation_mode: automationPolicy.automation_mode,
    automation_summary: automationModeCopy(automationPolicy.automation_mode),
    interval_seconds: schedule.interval_seconds,
    jitter_seconds: schedule.jitter_seconds,
    enabled: schedule.enabled,
    created_at: schedule.created_at,
    updated_at: schedule.updated_at,
    next_due_at: nextDueAt,
    notification_posture: automationPolicy.notification_posture,
    active_run_id: runtimeProjection?.active_run_id || null,
    ...(runtimeProjection?.browser_surface_status
      ? {
          browser_surface_status: runtimeProjection.browser_surface_status,
          pending_run_id: runtimeProjection.pending_run_id,
          browser_surface_lease_id: runtimeProjection.browser_surface_lease_id,
          browser_surface_profile_key: runtimeProjection.browser_surface_profile_key,
          ...(runtimeProjection.browser_surface_wait_reason
            ? { browser_surface_wait_reason: runtimeProjection.browser_surface_wait_reason }
            : {}),
        }
      : {}),
    last_started_at: runtimeProjection?.last_started_at || null,
    last_finished_at: runtimeProjection?.last_finished_at || null,
    last_error_code: lastErrorCode,
    last_successful_at: runtimeProjection?.last_successful_at || null,
    effective_mode: effectiveMode,
    human_attention_needed: humanAttentionNeeded,
    ineligibility_reason: ineligibilityReason,
    recommended_policy: policy,
    scheduler_backoff: schedulerBackoff,
    minimum_interval_warning: minimumIntervalWarning,
    trigger_kind: "scheduled",
  };
}

// ─── Controller factory ─────────────────────────────────────────────────────

/**
 * Create a new controller instance.
 */
export function createController(opts: ControllerOptions = {}): Controller {
  const log: ControllerLogger = opts.logger || console;
  const resolveConnectorPath = opts.connectorPathResolver || resolveDefaultConnectorPath;
  const ownerClientId = opts.ownerClientId || "cli_longview";
  const ownerSubjectId = opts.ownerSubjectId || "owner_local";
  const schedulerStore = opts.schedulerStore || getDefaultSchedulerStore();
  const detailGapStore: ConnectorDetailGapReadStore = opts.detailGapStore || getDefaultConnectorDetailGapStore();
  const browserSurfaceAllocator = opts.browserSurfaceAllocator;
  const browserSurfaceLeaseManager = opts.browserSurfaceLeaseManager;
  const browserSurfaceReadinessTimeoutMs = opts.browserSurfaceReadinessTimeoutMs;
  const browserSurfaceLeaseStore = opts.browserSurfaceLeaseStore;
  // Default is `null` — disabled unless explicitly wired. The production
  // path (`resolveNekoBrowserSurfaceControllerOptions` in server/index.js)
  // installs the default HTTP probe; tests opt in only when they exercise
  // probe behavior. This keeps the readiness gate from running against
  // a fake n.eko url in every controller test.
  const browserSurfaceReadinessProbe: BrowserSurfaceReadinessProbe | null =
    opts.browserSurfaceReadinessProbe === undefined ? null : opts.browserSurfaceReadinessProbe;
  const browserSurfaceMidWaitPollIntervalMs = opts.browserSurfaceMidWaitPollIntervalMs;
  const runConnectorImpl = opts.runConnectorImpl || runConnector;
  // Wall-clock watchdog budget per run. Resolves from opts first, then the
  // PDPP_MAX_RUN_WALL_CLOCK_MS env var, then a safe 4-hour default. Infinity
  // disables the watchdog entirely (tests set this to avoid real timers).
  //
  // The watchdog exists to reclaim a HUNG run (one that never terminates), not
  // to right-size healthy runs — so the ceiling must sit safely above the
  // longest LEGITIMATE run. Observed live run durations (scheduler_run_history,
  // succeeded): gmail max ~6 860 s (~1.9 h), github ~5 040 s (~1.4 h). A 1-hour
  // default would have force-failed real gmail/github runs. 4 hours is ~2x the
  // observed worst case with headroom; a genuinely hung run never terminates,
  // so the wider ceiling still catches it. Tying this to a connector's
  // `maximum_staleness_seconds` would be wrong — that is a data-freshness
  // cadence, not a single-run duration budget.
  const maxRunWallClockMs = (() => {
    if (opts.maxRunWallClockMs !== undefined) {
      return opts.maxRunWallClockMs;
    }
    const envVal = process.env.PDPP_MAX_RUN_WALL_CLOCK_MS;
    if (envVal !== undefined) {
      if (envVal === "Infinity") {
        return Number.POSITIVE_INFINITY;
      }
      const parsed = Number(envVal);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`PDPP_MAX_RUN_WALL_CLOCK_MS must be a non-negative number or "Infinity", got ${envVal}`);
      }
      return parsed;
    }
    return 14_400_000; // 4 hour default (>2x longest observed legitimate run)
  })();
  const pendingBrowserSurfaceLaunches = new Map<string, RunNowOptions>();
  const activeRunTraceContexts = new Map<string, SpineTraceContext>();
  // Per-run owner-cancel controllers, keyed by run_id. `runNow` creates one
  // AbortController per run and threads its signal into `runConnector`;
  // `cancelRun` aborts only the targeted run's controller; `finalizeRunCleanup`
  // deletes the entry when the run settles. Scoped to a single run so a cancel
  // never touches sibling runs. See add-owner-run-cancellation-control.
  const activeRunCancellations = new Map<string, AbortController>();

  // `runtime` and `scheduler` are declared in ControllerOptions as hooks
  // for a later slice that will wire runtime state into the schedule
  // projections (next_due_at, last_finished_at, last_error_code). Until
  // then we accept them in the type but don't read them here.

  function listPersistedActiveRuns(): Promise<readonly PersistedActiveRun[]> {
    return Promise.resolve(schedulerStore.listActiveRuns());
  }

  async function persistActiveRun(record: PersistedActiveRun): Promise<void> {
    await schedulerStore.upsertActiveRun(record);
  }

  async function clearPersistedActiveRun(connectorInstanceId: string, runId: string): Promise<void> {
    await schedulerStore.deleteActiveRun(connectorInstanceId, runId);
  }

  async function runAlreadyTerminal(runId: string): Promise<boolean> {
    if (isPostgresStorageBackend()) {
      const { rows } = await postgresQuery(
        `
        SELECT 1 AS present
        FROM spine_events
        WHERE run_id = $1
          AND event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
        LIMIT 1
        `,
        [runId]
      );
      return Boolean(rows[0]);
    }

    const row = getOne<TerminalRunRow>(referenceQueries.spineCheckRunTerminal, [runId]);
    return Boolean(row);
  }

  async function reconcileAbandonedControllerRuns(): Promise<void> {
    const rows = await listPersistedActiveRuns();
    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      if (!(await runAlreadyTerminal(row.run_id))) {
        try {
          await emitSpineEvent({
            event_type: "run.failed",
            trace_id: row.trace_id,
            scenario_id: row.scenario_id,
            actor_type: "runtime",
            actor_id: row.connector_id,
            object_type: "run",
            object_id: row.run_id,
            status: "failed",
            run_id: row.run_id,
            data: {
              source: buildRunSource(row.connector_id),
              reason: ABANDONED_CONTROLLER_RUN_REASON,
              failure_reason: ABANDONED_CONTROLLER_RUN_REASON,
              message: "Reference server restarted while a controller-managed run was still active.",
            },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn?.(`[controller] failed to emit restart reconciliation event for ${row.run_id}: ${message}`);
        }
      }
      await clearPersistedActiveRun(row.connector_instance_id ?? row.connector_id, row.run_id);
    }

    for (const row of rows) {
      log.warn?.(`[controller] reconciled abandoned controller-managed run ${row.run_id} for ${row.connector_id}`);
    }
  }

  const startupControllerRunReconciliation = reconcileAbandonedControllerRuns().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn?.(`[controller] failed to reconcile abandoned controller-managed runs: ${message}`);
  });

  function getScheduleRecord(connectorId: string): Promise<Schedule | null> {
    return Promise.resolve(schedulerStore.getSchedule(connectorId));
  }

  function currentRsUrl(override: string | undefined): string {
    if (override) {
      return override;
    }
    if (typeof opts.rsUrl === "string" && opts.rsUrl) {
      return opts.rsUrl;
    }
    const contextUrl = opts.runtimeContext?.rsUrl;
    if (typeof contextUrl === "string" && contextUrl) {
      return contextUrl;
    }
    return process.env.RS_URL || "http://localhost:7663";
  }

  /**
   * Resolve the AS base URL the spawned connector child should PUT its
   * streaming-target registration to. Read lazily because the surrounding
   * server populates `runtimeContext.referenceBaseUrl` AFTER its listener
   * has actually allocated a port (the same pattern `runtimeContext.rsUrl`
   * uses).
   *
   * IMPORTANT: this URL is for SERVER-TO-SERVER traffic between the
   * connector child and the AS Fastify listener (both on the same host
   * in Mode A). It is NOT the browser-facing public URL. In composed
   * deployments the two differ — the public URL points at a Next.js
   * webapp that does not proxy
   * `/admin/runs/:runId/interactions/:interactionId/streaming-target`,
   * so passing the public URL here surfaces as a silent registration
   * 404 and `companion_start_failed` later. The server populates
   * `runtimeContext.referenceBaseUrl` with the AS loopback URL for
   * exactly this reason; we no longer fall back to `opts.asPublicUrl`
   * or `PDPP_REFERENCE_ORIGIN` (both are public/browser-facing URLs).
   *
   * Returns `null` when the context URL is not yet populated so
   * `runConnector` skips the env block entirely.
   */
  function currentReferenceBaseUrl(): string | null {
    const contextUrl = opts.runtimeContext?.referenceBaseUrl;
    if (typeof contextUrl === "string" && contextUrl) {
      return contextUrl;
    }
    return null;
  }

  async function issueRuntimeOwnerToken(): Promise<string> {
    const device = await initiateOwnerDeviceAuthorization(ownerClientId, {
      baseUrl: opts.asPublicUrl || process.env.AS_PUBLIC_URL || undefined,
    });
    const approved = await approveOwnerDeviceAuthorization(device.user_code, ownerSubjectId);
    return approved.access_token;
  }


  const browserSurface = createBrowserSurfaceManager({
    activeRunInteractions,
    browserSurfaceAllocator: browserSurfaceAllocator ?? null,
    browserSurfaceLeaseManager: browserSurfaceLeaseManager ?? null,
    browserSurfaceLeaseStore: browserSurfaceLeaseStore ?? null,
    browserSurfaceMidWaitPollIntervalMs,
    browserSurfaceReadinessProbe,
    browserSurfaceReadinessTimeoutMs,
    listPersistedActiveRuns,
    log,
    pendingBrowserSurfaceLaunches,
    scheduleRun(connectorId, options, onFailure) {
      detachControllerTask(
        runNow(connectorId, options).catch(onFailure)
      );
    },
    startupControllerRunReconciliation,
  });


  async function getConnectorRefreshPolicy(connectorId: string): Promise<RefreshPolicy | null> {
    try {
      const manifest = await getConnectorManifest(connectorId);
      if (!manifest || typeof manifest !== "object") {
        return null;
      }
      const caps = (manifest as { capabilities?: unknown }).capabilities;
      if (!caps || typeof caps !== "object") {
        return null;
      }
      const policy = (caps as { refresh_policy?: unknown }).refresh_policy;
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        return null;
      }
      return policy as RefreshPolicy;
    } catch {
      return null;
    }
  }

  async function getLastRunTimeMs(connectorId: string, connectorInstanceId: string): Promise<number> {
    const [lastRunRows, historyRows] = await Promise.all([
      Promise.resolve(schedulerStore.listLastRunTimes()).catch(() => []),
      Promise.resolve(schedulerStore.listRunHistory(500)).catch(() => []),
    ]);
    let latest = 0;
    for (const row of lastRunRows ?? []) {
      if (!matchesConnectorInstance(row.connector_id, row.connector_instance_id, connectorId, connectorInstanceId)) {
        continue;
      }
      latest = Math.max(latest, parseEpochMs(row.last_run_time_ms));
    }
    for (const record of historyRows ?? []) {
      if (!matchesConnectorInstance(record.connectorId, record.connectorInstanceId, connectorId, connectorInstanceId)) {
        continue;
      }
      latest = Math.max(latest, parseIsoEpochMs(record.completedAt || record.startedAt));
    }
    return latest;
  }

  function matchesConnectorInstance(
    rowConnectorId: string | null | undefined,
    rowConnectorInstanceId: string | null | undefined,
    connectorId: string,
    connectorInstanceId: string
  ): boolean {
    if (rowConnectorInstanceId) {
      return rowConnectorInstanceId === connectorInstanceId;
    }
    return connectorInstanceId === connectorId && rowConnectorId === connectorId;
  }

  function parseEpochMs(value: unknown): number {
    const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
  }

  function parseIsoEpochMs(value: unknown): number {
    if (typeof value !== "string" || value.length === 0) {
      return 0;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  // Bounded once-per-call slice of recent run history. 500 is the same
  // upper bound the scheduler runtime uses when hydrating its in-memory
  // history projection (`scheduler.ts::hydratePersistence`), so the
  // controller's read tracks the same operator-visible window without
  // pulling unbounded rows.
  const SCHEDULE_HISTORY_PROJECTION_LIMIT = 500;
  async function loadScheduleHistoryIndex(): Promise<ScheduleHistoryIndex> {
    // One bounded read of recent run history, grouped per connector. The
    // store returns rows in chronological order (oldest to newest); we walk
    // newest-first so the first row we see for each (connector, kind)
    // wins. `listLastRunTimes` covers connectors that have a persisted
    // last-run timestamp but whose history rows have rolled off the
    // bounded window; it surfaces `last_finished_at` honestly in that
    // case so the dashboard does not regress to "never ran".
    const [history, lastRunTimes] = await Promise.all([
      Promise.resolve(schedulerStore.listRunHistory(SCHEDULE_HISTORY_PROJECTION_LIMIT)),
      Promise.resolve(schedulerStore.listLastRunTimes()),
    ]);
    const facts = new Map<string, MutableScheduleHistoryFacts>();
    const ensure = (connectorId: string) => ensureScheduleHistoryFacts(facts, connectorId);
    hydrateScheduleHistoryFromLastRunTimes(lastRunTimes, ensure);
    bucketRecentRunsByConnector(history, ensure);
    deriveLatestScheduleFacts(history, ensure);
    await attachPendingPressureGaps(history, lastRunTimes, ensure);
    return facts;
  }

  // One bounded pending-gap read per distinct connector type, bucketed onto the
  // per-instance facts so the cooldown projection can render `cooling_off`. A
  // probe failure is swallowed (best-effort, like the rest of the projection):
  // an unreadable gap store must not erase the honest history facts or crash
  // the records page — it just omits the cooldown overlay for that connector.
  async function attachPendingPressureGaps(
    history: readonly SchedulerRunHistoryRecord[],
    lastRunTimes: readonly SchedulerLastRunTimeRecord[],
    ensure: EnsureScheduleFacts
  ): Promise<void> {
    const connectorIds = collectConnectorIds(history, lastRunTimes);
    await Promise.all(
      [...connectorIds].map(async (connectorId) => {
        try {
          const gaps = (await detailGapStore.listPendingGapsForConnector(connectorId, { limit: 200 })) ?? [];
          bucketPressureGapsByInstance(gaps, connectorId, ensure);
        } catch (err) {
          console.error(
            `[controller] pending source-pressure gap read failed for ${connectorId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      })
    );
  }

  async function listSchedules(): Promise<ScheduleApi[]> {
    const schedules = await schedulerStore.listSchedules();
    // Single bounded read of run history + last-run-time map, indexed once
    // per `listSchedules()` call so per-connector projection avoids N+1
    // queries. The same indexer is reused by the single-row `getSchedule`
    // path with a smaller history slice.
    const historyIndex = await loadScheduleHistoryIndex();
    const apis = await Promise.all(
      schedules.map(async (schedule) => {
        const policy = await getConnectorRefreshPolicy(schedule.connector_id);
        const runtimeProjection = getRuntimeProjection(
          schedule.connector_id,
          schedule.connector_instance_id,
          browserSurfaceLeaseManager,
          historyIndex
        );
        return scheduleToApi(schedule, runtimeProjection, policy, historyIndex.get(schedule.connector_instance_id));
      })
    );
    return apis.flatMap((api) => (api ? [api] : []));
  }

  async function getSchedule(connectorId: string, options: ConnectorInstanceOptions = {}): Promise<ScheduleApi | null> {
    const resolvedConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || resolvedConnectorId;
    const directSchedule = await getScheduleRecord(connectorInstanceId);
    let schedule = directSchedule;
    if (!(schedule || options.connectorInstanceId)) {
      const matches = (await schedulerStore.listSchedules()).filter(
        (candidate) => candidate.connector_id === resolvedConnectorId
      );
      if (matches.length > 1) {
        throw new ControllerError(
          `Connector '${resolvedConnectorId}' has multiple schedules; provide connector_instance_id.`,
          "ambiguous_connector_instance"
        );
      }
      schedule = matches[0] ?? null;
    }
    if (!schedule) {
      return null;
    }
    const policy = await getConnectorRefreshPolicy(resolvedConnectorId);
    const historyIndex = await loadScheduleHistoryIndex();
    const runtimeProjection = getRuntimeProjection(
      resolvedConnectorId,
      schedule.connector_instance_id,
      browserSurfaceLeaseManager,
      historyIndex
    );
    return scheduleToApi(schedule, runtimeProjection, policy, historyIndex.get(schedule.connector_instance_id));
  }

  async function upsertSchedule(
    connectorId: string,
    input: ConnectorSchedulePatch,
    options: ConnectorInstanceOptions = {}
  ): Promise<ScheduleUpsertResult> {
    const resolvedConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || resolvedConnectorId;
    const now = nowIso();
    const validated = validateScheduleInput(input);
    const policy = await getConnectorRefreshPolicy(resolvedConnectorId);
    const ineligibilityReason = validated.enabled ? getScheduleIneligibilityReason(policy) : null;
    if (ineligibilityReason) {
      throw new ControllerError(ineligibilityReason, "invalid_request");
    }
    const existing = await getScheduleRecord(connectorInstanceId);
    if (existing) {
      await schedulerStore.updateSchedule(connectorInstanceId, {
        interval_seconds: validated.interval_seconds,
        jitter_seconds: validated.jitter_seconds,
        enabled: validated.enabled,
        updated_at: now,
      });
    } else {
      await schedulerStore.createSchedule({
        connector_instance_id: connectorInstanceId,
        connector_id: resolvedConnectorId,
        interval_seconds: validated.interval_seconds,
        jitter_seconds: validated.jitter_seconds,
        enabled: validated.enabled,
        created_at: now,
        updated_at: now,
      });
    }
    const historyIndex = await loadScheduleHistoryIndex();
    const schedule = scheduleToApi(
      await getScheduleRecord(connectorInstanceId),
      getRuntimeProjection(resolvedConnectorId, connectorInstanceId, browserSurfaceLeaseManager, historyIndex),
      policy,
      historyIndex.get(connectorInstanceId)
    );
    if (!schedule) {
      throw new ControllerError(
        `Schedule not found after upsert for connector: ${resolvedConnectorId}`,
        "internal_error"
      );
    }
    const policy_warning = buildMinimumIntervalWarning(validated.interval_seconds, policy);
    return { schedule, policy_warning };
  }

  async function setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options: ConnectorInstanceOptions = {}
  ): Promise<ScheduleApi | null> {
    const resolvedConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || resolvedConnectorId;
    const existing = await getScheduleRecord(connectorInstanceId);
    if (!existing) {
      throw new ControllerError(`Schedule not found for connector: ${resolvedConnectorId}`, "not_found");
    }
    const policy = await getConnectorRefreshPolicy(resolvedConnectorId);
    const ineligibilityReason = enabled ? getScheduleIneligibilityReason(policy) : null;
    if (ineligibilityReason) {
      throw new ControllerError(ineligibilityReason, "invalid_request");
    }
    await schedulerStore.setScheduleEnabled(connectorInstanceId, enabled, nowIso());
    const historyIndex = await loadScheduleHistoryIndex();
    return scheduleToApi(
      await getScheduleRecord(connectorInstanceId),
      getRuntimeProjection(
        resolvedConnectorId,
        existing.connector_instance_id,
        browserSurfaceLeaseManager,
        historyIndex
      ),
      policy
    );
  }

  function markNeedsHuman(connectorId: string, options: ConnectorInstanceOptions = {}): void {
    needsHumanAttention.add(runtimeKey(connectorId, options.connectorInstanceId));
  }

  function clearNeedsHuman(connectorId: string, options: ConnectorInstanceOptions = {}): void {
    needsHumanAttention.delete(runtimeKey(connectorId, options.connectorInstanceId));
  }

  async function deleteSchedule(connectorId: string, options: ConnectorInstanceOptions = {}): Promise<boolean> {
    const resolvedConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    const connectorInstanceId = options.connectorInstanceId || resolvedConnectorId;
    const existing = await getScheduleRecord(connectorInstanceId);
    if (!existing) {
      return false;
    }
    await schedulerStore.deleteSchedule(connectorInstanceId);
    return true;
  }

  function getActiveRun(connectorId: string, options: ConnectorInstanceOptions = {}): ActiveRun | null {
    return activeRuns.get(runtimeKey(connectorId, options.connectorInstanceId)) || null;
  }

  function findActiveRunByRunId(runId: string): ActiveRun | null {
    if (!runId) {
      return null;
    }
    // The active-run map is keyed by runtime key (connector/instance), not
    // run id; it holds at most one entry per connection, so this linear
    // scan is bounded by the number of concurrently active connections.
    for (const run of activeRuns.values()) {
      if (run.run_id === runId) {
        return run;
      }
    }
    return null;
  }
  function deriveCollectionState(syncState: { state?: unknown } | null): {
    readonly collectionMode: "full_refresh" | "incremental";
    readonly state: Record<string, unknown> | null;
  } {
    const rawState = syncState?.state;
    const state: Record<string, unknown> | null =
      rawState && typeof rawState === "object" && !Array.isArray(rawState) && Object.keys(rawState).length
        ? (rawState as Record<string, unknown>)
        : null;
    return { collectionMode: state ? "incremental" : "full_refresh", state };
  }

  function mintStreamingRegistrationNonce(runId: string): string | null {
    // Mode-A streaming-target registration: mint a per-run shared secret
    // before spawning the connector child. The hook stores its hash; the raw
    // nonce flows to the child via env (see runConnector below) and is
    // presented as a Bearer credential when the child registers its CDP
    // page-target wsUrl. 32 bytes of CSPRNG entropy yields a 64-char hex
    // token — enough that brute force across the run's lifetime is not a
    // credible threat. Hooks may be unset (older deployments, tests that
    // don't exercise streaming); when unset, no nonce is minted, the env
    // vars are not threaded, and Mode-A streaming gracefully no-ops.
    if (!opts.streamingTargetNonceHooks) {
      return null;
    }
    const nonce = randomBytes(32).toString("hex");
    try {
      opts.streamingTargetNonceHooks.registerNonce({ runId, nonce });
    } catch (err) {
      // Don't fail the run if the registry rejects (e.g. duplicate runId).
      // Streaming will simply be unavailable for this run.
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] streaming nonce register failed for ${runId}: ${message}`);
    }
    return nonce;
  }

  async function registerActiveRunBookkeeping(input: {
    readonly browserSurfaceLease: BrowserSurfaceLease | null;
    readonly connectorId: string;
    readonly connectorInstanceId: string;
    readonly key: string;
    readonly runId: string;
    readonly startedAt: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<string | null> {
    try {
      // Advance the fencing token for this connector_instance. Any previously
      // admitted run that somehow outlived reclaim (SIGTERM slow-exit, watchdog
      // mid-write race) is now stale by generation and its commit is refused.
      const prevGeneration = runGenerations.get(input.key) ?? 0;
      const newGeneration = prevGeneration + 1;
      runGenerations.set(input.key, newGeneration);
      await persistActiveRun({
        connector_instance_id: input.connectorInstanceId,
        connector_id: input.connectorId,
        run_id: input.runId,
        run_generation: newGeneration,
        trace_id: input.traceContext.trace_id,
        scenario_id: input.traceContext.scenario_id,
        started_at: input.startedAt,
      });
      activeRuns.set(input.key, {
        connector_id: input.connectorId,
        connector_instance_id: input.connectorInstanceId,
        run_id: input.runId,
        run_generation: newGeneration,
        trace_id: input.traceContext.trace_id,
        started_at: input.startedAt,
      });
      activeRunTraceContexts.set(input.runId, input.traceContext);
      activeRunInteractions.set(input.runId, {
        connector_id: input.connectorId,
        pending: null,
      });
      return mintStreamingRegistrationNonce(input.runId);
    } catch (err) {
      if (input.browserSurfaceLease) {
        await browserSurface.releaseLease(
          input.browserSurfaceLease,
          input.connectorId,
          input.runId,
          input.traceContext
        );
      }
      throw err;
    }
  }

  function clearStreamingNonceForRun(runId: string): void {
    // Clear the per-run streaming nonce. Idempotent at the registry level,
    // so the conditional here is just to avoid a needless call when
    // streaming hooks weren't wired up at all.
    if (!opts.streamingTargetNonceHooks) {
      return;
    }
    try {
      opts.streamingTargetNonceHooks.clearNonce({ runId });
    } catch {
      /* registry shutdown raced run end — safe to ignore */
    }
  }

  function resolveCancelledInteraction(runId: string): void {
    const leftover = activeRunInteractions.get(runId);
    activeRunInteractions.delete(runId);
    if (leftover?.pending) {
      leftover.pending.resolve({
        type: "INTERACTION_RESPONSE",
        request_id: leftover.pending.interaction_id,
        status: "cancelled",
      });
    }
  }

  async function finalizeRunCleanup(input: {
    readonly browserSurfaceLease: BrowserSurfaceLease | null;
    readonly connectorId: string;
    readonly connectorInstanceId: string;
    readonly key: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }): Promise<void> {
    // Idempotency guard: the watchdog and the run's own .finally() can both
    // call finalizeRunCleanup. Only the first call does real work; subsequent
    // calls are silent no-ops. We detect "already finalized" by checking
    // whether the key is still in activeRuns (the primary liveness signal).
    if (!activeRuns.has(input.key)) {
      // Already cleaned up (watchdog fired first, or called twice). Ensure
      // the settled marker is present regardless.
      settledRunIds.add(input.runId);
      return;
    }
    // Clear the watchdog timer for this run so a normal completion that beats
    // the deadline never fires the watchdog afterwards.
    const watchdogTimer = activeRunWatchdogTimers.get(input.runId);
    if (watchdogTimer !== undefined) {
      clearTimeout(watchdogTimer);
      activeRunWatchdogTimers.delete(input.runId);
    }
    // Mark settled BEFORE deleting from activeRuns so the 409 guard's
    // reconciliation window is as short as possible.
    settledRunIds.add(input.runId);
    activeRuns.delete(input.key);
    activeRunPromises.delete(input.runId);
    activeRunTraceContexts.delete(input.runId);
    activeRunCancellations.delete(input.runId);
    clearPersistedActiveRun(input.connectorInstanceId, input.runId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn?.(`[controller] failed to clear active run ${input.runId} for ${input.connectorId}: ${message}`);
    });
    clearStreamingNonceForRun(input.runId);
    if (input.browserSurfaceLease) {
      await browserSurface.releaseLease(
        input.browserSurfaceLease,
        input.connectorId,
        input.runId,
        input.traceContext
      );
    }
    resolveCancelledInteraction(input.runId);
  }

  /**
   * Guards the 409 run_already_active check against stale in-memory entries.
   *
   * A stale entry arises when the watchdog force-finalizes a hung run but the
   * `activeRuns` map still contains the entry (race between the watchdog's async
   * emitAndFinalize and the next run-now call). The entry is stale when its
   * run_id appears in `settledRunIds` (marked by finalizeRunCleanup) or when
   * there is no corresponding `activeRunPromises` entry (promise already gone).
   *
   * - If stale: clears the orphaned map entries and returns (allows new run).
   * - If live: throws 409 run_already_active.
   * - If absent: returns (no conflict).
   */
  function assertNoConflictingActiveRun(key: string): void {
    const existing = activeRuns.get(key);
    if (!existing) {
      return;
    }
    const isStale = settledRunIds.has(existing.run_id) || !activeRunPromises.has(existing.run_id);
    if (isStale) {
      log.warn?.(
        `[controller] reclaiming stale activeRuns entry for ${existing.connector_id} (run_id=${existing.run_id}); allowing new run`
      );
      activeRuns.delete(key);
      activeRunPromises.delete(existing.run_id);
      settledRunIds.delete(existing.run_id);
    } else {
      throw new ControllerError(`Connector already has an active run: ${existing.run_id}`, "run_already_active", {
        runId: existing.run_id,
      });
    }
  }

  async function validateRunNowPreconditions(
    connectorId: string,
    options: RunNowOptions,
    key: string
  ): Promise<{ readonly connectorPath: string; readonly manifest: ConnectorManifest }> {
    const manifest = options.manifest ?? (await getConnectorManifest(connectorId));
    if (!manifest) {
      throw new ControllerError(`Unknown connector: ${connectorId}`, "not_found");
    }
    assertNoConflictingActiveRun(key);

    // Provider-pressure cooldown gate. Ordinary manual runs respect the same
    // cross-run cooldown the scheduler uses. An explicit `force: true` bypasses
    // it (a separately-named action, never the default "Sync now" button).
    if (!options.force) {
      const connectorInstanceId = options.connectorInstanceId || connectorId;
      const pendingGapRows = await Promise.resolve(
        detailGapStore.listPendingGapsForConnector(connectorId, { limit: 200 })
      );
      const pendingPressureGaps: PendingPressureGap[] = pendingGapRows
        .filter((row) => (row.connector_instance_id || connectorId) === connectorInstanceId)
        .filter((row) => typeof row.reason === "string" && SOURCE_PRESSURE_GAP_REASONS.has(row.reason))
        .map((row) => ({
          reason: row.reason as string,
          attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : null,
          nextAttemptAfter: typeof row.next_attempt_after === "string" ? row.next_attempt_after : null,
          lastPressureAt:
            typeof row.last_attempt_at === "string"
              ? row.last_attempt_at
              : typeof row.updated_at === "string"
                ? row.updated_at
                : null,
        }));

      if (pendingPressureGaps.length > 0) {
        // Use base interval 0 when no schedule is known — the cooldown still
        // computes a valid decision and any connector-authored
        // nextAttemptAfter floor is honoured.
        const schedule = await Promise.resolve(schedulerStore.getSchedule(connectorInstanceId)).catch(() => null);
        const baseIntervalMs = schedule ? Math.max(1, schedule.interval_seconds) * 1000 : 0;
        const lastRunTimeMs = await getLastRunTimeMs(connectorId, connectorInstanceId);
        // Route through the connection variant so the profile is resolved +
        // asserted (no bare cooldown call can bypass §10-B). This gate only
        // reads `isSourcePressureCooldownDeferring`, so the escalation health
        // state is unused here — but using one production entry keeps the seam
        // uniform.
        const cooldown = computeConnectionSourcePressureCooldown(
          connectorId,
          pendingPressureGaps,
          baseIntervalMs,
          lastRunTimeMs,
          { consecutiveCooldownCycles: maxPressureGapAttemptCount(pendingPressureGaps) }
        );
        if (isSourcePressureCooldownDeferring(cooldown)) {
          throw new ControllerError(
            `Provider pressure cooldown active — next eligible retry at ${cooldown.nextRunAt}. ` +
              `Use force: true to override. Pending pressure gaps: ${cooldown.pendingPressureGapCount}.`,
            "provider_pressure_cooldown",
            {
              nextEligibleAt: cooldown.nextRunAt,
              pendingPressureGapCount: cooldown.pendingPressureGapCount,
            }
          );
        }
      }
    }

    const connectorPath = await Promise.resolve(resolveConnectorPath(connectorId, manifest, options));
    if (!connectorPath) {
      throw new ControllerError(`No runnable connector implementation is available for ${connectorId}`, "not_found");
    }
    return { connectorPath, manifest };
  }

  /**
   * Arms the wall-clock watchdog for a run. If the run does not reach terminal
   * state within `maxRunWallClockMs`, the watchdog:
   *   1. Aborts the run's cancellation signal (requests cooperative subprocess exit).
   *   2. Emits a typed `run.failed` (reason: `run_timed_out`) terminal spine event.
   *   3. Calls `finalizeRunCleanup` to clear the in-memory and DB active-run entry.
   *
   * No-op when `maxRunWallClockMs` is not a positive finite number (Infinity disables).
   * The timer is `.unref()`'d so it never prevents a clean process exit.
   * `finalizeRunCleanup` is idempotent — both the watchdog and the run's own `.finally()`
   * can call it safely.
   */
  function armRunWatchdog(input: {
    readonly browserSurfaceLease: BrowserSurfaceLease | null;
    readonly connectorId: string;
    readonly connectorInstanceId: string;
    readonly key: string;
    readonly runId: string;
    readonly traceContext: SpineTraceContext;
  }): void {
    if (!Number.isFinite(maxRunWallClockMs) || maxRunWallClockMs <= 0) {
      return;
    }
    const { browserSurfaceLease, connectorId, connectorInstanceId, key, runId, traceContext } = input;
    const watchdogTimer = setTimeout(() => {
      activeRunWatchdogTimers.delete(runId);
      if (!activeRuns.has(key)) {
        return;
      }
      log.warn?.(
        `[controller] watchdog: run ${runId} for ${connectorId} exceeded ${maxRunWallClockMs}ms wall-clock budget; force-finalizing`
      );
      const cancellation = activeRunCancellations.get(runId);
      if (cancellation && !cancellation.signal.aborted) {
        try {
          cancellation.abort();
        } catch {
          /* idempotent */
        }
      }
      const emitAndFinalize = async () => {
        try {
          if (!(await runAlreadyTerminal(runId))) {
            await emitSpineEvent({
              event_type: "run.failed",
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: "runtime",
              actor_id: connectorId,
              object_type: "run",
              object_id: runId,
              status: "failed",
              run_id: runId,
              data: {
                source: buildRunSource(connectorId),
                reason: "run_timed_out",
                failure_reason: "run_timed_out",
                records_emitted: 0,
                message: `Run exceeded the ${maxRunWallClockMs}ms wall-clock budget and was force-terminated by the watchdog.`,
              },
            });
          }
        } catch (emitErr) {
          const emitMessage = emitErr instanceof Error ? emitErr.message : String(emitErr);
          log.warn?.(`[controller] watchdog: failed to emit run_timed_out terminal for ${runId}: ${emitMessage}`);
        }
        await finalizeRunCleanup({ browserSurfaceLease, connectorId, connectorInstanceId, key, runId, traceContext });
      };
      emitAndFinalize().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn?.(`[controller] watchdog: emitAndFinalize failed for ${runId}: ${message}`);
      });
    }, maxRunWallClockMs);
    if (watchdogTimer.unref) {
      watchdogTimer.unref();
    }
    activeRunWatchdogTimers.set(runId, watchdogTimer);
  }

  function normalizeRunNowResources(
    resources: Readonly<Record<string, readonly string[]>> | undefined
  ): Array<{ name: string; resources: string[] }> | null {
    if (!resources) {
      return null;
    }
    const streams = Object.entries(resources)
      .map(([name, values]) => ({
        name,
        resources: [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))],
      }))
      .filter(
        (stream) =>
          stream.name.length > 0 &&
          stream.name !== "__proto__" &&
          stream.name !== "constructor" &&
          stream.name !== "prototype" &&
          stream.resources.length > 0
      );
    return streams.length > 0 ? streams : null;
  }

  async function runNow(connectorId: string, options: RunNowOptions = {}): Promise<RunNowResult> {
    const connectorInstanceId = options.connectorInstanceId || connectorId;
    const key = runtimeKey(connectorId, connectorInstanceId);
    const { manifest, connectorPath } = await validateRunNowPreconditions(connectorId, options, key);

    const triggerKind = options.triggerKind ?? "manual";
    const automationMetadata = runAutomationMetadata(readManifestRefreshPolicy(manifest), triggerKind);
    const traceContext =
      options.traceContext ??
      (options.scenarioId ? createTraceContext({ scenarioId: options.scenarioId }) : createTraceContext());
    const runId = options.runId || `run_${Date.now()}`;
    const startedAt = nowIso();

    // Resolve connection-scoped static-secret credentials before acquiring any
    // managed runtime resources. A resolver throw is fail-closed for true
    // static-secret sources, refusing the run before it can fall through to a
    // deployment-wide provider-account secret. A `null` return means either the
    // connector is not static-secret-backed or this browser-session source has
    // no optional stored login credential.
    const staticSecretEnv = opts.resolveStaticSecretRunEnv
      ? await opts.resolveStaticSecretRunEnv({ connectorId, connectorInstanceId, ownerSubjectId })
      : null;
    const usedStaticSecret = Boolean(staticSecretEnv && Object.keys(staticSecretEnv).length > 0);

    const acquireResult = browserSurfaceLeaseManager?.isManagedConnector(connectorId)
      ? await browserSurface.acquireManagedBrowserSurfaceForRun({
          automationMetadata,
          connectorId,
          connectorInstanceId,
          manifest,
          options,
          runId,
          traceContext,
        })
      : ({ kind: "ready" as const, lease: null, env: null });
    if (acquireResult.kind === "early_return") {
      return acquireResult.result;
    }
    const browserSurfaceLease = acquireResult.lease;
    const browserSurfaceEnv = acquireResult.env;

    // State must be read from the connection-instance namespace, not by
    // caller convention. `getSyncState` keys storage off the *storage target*
    // (its first argument); a bare `connectorId` string falls back to the
    // default-account instance id and silently ignores any `connectorInstanceId`
    // option. Pass an explicit `{ connector_id, connector_instance_id }` object
    // so an explicit connection run reads its own durable state and defaults to
    // incremental when that state is non-empty.
    const { state, collectionMode } = deriveCollectionState(
      (await getSyncState({
        connector_id: connectorId,
        connector_instance_id: connectorInstanceId,
      })) as { state?: unknown } | null
    );
    const ownerToken = options.ownerToken || (await issueRuntimeOwnerToken());
    const scopedResources = normalizeRunNowResources(options.resources);

    // Manual owner gestures clear any pending human-attention flag so the
    // scheduler can resume after the owner resolves the issue. Webhook
    // triggers are external automation and must not silently clear this gate.
    if (triggerKind === "manual") {
      needsHumanAttention.delete(key);
    }

    const streamingNonce = await registerActiveRunBookkeeping({
      browserSurfaceLease,
      connectorId,
      connectorInstanceId,
      key,
      runId,
      startedAt,
      traceContext,
    });
    // Capture this run's fencing token at admission time. The .catch() path
    // below uses it to refuse terminal writes when a newer generation has
    // already been admitted (zombie double-write guard).
    const myRunGeneration = runGenerations.get(key) ?? 1;

    // Per-run owner-cancel controller. Aborting this signal requests
    // cancellation of only this run; the runtime cooperatively terminates the
    // connector child. Cleared in finalizeRunCleanup when the run settles.
    const cancellation = new AbortController();
    activeRunCancellations.set(runId, cancellation);

    const connectorDisplayName = readManifestDisplayName(manifest) ?? connectorId;
    const baseInteractionHandler = (interaction: unknown) =>
      brokerInteraction(runId, connectorId, interaction as RuntimeInteraction, {
        connectorDisplayName,
        log,
        ownerSubjectId,
      });
    const interactionHandler = browserSurface.wrapInteractionHandlerWithSurfaceLossDetection(
      runId,
      connectorId,
      traceContext,
      baseInteractionHandler
    );
    const handleAssistanceProgress = (msg: unknown) => {
      // Progress is persisted via the event spine, not this callback. The
      // one exception is nonblocking ASSISTANCE: the owner has to act
      // somewhere outside PDPP (e.g. approve a ChatGPT push in the app) and
      // we want their subscribed PWA to ring. INTERACTION pushes still flow
      // through brokerInteraction → fireWebPush.
      if (shouldFanoutAssistanceProgressMessage(msg)) {
        detachControllerTask(
          fireAssistanceWebPush({
            assistance: msg as Record<string, unknown>,
            connectorDisplayName,
            ownerSubjectId,
            runId,
            log,
          })
        );
      }
    };

    // runNow returns the run handle immediately; the actual connector
    // execution resolves later and clears activeRuns in the finally.
    // Callers poll the projection via getActiveRun / listSchedules.
    //
    // The Promise itself is tracked in `activeRunPromises` so the
    // graceful-shutdown path (`drainActiveRuns`) can await in-flight
    // children before the parent process exits — critical for Chromium
    // release() to complete and prevent stale singleton-lock files (see
    // polyfill-connectors/src/profile-lock.ts).
    const runPromise = Promise.resolve()
      .then(() =>
        runConnectorImpl({
          connectorPath,
          connectorId,
          connectorInstanceId,
          ownerToken,
          manifest,
          state,
          ...(scopedResources ? { scope: { streams: scopedResources } } : {}),
          collectionMode,
          rsUrl: currentRsUrl(options.rsUrl),
          runId,
          traceContext,
          triggerKind,
          automationMode: automationMetadata.automation_mode ?? null,
          onInteraction: interactionHandler,
          onProgress: handleAssistanceProgress,
          // Mode-A streaming registration env. Both fields must be present
          // for runConnector to thread them into the spawn env; either
          // omitted is a graceful no-op.
          streamingRegistrationToken: streamingNonce,
          referenceBaseUrl: currentReferenceBaseUrl(),
          browserSurfaceEnv,
          staticSecretEnv,
          cancelSignal: cancellation.signal,
        })
      )
      .then(async (result) => {
        if (
          usedStaticSecret &&
          result?.connector_error?.code === "credential_rejected" &&
          opts.markStaticSecretCredentialRejected
        ) {
          try {
            await opts.markStaticSecretCredentialRejected({
              connectorId,
              connectorInstanceId,
              ownerSubjectId,
              reason: typeof result.connector_error.message === "string" ? result.connector_error.message : null,
              rejectedAt: nowIso(),
              runId,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            log.warn?.(
              `[controller] failed to mark stored credential rejected for ${connectorId} ` +
                `(connection=${connectorInstanceId}, run_id=${runId}): ${message}`
            );
          }
        }
        return result;
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error?.(
          `[controller] run failed for ${connectorId} (run_id=${runId}, trace_id=${traceContext.trace_id}): ${message}`
        );
        // Run-generation fencing: if a newer generation has been admitted for
        // this connector_instance (watchdog reclaimed us and started a new run),
        // this run is a zombie. Refuse the terminal write so the zombie cannot
        // corrupt the new run's spine stream. The watchdog already emitted the
        // correct run_timed_out terminal under the new generation.
        const currentGeneration = runGenerations.get(key);
        if (currentGeneration !== undefined && currentGeneration !== myRunGeneration) {
          log.warn?.(
            `[controller] run_superseded: refusing launch-failure terminal for stale run ${runId} ` +
              `(my_generation=${myRunGeneration}, current_generation=${currentGeneration})`
          );
          return;
        }
        // Close the phantom-202 window: a throw before the runtime's
        // `run.started` emit (env/spawn prep) used to leave a 202-returned
        // run id with ZERO spine events — log-and-forget. Emit a typed
        // terminal `run.failed` (reason: launch_failed) so the handle stays
        // resolvable. Guarded by the same terminal-existence probe the boot
        // reconciler uses, because post-spawn rejections reach this catch
        // AFTER the runtime already recorded its own terminal event.
        try {
          if (!(await runAlreadyTerminal(runId))) {
            await emitSpineEvent({
              event_type: "run.failed",
              trace_id: traceContext.trace_id,
              scenario_id: traceContext.scenario_id,
              actor_type: "runtime",
              actor_id: connectorId,
              object_type: "run",
              object_id: runId,
              status: "failed",
              run_id: runId,
              data: {
                source: buildRunSource(connectorId),
                reason: LAUNCH_FAILED_RUN_REASON,
                failure_reason: LAUNCH_FAILED_RUN_REASON,
                records_emitted: 0,
                message: boundedLaunchFailureMessage(message),
              },
            });
          }
        } catch (emitErr) {
          const emitMessage = emitErr instanceof Error ? emitErr.message : String(emitErr);
          log.warn?.(`[controller] failed to emit launch-failure terminal event for ${runId}: ${emitMessage}`);
        }
      })
      .finally(() =>
        finalizeRunCleanup({
          browserSurfaceLease,
          connectorId,
          connectorInstanceId,
          key,
          runId,
          traceContext,
        })
      );
    activeRunPromises.set(runId, runPromise);
    // Arm the wall-clock watchdog. If runConnectorImpl hangs (never resolves
    // or rejects), the .finally() above never fires, leaving a phantom entry
    // in activeRuns that blocks all future run-nows with 409 until restart.
    // armRunWatchdog bounds this: it force-finalizes the run after the budget
    // expires and is a no-op when maxRunWallClockMs is Infinity or zero.
    armRunWatchdog({ browserSurfaceLease, connectorId, connectorInstanceId, key, runId, traceContext });

    return { run_id: runId, trace_id: traceContext.trace_id, status: "started", ...automationMetadata };
  }

  // ─── Graceful-shutdown drain ────────────────────────────────────────────
  //
  // Await all in-flight run promises with a hard deadline. The parent's
  // SIGTERM handler in server/index.js calls this before process.exit.
  // Returns the count drained, the count timed out, and elapsed wall-clock
  // time so the caller can log a useful summary.
  function drainActiveRuns(timeoutMs: number): Promise<DrainSummary> {
    return drainPromisesWithDeadline(activeRunPromises, timeoutMs);
  }

  // Await a managed-connector run's real terminal outcome.
  //
  // Waits for `activeRunPromises.get(runId)` to settle (the promise resolves
  // after `finalizeRunCleanup` completes, which fires in the `.finally()` of
  // the connector run — so by the time we get here, the spine terminal event
  // is guaranteed to have been emitted). Then reads that terminal status from
  // the spine and maps it to "succeeded" | "failed".
  //
  // If the run is not in `activeRunPromises` (already completed before we look,
  // or unknown), we skip the await and go straight to the spine read — this is
  // safe because the terminal event is already there.
  async function awaitRun(runId: string): Promise<"succeeded" | "failed"> {
    const runPromise = activeRunPromises.get(runId);
    if (runPromise) {
      // Suppress any rejection — we care about the terminal status from the
      // spine, not about whether the promise itself threw (the catch handler
      // in runNow already emits a terminal spine event for throws).
      await runPromise.catch(() => undefined);
    }
    const terminalStatus = await getRunTerminalStatus(runId);
    return terminalStatus === "completed" ? "succeeded" : "failed";
  }

  async function autoResumeSatisfiedActions(
    input: AutoResumeSatisfiedActionsInput
  ): Promise<AutoResumeSatisfiedActionsResult> {
    const connectorInstanceId = input.connectorInstanceId || input.connectorId;
    const satisfied = satisfiedOwnerActions(input.requiredActions, input.evidence);
    if (satisfied.length === 0) {
      return {
        object: "connection_self_heal",
        status: "no_satisfied_action",
        satisfied_actions: [],
        confirming_run: null,
      };
    }

    const active = getActiveRun(input.connectorId, { connectorInstanceId });
    if (active) {
      return {
        object: "connection_self_heal",
        status: "active_run_exists",
        satisfied_actions: satisfied,
        confirming_run: {
          run_id: active.run_id,
          trace_id: active.trace_id,
          status: "started",
        },
      };
    }

    try {
      await reattachSatisfiedScheduleContracts(input.connectorId, connectorInstanceId, satisfied);
      const started = await runNow(input.connectorId, buildAutoResumeRunNowOptions(input, connectorInstanceId));
      const terminalStatus = input.awaitCompletion ? await awaitRun(started.run_id) : undefined;
      return {
        object: "connection_self_heal",
        status: "started",
        satisfied_actions: satisfied,
        confirming_run: started,
        ...(terminalStatus ? { terminal_status: terminalStatus } : {}),
      };
    } catch (err) {
      const code = controllerErrorCode(err);
      return {
        object: "connection_self_heal",
        status: "blocked",
        satisfied_actions: satisfied,
        confirming_run: null,
        ...(code ? { error_code: code } : {}),
        error_message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function reattachSatisfiedScheduleContracts(
    connectorId: string,
    connectorInstanceId: string,
    actions: readonly RequiredAction[]
  ): Promise<void> {
    if (!actions.some((action) => action.satisfied_when.kind === "schedule_attached_and_enabled")) {
      return;
    }
    const schedule = await getSchedule(connectorId, { connectorInstanceId });
    if (schedule && schedule.enabled !== true) {
      await setScheduleEnabled(connectorId, true, { connectorInstanceId });
    }
  }

  function respondToInteraction(runId: string, input: RunInteractionResponseInput = {}): RunInteractionAck {
    const entry = activeRunInteractions.get(runId);
    if (!entry) {
      throw new ControllerError(`No active run with id: ${runId}`, "not_found");
    }
    if (!entry.pending) {
      throw new ControllerError(`Active run ${runId} has no pending interaction`, "no_pending_interaction");
    }

    const interactionId = input.interaction_id;
    if (typeof interactionId !== "string" || !interactionId.trim() || interactionId !== entry.pending.interaction_id) {
      throw new ControllerError(
        `Stale interaction_id for run ${runId}: expected ${entry.pending.interaction_id}`,
        "interaction_id_mismatch"
      );
    }
    if (input.status !== "success" && input.status !== "cancelled") {
      throw new ControllerError(`Invalid interaction status: ${String(input.status)}`, "invalid_status");
    }

    const response: InteractionResponse = {
      type: "INTERACTION_RESPONSE",
      request_id: interactionId,
      status: input.status,
    };
    const data = input.data;
    if (input.status === "success" && data && typeof data === "object" && !Array.isArray(data)) {
      response.data = data as Record<string, unknown>;
    }

    const pending = entry.pending;
    entry.pending = null;
    pending.resolve(response);
    if (input.status === "cancelled" && browserSurfaceLeaseManager) {
      const lease = browserSurfaceLeaseManager
        .listLeases()
        .find((candidate) => candidate.run_id === runId && candidate.status === "leased");
      const traceContext = activeRunTraceContexts.get(runId);
      if (lease && traceContext) {
        browserSurface.emitLeaseEvent("run.browser_surface_cancelled", entry.connector_id, runId, traceContext, lease);
      }
    }
    return { accepted: true, status: input.status };
  }

  async function cancelRun(runId: string): Promise<CancelRunResult> {
    const cancellation = activeRunCancellations.get(runId);
    if (!cancellation) {
      // No in-memory active run for this id. Distinguish a run that already
      // reached a terminal state (nothing to cancel) from one we never knew
      // about, so the owner gets an honest typed result either way.
      if (await runAlreadyTerminal(runId)) {
        return { status: "already_terminal", run_id: runId };
      }
      return { status: "no_active_run", run_id: runId };
    }
    if (cancellation.signal.aborted) {
      // Cancellation already requested for this run; the abort is idempotent.
      return { status: "cancel_requested", run_id: runId };
    }
    // Abort only this run's signal. The runtime's abort listener emits
    // run.cancel_requested and terminates the connector child; the terminal
    // run.cancelled event lands when the child exits.
    cancellation.abort();
    return { status: "cancel_requested", run_id: runId };
  }

  function getPendingInteraction(runId: string): PendingInteractionProjection | null {
    const entry = activeRunInteractions.get(runId);
    if (!entry?.pending) {
      return null;
    }
    return {
      run_id: runId,
      connector_id: entry.connector_id,
      interaction_id: entry.pending.interaction_id,
      kind: entry.pending.kind,
      stream: entry.pending.stream || null,
    };
  }

  function listBrowserSurfaceRunProjections(): BrowserSurfaceRunProjection[] {
    if (!browserSurfaceLeaseManager) {
      return [];
    }
    return browserSurfaceLeaseManager.listLeases().map((lease) => ({
      connector_id: lease.connector_id,
      ...projectBrowserSurfaceLease(lease),
    }));
  }

  return {
    cancelBrowserSurfaceRun: (runId: string) => browserSurface.cancelBrowserSurfaceRun(runId),
    cleanupIdleBrowserSurfaces: () => browserSurface.cleanupIdleBrowserSurfaces(),
    listSchedules,
    getSchedule,
    upsertSchedule,
    setScheduleEnabled,
    deleteSchedule,
    autoResumeSatisfiedActions,
    awaitRun,
    drainActiveRuns,
    expireBrowserSurfaceWaits: () => browserSurface.expireBrowserSurfaceWaits(),
    findActiveRunByRunId,
    getActiveRun,
    listBrowserSurfaceRunProjections,
    promoteBrowserSurfaceLeasesAfterBoot: () => browserSurface.promoteBrowserSurfaceLeasesAfterBoot(),
    reconcileBrowserSurfaceLeasesAfterBoot: () => browserSurface.reconcileBrowserSurfaceLeasesAfterBoot(),
    getPendingInteraction,
    isNeedsHuman: (connectorId: string, options: ConnectorInstanceOptions = {}) =>
      needsHumanAttention.has(runtimeKey(connectorId, options.connectorInstanceId)),
    issueRuntimeOwnerToken,
    respondToInteraction,
    cancelRun,
    runNow,
    markNeedsHuman,
    clearNeedsHuman,
    // Re-exported so the scheduler can route managed-connector runs through the
    // warm browser-surface lease (see the Controller interface doc above). This
    // is the in-scope const from createController's options; exposing it makes
    // server/index.js's scheduler seam + isManagedConnector predicate live.
    browserSurfaceLeaseManager,
    // Approval + connector inventory live in `auth.js`
    // (`listPendingApprovals`, `listConnectors`, `getConnectorManifest`).
    // Route handlers call those helpers directly; the controller does not
    // re-export them.
  };
}
