/**
 * Simple Proactive Scheduler (Experiment)
 *
 * Coordinates scheduled connector runs: picks connectors that are due
 * for collection, invokes the existing runConnector() function, manages
 * run history, and handles basic retry on failure.
 *
 * This is a runtime/orchestrator concern. It uses the Collection Profile's
 * runConnector() function as a black box and adds scheduling, retry, and
 * multi-connector coordination on top.
 *
 * The experiment tests whether orchestration creates interoperability
 * surface or stays cleanly in the runtime layer.
 *
 * Status: Experimental (reference architecture, non-normative)
 *
 * Key question: does orchestrating multiple connector runs require any
 * new wire-level contract, or is it purely a runtime concern?
 */

import type { SchedulerRunHistoryRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";
import {
  type AutomationRefreshPolicy,
  projectRunAutomationPolicy,
  type RunTriggerKind,
} from "./run-automation-policy.ts";
import { createDispatchGovernor } from "./scheduler/dispatch-governor.ts";
import { createPreRunGate } from "./scheduler/pre-run-gate.ts";
import { createRunExecutor } from "./scheduler/run-executor.ts";
import { isTerminalGrantFailure, type TerminalReason } from "./scheduler-retry-classifier.ts";
import type { PendingPressureGap } from "./scheduler-source-pressure-cooldown.ts";

// ─── Shared domain types ────────────────────────────────────────────────────

/**
 * Terminal reasons the runtime reports for a deterministic grant-lifecycle
 * failure. When any of these surface, the scheduler disables the connector
 * until it's restarted with a new grant — retrying would only loop.
 */
export type TerminalGrantFailureReason = "grant_consumed" | "grant_expired" | "grant_invalid" | "grant_revoked";

export type RunStatus = "failed" | "skipped" | "succeeded";

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

export interface SchedulerStats {
  readonly [connectorId: string]: {
    readonly failed: number;
    readonly lastRun: RunRecord | null;
    readonly succeeded: number;
    readonly totalRecords: number;
    readonly totalRuns: number;
  };
}

export type InteractionHandler = (...args: unknown[]) => unknown;
export type RunCompleteHandler = (record: RunRecord) => void;
export type GetStateHandler = (connectorId: string, connectorInstanceId?: string) => Promise<unknown>;
export type SetStateHandler = (connectorId: string, state: unknown, connectorInstanceId?: string) => Promise<void>;
export type NeedsHumanHandler = (connectorId: string, connectorInstanceId?: string) => void;
export type IsNeedsHumanHandler = (connectorId: string, connectorInstanceId?: string) => boolean;

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
    priorityClass: "scheduled_refresh";
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
  onHumanRequiredStateEscalation?: HumanRequiredStateEscalationHandler;
  onInteraction: InteractionHandler;
  onRunComplete?: RunCompleteHandler;
  readinessChecker?: SchedulerReadinessChecker;
  referenceBaseUrl?: string | null;
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

export interface Scheduler {
  getHistory(): RunRecord[];
  getStats(): SchedulerStats;
  start(): void;
  stop(): void;
}

export * from "./scheduler-retry-classifier.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function runtimeKey(schedule: Pick<ConnectorSchedule, "connectorId" | "connectorInstanceId">): string {
  return schedule.connectorInstanceId || schedule.connectorId;
}

function getManifestRefreshPolicy(manifest: SchedulerManifest | null | undefined): AutomationRefreshPolicy | null {
  const capabilities =
    manifest && typeof manifest === "object" ? (manifest as { capabilities?: unknown }).capabilities : null;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return null;
  }
  const policy = (capabilities as { refresh_policy?: unknown }).refresh_policy;
  return policy && typeof policy === "object" && !Array.isArray(policy) ? (policy as AutomationRefreshPolicy) : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeScheduleIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 60_000;
  }
  return intervalMs;
}

// ─── Core runtime state ─────────────────────────────────────────────────────

interface SchedulerRuntime {
  readonly activeRuns: Set<string>;
  // Per-connector reason-class for which we've already emitted a back-off
  // skip in the current streak. Cleared when the streak breaks (success or
  // different reason class), which lets the dashboard show one fresh
  // back-off banner per failure pattern instead of one per interval tick.
  readonly announcedBackoffClass: Map<string, string>;
  // Per-connector reason-class for which we've already emitted a
  // `schedule.gave_up` spine event. Parallel to `announcedBackoffClass`:
  // cleared on a successful run for the connector so a future
  // degradation can re-promote (and re-announce) blocked status.
  readonly announcedBlockedClass: Map<string, string>;
  readonly disabledGrantFailures: Map<string, TerminalGrantFailureReason>;
  readonly exhaustedGrants: Set<string>;
  readonly history: RunRecord[];
  readonly lastRunTime: Map<string, number>;
  // Tracks the durable attention key (from `hasUnresolvedAttention`) for
  // which we last emitted a suppression skip record. Keyed by
  // connector_instance_id. A different key means a fresh attention
  // identity and re-arms the emitter; an absent key (attention resolved)
  // clears the entry so the next observed suppression emits a new skip.
  readonly notifiedAttentionSkips: Map<string, string>;
  // Tracks the source-pressure cooldown identity (from
  // `computeConnectionSourcePressureCooldown`) for which we last emitted a
  // cooling-off skip record. Keyed by connector_instance_id. A different identity means
  // the pressure picture changed (gap count or persistence) and re-arms the
  // emitter; an absent identity (pressure recovered) clears the entry so the
  // next observed cooldown emits a fresh skip.
  readonly notifiedCooldownIdentity: Map<string, string>;
  readonly notifiedDisabledGrantFailures: Set<string>;
  // Tracks connectors for which we have already emitted one needs-human skip
  // record this cycle. Cleared when the owner clears the needs-human flag via
  // clearNeedsHuman / runNow so the next automatic tick emits a fresh skip.
  readonly notifiedNeedsHumanSkips: Set<string>;
  readonly notifiedNotReadySkips: Map<string, string>;
  running: boolean;
  readonly timers: NodeJS.Timeout[];
}

function buildRuntime(): SchedulerRuntime {
  return {
    activeRuns: new Set(),
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    disabledGrantFailures: new Map(),
    exhaustedGrants: new Set(),
    history: [],
    lastRunTime: new Map(),
    notifiedDisabledGrantFailures: new Set(),
    notifiedNeedsHumanSkips: new Set(),
    notifiedNotReadySkips: new Map(),
    notifiedAttentionSkips: new Map(),
    notifiedCooldownIdentity: new Map(),
    running: false,
    timers: [],
  };
}

function toStoredRunRecord(record: RunRecord): SchedulerRunHistoryRecord {
  const stored: SchedulerRunHistoryRecord = {
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    source: { ...record.source },
    status: record.status,
    recordsEmitted: record.recordsEmitted,
    reportedRecordsEmitted: record.reportedRecordsEmitted ?? null,
    checkpointSummary: record.checkpointSummary,
    knownGaps: record.knownGaps,
    connectorError: record.connectorError ? { ...record.connectorError } : null,
    runId: record.runId ?? null,
    traceId: record.traceId ?? null,
    failureReason: record.failureReason ?? null,
    terminalReason: record.terminalReason ?? null,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    attempt: record.attempt,
  };
  if (record.error !== undefined) {
    return { ...stored, error: record.error };
  }
  return stored;
}

function fromStoredRunRecord(record: SchedulerRunHistoryRecord): RunRecord {
  let sourceId = record.connectorId;
  if (typeof record.source.id === "string") {
    sourceId = record.source.id;
  }
  const restored: RunRecord = {
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    source: {
      kind: "connector",
      id: sourceId,
    },
    status: record.status,
    recordsEmitted: record.recordsEmitted,
    reportedRecordsEmitted: record.reportedRecordsEmitted ?? null,
    checkpointSummary: record.checkpointSummary,
    knownGaps: record.knownGaps,
    runId: record.runId ?? null,
    traceId: record.traceId ?? null,
    failureReason: record.failureReason ?? null,
    terminalReason: (record.terminalReason ?? null) as TerminalReason | null,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    attempt: record.attempt,
  };
  return {
    ...restored,
    ...(record.connectorError === undefined ? {} : { connectorError: record.connectorError as ConnectorError | null }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

// ─── Skip-record builders ───────────────────────────────────────────────────

/**
 * Fail-closed refusal record: the connection HAS a stored static-secret
 * credential the resolver could not turn into a run env (revoked, deleted, or
 * unrecoverable). The launch is refused — no connector child is spawned — so
 * the run can never fall through to a stale or process-global secret. The
 * message carries the resolver's typed error text, which never contains
 * secret bytes (see connector-instance-credential-store fail-closed errors).
 */

// ─── Spine-event transition markers ─────────────────────────────────────────
//
// Per brief §3.6, three new one-shot spine event types augment (do not
// replace) the existing back-off skip records. In this runtime the spine
// surface is the `RunRecord` history that's persisted via
// `appendRunHistory` and fanned out through `onRunComplete` — adding new
// `error` prefixes is the schema-free way to slot in new event types
// (the brief explicitly chose this path; no DB migration required).
//
// Marker prefixes:
//   - `schedule.back_off.started: <json>`   — one-shot on streak start
//   - `schedule.back_off.cleared: <json>`   — one-shot on streak reset
//   - `schedule.gave_up: <json>`            — one-shot on cooling_off → blocked

export * from "./scheduler-readiness.ts";

import { defaultReadinessChecker } from "./scheduler-readiness.ts";

// ─── createScheduler ────────────────────────────────────────────────────────

/**
 * Create a scheduler that manages periodic connector runs.
 */
export function createScheduler(opts: SchedulerOptions): Scheduler {
  const {
    connectors,
    rsUrl = process.env.RS_URL || "http://localhost:7663",
    referenceBaseUrl = null,
    onInteraction,
    onHumanRequiredStateEscalation = () => {
      // no-op: §10-F escalation is optional; existing callers unaffected
    },
    onRunComplete = () => {
      // no-op
    },
    schedulerStore,
    readinessChecker = defaultReadinessChecker,
    getState = async () => null,
    setState = async () => {
      // no-op
    },
    markNeedsHuman = () => {
      // no-op
    },
    isNeedsHuman = () => false,
    hasUnresolvedAttention = () => null,
    getSourcePressureGaps = () => [],
    getNonPressureRecoverableCount = async () => 0,
    getLastSuccessfulRunAt = async () => null,
    isManagedConnector = () => false,
    resolveStaticSecretRunEnv = null,
    runManagedConnectorViaController = null,
  } = opts;

  const runtime = buildRuntime();
  let hydrationStarted = false;

  function recordAndNotify(record: RunRecord): RunRecord {
    runtime.history.push(record);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${record.connectorId}: ${message}`);
      });
    }
    onRunComplete(record);
    return record;
  }

  async function hydratePersistence(): Promise<void> {
    if (!schedulerStore || hydrationStarted) {
      return;
    }
    hydrationStarted = true;
    const [history, lastRunTimes] = await Promise.all([
      Promise.resolve(schedulerStore.listRunHistory(500)),
      Promise.resolve(schedulerStore.listLastRunTimes()),
    ]);
    if (runtime.history.length === 0) {
      runtime.history.push(...history.map(fromStoredRunRecord));
    }
    for (const row of lastRunTimes) {
      runtime.lastRunTime.set(row.connector_instance_id || row.connector_id, row.last_run_time_ms);
    }
  }

  function persistLastRunTime(connectorId: string, connectorInstanceId: string, lastRunTimeMs: number): void {
    runtime.lastRunTime.set(connectorInstanceId, lastRunTimeMs);
    if (!schedulerStore) {
      return;
    }
    Promise.resolve(schedulerStore.upsertLastRunTime(connectorInstanceId, lastRunTimeMs, nowIso(), connectorId)).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist last_run_time for ${connectorId}: ${message}`);
      }
    );
  }

  function handleGrantFailureDisable(reason: string | null | undefined, connectorInstanceId: string): void {
    if (!isTerminalGrantFailure(reason)) {
      return;
    }
    runtime.disabledGrantFailures.set(connectorInstanceId, reason);
    runtime.notifiedDisabledGrantFailures.delete(connectorInstanceId);
  }

  const preRunGate = createPreRunGate({
    hasUnresolvedAttention,
    isNeedsHuman,
    onHumanRequiredStateEscalation,
    readinessChecker,
    runtime,
    recordAndNotify,
  });

  const runExecutor = createRunExecutor({
    getState,
    handleGrantFailureDisable,
    isManagedConnector,
    markNeedsHuman,
    onInteraction,
    onRunComplete,
    persistLastRunTime,
    recordAndNotify,
    referenceBaseUrl,
    resolveStaticSecretRunEnv,
    rsUrl,
    runtime,
    runManagedConnectorViaController,
    schedulerStore,
    setState,
  });

  async function executeRun(
    schedule: ConnectorSchedule,
    isManual = false,
    options: { recoveryOnly?: boolean } = {}
  ): Promise<RunRecord | null> {
    const { connectorId, connectorInstanceId = connectorId, manifest, grantAccessMode = "continuous" } = schedule;
    const key = connectorInstanceId;
    const recoveryOnly = options.recoveryOnly === true;
    const triggerKind: RunTriggerKind = isManual ? "manual" : "scheduled";
    const automationPolicy = projectRunAutomationPolicy({
      triggerKind,
      refreshPolicy: getManifestRefreshPolicy(manifest),
    });

    if (runtime.activeRuns.has(key)) {
      return null;
    }
    runtime.activeRuns.add(key);

    try {
      if (!isManual) {
        const preflight = await preRunGate.runAutomaticPreflight(schedule, key, automationPolicy);
        if (preflight !== "proceed") {
          return preflight;
        }
      }
      const grantDecision = preRunGate.gateGrantState(connectorId, connectorInstanceId, grantAccessMode);
      if (grantDecision !== "proceed") {
        return grantDecision;
      }
      return await runExecutor.launchRun(schedule, isManual, automationPolicy, { recoveryOnly });
    } finally {
      runtime.activeRuns.delete(key);
    }
  }

  function start(): void {
    if (runtime.running) {
      return;
    }
    runtime.running = true;
    Promise.resolve()
      .then(hydratePersistence)
      .then(() => {
        if (!runtime.running) {
          return;
        }
        startScheduledLoops();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to hydrate persisted scheduler state: ${message}`);
        if (runtime.running) {
          startScheduledLoops();
        }
      });
  }

  const dispatchGovernor = createDispatchGovernor({
    getLastSuccessfulRunAt,
    getNonPressureRecoverableCount,
    getSourcePressureGaps,
    onHumanRequiredStateEscalation,
    runtime,
  });

  function startScheduledLoops(): void {
    if (runtime.timers.length > 0) {
      return;
    }
    async function dispatchIfDue(schedule: ConnectorSchedule): Promise<void> {
      let dispatch: Awaited<ReturnType<typeof dispatchGovernor.evaluateBackoffDispatch>>;
      try {
        dispatch = await dispatchGovernor.evaluateBackoffDispatch(schedule, Date.now());
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to evaluate back-off for ${schedule.connectorId}: ${message}`);
        return;
      }
      const { eligible, recoveryOnly, skipToEmit, eventsToEmit } = dispatch;
      // Emit transition markers (back_off.started, gave_up) before
      // the audit skip so the dashboard sees the lifecycle event
      // ordering: "streak detected → cooling_off pill renders →
      // (maybe) blocked pill renders → audit skip explains why we
      // went quiet". Each entry is one-shot per streak so the
      // history doesn't drown in duplicates on every tick.
      for (const event of eventsToEmit) {
        recordAndNotify(event);
      }
      if (skipToEmit) {
        // One-shot back-off announcement. We record + persist + notify
        // exactly like other skip records so the UI/audit can see why
        // the connector went quiet. We do NOT executeRun in this case
        // because by definition the back-off window has not elapsed.
        recordAndNotify(skipToEmit);
        return;
      }
      if (eligible) {
        executeRun(schedule, false, { recoveryOnly }).catch(() => {
          // Errors are already surfaced into the run record via onRunComplete;
          // swallow here so the scheduler loop doesn't bubble an unhandled
          // rejection out of the interval callback.
        });
      }
    }

    // `dispatchIfDue` is async (it awaits the durable source-pressure gap
    // probe). Its body already try/catches the evaluator and swallows
    // `executeRun` rejections, but a throw from the post-await skip emission
    // would otherwise surface as an unhandled rejection out of the interval
    // callback — swallow it here, matching the `executeRun` stance.
    const tick = (schedule: ConnectorSchedule): void => {
      dispatchIfDue(schedule).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] dispatch tick failed for ${schedule.connectorId}: ${message}`);
      });
    };

    for (const schedule of connectors) {
      // Check immediately, then on interval. Startup uses the same persisted
      // last-run/back-off gate as every later tick; restarting the server must
      // not bypass a connector's configured interval.
      tick(schedule);

      const timer = setInterval(
        () => {
          if (!runtime.running) {
            return;
          }
          tick(schedule);
        },
        Math.min(normalizeScheduleIntervalMs(schedule.intervalMs), 60_000)
      );

      runtime.timers.push(timer);
    }
  }

  function stop(): void {
    if (!runtime.running) {
      return;
    }
    runtime.running = false;
    for (const timer of runtime.timers) {
      clearInterval(timer);
    }
    runtime.timers.length = 0;
  }

  function getHistory(): RunRecord[] {
    return [...runtime.history];
  }

  function getStats(): SchedulerStats {
    const stats: Record<string, SchedulerStats[string]> = {};
    for (const schedule of connectors) {
      const key = runtimeKey(schedule);
      const runs = runtime.history.filter((r) => (r.connectorInstanceId || r.connectorId) === key);
      stats[key] = {
        totalRuns: runs.length,
        succeeded: runs.filter((r) => r.status === "succeeded").length,
        failed: runs.filter((r) => r.status === "failed").length,
        totalRecords: runs.reduce((sum, r) => sum + r.recordsEmitted, 0),
        lastRun: runs.at(-1) ?? null,
      };
    }
    return stats;
  }

  return { start, stop, getHistory, getStats };
}

// ─── Observations for the post-experiment memo ──────────────────────────────
//
// 1. Did this fit cleanly as runtime/reference architecture?
//    → YES. The scheduler uses runConnector() as a black box. It adds:
//      scheduling (interval-based), retry (exponential backoff), state
//      management (get/set callbacks), multi-connector coordination,
//      and history tracking. None of these affect the wire protocol.
//
// 2. Did it expose a real interoperability contract?
//    → NO. The scheduler is between the orchestrator and the local runtime.
//      Two independently-built PDPP servers would not need to agree on
//      scheduling, retry, or coordination — those are deployment choices.
//
// 3. What about single_use grant handling?
//    → The scheduler correctly sets persistState=false for single_use
//      grants. This is a Collection Profile invariant (state not persisted
//      for single_use runs) enforced in the orchestrator. The wire protocol
//      doesn't change — the runtime just doesn't call setState.
//
// 4. What would make orchestration need spec treatment?
//    → If multiple PDPP servers needed to coordinate collection across a
//      shared connector pool (distributed scheduling), that would need a
//      coordination protocol. But PDPP personal servers are per-user —
//      there's no shared pool. Orchestration stays local.
//
// 5. What is still NOT in this experiment that a production orchestrator needs?
//    → Credential management, richer observability (metrics and structured
//      logging), and connector update management. The experiment now handles
//      basic deterministic grant lifecycle failures (single_use exhaustion,
//      grant_revoked, grant_expired, grant_invalid, grant_consumed), plus
//      per-connector run locking and predictable start/stop semantics.
