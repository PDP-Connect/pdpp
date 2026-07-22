/**
 * Shared scheduler domain types (type-only leaf).
 *
 * Extracted from `scheduler.ts` so the scheduler shell and its spokes
 * (retry classifier, readiness, back-off, pre-run gate, dispatch governor,
 * run executor) can depend on the shared type vocabulary WITHOUT a static
 * import cycle through `scheduler.ts`. This module is a pure type leaf: it
 * declares only types/interfaces/aliases and imports the few external types
 * it references from their real homes (all `import type`, fully erased at
 * runtime). It must NEVER import a VALUE from `scheduler.ts` or any spoke, and
 * never create a runtime (load-time) import edge. The terminal-reason union
 * (`TerminalGrantFailureReason` / `TerminalNonGrantReason` / `TerminalReason`)
 * now lives here in full, so this module no longer imports back from the retry
 * classifier; the prior type-graph edge to that spoke is gone.
 */

import type { SchedulerStore } from "../server/stores/scheduler-store.ts";
import type { PendingPressureGap } from "./scheduler-source-pressure-cooldown.ts";

// ─── Shared domain types ────────────────────────────────────────────────────

/**
 * Terminal reasons the runtime reports for a deterministic grant-lifecycle
 * failure. When any of these surface, the scheduler disables the connector
 * until it's restarted with a new grant — retrying would only loop.
 */
export type TerminalGrantFailureReason = "grant_consumed" | "grant_expired" | "grant_invalid" | "grant_revoked";

export type TerminalNonGrantReason =
  | "authentication_error"
  | "connector_protocol_violation"
  | "connector_reported_cancelled"
  | "owner_cancel_forced"
  | "owner_cancelled"
  | "run_timed_out"
  | "permission_error";

export type TerminalReason = TerminalGrantFailureReason | TerminalNonGrantReason;

export type RunStatus = "cancelled" | "failed" | "skipped" | "succeeded";

export type GrantAccessMode = "continuous" | "single_use";

export interface ConnectorError {
  readonly message?: string;
  readonly retryable?: boolean | null;
}

export interface RunSource {
  readonly id: string;
  readonly kind: "connector";
}

/**
 * Shape returned by `runtime/index.js`'s `runConnector`. Mirrors the wire
 * contract documented in the Collection Profile spec. Everything outside
 * `status` is best-effort metadata the scheduler forwards into its history.
 */
export interface RunConnectorResult {
  readonly checkpoint_summary?: Record<string, unknown> | null;
  readonly connector_error?: ConnectorError | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly message?: string;
  readonly records_emitted?: number;
  readonly reported_records_emitted?: number | null;
  readonly run_id?: string | null;
  readonly state?: unknown;
  readonly status: RunStatus;
  readonly terminal_reason?: TerminalReason | null;
  readonly trace_id?: string | null;
}

/**
 * Manifest fragment scheduler actually touches. The broader manifest type
 * lives in the connector-contract package; we don't need it here because
 * the scheduler forwards the manifest through to runConnector verbatim.
 */
export type SchedulerManifest = Record<string, unknown>;

export interface ConnectorSchedule {
  readonly connectorId: string;
  readonly connectorInstanceId?: string;
  readonly connectorPath: string;
  readonly grantAccessMode?: GrantAccessMode;
  readonly intervalMs: number;
  readonly manifest: SchedulerManifest;
  readonly maxRetries?: number;
  readonly ownerToken: string;
}

export interface SchedulerReadinessResult {
  readonly ready: boolean;
  readonly reason?: string;
}

export type SchedulerReadinessChecker = (
  schedule: ConnectorSchedule
) => Promise<SchedulerReadinessResult | null | undefined> | SchedulerReadinessResult | null | undefined;

export interface RunRecord {
  readonly attempt: number;
  readonly checkpointSummary: Record<string, unknown> | null;
  readonly completedAt: string;
  readonly connectorError?: ConnectorError | null;
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null;
  readonly error?: string;
  readonly failureReason?: string | null;
  readonly knownGaps: readonly Record<string, unknown>[];
  readonly recordsEmitted: number;
  readonly reportedRecordsEmitted?: number | null;
  readonly runId?: string | null;
  readonly source: RunSource;
  readonly startedAt: string;
  readonly status: RunStatus;
  readonly terminalReason?: TerminalReason | null;
  readonly traceId?: string | null;
}

export type InteractionHandler = (...args: unknown[]) => unknown;
export type RunCompleteHandler = (record: RunRecord) => void;
export type GetStateHandler = (connectorId: string, connectorInstanceId?: string) => Promise<unknown>;
export type SetStateHandler = (connectorId: string, state: unknown, connectorInstanceId?: string) => Promise<void>;
export type NeedsHumanHandler = (connectorId: string, connectorInstanceId?: string) => void;
export type IsNeedsHumanHandler = (connectorId: string, connectorInstanceId?: string) => boolean;

export interface RunCancellationRegistration {
  readonly cancel: () => void;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly runId: string;
}

export type RegisterRunCancellationHandler = (registration: RunCancellationRegistration) => (() => void) | undefined;

/**
 * Probe for durable unresolved owner/operator attention keyed to a
 * connection/source. When this returns a non-null evidence object, the
 * scheduler treats the schedule as paused-for-attention: it does not
 * launch another automatic run, it emits at most one skip record per
 * attention identity, and it does not replay missed ticks once the
 * evidence is gone.
 *
 * The `key` is an opaque, owner-controlled string (typically the
 * `dedupe_key` or `attention_id` of the unresolved request) that the
 * scheduler uses to dedupe its own skip records. Two consecutive probes
 * returning the same `key` are treated as the same attention; a probe
 * returning a different `key` re-arms the skip emitter so the operator
 * sees a fresh audit line.
 *
 * The handler MAY return null/undefined or throw to signal "no relevant
 * attention or unable to determine". A throw is treated as "no evidence"
 * — the scheduler must never silently suppress launches when the durable
 * store is unreachable, because that would itself hide a real freshness
 * problem.
 */
export interface UnresolvedAttentionEvidence {
  readonly key: string;
  readonly reason?: string | null;
}
export type HasUnresolvedAttentionHandler = (
  connectorId: string,
  connectorInstanceId?: string
) => Promise<UnresolvedAttentionEvidence | null | undefined> | UnresolvedAttentionEvidence | null | undefined;

/**
 * Probe for durable pending *source-pressure* detail gaps keyed to a
 * connection/source. When this returns a non-empty list of pending gaps whose
 * reason is account/source pressure (e.g. ChatGPT `upstream_pressure` /
 * `rate_limited`), the scheduler applies a decaying inter-run cooldown so an
 * unattended cadence does not keep re-hitting a hot upstream bucket while the
 * prior run's deferred work is still waiting to recover.
 *
 * Unlike `hasUnresolvedAttention`, this is not a hard pause: it only delays the
 * next *automatic* dispatch until the computed retry time arrives and surfaces
 * `cooling_off` while that retry is still too early. Ordinary manual runs use
 * the same future-only safety gate unless explicitly forced. A run that
 * recovers the gaps empties the pending set, which relaxes the cooldown on the
 * next tick.
 *
 * The handler MAY return an empty array, null/undefined, or throw to signal
 * "no pressure or unable to determine". A throw is treated as "no evidence" —
 * the scheduler must never silently suppress launches when the durable store
 * is unreachable, because that would itself hide a real freshness problem.
 */
export type GetSourcePressureGapsHandler = (
  connectorId: string,
  connectorInstanceId?: string
) => Promise<readonly PendingPressureGap[] | null | undefined> | readonly PendingPressureGap[] | null | undefined;

/**
 * Counts durable pending detail gaps whose reason is NOT source pressure
 * (everything outside `SOURCE_PRESSURE_GAP_REASONS` — e.g. `run_cap_deferred`
 * / `retry_exhausted`). Drives recovery-only eligibility (SLVP-ideal §4.3): a
 * source-pressure cooldown defers the forward walk but MUST NOT block recovery
 * of these non-pressure gaps. Returns a bounded scalar count; never record
 * bodies. Defaults to a no-op `() => 0` so a host that does not wire it keeps
 * the legacy (whole-dispatch-gated) behaviour.
 */
export type GetNonPressureRecoverableCountHandler = (
  connectorId: string,
  connectorInstanceId?: string
) => Promise<number> | number;

/**
 * Returns the epoch ms of the most recent GENUINELY-SUCCESSFUL run for this
 * connection from a durable cross-path projection (the spine run timeline),
 * regardless of which path dispatched it. The scheduler's own `runtime.history`
 * only contains runs it dispatched, so a manual/owner `controller.runNow`
 * success is invisible to it; this probe lets the back-off gate recognize such
 * a success and clear a stale failure streak. `null` when no successful run is
 * known. A probe failure is treated as "no evidence" (return `null`) — the same
 * fail-open stance as the attention/pressure probes: it must never *fabricate*
 * a success (which would suppress a legitimate back-off), only surface a real
 * one to break a wedge.
 */
export type GetLastSuccessfulRunAtHandler = (
  connectorId: string,
  connectorInstanceId?: string
) => Promise<number | null> | number | null;

/**
 * Returns true when the connector is a managed (browser-surface-leased)
 * connector. The scheduler uses this to DEFER a scheduled tick when the
 * managed-routing seam (`runManagedConnectorViaController`) is not currently
 * wired, rather than cold-dispatching the connector through the bare
 * `runConnector` path. A cold dispatch launches a fresh headless browser with
 * an empty profile (no warm Cloudflare clearance), which a bot-detecting
 * provider challenges and fails — and each such failure deepens the failure
 * back-off. Deferring (skip this tick, retry next) mirrors the existing
 * surface-unavailable defer. Defaults to "not managed" so non-managed hosts
 * and tests are unaffected.
 */
export type IsManagedConnectorHandler = (connectorId: string) => boolean;

/**
 * Resolves the connection-scoped static-secret env fragment for one scheduled
 * launch. Mirrors the controller's `resolveStaticSecretRunEnv` contract
 * (controller.ts `CreateControllerOptions`): return the env fragment when the
 * connection has an active stored credential, `null` only when the connector is
 * not handled by the static-secret setup family, and THROW (fail closed) when
 * the configured connection has no active recoverable credential — the launch
 * is then refused rather than started against a stale or deployment-wide
 * provider-account secret.
 */
export type ResolveStaticSecretRunEnv = (args: {
  connectorId: string;
  connectorInstanceId: string;
}) => Promise<Record<string, string> | null>;

/**
 * Called ONCE per transition into a human-required state:
 *   - 'blocked':          the failure back-off ladder reached gave_up
 *                         (scheduler stops auto-dispatching; owner must act).
 *   - 'needs_attention':  the needs-human gate first fired for this connection
 *                         (automatic runs suppressed until the owner resolves).
 *
 * Dedup mirrors the existing announce-once maps (announcedBlockedClass and
 * notifiedNeedsHumanSkips) so the callback fires exactly once per streak/flag,
 * not on every tick. Defaults to a no-op so existing callers are unaffected.
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-F
 */
export type HumanRequiredStateEscalationHandler = (info: {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly reason: "blocked" | "needs_attention";
}) => void | Promise<void>;

/**
 * Routes a managed-connector scheduled run through `controller.runNow` so it
 * acquires the managed neko browser-surface lease (with a persistent CF profile)
 * instead of launching a fresh headless Chromium with an empty profile.
 *
 * Called ONLY when the connector is managed (i.e. the controller would call
 * `acquireManagedBrowserSurfaceForRun`). Non-managed connectors fall through to
 * the existing `runConnector` path unchanged.
 *
 * The function MUST call `controller.runNow(connectorId, opts)` and await it.
 * Because `runNow` wraps the connector spawn in `.finally(() => finalizeRunCleanup(...))`
 * the surface lease is released on every exit path — success, failure, and crash.
 * Do NOT add a separate release call in the scheduler.
 *
 * Return value: the run handle enriched with the REAL terminal status.
 *
 * The callback is responsible for awaiting the run's actual completion (via
 * `controller.awaitRun`) before returning, so the status field reflects the
 * genuine outcome ("succeeded" | "failed") — not the intermediate "started"
 * handle that `controller.runNow` returns immediately.
 *
 * Early-exit statuses (browser_surface_queued, browser_surface_probe_failed,
 * browser_surface_lost, surface_failed) are returned without awaiting, since
 * no run was started and there is nothing to await.
 *
 * Returning null signals that this connector is not managed; launchRun falls
 * through to the direct runConnector path unchanged.
 */
export type RunManagedConnectorViaController = (
  connectorId: string,
  opts: {
    connectorInstanceId: string;
    ownerToken: string;
    priorityClass: "background";
    recoveryOnly?: boolean;
    triggerKind: "scheduled";
    runId?: string;
    traceContext?: unknown;
    rsUrl?: string;
    referenceBaseUrl?: string | null;
  }
) => Promise<{
  readonly connector_error?: ConnectorError | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly run_id: string;
  readonly status: string;
  readonly terminal_reason?: TerminalReason | null;
  readonly trace_id: string;
} | null>;

export interface SchedulerOptions {
  connectors: readonly ConnectorSchedule[];
  /**
   * Durable cross-path "latest successful run at" projection. Lets the back-off
   * gate clear a stale failure streak when a genuine success (any trigger,
   * including manual `controller.runNow`) has occurred since the streak's newest
   * failure. Optional: defaults to "no external success known" (legacy
   * in-history-only streak walk).
   */
  getLastSuccessfulRunAt?: GetLastSuccessfulRunAtHandler;
  getNonPressureRecoverableCount?: GetNonPressureRecoverableCountHandler;
  getSourcePressureGaps?: GetSourcePressureGapsHandler;
  getState?: GetStateHandler;
  hasUnresolvedAttention?: HasUnresolvedAttentionHandler;
  /**
   * Predicate: is this connector managed (browser-surface-leased)? Used to DEFER
   * a managed connector's scheduled tick when the managed-routing seam is not
   * wired, instead of cold-dispatching it. Optional: defaults to "not managed".
   */
  isManagedConnector?: IsManagedConnectorHandler;
  isNeedsHuman?: IsNeedsHumanHandler;
  markNeedsHuman?: NeedsHumanHandler;
  /**
   * Maximum no-progress budget for a direct scheduler connector attempt.
   *
   * Defaults to `PDPP_MAX_RUN_WALL_CLOCK_MS` when set, otherwise four hours.
   * `Infinity` disables the scheduler attempt watchdog. Valid connector
   * progress resets the budget, so long-running attempts are allowed when they
   * continue publishing progress. Managed browser-surface runs route through
   * controller.runNow and use the controller watchdog.
   */
  maxRunWallClockMs?: number;
  onHumanRequiredStateEscalation?: HumanRequiredStateEscalationHandler;
  onInteraction: InteractionHandler;
  onRunComplete?: RunCompleteHandler;
  readinessChecker?: SchedulerReadinessChecker;
  referenceBaseUrl?: string | null;
  registerRunCancellation?: RegisterRunCancellationHandler;
  resolveStaticSecretRunEnv?: ResolveStaticSecretRunEnv | null;
  rsUrl?: string;
  /**
   * When provided, managed-connector scheduled runs are routed through
   * `controller.runNow` (which acquires the neko browser-surface lease with
   * a warm, persistent CF profile) instead of launching a bare headless
   * Chromium via `runConnector` directly.
   *
   * Non-managed connectors are NOT affected — they fall through to the existing
   * `runConnector` path. The `isManagedConnector` check lives in `launchRun`.
   *
   * Injected the same way as `resolveStaticSecretRunEnv`: optional in the
   * interface so existing callers (tests that don't exercise managed surfaces)
   * remain unaffected.
   */
  runManagedConnectorViaController?: RunManagedConnectorViaController | null;
  schedulerStore?: Pick<
    SchedulerStore,
    | "appendRunHistory"
    | "deleteActiveRun"
    | "listLastRunTimes"
    | "listRunHistory"
    | "upsertActiveRun"
    | "upsertLastRunTime"
  >;
  setState?: SetStateHandler;
}
