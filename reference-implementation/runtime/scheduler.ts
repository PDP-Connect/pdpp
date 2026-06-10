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

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalConnectorKey } from "../server/connector-key.js";
import type { SchedulerRunHistoryRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";
import { runConnector } from "./index.js";
import {
  type AutomationRefreshPolicy,
  projectRunAutomationPolicy,
  type RunAutomationMode,
  type RunTriggerKind,
} from "./run-automation-policy.ts";
import { type BackoffDecision, computeNextRunWithBackoff } from "./scheduler-backoff.ts";
import {
  computeSourcePressureCooldown,
  isSourcePressureCooldownDeferring,
  type PendingPressureGap,
  type SourcePressureCooldownDecision,
} from "./scheduler-source-pressure-cooldown.ts";

// ─── Shared domain types ────────────────────────────────────────────────────

/**
 * Terminal reasons the runtime reports for a deterministic grant-lifecycle
 * failure. When any of these surface, the scheduler disables the connector
 * until it's restarted with a new grant — retrying would only loop.
 */
export type TerminalGrantFailureReason = "grant_consumed" | "grant_expired" | "grant_invalid" | "grant_revoked";

/**
 * Terminal reasons that are NOT grant-lifecycle but still non-retryable.
 * We keep them separate so `isTerminalGrantFailure` remains precise.
 */
type TerminalNonGrantReason =
  | "authentication_error"
  | "connector_protocol_violation"
  | "connector_reported_cancelled"
  | "permission_error";

type TerminalReason = TerminalGrantFailureReason | TerminalNonGrantReason;

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
 * A thrown runtime error carries similar metadata. Typed loosely because
 * the runtime can also throw ordinary `Error` instances without any of
 * these fields set.
 */
interface RunConnectorError {
  readonly checkpoint_summary?: Record<string, unknown> | null;
  readonly connector_error?: ConnectorError | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly message?: string;
  readonly records_emitted?: number;
  readonly reported_records_emitted?: number | null;
  readonly response_status?: number;
  readonly run_id?: string | null;
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
 * Resolves the connection-scoped static-secret env fragment for one scheduled
 * launch. Mirrors the controller's `resolveStaticSecretRunEnv` contract
 * (controller.ts `CreateControllerOptions`): return the env fragment when the
 * connection has an active stored credential, `null` when no stored credential
 * applies (legacy process-env fallback), and THROW (fail closed) when the
 * connection has a credential that is revoked/deleted or unrecoverable — the
 * launch is then refused rather than started against a stale or process-global
 * secret. Without this seam the scheduled path silently depended on
 * process-global env vars even after the owner migrated credentials into the
 * encrypted per-connection store.
 */
export type ResolveStaticSecretRunEnv = (args: {
  connectorId: string;
  connectorInstanceId: string;
}) => Promise<Record<string, string> | null>;

export interface SchedulerOptions {
  connectors: readonly ConnectorSchedule[];
  getSourcePressureGaps?: GetSourcePressureGapsHandler;
  getState?: GetStateHandler;
  hasUnresolvedAttention?: HasUnresolvedAttentionHandler;
  isNeedsHuman?: IsNeedsHumanHandler;
  markNeedsHuman?: NeedsHumanHandler;
  onInteraction: InteractionHandler;
  onRunComplete?: RunCompleteHandler;
  readinessChecker?: SchedulerReadinessChecker;
  referenceBaseUrl?: string | null;
  resolveStaticSecretRunEnv?: ResolveStaticSecretRunEnv | null;
  rsUrl?: string;
  schedulerStore?: Pick<
    SchedulerStore,
    "appendRunHistory" | "listLastRunTimes" | "listRunHistory" | "upsertLastRunTime"
  >;
  setState?: SetStateHandler;
}

export interface Scheduler {
  getHistory(): RunRecord[];
  getStats(): SchedulerStats;
  start(): void;
  stop(): void;
}

// ─── Retry classifier ────────────────────────────────────────────────────────

function isRetryableHttpStatus(status: unknown): boolean {
  if (!Number.isInteger(status)) {
    return true;
  }
  const code = status as number;
  if (code >= 400 && code < 500 && code !== 429) {
    return false;
  }
  return true;
}

const NON_RETRYABLE_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "authentication_error",
  "connector_protocol_violation",
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
  "permission_error",
]);

const NON_RETRYABLE_TERMINAL_REASONS: ReadonlySet<TerminalReason> = new Set<TerminalReason>([
  "authentication_error",
  "connector_reported_cancelled",
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
  "permission_error",
]);

function shouldRetryRunFailure(err: RunConnectorError | null | undefined): boolean {
  if (!err) {
    return false;
  }
  if (!isRetryableHttpStatus(err.response_status)) {
    return false;
  }
  if (err.failure_reason && NON_RETRYABLE_FAILURE_REASONS.has(err.failure_reason)) {
    return false;
  }
  if (err.terminal_reason && NON_RETRYABLE_TERMINAL_REASONS.has(err.terminal_reason)) {
    return false;
  }
  if (err.connector_error?.retryable === false) {
    return false;
  }
  return true;
}

const TERMINAL_GRANT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "grant_consumed",
  "grant_expired",
  "grant_invalid",
  "grant_revoked",
]);

function isTerminalGrantFailure(reason: string | null | undefined): reason is TerminalGrantFailureReason {
  return reason !== null && reason !== undefined && TERMINAL_GRANT_FAILURE_REASONS.has(reason);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildScheduledRunSource(connectorId: string): RunSource {
  return { kind: "connector", id: connectorId };
}

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

function describeFailedRunResult(result: RunConnectorResult): RunConnectorError {
  return {
    message: result.message || "unknown",
    records_emitted: result.records_emitted ?? 0,
    reported_records_emitted: result.reported_records_emitted ?? null,
    checkpoint_summary: result.checkpoint_summary || null,
    run_id: result.run_id || null,
    trace_id: result.trace_id || null,
    failure_reason: result.terminal_reason === "connector_protocol_violation" ? result.terminal_reason : null,
    terminal_reason: result.terminal_reason || null,
    connector_error: result.connector_error || null,
    known_gaps: result.known_gaps || null,
  };
}

function backoffDelayMs(attempt: number): number {
  // Exponential backoff capped at 30 s: 1 s, 2 s, 4 s, ...
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function coerceRunError(err: unknown): RunConnectorError {
  if (err && typeof err === "object") {
    const candidate = err as RunConnectorError;
    const message = candidate.message ?? (err instanceof Error ? err.message : "unknown");
    return { ...candidate, message };
  }
  return { message: typeof err === "string" ? err : "unknown" };
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

function normalizeSchedulerEpochMs(epochMs: number | undefined): number {
  if (epochMs === undefined || !Number.isFinite(epochMs) || epochMs < 0) {
    return 0;
  }
  return epochMs;
}

function newestHistoryEpochMs(history: readonly RunRecord[]): number {
  let newest = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (!record) {
      continue;
    }
    const parsed = Date.parse(record.completedAt || record.startedAt || "");
    if (Number.isFinite(parsed) && parsed > newest) {
      newest = parsed;
    }
  }
  return newest;
}

function resolveLastRunEpochMs(lastRunTimeMs: number | undefined, history: readonly RunRecord[]): number {
  const fromMap = normalizeSchedulerEpochMs(lastRunTimeMs);
  if (fromMap > 0) {
    return fromMap;
  }
  return newestHistoryEpochMs(history);
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
  // `computeSourcePressureCooldown`) for which we last emitted a cooling-off
  // skip record. Keyed by connector_instance_id. A different identity means
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

function buildSingleUseExhaustedSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: "single_use grant already consumed",
    attempt: 0,
  };
}

function buildDisabledGrantSkip(
  connectorId: string,
  terminalReason: TerminalGrantFailureReason,
  connectorInstanceId?: string
): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    terminalReason,
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `${terminalReason} grant no longer usable`,
    attempt: 0,
  };
}

function buildUnresolvedAttentionSkip(
  connectorId: string,
  evidence: UnresolvedAttentionEvidence,
  connectorInstanceId?: string
): RunRecord {
  const tail = evidence.reason ? `: ${evidence.reason} (${evidence.key})` : `: ${evidence.key}`;
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `attention_unresolved${tail}`,
    attempt: 0,
  };
}

function buildNeedsHumanSkip(connectorId: string, connectorInstanceId?: string): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: "needs_human_attention: automatic run skipped until owner provides input",
    attempt: 0,
  };
}

function buildNotReadySkip(connectorId: string, reason: string, connectorInstanceId?: string): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `not_ready: ${reason}`,
    attempt: 0,
  };
}

/**
 * Fail-closed refusal record: the connection HAS a stored static-secret
 * credential the resolver could not turn into a run env (revoked, deleted, or
 * unrecoverable). The launch is refused — no connector child is spawned — so
 * the run can never fall through to a stale or process-global secret. The
 * message carries the resolver's typed error text, which never contains
 * secret bytes (see connector-instance-credential-store fail-closed errors).
 */
function buildCredentialResolutionFailure(
  connectorId: string,
  message: string,
  connectorInstanceId?: string
): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "failed",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    failureReason: "static_secret_credential_unavailable",
    error: `static_secret_credential_unavailable: ${message}`,
    attempt: 0,
  };
}

function buildAutomationPolicySkip(
  connectorId: string,
  reason: string | null,
  connectorInstanceId?: string
): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `automation_policy_blocked: ${reason || "automatic run is not allowed by connector policy"}`,
    attempt: 0,
  };
}

// `next_attempt_at` values that resolve to the unix epoch (or anywhere in
// 1970) are operator-hostile: they mean "we never knew when the connector
// last ran" rather than "we plan to retry at midnight Jan 1 1970". We guard
// the audit string against that shape so a hydration gap (history rows
// without a matching `scheduler_last_run_times` row) doesn't surface as
// `next attempt at 1970-01-02T00:00:00.000Z` on the dashboard. The
// underlying ISO field is still emitted in the `schedule.back_off.started`
// structured event for machine consumers; humans see the safe phrasing.
const EPOCH_SUSPICION_CUTOFF_MS = Date.UTC(2000, 0, 1);

function formatNextAttempt(decision: BackoffDecision): string {
  if (decision.recommendedHealthState === "blocked") {
    return "not scheduled (gave_up — manual run-now required)";
  }
  const parsed = Date.parse(decision.nextRunAt);
  if (!Number.isFinite(parsed) || parsed < EPOCH_SUSPICION_CUTOFF_MS) {
    return "unknown (no recorded last-run time)";
  }
  return decision.nextRunAt;
}

function buildBackoffSkip(connectorId: string, decision: BackoffDecision, connectorInstanceId?: string): RunRecord {
  // One-shot skip emitted when back-off first engages for the current
  // failure streak. The error string carries enough context for the
  // dashboard to render `scheduler_backoff_applied; next attempt at HH:MM`
  // without re-deriving anything. We keep emitting one record (rather than
  // suppressing entirely) so the audit log shows *why* the connector went
  // quiet — silence would look like a healthy run.
  const reason = decision.reasonClass ?? "unknown";
  const failures = decision.consecutiveFailures;
  const next = formatNextAttempt(decision);
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `scheduler_backoff_applied: ${failures} consecutive ${reason} failures; next attempt at ${next}`,
    attempt: 0,
  };
}

function buildSourcePressureCooldownSkip(
  connectorId: string,
  decision: SourcePressureCooldownDecision,
  connectorInstanceId?: string
): RunRecord {
  // One-shot skip emitted when the cross-run source-pressure cooldown first
  // engages for the current pressure picture. Like the back-off skip, we keep
  // emitting one record (rather than going silent) so the audit log shows the
  // connection is intentionally cooling off rather than looking like a healthy
  // gap-free run. Carries the pending-gap count and persistence so the
  // dashboard can render `cooling_off; next attempt at HH:MM` without
  // re-deriving anything.
  const next = decision.nextRunAt;
  const gaps = decision.pendingPressureGapCount;
  const attempts = decision.maxAttemptCount;
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `source_pressure_cooldown_applied: ${gaps} pending source-pressure gap(s), persistence ${attempts}; next attempt at ${next}`,
    attempt: 0,
  };
}

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

const BACKOFF_STARTED_PREFIX = "schedule.back_off.started:";
const GAVE_UP_PREFIX = "schedule.gave_up:";

function buildBackoffStartedEvent(
  connectorId: string,
  decision: BackoffDecision,
  connectorInstanceId?: string
): RunRecord {
  const payload = JSON.stringify({
    reason_class: decision.reasonClass,
    consecutive_failures: decision.consecutiveFailures,
    next_attempt_at: decision.nextRunAt,
  });
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `${BACKOFF_STARTED_PREFIX} ${payload}`,
    attempt: 0,
  };
}

function buildBackoffClearedEvent(connectorId: string, resumedAt: string, connectorInstanceId?: string): RunRecord {
  const payload = JSON.stringify({ resumed_at: resumedAt });
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `schedule.back_off.cleared: ${payload}`,
    attempt: 0,
  };
}

function buildGaveUpEvent(
  connectorId: string,
  decision: BackoffDecision,
  lastSuccessAt: string | null,
  connectorInstanceId?: string
): RunRecord {
  const payload = JSON.stringify({
    reason_class: decision.reasonClass,
    final_consecutive_failures: decision.consecutiveFailures,
    last_success_at: lastSuccessAt,
  });
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `${GAVE_UP_PREFIX} ${payload}`,
    attempt: 0,
  };
}

function findLastSuccessAt(history: readonly RunRecord[], connectorKey: string): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (
      record &&
      (record.connectorInstanceId || record.connectorId) === connectorKey &&
      record.status === "succeeded"
    ) {
      return record.completedAt;
    }
  }
  return null;
}

function readSchedulerEventReasonClass(record: RunRecord, prefix: string): string | null {
  const error = record.error;
  if (!error?.startsWith(prefix)) {
    return null;
  }
  try {
    const payload = JSON.parse(error.slice(prefix.length).trim()) as { reason_class?: unknown };
    return typeof payload.reason_class === "string" ? payload.reason_class : null;
  } catch {
    return null;
  }
}

function currentStreakHasSchedulerEvent(history: readonly RunRecord[], prefix: string, reasonClass: string): boolean {
  const lastSuccessIndex = history.findLastIndex((record) => record.status === "succeeded");
  return history
    .slice(lastSuccessIndex + 1)
    .some((record) => readSchedulerEventReasonClass(record, prefix) === reasonClass);
}

// ─── Automatic-run readiness checks ────────────────────────────────────────

interface RuntimeRequirements {
  readonly bindings?: Record<string, { readonly required?: boolean } | undefined>;
  readonly external_tools?: readonly {
    readonly detect?: { readonly command?: string; readonly exit_code?: number };
    readonly install_hint?: string;
    readonly name?: string;
  }[];
}

function getRuntimeRequirements(manifest: SchedulerManifest): RuntimeRequirements {
  const requirements = manifest.runtime_requirements;
  if (requirements && typeof requirements === "object") {
    return requirements as RuntimeRequirements;
  }
  return {};
}

async function canAccessPath(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, expectedExitCode: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === expectedExitCode);
    });
  });
}

function runExecutable(file: string, args: readonly string[], expectedExitCode: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: "ignore" });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 5000);
    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === expectedExitCode);
    });
  });
}

function runDetectCommand(tool: NonNullable<RuntimeRequirements["external_tools"]>[number]): Promise<boolean> {
  const expectedExitCode = Number.isInteger(tool.detect?.exit_code) ? Number(tool.detect?.exit_code) : 0;
  const slackdumpBin = process.env.SLACKDUMP_BIN?.trim();
  if (tool.name === "slackdump" && slackdumpBin) {
    return runExecutable(slackdumpBin, ["version"], expectedExitCode);
  }

  const command = tool.detect?.command;
  if (!command) {
    return Promise.resolve(true);
  }
  return runCommand(command, expectedExitCode);
}

function formatMissingToolReason(tool: NonNullable<RuntimeRequirements["external_tools"]>[number]): string {
  const name = tool.name || "required external tool";
  const hint = tool.install_hint ? ` ${tool.install_hint}` : "";
  return `required external tool ${name} is not available.${hint}`;
}

function requiredBindingEnabled(manifest: SchedulerManifest, binding: string): boolean {
  return getRuntimeRequirements(manifest).bindings?.[binding]?.required === true;
}

function browserSurfaceConfigured(): boolean {
  // Direct CDP URL — connector receives the URL in env and talks to it directly.
  if (process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?.trim()) {
    return true;
  }
  // Managed neko surface (static mode): a single shared n.eko container whose
  // CDP port is exposed at PDPP_NEKO_CDP_HTTP_URL.  The controller owns leasing;
  // the connector does not discover the CDP endpoint itself.
  if (process.env.PDPP_NEKO_CDP_HTTP_URL?.trim()) {
    return true;
  }
  // Managed neko surface (dynamic mode): the allocator spawns per-connector
  // n.eko containers; PDPP_NEKO_MANAGED_CONNECTORS lists the connector IDs
  // eligible for those surfaces.
  if (process.env.PDPP_NEKO_MANAGED_CONNECTORS?.trim()) {
    return true;
  }
  // Explicit opt-in for unmanaged/bring-your-own browser setups.
  if (process.env.PDPP_ALLOW_UNMANAGED_BROWSER_SCHEDULES === "1") {
    return true;
  }
  return false;
}

async function checkFirstPartyLocalSourceReadiness(
  connectorId: string,
  manifest: SchedulerManifest
): Promise<string | null> {
  if (!requiredBindingEnabled(manifest, "filesystem")) {
    return null;
  }
  const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
  if (canonicalId === "codex") {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const requiredPaths = [
      process.env.CODEX_SESSIONS_DIR || join(codexHome, "sessions"),
      process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite"),
    ];
    const missing: string[] = [];
    for (const path of requiredPaths) {
      if (!(await canAccessPath(path))) {
        missing.push(path);
      }
    }
    return missing.length > 0 ? `Codex local source path(s) are missing or unreadable: ${missing.join(", ")}` : null;
  }
  if (canonicalId === "claude-code") {
    const claudeHome = process.env.CLAUDE_CODE_HOME || join(homedir(), ".claude");
    const projectsDir = process.env.CLAUDE_CODE_PROJECTS_DIR || join(claudeHome, "projects");
    return (await canAccessPath(projectsDir))
      ? null
      : `Claude Code local source path is missing or unreadable: ${projectsDir}`;
  }
  return null;
}

async function defaultReadinessChecker(schedule: ConnectorSchedule): Promise<SchedulerReadinessResult> {
  const requirements = getRuntimeRequirements(schedule.manifest);
  for (const tool of requirements.external_tools || []) {
    if (!(await runDetectCommand(tool))) {
      return { ready: false, reason: formatMissingToolReason(tool) };
    }
  }

  if (requiredBindingEnabled(schedule.manifest, "browser") && !browserSurfaceConfigured()) {
    return {
      ready: false,
      reason: "required browser runtime is not configured for unattended scheduled runs",
    };
  }

  const localSourceReason = await checkFirstPartyLocalSourceReadiness(schedule.connectorId, schedule.manifest);
  if (localSourceReason) {
    return { ready: false, reason: localSourceReason };
  }

  return { ready: true };
}

// ─── Result → record ────────────────────────────────────────────────────────

function buildSuccessOrFailureRecord({
  connectorId,
  connectorInstanceId,
  result,
  startedAt,
  attempt,
}: {
  attempt: number;
  connectorId: string;
  connectorInstanceId?: string;
  result: RunConnectorResult;
  startedAt: string;
}): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: result.status === "succeeded" ? "succeeded" : "failed",
    recordsEmitted: result.records_emitted || 0,
    reportedRecordsEmitted: result.reported_records_emitted ?? null,
    checkpointSummary: result.checkpoint_summary || null,
    knownGaps: result.known_gaps || [],
    runId: result.run_id || null,
    traceId: result.trace_id || null,
    failureReason: null,
    terminalReason: result.terminal_reason || null,
    connectorError: result.connector_error || null,
    startedAt,
    completedAt: nowIso(),
    attempt,
  };
}

function buildExhaustedFailureRecord({
  connectorId,
  connectorInstanceId,
  lastError,
  attempt,
}: {
  attempt: number;
  connectorId: string;
  connectorInstanceId?: string;
  lastError: RunConnectorError | null;
}): RunRecord {
  return {
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "failed",
    recordsEmitted: lastError?.records_emitted ?? 0,
    reportedRecordsEmitted: lastError?.reported_records_emitted ?? null,
    checkpointSummary: lastError?.checkpoint_summary || null,
    knownGaps: lastError?.known_gaps || [],
    runId: lastError?.run_id || null,
    traceId: lastError?.trace_id || null,
    failureReason: lastError?.failure_reason || null,
    terminalReason: lastError?.terminal_reason || null,
    connectorError: lastError?.connector_error || null,
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: lastError?.message || "unknown",
    attempt,
  };
}

// ─── Core run loop ──────────────────────────────────────────────────────────

interface RunConnectorCall {
  automationMode?: RunAutomationMode;
  collectionMode: "full_refresh" | "incremental";
  connectorId: string;
  connectorInstanceId?: string;
  connectorPath: string;
  manifest: SchedulerManifest;
  onInteraction: InteractionHandler;
  onProgress: () => void;
  onStarted?: (run: { run_id?: string | null; trace_id?: string | null }) => void;
  ownerToken: string;
  persistState: boolean;
  referenceBaseUrl?: string | null;
  rsUrl: string;
  state: Record<string, unknown> | null;
  /**
   * Connection-scoped static-secret env fragment resolved from the encrypted
   * credential store before launch. Threaded verbatim to `runConnector`, which
   * merges it LAST over `process.env` at spawn — so a stored credential always
   * wins over any (possibly empty-string) process-global secret. `null` means
   * no stored credential applies and the legacy process-env path is used.
   */
  staticSecretEnv?: Record<string, string> | null;
  triggerKind?: RunTriggerKind;
}

async function invokeRunConnector(call: RunConnectorCall): Promise<RunConnectorResult> {
  // `runConnector` is still JS; its parameter signature is refined through
  // `runtime/index.d.ts`. The return shape is validated by the callers
  // (retry classifier + record builders) — they only read documented
  // fields.
  const raw = await runConnector(call);
  return raw as RunConnectorResult;
}

// getState() yields `unknown`; runConnector accepts an object or null.
// Narrow at this single seam so the cross-module boundary stays honest.
function narrowState(state: unknown): Record<string, unknown> | null {
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return state as Record<string, unknown>;
  }
  return null;
}

function displayNameForScheduledConnector(manifest: SchedulerManifest, connectorId: string): string {
  return typeof manifest?.display_name === "string" && manifest.display_name.trim()
    ? manifest.display_name.trim()
    : connectorId;
}

function withSchedulerInteractionContext(
  interaction: unknown,
  {
    connectorDisplayName,
    connectorId,
    connectorInstanceId,
    runId,
  }: { connectorDisplayName: string; connectorId: string; connectorInstanceId?: string; runId: string | null }
): unknown {
  if (!interaction || typeof interaction !== "object" || Array.isArray(interaction)) {
    return interaction;
  }
  return {
    ...interaction,
    connector_id: connectorId,
    ...(connectorInstanceId ? { connector_instance_id: connectorInstanceId } : {}),
    connector_display_name: connectorDisplayName,
    run_id: runId,
  };
}

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
    resolveStaticSecretRunEnv = null,
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

  function maybeSkipSingleUseExhausted(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: GrantAccessMode
  ): RunRecord | null {
    if (grantAccessMode !== "single_use" || !runtime.exhaustedGrants.has(connectorInstanceId)) {
      return null;
    }
    return recordAndNotify(buildSingleUseExhaustedSkip(connectorId, connectorInstanceId));
  }

  type NotReadyDecision = "proceed" | "silent-skip" | RunRecord;

  async function decideNotReady(schedule: ConnectorSchedule): Promise<NotReadyDecision> {
    const readiness = await readinessChecker(schedule);
    const key = runtimeKey(schedule);
    if (!readiness || readiness.ready) {
      runtime.notifiedNotReadySkips.delete(key);
      return "proceed";
    }
    const projection = projectRunAutomationPolicy({
      triggerKind: "scheduled",
      refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
      deploymentReadiness: {
        ready: false,
        reason: readiness.reason || "scheduled connector runtime prerequisites are not currently satisfied",
      },
    });
    const reason = projection.reason || "scheduled connector runtime prerequisites are not currently satisfied";
    if (runtime.notifiedNotReadySkips.get(key) === reason) {
      return "silent-skip";
    }
    runtime.notifiedNotReadySkips.set(key, reason);
    return recordAndNotify(buildNotReadySkip(schedule.connectorId, reason, schedule.connectorInstanceId));
  }

  // Returns a sentinel that tells executeRun what to do next:
  //   - "proceed": no terminal grant failure on record; run normally
  //   - "silent-skip": already-notified terminal failure; return null
  //     (don't emit another record or run the connector)
  //   - a skip RunRecord: first terminal failure notification; return it
  type DisabledGrantDecision = "proceed" | "silent-skip" | RunRecord;

  function decideDisabledGrant(connectorId: string, connectorInstanceId: string): DisabledGrantDecision {
    if (!runtime.disabledGrantFailures.has(connectorInstanceId)) {
      return "proceed";
    }
    if (runtime.notifiedDisabledGrantFailures.has(connectorInstanceId)) {
      return "silent-skip";
    }
    const terminalReason = runtime.disabledGrantFailures.get(connectorInstanceId);
    if (!terminalReason) {
      return "proceed";
    }
    runtime.notifiedDisabledGrantFailures.add(connectorInstanceId);
    return recordAndNotify(buildDisabledGrantSkip(connectorId, terminalReason, connectorInstanceId));
  }

  async function finalizeSuccessOrFailure(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    result: RunConnectorResult,
    startedAt: string,
    attempt: number
  ): Promise<RunRecord> {
    const { connectorId, connectorInstanceId = connectorId, grantAccessMode = "continuous" } = schedule;
    const record = buildSuccessOrFailureRecord({
      connectorId,
      connectorInstanceId,
      result,
      startedAt,
      attempt,
    });

    // Capture pre-success streak state so we can emit a one-shot
    // `schedule.back_off.cleared` transition marker iff this success
    // ended an announced back-off (or blocked) streak. The marker is
    // emitted AFTER the success record itself so the chronological
    // order on the timeline is: success → cleared.
    const wasAnnouncedBackoff = runtime.announcedBackoffClass.has(connectorInstanceId);
    const wasAnnouncedBlocked = runtime.announcedBlockedClass.has(connectorInstanceId);

    runtime.history.push(record);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${connectorId}: ${message}`);
      });
    }
    persistLastRunTime(connectorId, connectorInstanceId, Date.now());

    if (result.status === "succeeded" && grantAccessMode === "single_use") {
      runtime.exhaustedGrants.add(connectorInstanceId);
    }
    if (result.status !== "succeeded") {
      handleGrantFailureDisable(record.terminalReason, connectorInstanceId);
    }

    if (result.status === "succeeded" && call.persistState && result.state !== undefined) {
      await setState(connectorId, result.state, connectorInstanceId);
    }

    onRunComplete(record);

    // Streak-cleared transition. Resets both announce-once maps so a
    // future degradation can re-promote (and re-announce). The
    // `evaluateBackoffDispatch` gate also clears `announcedBackoffClass`
    // when it next observes no back-off applied, but doing it here
    // keeps the timeline event ordering tight (success → cleared in
    // the same tick).
    if (result.status === "succeeded" && (wasAnnouncedBackoff || wasAnnouncedBlocked)) {
      runtime.announcedBackoffClass.delete(connectorInstanceId);
      runtime.announcedBlockedClass.delete(connectorInstanceId);
      recordAndNotify(buildBackoffClearedEvent(connectorId, record.completedAt, connectorInstanceId));
    }

    return record;
  }

  // A single attempt's outcome: either "done" (return this record) or
  // "retry" (loop again) or "give-up" (break and fall through to the
  // exhausted-failure branch). Factoring the per-attempt classification
  // out keeps `runWithRetries` a short state machine.
  type AttemptOutcome =
    | { kind: "done"; record: RunRecord }
    | { kind: "give-up"; error: RunConnectorError | null }
    | { kind: "retry"; error: RunConnectorError };

  async function runSingleAttempt(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number
  ): Promise<AttemptOutcome> {
    const { maxRetries = 2 } = schedule;
    const startedAt = nowIso();

    try {
      const result = await invokeRunConnector(call);
      const candidateError: RunConnectorError = {
        failure_reason: result.terminal_reason === "connector_protocol_violation" ? result.terminal_reason : null,
        terminal_reason: result.terminal_reason || null,
        connector_error: result.connector_error || null,
      };

      if (result.status !== "succeeded" && attempt <= maxRetries && shouldRetryRunFailure(candidateError)) {
        return { kind: "retry", error: describeFailedRunResult(result) };
      }

      const record = await finalizeSuccessOrFailure(schedule, call, result, startedAt, attempt);
      return { kind: "done", record };
    } catch (err) {
      const error = coerceRunError(err);
      if (attempt <= maxRetries && shouldRetryRunFailure(error)) {
        return { kind: "retry", error };
      }
      return { kind: "give-up", error };
    }
  }
  function buildAttemptCall(schedule: ConnectorSchedule, call: RunConnectorCall, attempt: number): RunConnectorCall {
    const attemptTriggerKind: RunTriggerKind = attempt === 1 ? (call.triggerKind ?? "scheduled") : "retry";
    const attemptPolicy = projectRunAutomationPolicy({
      triggerKind: attemptTriggerKind,
      refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
    });
    return {
      ...call,
      triggerKind: attemptPolicy.trigger_kind,
      automationMode: attemptPolicy.automation_mode,
    };
  }

  // Drains the durable failure record for an exhausted-retries run: history,
  // store append, last-run timestamp, terminal-grant handling, completion
  // notification. Pulled out so `runWithRetries` only orchestrates the retry
  // loop and trusts this helper for the failure tail.
  function finalizeExhaustedFailure(
    schedule: ConnectorSchedule,
    lastError: RunConnectorError | null,
    attempt: number
  ): RunRecord {
    const { connectorId, connectorInstanceId = connectorId } = schedule;
    const failRecord = buildExhaustedFailureRecord({
      connectorId,
      connectorInstanceId,
      lastError,
      attempt,
    });
    runtime.history.push(failRecord);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(failRecord))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${connectorId}: ${message}`);
      });
    }
    persistLastRunTime(connectorId, connectorInstanceId, Date.now());
    handleGrantFailureDisable(failRecord.terminalReason ?? failRecord.failureReason, connectorInstanceId);
    onRunComplete(failRecord);
    return failRecord;
  }

  async function runWithRetries(schedule: ConnectorSchedule, call: RunConnectorCall): Promise<RunRecord> {
    const { maxRetries = 2 } = schedule;
    let attempt = 0;
    let lastError: RunConnectorError | null = null;

    while (attempt <= maxRetries) {
      if (!runtime.running) {
        break;
      }
      attempt++;

      const outcome = await runSingleAttempt(schedule, buildAttemptCall(schedule, call, attempt), attempt);
      if (outcome.kind === "done") {
        return outcome.record;
      }
      lastError = outcome.error;
      if (outcome.kind === "give-up") {
        break;
      }
      await sleep(backoffDelayMs(attempt));
    }

    return finalizeExhaustedFailure(schedule, lastError, attempt);
  }
  // Outcome of a pre-run gate check. `"proceed"` means the gate is clear; any
  // other value is the value `executeRun` must return immediately (either a
  // recorded skip or `null` for silent skips).
  type GateOutcome = "proceed" | RunRecord | null;

  async function probeUnresolvedAttention(
    connectorId: string,
    connectorInstanceId: string
  ): Promise<UnresolvedAttentionEvidence | null> {
    try {
      const observed = await hasUnresolvedAttention(connectorId, connectorInstanceId);
      return observed ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] attention probe failed for ${connectorId}: ${message}`);
      return null;
    }
  }

  // Read durable pending source-pressure gaps for the cross-run cooldown.
  // A probe failure is treated as "no pressure" — the same fail-open stance as
  // the attention probe: silently suppressing launches when the durable store
  // is unreachable would itself hide a freshness problem.
  async function probeSourcePressureGaps(
    connectorId: string,
    connectorInstanceId: string
  ): Promise<readonly PendingPressureGap[]> {
    try {
      const observed = await getSourcePressureGaps(connectorId, connectorInstanceId);
      return Array.isArray(observed) ? observed : [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] source-pressure gap probe failed for ${connectorId}: ${message}`);
      return [];
    }
  }

  // Durable attention is the highest-priority gate. If an equivalent
  // unresolved attention request exists for this connection/source, no other
  // policy result matters: we do not launch another automatic run, we emit at
  // most one skip record per attention identity, and we leave `lastRunTime`
  // alone so the schedule stays eligible for a single latest-only catch-up
  // once the attention resolves.
  //
  // Probe failures are treated as "no evidence" — silently suppressing
  // launches when the durable store is unreachable would itself hide a
  // freshness problem.
  async function gateAttention(connectorId: string, connectorInstanceId: string, key: string): Promise<GateOutcome> {
    const attentionEvidence = await probeUnresolvedAttention(connectorId, connectorInstanceId);
    if (attentionEvidence?.key) {
      if (runtime.notifiedAttentionSkips.get(key) === attentionEvidence.key) {
        return null;
      }
      runtime.notifiedAttentionSkips.set(key, attentionEvidence.key);
      return recordAndNotify(buildUnresolvedAttentionSkip(connectorId, attentionEvidence, connectorInstanceId));
    }
    // No durable attention evidence. Clear suppression so the next observed
    // attention emits a fresh skip record. This also enforces latest-only
    // catch-up: once attention clears, the next eligible tick fires exactly
    // one run regardless of how many ticks were skipped while attention was
    // open.
    runtime.notifiedAttentionSkips.delete(key);
    return "proceed";
  }

  function gateAutomationPolicy(
    connectorId: string,
    connectorInstanceId: string,
    key: string,
    policy: ReturnType<typeof projectRunAutomationPolicy>
  ): GateOutcome {
    if (policy.allowed_to_start) {
      return "proceed";
    }
    const reason = policy.reason || "automatic run is not allowed by connector policy";
    const dedupeReason = `automation_policy_blocked:${reason}`;
    if (runtime.notifiedNotReadySkips.get(key) === dedupeReason) {
      return null;
    }
    runtime.notifiedNotReadySkips.set(key, dedupeReason);
    return recordAndNotify(buildAutomationPolicySkip(connectorId, reason, connectorInstanceId));
  }

  function gateNeedsHuman(connectorId: string, connectorInstanceId: string, key: string): GateOutcome {
    if (!isNeedsHuman(connectorId, connectorInstanceId)) {
      // Flag was cleared (owner ran manually or called clearNeedsHuman).
      // Reset suppression so the next time the flag is set we emit a fresh
      // skip.
      runtime.notifiedNeedsHumanSkips.delete(key);
      return "proceed";
    }
    // Emit one inspectable skip record, then suppress further skips on
    // subsequent ticks (mirrors the terminal-grant disabled pattern).
    if (runtime.notifiedNeedsHumanSkips.has(key)) {
      return null;
    }
    runtime.notifiedNeedsHumanSkips.add(key);
    return recordAndNotify(buildNeedsHumanSkip(connectorId, connectorInstanceId));
  }

  // The pre-run gate cascade that only applies to automatic runs. Manual runs
  // bypass all of these so the owner can resolve the issue. Each gate either
  // returns `"proceed"` or yields the final decision `executeRun` must
  // surface to the caller (either a recorded skip or `null` for silent).
  async function runAutomaticPreflight(
    schedule: ConnectorSchedule,
    key: string,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>
  ): Promise<GateOutcome> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;

    const attention = await gateAttention(connectorId, connectorInstanceId, key);
    if (attention !== "proceed") {
      return attention;
    }
    const policyDecision = gateAutomationPolicy(connectorId, connectorInstanceId, key, automationPolicy);
    if (policyDecision !== "proceed") {
      return policyDecision;
    }
    const notReadyDecision = await decideNotReady(schedule);
    if (notReadyDecision === "silent-skip") {
      return null;
    }
    if (notReadyDecision !== "proceed") {
      return notReadyDecision;
    }
    return gateNeedsHuman(connectorId, connectorInstanceId, key);
  }

  function gateGrantState(
    connectorId: string,
    connectorInstanceId: string,
    grantAccessMode: NonNullable<ConnectorSchedule["grantAccessMode"]>
  ): GateOutcome {
    const singleUseSkip = maybeSkipSingleUseExhausted(connectorId, connectorInstanceId, grantAccessMode);
    if (singleUseSkip) {
      return singleUseSkip;
    }
    const disabledDecision = decideDisabledGrant(connectorId, connectorInstanceId);
    if (disabledDecision === "silent-skip") {
      return null;
    }
    return disabledDecision;
  }

  async function launchRun(
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>
  ): Promise<RunRecord> {
    const {
      connectorId,
      connectorInstanceId = connectorId,
      connectorPath,
      manifest,
      ownerToken,
      grantAccessMode = "continuous",
    } = schedule;
    const persistState = grantAccessMode !== "single_use";

    // Resolve connection-scoped static-secret credentials BEFORE launching —
    // parity with the manual path (`controller.ts::runNow`). The encrypted
    // per-connection credential store is the source of truth for scheduled
    // runs too: without this seam, scheduled launches silently depended on
    // process-global env vars, so a connection whose credential lives only in
    // the store raised `credentials_required` the moment those env vars went
    // absent or empty. A resolver throw is fail-closed: the connection HAS a
    // credential we cannot use (revoked/deleted), so refuse the launch rather
    // than fall through to a possibly stale process-global secret.
    let staticSecretEnv: Record<string, string> | null = null;
    if (resolveStaticSecretRunEnv) {
      try {
        staticSecretEnv = await resolveStaticSecretRunEnv({ connectorId, connectorInstanceId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        persistLastRunTime(connectorId, connectorInstanceId, Date.now());
        return recordAndNotify(buildCredentialResolutionFailure(connectorId, message, connectorInstanceId));
      }
    }

    const state = narrowState(await getState(connectorId, connectorInstanceId));
    const collectionMode: "full_refresh" | "incremental" = state ? "incremental" : "full_refresh";
    let currentRunId: string | null = null;
    const connectorDisplayName = displayNameForScheduledConnector(manifest, connectorId);

    // Wrap onInteraction to detect when an automatic run surfaces a
    // human-attention interaction. We mark the connector as needs-human so
    // subsequent automatic ticks skip it rather than repeatedly prompting for
    // OTP or manual browser action.
    const wrappedInteraction: InteractionHandler = (interaction) => {
      if (!isManual) {
        markNeedsHuman(connectorId, connectorInstanceId);
      }
      return onInteraction(
        withSchedulerInteractionContext(interaction, {
          connectorDisplayName,
          connectorId,
          connectorInstanceId,
          runId: currentRunId,
        })
      );
    };

    return await runWithRetries(schedule, {
      connectorPath,
      connectorId,
      connectorInstanceId,
      ownerToken,
      manifest,
      state,
      collectionMode,
      persistState,
      referenceBaseUrl,
      rsUrl,
      staticSecretEnv,
      triggerKind: automationPolicy.trigger_kind,
      automationMode: automationPolicy.automation_mode,
      onInteraction: wrappedInteraction,
      onStarted: (run) => {
        currentRunId = typeof run?.run_id === "string" ? run.run_id : null;
      },
      onProgress: () => {
        // no-op; progress is driven by the runtime's own logging.
      },
    });
  }

  async function executeRun(schedule: ConnectorSchedule, isManual = false): Promise<RunRecord | null> {
    const { connectorId, connectorInstanceId = connectorId, manifest, grantAccessMode = "continuous" } = schedule;
    const key = connectorInstanceId;
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
        const preflight = await runAutomaticPreflight(schedule, key, automationPolicy);
        if (preflight !== "proceed") {
          return preflight;
        }
      }
      const grantDecision = gateGrantState(connectorId, connectorInstanceId, grantAccessMode);
      if (grantDecision !== "proceed") {
        return grantDecision;
      }
      return await launchRun(schedule, isManual, automationPolicy);
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

  // Pure dispatch-gate: given the current history + lastRun for a
  // connector, decide whether the next automatic tick should run, skip
  // silently (already announced), or emit a back-off skip record. Pulled
  // out so the interval body stays short and so tests can drive it
  // directly without touching real timers.
  //
  // In addition to the always-firing back-off skip record (one per
  // streak), this gate may emit two transition spine-event markers:
  //   - `schedule.back_off.started` — once when a fresh streak engages.
  //   - `schedule.gave_up`          — once when the streak crosses the
  //                                   `BLOCKED_PROMOTION_THRESHOLD` and
  //                                   the scheduler stops auto-dispatching.
  // The auto-dispatch suppression on `blocked` is the one behavioural
  // change relative to Worker C: manual `runNow` still works (the brief
  // is explicit about this), but the interval loop will not call
  // `executeRun` for a connector whose `recommendedHealthState` is
  // `"blocked"`.
  async function evaluateBackoffDispatch(
    schedule: ConnectorSchedule,
    now: number
  ): Promise<{
    decision: BackoffDecision;
    eligible: boolean;
    eventsToEmit: RunRecord[];
    skipToEmit: RunRecord | null;
  }> {
    const connectorId = schedule.connectorId;
    const key = runtimeKey(schedule);
    const history = runtime.history.filter((r) => (r.connectorInstanceId || r.connectorId) === key);
    // `scheduler_last_run_times` and `scheduler_run_history` are persisted
    // through separate writes. If a process is killed between them — or if
    // an older runtime never wrote `last_run_time` at all — we hydrate
    // history with failed records but no last-run timestamp. Computing
    // `nextRunAt = 0 + effectiveIntervalMs` then surfaces a 1970 date in
    // the audit log. Fall back to the newest history record's
    // `completedAt` so the next-attempt math has a real anchor.
    const lastRun = resolveLastRunEpochMs(runtime.lastRunTime.get(key), history);
    const scheduleIntervalMs = normalizeScheduleIntervalMs(schedule.intervalMs);
    const decision = computeNextRunWithBackoff(history, scheduleIntervalMs, lastRun);

    // Cross-run source-pressure cooldown. Independent of failure back-off: a
    // connection that *succeeded* but deferred work under upstream pressure
    // has no failure streak, so back-off alone would fire on the normal
    // interval and re-hit the still-hot bucket. The cooldown reads the durable
    // pending pressure gaps and defers the next automatic dispatch on its own
    // capped curve. We take whichever governor defers the run further.
    const pendingPressureGaps = await probeSourcePressureGaps(connectorId, key);
    const cooldown = computeSourcePressureCooldown(pendingPressureGaps, scheduleIntervalMs, lastRun);
    const cooldownDefers = isSourcePressureCooldownDeferring(cooldown, now);

    const elapsed = now - lastRun;
    let eligible = elapsed >= decision.effectiveIntervalMs && !cooldownDefers;

    let skipToEmit: RunRecord | null = null;
    const eventsToEmit: RunRecord[] = [];

    if (decision.backoffApplied && decision.reasonClass) {
      const announced = runtime.announcedBackoffClass.get(key);
      const persistedBackoffStarted = currentStreakHasSchedulerEvent(
        history,
        BACKOFF_STARTED_PREFIX,
        decision.reasonClass
      );
      if (announced === decision.reasonClass || persistedBackoffStarted) {
        runtime.announcedBackoffClass.set(key, decision.reasonClass);
      } else {
        runtime.announcedBackoffClass.set(key, decision.reasonClass);
        // The existing back-off skip record (audit log) plus the new
        // one-shot `schedule.back_off.started` transition marker. Both
        // are tied to the *first* skip of the streak; subsequent ticks
        // are suppressed by the `announcedBackoffClass` gate above.
        skipToEmit = buildBackoffSkip(connectorId, decision, schedule.connectorInstanceId);
        eventsToEmit.push(buildBackoffStartedEvent(connectorId, decision, schedule.connectorInstanceId));
      }

      if (decision.recommendedHealthState === "blocked") {
        // One-shot `schedule.gave_up` per (connector, reason_class)
        // streak. Cleared by a successful run (see
        // `finalizeSuccessOrFailure`) so a future degradation can
        // re-promote and re-announce.
        const blockedAnnounced = runtime.announcedBlockedClass.get(key);
        const persistedGaveUp = currentStreakHasSchedulerEvent(history, GAVE_UP_PREFIX, decision.reasonClass);
        if (blockedAnnounced === decision.reasonClass || persistedGaveUp) {
          runtime.announcedBlockedClass.set(key, decision.reasonClass);
        } else {
          runtime.announcedBlockedClass.set(key, decision.reasonClass);
          eventsToEmit.push(
            buildGaveUpEvent(connectorId, decision, findLastSuccessAt(history, key), schedule.connectorInstanceId)
          );
        }
        // Auto-dispatch is suppressed for blocked connectors. Manual
        // `runNow` still works (it bypasses this evaluator entirely via
        // `controller.ts::runNow` → `executeRun(schedule, true)`).
        eligible = false;
      }
    } else if (!decision.backoffApplied) {
      // Streak broken (success or different class): clear the announcement
      // so the next time back-off engages we emit a fresh skip record.
      runtime.announcedBackoffClass.delete(key);
    }

    // Source-pressure cooldown is layered on top of failure back-off. Pending
    // pressure gaps alone do not defer forever; only a future `nextRunAt` does.
    // `resolveCooldownSkip` emits at most one cooling-off skip per pressure
    // identity while the retry is too early, but only when back-off has not
    // already emitted its own skip this tick (back-off is the stronger signal
    // and already explains the quiet; double-emitting would be noise).
    skipToEmit = resolveCooldownSkip(schedule, key, cooldown, cooldownDefers, skipToEmit);

    return { decision, eligible, skipToEmit, eventsToEmit };
  }

  // Decide whether this tick should emit a one-shot source-pressure cooling-off
  // skip record. Manages the per-connection dedup map so the audit log shows
  // one record per pressure identity and re-arms when pressure clears. Returns
  // the (possibly unchanged) skip record the caller should emit.
  function resolveCooldownSkip(
    schedule: ConnectorSchedule,
    key: string,
    cooldown: SourcePressureCooldownDecision,
    cooldownDefers: boolean,
    existingSkip: RunRecord | null
  ): RunRecord | null {
    if (!(cooldownDefers && cooldown.identity)) {
      // Pressure recovered (no pending pressure gaps): clear the announcement
      // so a future pressure window emits a fresh cooling-off skip. Also
      // re-arm once the current cooldown is due, because a run may create a new
      // cooldown window with the same pressure identity.
      runtime.notifiedCooldownIdentity.delete(key);
      return existingSkip;
    }
    const alreadyAnnounced = runtime.notifiedCooldownIdentity.get(key) === cooldown.identity;
    runtime.notifiedCooldownIdentity.set(key, cooldown.identity);
    if (existingSkip || alreadyAnnounced) {
      return existingSkip;
    }
    return buildSourcePressureCooldownSkip(schedule.connectorId, cooldown, schedule.connectorInstanceId);
  }

  function startScheduledLoops(): void {
    if (runtime.timers.length > 0) {
      return;
    }
    async function dispatchIfDue(schedule: ConnectorSchedule): Promise<void> {
      let dispatch: Awaited<ReturnType<typeof evaluateBackoffDispatch>>;
      try {
        dispatch = await evaluateBackoffDispatch(schedule, Date.now());
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to evaluate back-off for ${schedule.connectorId}: ${message}`);
        return;
      }
      const { eligible, skipToEmit, eventsToEmit } = dispatch;
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
        executeRun(schedule).catch(() => {
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
