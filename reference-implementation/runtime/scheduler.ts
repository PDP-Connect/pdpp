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

import type { SchedulerRunHistoryRecord, SchedulerStore } from "../server/stores/scheduler-store.ts";
import { runConnector } from "./index.js";
import { type BackoffDecision, computeNextRunWithBackoff } from "./scheduler-backoff.ts";

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
export type GetStateHandler = (connectorId: string) => Promise<unknown>;
export type SetStateHandler = (connectorId: string, state: unknown) => Promise<void>;
export type NeedsHumanHandler = (connectorId: string) => void;
export type IsNeedsHumanHandler = (connectorId: string) => boolean;

export interface SchedulerOptions {
  connectors: readonly ConnectorSchedule[];
  getState?: GetStateHandler;
  isNeedsHuman?: IsNeedsHumanHandler;
  markNeedsHuman?: NeedsHumanHandler;
  onInteraction: InteractionHandler;
  onRunComplete?: RunCompleteHandler;
  readinessChecker?: SchedulerReadinessChecker;
  referenceBaseUrl?: string | null;
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
    running: false,
    timers: [],
  };
}

function toStoredRunRecord(record: RunRecord): SchedulerRunHistoryRecord {
  const stored: SchedulerRunHistoryRecord = {
    connectorId: record.connectorId,
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

function buildSingleUseExhaustedSkip(connectorId: string): RunRecord {
  return {
    connectorId,
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

function buildDisabledGrantSkip(connectorId: string, terminalReason: TerminalGrantFailureReason): RunRecord {
  return {
    connectorId,
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

function buildNeedsHumanSkip(connectorId: string): RunRecord {
  return {
    connectorId,
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

function buildNotReadySkip(connectorId: string, reason: string): RunRecord {
  return {
    connectorId,
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

function buildBackoffSkip(connectorId: string, decision: BackoffDecision): RunRecord {
  // One-shot skip emitted when back-off first engages for the current
  // failure streak. The error string carries enough context for the
  // dashboard to render `scheduler_backoff_applied; next attempt at HH:MM`
  // without re-deriving anything. We keep emitting one record (rather than
  // suppressing entirely) so the audit log shows *why* the connector went
  // quiet — silence would look like a healthy run.
  const reason = decision.reasonClass ?? "unknown";
  const next = decision.nextRunAt;
  const failures = decision.consecutiveFailures;
  return {
    connectorId,
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

function buildBackoffStartedEvent(connectorId: string, decision: BackoffDecision): RunRecord {
  const payload = JSON.stringify({
    reason_class: decision.reasonClass,
    consecutive_failures: decision.consecutiveFailures,
    next_attempt_at: decision.nextRunAt,
  });
  return {
    connectorId,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `schedule.back_off.started: ${payload}`,
    attempt: 0,
  };
}

function buildBackoffClearedEvent(connectorId: string, resumedAt: string): RunRecord {
  const payload = JSON.stringify({ resumed_at: resumedAt });
  return {
    connectorId,
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

function buildGaveUpEvent(connectorId: string, decision: BackoffDecision, lastSuccessAt: string | null): RunRecord {
  const payload = JSON.stringify({
    reason_class: decision.reasonClass,
    final_consecutive_failures: decision.consecutiveFailures,
    last_success_at: lastSuccessAt,
  });
  return {
    connectorId,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `schedule.gave_up: ${payload}`,
    attempt: 0,
  };
}

function findLastSuccessAt(history: readonly RunRecord[], connectorId: string): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const record = history[i];
    if (record && record.connectorId === connectorId && record.status === "succeeded") {
      return record.completedAt;
    }
  }
  return null;
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
  if (process.env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?.trim()) {
    return true;
  }
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
  if (connectorId === "https://registry.pdpp.org/connectors/codex") {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const requiredPaths = [
      process.env.CODEX_SESSIONS_DIR || join(codexHome, "sessions"),
      process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite"),
    ];
    const missing = [];
    for (const path of requiredPaths) {
      if (!(await canAccessPath(path))) {
        missing.push(path);
      }
    }
    return missing.length > 0 ? `Codex local source path(s) are missing or unreadable: ${missing.join(", ")}` : null;
  }
  if (connectorId === "https://registry.pdpp.org/connectors/claude-code") {
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
  result,
  startedAt,
  attempt,
}: {
  attempt: number;
  connectorId: string;
  result: RunConnectorResult;
  startedAt: string;
}): RunRecord {
  return {
    connectorId,
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
  lastError,
  attempt,
}: {
  attempt: number;
  connectorId: string;
  lastError: RunConnectorError | null;
}): RunRecord {
  return {
    connectorId,
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
  collectionMode: "full_refresh" | "incremental";
  connectorId: string;
  connectorPath: string;
  manifest: SchedulerManifest;
  onInteraction: InteractionHandler;
  onProgress: () => void;
  ownerToken: string;
  persistState: boolean;
  referenceBaseUrl?: string | null;
  rsUrl: string;
  state: Record<string, unknown> | null;
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
      runtime.lastRunTime.set(row.connector_id, row.last_run_time_ms);
    }
  }

  function persistLastRunTime(connectorId: string, lastRunTimeMs: number): void {
    runtime.lastRunTime.set(connectorId, lastRunTimeMs);
    if (!schedulerStore) {
      return;
    }
    Promise.resolve(schedulerStore.upsertLastRunTime(connectorId, lastRunTimeMs, nowIso())).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] failed to persist last_run_time for ${connectorId}: ${message}`);
    });
  }

  function handleGrantFailureDisable(reason: string | null | undefined, connectorId: string): void {
    if (!isTerminalGrantFailure(reason)) {
      return;
    }
    runtime.disabledGrantFailures.set(connectorId, reason);
    runtime.notifiedDisabledGrantFailures.delete(connectorId);
  }

  function maybeSkipSingleUseExhausted(connectorId: string, grantAccessMode: GrantAccessMode): RunRecord | null {
    if (grantAccessMode !== "single_use" || !runtime.exhaustedGrants.has(connectorId)) {
      return null;
    }
    return recordAndNotify(buildSingleUseExhaustedSkip(connectorId));
  }

  type NotReadyDecision = "proceed" | "silent-skip" | RunRecord;

  async function decideNotReady(schedule: ConnectorSchedule): Promise<NotReadyDecision> {
    const readiness = await readinessChecker(schedule);
    if (!readiness || readiness.ready) {
      runtime.notifiedNotReadySkips.delete(schedule.connectorId);
      return "proceed";
    }
    const reason = readiness.reason || "scheduled connector runtime prerequisites are not currently satisfied";
    if (runtime.notifiedNotReadySkips.get(schedule.connectorId) === reason) {
      return "silent-skip";
    }
    runtime.notifiedNotReadySkips.set(schedule.connectorId, reason);
    return recordAndNotify(buildNotReadySkip(schedule.connectorId, reason));
  }

  // Returns a sentinel that tells executeRun what to do next:
  //   - "proceed": no terminal grant failure on record; run normally
  //   - "silent-skip": already-notified terminal failure; return null
  //     (don't emit another record or run the connector)
  //   - a skip RunRecord: first terminal failure notification; return it
  type DisabledGrantDecision = "proceed" | "silent-skip" | RunRecord;

  function decideDisabledGrant(connectorId: string): DisabledGrantDecision {
    if (!runtime.disabledGrantFailures.has(connectorId)) {
      return "proceed";
    }
    if (runtime.notifiedDisabledGrantFailures.has(connectorId)) {
      return "silent-skip";
    }
    const terminalReason = runtime.disabledGrantFailures.get(connectorId);
    if (!terminalReason) {
      return "proceed";
    }
    runtime.notifiedDisabledGrantFailures.add(connectorId);
    return recordAndNotify(buildDisabledGrantSkip(connectorId, terminalReason));
  }

  async function finalizeSuccessOrFailure(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    result: RunConnectorResult,
    startedAt: string,
    attempt: number
  ): Promise<RunRecord> {
    const { connectorId, grantAccessMode = "continuous" } = schedule;
    const record = buildSuccessOrFailureRecord({ connectorId, result, startedAt, attempt });

    // Capture pre-success streak state so we can emit a one-shot
    // `schedule.back_off.cleared` transition marker iff this success
    // ended an announced back-off (or blocked) streak. The marker is
    // emitted AFTER the success record itself so the chronological
    // order on the timeline is: success → cleared.
    const wasAnnouncedBackoff = runtime.announcedBackoffClass.has(connectorId);
    const wasAnnouncedBlocked = runtime.announcedBlockedClass.has(connectorId);

    runtime.history.push(record);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${connectorId}: ${message}`);
      });
    }
    persistLastRunTime(connectorId, Date.now());

    if (result.status === "succeeded" && grantAccessMode === "single_use") {
      runtime.exhaustedGrants.add(connectorId);
    }
    if (result.status !== "succeeded") {
      handleGrantFailureDisable(record.terminalReason, connectorId);
    }

    if (result.status === "succeeded" && call.persistState && result.state !== undefined) {
      await setState(connectorId, result.state);
    }

    onRunComplete(record);

    // Streak-cleared transition. Resets both announce-once maps so a
    // future degradation can re-promote (and re-announce). The
    // `evaluateBackoffDispatch` gate also clears `announcedBackoffClass`
    // when it next observes no back-off applied, but doing it here
    // keeps the timeline event ordering tight (success → cleared in
    // the same tick).
    if (result.status === "succeeded" && (wasAnnouncedBackoff || wasAnnouncedBlocked)) {
      runtime.announcedBackoffClass.delete(connectorId);
      runtime.announcedBlockedClass.delete(connectorId);
      recordAndNotify(buildBackoffClearedEvent(connectorId, record.completedAt));
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

  async function runWithRetries(schedule: ConnectorSchedule, call: RunConnectorCall): Promise<RunRecord> {
    const { connectorId, maxRetries = 2 } = schedule;
    let attempt = 0;
    let lastError: RunConnectorError | null = null;

    while (attempt <= maxRetries) {
      if (!runtime.running) {
        break;
      }
      attempt++;

      const outcome = await runSingleAttempt(schedule, call, attempt);
      if (outcome.kind === "done") {
        return outcome.record;
      }
      if (outcome.kind === "give-up") {
        lastError = outcome.error;
        break;
      }

      lastError = outcome.error;
      await sleep(backoffDelayMs(attempt));
      if (!runtime.running) {
        break;
      }
    }

    const failRecord = buildExhaustedFailureRecord({ connectorId, lastError, attempt });
    runtime.history.push(failRecord);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(failRecord))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${connectorId}: ${message}`);
      });
    }
    persistLastRunTime(connectorId, Date.now());
    handleGrantFailureDisable(failRecord.terminalReason ?? failRecord.failureReason, connectorId);
    onRunComplete(failRecord);
    return failRecord;
  }

  async function executeRun(schedule: ConnectorSchedule, isManual = false): Promise<RunRecord | null> {
    const { connectorId, connectorPath, manifest, ownerToken, grantAccessMode = "continuous" } = schedule;

    if (runtime.activeRuns.has(connectorId)) {
      return null;
    }
    runtime.activeRuns.add(connectorId);

    try {
      // Automatic runs skip connectors that previously surfaced a human-attention
      // interaction. Manual runs (isManual=true) bypass this gate so the owner
      // can resolve the issue. The controller also clears the flag on runNow.
      if (!isManual) {
        const notReadyDecision = await decideNotReady(schedule);
        if (notReadyDecision === "silent-skip") {
          return null;
        }
        if (notReadyDecision !== "proceed") {
          return notReadyDecision;
        }
        if (isNeedsHuman(connectorId)) {
          // Emit one inspectable skip record, then suppress further skips on
          // subsequent ticks (mirrors the terminal-grant disabled pattern).
          if (runtime.notifiedNeedsHumanSkips.has(connectorId)) {
            return null;
          }
          runtime.notifiedNeedsHumanSkips.add(connectorId);
          return recordAndNotify(buildNeedsHumanSkip(connectorId));
        }
        // Flag was cleared (owner ran manually or called clearNeedsHuman).
        // Reset suppression so the next time the flag is set we emit a fresh skip.
        runtime.notifiedNeedsHumanSkips.delete(connectorId);
      }

      const singleUseSkip = maybeSkipSingleUseExhausted(connectorId, grantAccessMode);
      if (singleUseSkip) {
        return singleUseSkip;
      }

      const disabledDecision = decideDisabledGrant(connectorId);
      if (disabledDecision === "silent-skip") {
        return null;
      }
      if (disabledDecision !== "proceed") {
        return disabledDecision;
      }

      const persistState = grantAccessMode !== "single_use";
      const state = narrowState(await getState(connectorId));
      const collectionMode: "full_refresh" | "incremental" = state ? "incremental" : "full_refresh";

      // Wrap onInteraction to detect when an automatic run surfaces a
      // human-attention interaction. We mark the connector as needs-human
      // so subsequent automatic ticks skip it rather than repeatedly
      // prompting for OTP or manual browser action.
      const wrappedInteraction: InteractionHandler = (interaction) => {
        if (!isManual) {
          markNeedsHuman(connectorId);
        }
        return onInteraction(interaction);
      };

      return await runWithRetries(schedule, {
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state,
        collectionMode,
        persistState,
        referenceBaseUrl,
        rsUrl,
        onInteraction: wrappedInteraction,
        onProgress: () => {
          // no-op; progress is driven by the runtime's own logging.
        },
      });
    } finally {
      runtime.activeRuns.delete(connectorId);
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
  function evaluateBackoffDispatch(
    schedule: ConnectorSchedule,
    now: number
  ): {
    decision: BackoffDecision;
    eligible: boolean;
    eventsToEmit: RunRecord[];
    skipToEmit: RunRecord | null;
  } {
    const connectorId = schedule.connectorId;
    const lastRun = runtime.lastRunTime.get(connectorId) || 0;
    const history = runtime.history.filter((r) => r.connectorId === connectorId);
    const decision = computeNextRunWithBackoff(history, schedule.intervalMs, lastRun);

    const elapsed = now - lastRun;
    let eligible = elapsed >= decision.effectiveIntervalMs;

    let skipToEmit: RunRecord | null = null;
    const eventsToEmit: RunRecord[] = [];

    if (decision.backoffApplied && decision.reasonClass) {
      const announced = runtime.announcedBackoffClass.get(connectorId);
      if (announced !== decision.reasonClass) {
        runtime.announcedBackoffClass.set(connectorId, decision.reasonClass);
        // The existing back-off skip record (audit log) plus the new
        // one-shot `schedule.back_off.started` transition marker. Both
        // are tied to the *first* skip of the streak; subsequent ticks
        // are suppressed by the `announcedBackoffClass` gate above.
        skipToEmit = buildBackoffSkip(connectorId, decision);
        eventsToEmit.push(buildBackoffStartedEvent(connectorId, decision));
      }

      if (decision.recommendedHealthState === "blocked") {
        // One-shot `schedule.gave_up` per (connector, reason_class)
        // streak. Cleared by a successful run (see
        // `finalizeSuccessOrFailure`) so a future degradation can
        // re-promote and re-announce.
        const blockedAnnounced = runtime.announcedBlockedClass.get(connectorId);
        if (blockedAnnounced !== decision.reasonClass) {
          runtime.announcedBlockedClass.set(connectorId, decision.reasonClass);
          eventsToEmit.push(buildGaveUpEvent(connectorId, decision, findLastSuccessAt(history, connectorId)));
        }
        // Auto-dispatch is suppressed for blocked connectors. Manual
        // `runNow` still works (it bypasses this evaluator entirely via
        // `controller.ts::runNow` → `executeRun(schedule, true)`).
        eligible = false;
      }
    } else if (!decision.backoffApplied) {
      // Streak broken (success or different class): clear the announcement
      // so the next time back-off engages we emit a fresh skip record.
      runtime.announcedBackoffClass.delete(connectorId);
    }

    return { decision, eligible, skipToEmit, eventsToEmit };
  }

  function startScheduledLoops(): void {
    if (runtime.timers.length > 0) {
      return;
    }
    for (const schedule of connectors) {
      // Run immediately, then on interval. Fire-and-forget is intentional:
      // the callback handles its own errors via `onRunComplete`, and the
      // scheduler's state machine tracks activeRuns to prevent overlap.
      executeRun(schedule).catch(() => {
        // Errors are already surfaced into the run record via onRunComplete;
        // swallow here so the scheduler loop doesn't bubble an unhandled
        // rejection out of the interval callback.
      });

      const timer = setInterval(
        () => {
          if (!runtime.running) {
            return;
          }
          const { eligible, skipToEmit, eventsToEmit } = evaluateBackoffDispatch(schedule, Date.now());
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
              // See note on the immediate executeRun above.
            });
          }
        },
        Math.min(schedule.intervalMs, 60_000)
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
      const runs = runtime.history.filter((r) => r.connectorId === schedule.connectorId);
      stats[schedule.connectorId] = {
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
