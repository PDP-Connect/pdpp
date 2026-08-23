// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Run-executor for the scheduler.
 *
 * Encapsulates executing one connector run attempt through retry/finalization
 * to a terminal RunRecord. Called by `executeRun` in scheduler.ts after the
 * pre-run gate cascade clears.
 *
 * Owns:
 *   - launchRun              — top-level launch: static-secret resolution,
 *                              managed-connector routing, state load, retry loop
 *   - runWithRetries         — retry loop over runSingleAttempt
 *   - runSingleAttempt       — one attempt: invoke connector, classify outcome
 *   - buildAttemptCall       — per-attempt call shape (trigger/automation mode)
 *   - finalizeSuccessOrFailure — persist + notify a success or non-exhausted failure
 *   - finalizeExhaustedFailure — persist + notify when retries are exhausted
 *   - routeScheduledManagedRun — managed-connector scheduled routing via controller
 *   - scheduledManagedConnectorLacksRoutingSeam — defer guard for missing seam
 *
 * Does NOT own: executeRun (the orchestration shell that sequences active-run
 * guard → preRunGate → launchRun), pre-run gate, or dispatch governor.
 */

import { createTraceContext, type SpineTraceContext } from "../../lib/spine.ts";
import type { SchedulerRunHistoryRecord } from "../../server/stores/scheduler-store.ts";
import type { ConnectorEnvironmentBinding } from "../connector-child-environment.ts";
import { runConnector } from "../index.ts";
import {
  type AutomationRefreshPolicy,
  projectRunAutomationPolicy,
  type RunAutomationMode,
  type RunTriggerKind,
} from "../run-automation-policy.ts";
import { createRunLogger, NOOP_RUN_BASE_LOGGER, type RunBaseLogger } from "../run-logger.ts";
import type {
  ConnectorSchedule,
  GetStateHandler,
  InteractionHandler,
  IsManagedConnectorHandler,
  NeedsHumanHandler,
  RegisterRunCancellationHandler,
  ResolveStaticSecretRunEnv,
  RunCompleteHandler,
  RunConnectorResult,
  RunManagedConnectorViaController,
  RunRecord,
  RunSource,
  SchedulerManifest,
  SchedulerOptions,
  SetStateHandler,
} from "../scheduler-domain-types.ts";
import {
  type RunConnectorError,
  runRequiresOwnerAuthRepair,
  shouldRetryRunFailure,
} from "../scheduler-retry-classifier.ts";

// ─── Dep types ───────────────────────────────────────────────────────────────

/**
 * Runtime state cells the run-executor reads and mutates.
 * Passed by reference so mutations take effect in the shared runtime.
 */
export interface RunExecutorRuntimeState {
  readonly announcedBackoffClass: Map<string, string>;
  readonly announcedBlockedClass: Map<string, string>;
  readonly exhaustedGrants: Set<string>;
  readonly history: RunRecord[];
  running: boolean;
}

export interface RunExecutorDeps {
  admitRunConnection:
    | ((input: {
        connectorId: string;
        connectorInstanceId: string | null;
        ownerSubjectId: string | null;
      }) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>)
    | null;
  approvedEnvironmentBindings?: readonly ConnectorEnvironmentBinding[];
  approvedProxyConnectorIds?: readonly string[];
  getState: GetStateHandler;
  handleGrantFailureDisable: (reason: string | null | undefined, connectorInstanceId: string) => void;
  isManagedConnector: IsManagedConnectorHandler;
  /**
   * Base structured logger to bind run identity onto (see
   * `runtime/run-logger.ts`). Optional: defaults to `NOOP_RUN_BASE_LOGGER`,
   * so existing callers/tests that construct `RunExecutorDeps` directly are
   * unaffected.
   */
  logger?: RunBaseLogger;
  markNeedsHuman: NeedsHumanHandler;
  maxRunWallClockMs: number;
  onInteraction: InteractionHandler;
  onRunComplete: RunCompleteHandler;
  persistLastRunTime: (connectorId: string, connectorInstanceId: string, lastRunTimeMs: number) => void;
  recordAndNotify: (record: RunRecord) => RunRecord;
  recordAndNotifyAwaited?: (record: RunRecord) => Promise<RunRecord>;
  referenceBaseUrl: string | null;
  registerRunCancellation: RegisterRunCancellationHandler | null | undefined;
  resolveStaticSecretRunEnv: ResolveStaticSecretRunEnv | null;
  rsUrl: string;
  runManagedConnectorViaController: RunManagedConnectorViaController | null;
  runtime: RunExecutorRuntimeState;
  schedulerStore:
    | Pick<NonNullable<SchedulerOptions["schedulerStore"]>, "appendRunHistory" | "deleteActiveRun" | "upsertActiveRun">
    | null
    | undefined;
  setState: SetStateHandler;
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RunExecutor {
  launchRun: (
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    options?: { recoveryOnly?: boolean }
  ) => Promise<RunRecord>;
}

// ─── Local helpers (pure — no runtime dep) ───────────────────────────────────

function buildScheduledRunSource(connectorId: string): RunSource {
  return { id: connectorId, kind: "connector" };
}

function getManifestRefreshPolicy(manifest: SchedulerManifest | null | undefined): AutomationRefreshPolicy | null {
  const manifestObject = narrowState(manifest);
  const capabilities = manifestObject ? narrowState(manifestObject.capabilities) : null;
  const policy = capabilities ? narrowState(capabilities.refresh_policy) : null;
  return policy as AutomationRefreshPolicy | null;
}

function describeFailedRunResult(result: RunConnectorResult): RunConnectorError {
  return {
    checkpoint_summary: result.checkpoint_summary || null,
    connector_error: result.connector_error || null,
    // `failure_reason` and `terminal_reason` are two SEPARATE classification
    // channels, not a value and its fallback. `shouldRetryRunFailure` checks
    // each against its own set — `NON_RETRYABLE_FAILURE_REASONS` and
    // `NON_RETRYABLE_TERMINAL_REASONS` (scheduler-retry-classifier.ts:60,71)
    // — so folding a terminal reason into this field feeds it to a set that
    // was never meant to see it and silently changes retry classification.
    // `connector_protocol_violation` is forwarded because it is a member of
    // BOTH vocabularies; nothing else is.
    failure_reason:
      result.failure_message ||
      (result.terminal_reason === "connector_protocol_violation" ? result.terminal_reason : null),
    known_gaps: result.known_gaps || null,
    message: result.message || "unknown",
    records_emitted: result.records_emitted ?? 0,
    reported_records_emitted: result.reported_records_emitted ?? null,
    run_id: result.run_id || null,
    terminal_reason: result.terminal_reason || null,
    trace_id: result.trace_id || null,
  };
}

function schedulerStatusFromRuntimeResult(status: string | null | undefined): "cancelled" | "failed" | "succeeded" {
  if (status === "succeeded" || status === "cancelled") {
    return status;
  }
  return "failed";
}

function backoffDelayMs(attempt: number): number {
  // Exponential backoff capped at 30 s: 1 s, 2 s, 4 s, ...
  return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// True when a thrown error's message indicates the run was refused by the
// admission gate (admitRunConnection), rather than failing inside the
// connector itself. Both coerceRunError branches below reclassify this
// case to failure_reason/terminal_reason "permission_error" so it is never
// mistaken for a retryable connector defect.
function isAdmissionDeniedMessage(message: string): boolean {
  return message.includes("admitted run connection") || message.includes("admission did not authorize");
}

function coerceRunError(err: unknown): RunConnectorError {
  if (err && typeof err === "object") {
    const candidate = err as RunConnectorError;
    const message = candidate.message ?? (err instanceof Error ? err.message : "unknown");
    return {
      ...candidate,
      message,
      ...(isAdmissionDeniedMessage(message)
        ? { failure_reason: "permission_error", terminal_reason: "permission_error" as const }
        : {}),
    };
  }
  const message = typeof err === "string" ? err : "unknown";
  return isAdmissionDeniedMessage(message)
    ? { failure_reason: "permission_error", message, terminal_reason: "permission_error" }
    : { message };
}

function nowIso(): string {
  return new Date().toISOString();
}

function narrowState(state: unknown): Record<string, unknown> | null {
  if (state && typeof state === "object" && !Array.isArray(state)) {
    return state as Record<string, unknown>;
  }
  return null;
}

// `onProgress` is typed `unknown` at this boundary (see RunConnectorCall);
// only `phase_boundary` is read from it, so narrowing is intentionally this
// narrow rather than casting the whole payload to a wider connector-message type.
function extractPhaseBoundary(msg: unknown): { phase_boundary?: string } | undefined {
  const record = narrowState(msg);
  if (!record || typeof record.phase_boundary !== "string") {
    return;
  }
  return { phase_boundary: record.phase_boundary };
}

function displayNameForScheduledConnector(manifest: SchedulerManifest, connectorId: string): string {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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

function toStoredRunRecord(record: RunRecord): SchedulerRunHistoryRecord {
  const stored: SchedulerRunHistoryRecord = {
    attempt: record.attempt,
    checkpointSummary: record.checkpointSummary,
    completedAt: record.completedAt,
    connectorError: record.connectorError ? { ...record.connectorError } : null,
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    failureReason: record.failureReason ?? null,
    knownGaps: record.knownGaps,
    recordsEmitted: record.recordsEmitted,
    reportedRecordsEmitted: record.reportedRecordsEmitted ?? null,
    runId: record.runId ?? null,
    source: { ...record.source },
    startedAt: record.startedAt,
    status: record.status,
    terminalReason: record.terminalReason ?? null,
    traceId: record.traceId ?? null,
  };
  if (record.error !== undefined) {
    return { ...stored, error: record.error };
  }
  return stored;
}

// ─── RunConnectorCall (internal) ──────────────────────────────────────────────

interface RunConnectorCall {
  admitRunConnection?: Exclude<RunExecutorDeps["admitRunConnection"], null>;
  approvedEnvironmentBindings?: readonly ConnectorEnvironmentBinding[];
  approvedProxyConnectorIds?: readonly string[];
  automationMode?: RunAutomationMode;
  cancelSignal?: AbortSignal | null;
  collectionMode: "full_refresh" | "incremental";
  connectorId: string;
  connectorInstanceId?: string;
  connectorPath: string;
  manifest: SchedulerManifest;
  onInteraction: InteractionHandler;
  // `runtime/index.ts` (still JS) always calls this with the connector's raw
  // PROGRESS payload, typed `unknown` here to match RuntimeRunConnectorOptions
  // (runtime/index.d.ts). `msg.phase_boundary` (see
  // connector-protocol-phase-boundary.d.ts) is the only field this layer
  // reads from it, via the watchdog wrapper in createActiveRunAttemptLease,
  // which narrows before use.
  onProgress: (msg?: unknown) => void;
  onStarted?: (run: { run_id?: string | null; scenario_id?: string | null; trace_id?: string | null }) => void;
  ownerSubjectId: string;
  ownerToken: string;
  persistState: boolean;
  recoveryOnly?: boolean;
  referenceBaseUrl?: string | null;
  rsUrl: string;
  runId?: string;
  state: Record<string, unknown> | null;
  staticSecretEnv?: Record<string, string> | null;
  traceContext?: SpineTraceContext;
  triggerKind?: RunTriggerKind;
}

interface StartedRunInfo {
  runId: string;
  scenarioId: string;
  traceId: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStartedRunInfo(run: Parameters<NonNullable<RunConnectorCall["onStarted"]>>[0]): StartedRunInfo | null {
  const runId = nonEmptyString(run?.run_id);
  if (!runId) {
    return null;
  }
  const traceId = nonEmptyString(run?.trace_id);
  if (!traceId) {
    return null;
  }
  return {
    runId,
    scenarioId: nonEmptyString(run?.scenario_id) ?? "default",
    traceId,
  };
}

async function invokeRunConnector(call: RunConnectorCall): Promise<RunConnectorResult> {
  // `runConnector` is still JS; its parameter signature is refined through
  // `runtime/index.d.ts`. The return shape is validated by the callers
  // (retry classifier + record builders) — they only read documented fields.
  const raw = await runConnector(call);
  return raw as RunConnectorResult;
}

// ─── Attempt watchdog ─────────────────────────────────────────────────────────

interface AttemptWatchdog {
  cancel: () => void;
  clear: () => void;
  /**
   * Called on every PROGRESS message. `extra` carries the connector's
   * `phase_boundary` marker (see connector-protocol-phase-boundary.d.ts) when
   * present — used to detect the local-only-phase transition below.
   */
  /** Returns true on the ONE call that latches local-only suppression, so the
   *  caller can emit a durable trace. A disarmed safety timer must not be an
   *  invisible decision: before this, `phase_boundary` appeared in ZERO spine
   *  events across every run, so an operator seeing a run exceed its ceiling
   *  could not tell "legitimately local-only" from "the watchdog failed". */
  markProgress: (extra?: { phase_boundary?: string }) => boolean;
  readonly signal: AbortSignal;
  timedOut: () => boolean;
}

// A non-finite or non-positive budget means "no wall-clock ceiling" — the
// watchdog must never arm its timer in that case. Named once so the arm
// gate and the constructor's initial-arm decision cannot drift apart.
function isBoundedWallClock(maxRunWallClockMs: number): boolean {
  return Number.isFinite(maxRunWallClockMs) && maxRunWallClockMs > 0;
}

function createAttemptWatchdog(maxRunWallClockMs: number): AttemptWatchdog {
  const cancellation = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  // Set once a connector reports `phase_boundary: "local_only_phase_started"`
  // and never cleared for the rest of this attempt. `maxRunWallClockMs` is
  // sized for provider-rate-limited walks (external API pagination); once a
  // connector declares it has moved to purely local work (e.g. reading its
  // own already-downloaded archive into the store), that budget no longer
  // describes what the run is bound by, and re-arming the timer against it
  // would truncate durable local work exactly like the provider walk it was
  // never meant to bound. See run_1787407222861 (a Slack local sqlite→Postgres
  // ingest killed by this timer after slackdump's own external walk had
  // already finished).
  let localOnlyPhase = false;

  const arm = () => {
    if (!isBoundedWallClock(maxRunWallClockMs) || timedOut || localOnlyPhase || cancellation.signal.aborted) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timedOut = true;
      cancellation.abort("run_timed_out");
    }, maxRunWallClockMs);
    timer.unref?.();
  };

  if (isBoundedWallClock(maxRunWallClockMs)) {
    arm();
  }

  return {
    cancel() {
      if (!cancellation.signal.aborted) {
        cancellation.abort("owner_cancelled");
      }
    },
    clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    markProgress(extra) {
      if (extra?.phase_boundary === "local_only_phase_started" && !localOnlyPhase) {
        localOnlyPhase = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // TRUE only on the latching call — the caller emits the durable trace.
        return true;
      }
      arm();
      return false;
    },
    signal: cancellation.signal,
    timedOut() {
      return timedOut;
    },
  };
}

function runTimedOutError(result: RunConnectorResult, maxRunWallClockMs: number): RunConnectorError {
  const message = `Scheduler run exceeded the ${maxRunWallClockMs}ms progress watchdog budget.`;
  return {
    // `result` is the connector's actual terminal RunConnectorResult at the
    // moment the watchdog killed it — runtime/index.ts's buildClosedRunResult
    // already computed real records_emitted/known_gaps/checkpoint_summary from
    // durable ingest accounting before resolving. A prior revision of this
    // function synthesized a fresh object carrying only classification fields
    // (failure_reason/terminal_reason/message/run_id/trace_id), which silently
    // discarded those already-correct counts and reported records_emitted: 0 /
    // known_gaps: [] / checkpoint_summary: null on every timed-out run
    // regardless of how much work it durably completed before being killed.
    checkpoint_summary: result.checkpoint_summary || null,
    connector_error: result.connector_error || { message },
    failure_reason: "run_timed_out",
    known_gaps: result.known_gaps || null,
    message,
    records_emitted: result.records_emitted ?? 0,
    reported_records_emitted: result.reported_records_emitted ?? null,
    run_id: result.run_id ?? null,
    terminal_reason: "run_timed_out",
    trace_id: result.trace_id ?? null,
  };
}

// ─── Record builders ──────────────────────────────────────────────────────────

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
    attempt,
    checkpointSummary: result.checkpoint_summary || null,
    completedAt: nowIso(),
    connectorError: result.connector_error || null,
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    // Was hardcoded `null` unconditionally — every scheduled run's
    // run_history.failure_reason column stayed empty even on failure,
    // leaving `terminal_reason` (a coarse bucket) as the only classification
    // on record and `connector_error_json` as the only other evidence. The
    // runtime always computes a concise, run-specific failure_message (e.g.
    // "Run exceeded a connector assistance timeout.") and already emits it on
    // the terminal spine event; this was simply never read here.
    //
    // Deliberately does NOT fall back to `terminal_reason`. The two are
    // independent columns that callers read side by side — a run whose only
    // classification is its terminal bucket records `failureReason: null` and
    // `terminalReason: <bucket>`, and collapsing them would make the pair
    // report the same fact twice while erasing "there was no distinct
    // message." See `describeFailedRunResult` above for why the same
    // collapse is additionally unsafe on the retry-classification path.
    failureReason: result.failure_message || null,
    knownGaps: result.known_gaps || [],
    recordsEmitted: result.records_emitted || 0,
    reportedRecordsEmitted: result.reported_records_emitted ?? null,
    runId: result.run_id || null,
    source: buildScheduledRunSource(connectorId),
    startedAt,
    status: schedulerStatusFromRuntimeResult(result.status),
    terminalReason: result.terminal_reason || null,
    traceId: result.trace_id || null,
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
    attempt,
    checkpointSummary: lastError?.checkpoint_summary || null,
    completedAt: nowIso(),
    connectorError: lastError?.connector_error || null,
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: lastError?.message || "unknown",
    failureReason: lastError?.failure_reason || null,
    knownGaps: lastError?.known_gaps || [],
    recordsEmitted: lastError?.records_emitted ?? 0,
    reportedRecordsEmitted: lastError?.reported_records_emitted ?? null,
    runId: lastError?.run_id || null,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "failed",
    terminalReason: lastError?.terminal_reason || null,
    traceId: lastError?.trace_id || null,
  };
}

function buildCredentialResolutionFailure(
  connectorId: string,
  message: string,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `static_secret_credential_unavailable: ${message}`,
    failureReason: "static_secret_credential_unavailable",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "failed",
  };
}

function buildRunAdmissionFailure(connectorId: string, message: string, connectorInstanceId?: string): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `run_connection_admission_failed: ${message}`,
    failureReason: "permission_error",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "failed",
  };
}

const OWNER_REPAIR_CREDENTIAL_CODES = new Set(["credential_not_found", "credential_revoked", "credential_rejected"]);

function ownerRepairCredentialCode(err: unknown): string | null {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return null;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && OWNER_REPAIR_CREDENTIAL_CODES.has(code) ? code : null;
}

function buildCredentialResolutionOwnerActionSkip(
  connectorId: string,
  code: string,
  message: string,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `needs_human_attention: ${code}: ${message}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildBackoffClearedEvent(connectorId: string, resumedAt: string, connectorInstanceId?: string): RunRecord {
  const payload = JSON.stringify({ resumed_at: resumedAt });
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `schedule.back_off.cleared: ${payload}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildBrowserSurfaceUnavailableSkip(
  connectorId: string,
  status: string,
  connectorInstanceId?: string
): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `browser_surface_unavailable: ${status}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

const BROWSER_SURFACE_UNAVAILABLE_STATUSES = new Set([
  "run_browser_surface_queued",
  "browser_surface_probe_failed",
  "browser_surface_lost",
  "surface_failed",
]);

function messageIndicatesRunAlreadyActive(normalizedMessage: string): boolean {
  return normalizedMessage.includes("run_already_active") || normalizedMessage.includes("already has an active run");
}

function messageIndicatesBrowserSurfaceLeaseActive(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes("idx_pg_browser_surface_leases_one_non_terminal_run") ||
    normalizedMessage.includes("browser_surface_leases") ||
    normalizedMessage.includes("non_terminal_run")
  );
}

function controllerRunNowDeferReason(err: unknown): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "run_already_active") {
    return "run_already_active";
  }
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  if (messageIndicatesRunAlreadyActive(normalized)) {
    return "run_already_active";
  }
  if (messageIndicatesBrowserSurfaceLeaseActive(normalized)) {
    return "browser_surface_lease_active";
  }
  return null;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRunExecutor(deps: RunExecutorDeps): RunExecutor {
  const {
    admitRunConnection,
    approvedEnvironmentBindings,
    approvedProxyConnectorIds,
    getState,
    handleGrantFailureDisable,
    isManagedConnector,
    logger: baseLogger = NOOP_RUN_BASE_LOGGER,
    markNeedsHuman,
    maxRunWallClockMs,
    onInteraction,
    onRunComplete,
    persistLastRunTime,
    recordAndNotify,
    recordAndNotifyAwaited,
    referenceBaseUrl,
    registerRunCancellation,
    resolveStaticSecretRunEnv,
    rsUrl,
    runtime,
    runManagedConnectorViaController,
    schedulerStore,
    setState,
  } = deps;

  async function appendRunHistoryBestEffort(record: RunRecord, connectorId: string): Promise<void> {
    if (!schedulerStore) {
      return;
    }
    await Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] failed to persist run history for ${connectorId}: ${message}`);
      createRunLogger(baseLogger, {
        connectorId,
        connectorInstanceId: record.connectorInstanceId,
        runId: record.runId,
      }).error(`failed to persist run history: ${message}`, { phase: "run_history_persist" });
    });
  }

  // Appends `record` to in-memory + durable history and stamps the
  // connector's last-run time. The store append is best-effort, but its
  // settlement is awaited so a later transition cannot overtake this row.
  async function persistRunHistory(record: RunRecord, connectorId: string, connectorInstanceId: string): Promise<void> {
    runtime.history.push(record);
    await appendRunHistoryBestEffort(record, connectorId);
    persistLastRunTime(connectorId, connectorInstanceId, Date.now());
  }

  async function recordAndNotifyDurably(record: RunRecord): Promise<RunRecord> {
    if (recordAndNotifyAwaited) {
      return recordAndNotifyAwaited(record);
    }
    if (!schedulerStore) {
      return recordAndNotify(record);
    }
    runtime.history.push(record);
    await appendRunHistoryBestEffort(record, record.connectorId);
    onRunComplete(record);
    return record;
  }

  // Grant-lifecycle side effects of a terminal result: a succeeded
  // single-use grant is exhausted (never runs again); any non-success
  // status runs the existing terminal-reason-driven disable check.
  function applyGrantOutcome(
    result: RunConnectorResult,
    record: RunRecord,
    grantAccessMode: "continuous" | "single_use",
    connectorInstanceId: string
  ): void {
    if (result.status === "succeeded" && grantAccessMode === "single_use") {
      runtime.exhaustedGrants.add(connectorInstanceId);
    }
    if (result.status !== "succeeded") {
      handleGrantFailureDisable(record.terminalReason, connectorInstanceId);
    }
  }

  // Emits a one-shot `schedule.back_off.cleared` transition marker iff this
  // success ended an announced back-off (or blocked) streak, and resets both
  // announce-once maps so a future degradation can re-promote (and
  // re-announce). The `evaluateBackoffDispatch` gate also clears
  // `announcedBackoffClass` when it next observes no back-off applied, but
  // doing it here keeps the timeline event ordering tight (success →
  // cleared in the same tick). `wasAnnouncedBackoff`/`wasAnnouncedBlocked`
  // must be captured BEFORE this call by the caller, since a success is
  // about to be recorded and this checks the PRE-success streak state.
  async function emitBackoffClearedIfStreakEnded(
    record: RunRecord,
    connectorId: string,
    connectorInstanceId: string,
    wasAnnouncedBackoff: boolean,
    wasAnnouncedBlocked: boolean
  ): Promise<void> {
    if (record.status !== "succeeded" || !(wasAnnouncedBackoff || wasAnnouncedBlocked)) {
      return;
    }
    runtime.announcedBackoffClass.delete(connectorInstanceId);
    runtime.announcedBlockedClass.delete(connectorInstanceId);
    await recordAndNotifyDurably(buildBackoffClearedEvent(connectorId, record.completedAt, connectorInstanceId));
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
      attempt,
      connectorId,
      connectorInstanceId,
      result,
      startedAt,
    });

    // Capture pre-success streak state so the post-record streak-cleared
    // check below observes state as of BEFORE this success, not after.
    const wasAnnouncedBackoff = runtime.announcedBackoffClass.has(connectorInstanceId);
    const wasAnnouncedBlocked = runtime.announcedBlockedClass.has(connectorInstanceId);

    await persistRunHistory(record, connectorId, connectorInstanceId);
    applyGrantOutcome(result, record, grantAccessMode, connectorInstanceId);

    if (result.status === "succeeded" && call.persistState && result.state !== undefined) {
      await setState(connectorId, result.state, connectorInstanceId);
    }

    onRunComplete(record);
    await emitBackoffClearedIfStreakEnded(
      record,
      connectorId,
      connectorInstanceId,
      wasAnnouncedBackoff,
      wasAnnouncedBlocked
    );

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

  // The durable active-run store is only usable when both methods this
  // lease needs are present; a partially-implemented store (e.g. a test
  // double or an older store version) is treated the same as "no store".
  function selectActiveRunStore(): RunExecutorDeps["schedulerStore"] | null {
    return schedulerStore &&
      typeof schedulerStore.upsertActiveRun === "function" &&
      typeof schedulerStore.deleteActiveRun === "function"
      ? schedulerStore
      : null;
  }

  // Reserves the durable active-run row for this attempt. Returns true
  // (admitted) whenever there is no active-run store to reserve against —
  // admission is only ever refused by an explicit `false` upsert result,
  // never by the reservation attempt itself failing (log-and-continue,
  // fail-open).
  async function reserveActiveRunRow(
    activeRunStore: RunExecutorDeps["schedulerStore"] | null,
    connectorId: string,
    connectorInstanceId: string,
    attempt: number,
    runId: string,
    startedAt: string,
    traceContext: SpineTraceContext
  ): Promise<boolean> {
    if (!activeRunStore) {
      return true;
    }
    const upserted = await Promise.resolve(
      activeRunStore.upsertActiveRun({
        connector_id: connectorId,
        connector_instance_id: connectorInstanceId,
        run_generation: attempt,
        run_id: runId,
        scenario_id: traceContext.scenario_id,
        started_at: startedAt,
        trace_id: traceContext.trace_id,
      })
    ).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] failed to reserve active run for ${connectorId}: ${message}`);
      createRunLogger(baseLogger, { connectorId, connectorInstanceId, runId }).error(
        `failed to reserve active run: ${message}`,
        { phase: "active_run_reserve" }
      );
      return false;
    });
    return upserted !== false;
  }

  // Wraps the caller's onStarted so it also registers this attempt's
  // cancellation handle once the connector reports a real run id/trace id.
  // The unregister handle is written into `unregisterCancellationBox` (owned
  // by the caller) rather than returned, since onStarted fires later,
  // asynchronously, from inside the connector run — the caller's `clear()`
  // needs a box it can read after this callback may have already run.
  function registerAttemptCancellation(
    originalOnStarted: RunConnectorCall["onStarted"],
    admitted: boolean,
    watchdog: AttemptWatchdog,
    connectorId: string,
    connectorInstanceId: string,
    unregisterCancellationBox: { value: (() => void) | null }
  ): NonNullable<RunConnectorCall["onStarted"]> {
    return (run) => {
      originalOnStarted?.(run);
      // Only a genuinely admitted attempt with a real run id/trace id gets a
      // cancellation handle — an unadmitted attempt has no watchdog worth
      // cancelling, and readStartedRunInfo must not even run for it.
      const startedRun = admitted ? readStartedRunInfo(run) : null;
      if (!startedRun) {
        return;
      }
      unregisterCancellationBox.value =
        registerRunCancellation?.({
          cancel: () => watchdog.cancel(),
          connectorId,
          connectorInstanceId,
          runId: startedRun.runId,
        }) ?? null;
    };
  }

  // The durable active-run lease + wall-clock watchdog for one attempt. Wraps the
  // caller's RunConnectorCall so `onStarted` persists an active-run row and
  // `onProgress` feeds the watchdog; `clear()` (run in runSingleAttempt's finally)
  // awaits the pending upsert then deletes the row.
  async function createActiveRunAttemptLease(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number,
    startedAt: string
  ): Promise<{
    call: RunConnectorCall;
    admitted: boolean;
    watchdog: ReturnType<typeof createAttemptWatchdog>;
    clear: () => Promise<void>;
  }> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;
    const originalOnProgress = call.onProgress;
    const activeRunStore = selectActiveRunStore();
    const watchdog = createAttemptWatchdog(maxRunWallClockMs);
    const runId = call.runId || `run_${Date.now()}`;
    const traceContext = call.traceContext ?? createTraceContext();
    const admitted = await reserveActiveRunRow(
      activeRunStore,
      connectorId,
      connectorInstanceId,
      attempt,
      runId,
      startedAt,
      traceContext
    );
    const unregisterCancellationBox: { value: (() => void) | null } = { value: null };

    const leasedCall: RunConnectorCall = {
      ...call,
      cancelSignal: watchdog.signal,
      onProgress: (msg) => {
        const suppressedWallClock = watchdog.markProgress(extractPhaseBoundary(msg));
        originalOnProgress(msg);
        if (suppressedWallClock) {
          // The run just disarmed its own wall-clock watchdog. Record it through
          // the SAME progress channel the timeline already persists, so the
          // decision leaves a trace instead of being reconstructable only by
          // reading source inside a container.
          originalOnProgress({
            message: `runtime.wall_clock_watchdog_suppressed {"reason":"local_only_phase_started","disarmed_budget_ms":${String(maxRunWallClockMs)}}`,
            stream: null,
          } as Parameters<typeof originalOnProgress>[0]);
        }
      },
      onStarted: registerAttemptCancellation(
        call.onStarted,
        admitted,
        watchdog,
        connectorId,
        connectorInstanceId,
        unregisterCancellationBox
      ),
      runId,
      traceContext,
    };

    const clear = async (): Promise<void> => {
      unregisterCancellationBox.value?.();
      unregisterCancellationBox.value = null;
      watchdog.clear();
      if (admitted && activeRunStore) {
        await Promise.resolve(activeRunStore.deleteActiveRun(connectorInstanceId, runId)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] failed to clear active run ${runId} for ${connectorId}: ${message}`);
          createRunLogger(baseLogger, { connectorId, connectorInstanceId, runId }).error(
            `failed to clear active run: ${message}`,
            { phase: "active_run_clear" }
          );
        });
      }
    };

    return { admitted, call: leasedCall, clear, watchdog };
  }

  async function runSingleAttempt(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number
  ): Promise<AttemptOutcome> {
    const { maxRetries = 2 } = schedule;
    const startedAt = nowIso();
    const lease = await createActiveRunAttemptLease(schedule, call, attempt, startedAt);
    const { watchdog } = lease;

    try {
      if (!lease.admitted) {
        return {
          kind: "done",
          record: recordAndNotify(
            buildBrowserSurfaceUnavailableSkip(schedule.connectorId, "run_already_active", schedule.connectorInstanceId)
          ),
        };
      }
      const result = await invokeRunConnector(lease.call);
      if (watchdog.timedOut()) {
        return { error: runTimedOutError(result, maxRunWallClockMs), kind: "give-up" };
      }
      const candidateError: RunConnectorError = {
        connector_error: result.connector_error || null,
        failure_reason: result.terminal_reason === "connector_protocol_violation" ? result.terminal_reason : null,
        known_gaps: result.known_gaps || null,
        terminal_reason: result.terminal_reason || null,
      };

      if (result.status !== "succeeded" && attempt <= maxRetries && shouldRetryRunFailure(candidateError)) {
        return { error: describeFailedRunResult(result), kind: "retry" };
      }

      const record = await finalizeSuccessOrFailure(schedule, call, result, startedAt, attempt);
      return { kind: "done", record };
    } catch (err) {
      const error = coerceRunError(err);
      if (attempt <= maxRetries && shouldRetryRunFailure(error)) {
        return { error, kind: "retry" };
      }
      return { error, kind: "give-up" };
    } finally {
      await lease.clear();
    }
  }

  function buildAttemptCall(schedule: ConnectorSchedule, call: RunConnectorCall, attempt: number): RunConnectorCall {
    const attemptTriggerKind: RunTriggerKind = attempt === 1 ? (call.triggerKind ?? "scheduled") : "retry";
    const attemptPolicy = projectRunAutomationPolicy({
      refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
      triggerKind: attemptTriggerKind,
    });
    return {
      ...call,
      automationMode: attemptPolicy.automation_mode,
      runId: call.runId ?? `run_${Date.now()}_${attempt}`,
      traceContext: call.traceContext ?? createTraceContext(),
      triggerKind: attemptPolicy.trigger_kind,
    };
  }

  // Drains the durable failure record for an exhausted-retries run: history,
  // store append, last-run timestamp, terminal-grant handling, completion
  // notification. Pulled out so `runWithRetries` only orchestrates the retry
  // loop and trusts this helper for the failure tail.
  async function finalizeExhaustedFailure(
    schedule: ConnectorSchedule,
    lastError: RunConnectorError | null,
    attempt: number
  ): Promise<RunRecord> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;
    const failRecord = buildExhaustedFailureRecord({
      attempt,
      connectorId,
      connectorInstanceId,
      lastError,
    });
    await persistRunHistory(failRecord, connectorId, connectorInstanceId);
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
      // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
      attempt++;

      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
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

  function scheduledManagedConnectorLacksRoutingSeam(
    isManual: boolean,
    via: RunManagedConnectorViaController | null | undefined,
    connectorId: string
  ): boolean {
    return !(isManual || via) && isManagedConnector(connectorId);
  }

  // Routes a scheduled managed-connector run through controller.runNow and
  // maps every outcome (contention, controller failure, surface unavailable,
  // terminal success/failure) to a RunRecord. Returns null when runNowResult
  // is null, signalling that the connector is not managed and launchRun should
  // fall through to the runWithRetries path.
  // Failure RunRecord for a managed run whose controller `runNow` THREW a
  // non-deferrable error. Extracted from routeScheduledManagedRun verbatim.
  function buildManagedRunControllerFailure(
    connectorId: string,
    connectorInstanceId: string,
    startedAt: string,
    message: string,
    attempt = 1
  ): RunRecord {
    return {
      attempt,
      checkpointSummary: null,
      completedAt: nowIso(),
      connectorId,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      connectorInstanceId: connectorInstanceId ?? null,
      error: `controller_run_now_failed: ${message}`,
      knownGaps: [],
      recordsEmitted: 0,
      source: buildScheduledRunSource(connectorId),
      startedAt,
      status: "failed",
    };
  }

  // Terminal RunRecord for a managed run whose controller `runNow` RETURNED a
  // result (succeeded/failed). Extracted from routeScheduledManagedRun verbatim.
  function buildManagedRunTerminalRecord(
    connectorId: string,
    connectorInstanceId: string,
    startedAt: string,
    runNowResult: NonNullable<Awaited<ReturnType<RunManagedConnectorViaController>>>,
    attempt = 1
  ): RunRecord {
    return {
      attempt,
      checkpointSummary: null,
      completedAt: nowIso(),
      connectorError: runNowResult.connector_error || null,
      connectorId,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      connectorInstanceId: connectorInstanceId ?? null,
      failureReason: runNowResult.failure_reason || null,
      knownGaps: runNowResult.known_gaps || [],
      recordsEmitted: 0,
      runId: runNowResult.run_id ?? null,
      source: buildScheduledRunSource(connectorId),
      startedAt,
      status: schedulerStatusFromRuntimeResult(runNowResult.status),
      terminalReason: runNowResult.terminal_reason || null,
      traceId: runNowResult.trace_id ?? null,
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
  async function routeScheduledManagedRun(
    via: RunManagedConnectorViaController,
    connectorId: string,
    connectorInstanceId: string,
    ownerToken: string,
    ownerSubjectId: string,
    options: { maxRetries?: number; recoveryOnly?: boolean } = {}
  ): Promise<RunRecord | null> {
    const maxRetries =
      options.maxRetries !== undefined && Number.isFinite(options.maxRetries)
        ? Math.max(0, Math.trunc(options.maxRetries))
        : 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
      attempt++;
      const startedAt = nowIso();
      let runNowResult: Awaited<ReturnType<RunManagedConnectorViaController>>;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
        runNowResult = await via(connectorId, {
          connectorInstanceId,
          ownerSubjectId,
          ownerToken,
          priorityClass: "background",
          recoveryOnly: options.recoveryOnly === true,
          referenceBaseUrl,
          rsUrl,
          triggerKind: "scheduled",
        });
      } catch (err) {
        const deferReason = controllerRunNowDeferReason(err);
        if (deferReason) {
          return recordAndNotify(buildBrowserSurfaceUnavailableSkip(connectorId, deferReason, connectorInstanceId));
        }
        const message = err instanceof Error ? err.message : String(err);
        persistLastRunTime(connectorId, connectorInstanceId, Date.now());
        return recordAndNotify(
          buildManagedRunControllerFailure(connectorId, connectorInstanceId, startedAt, message, attempt)
        );
      }

      if (runNowResult === null) {
        return null;
      }

      if (runNowResult.status && BROWSER_SURFACE_UNAVAILABLE_STATUSES.has(runNowResult.status)) {
        return recordAndNotify(
          buildBrowserSurfaceUnavailableSkip(connectorId, runNowResult.status, connectorInstanceId)
        );
      }

      if (
        runNowResult.status !== "succeeded" &&
        attempt <= maxRetries &&
        shouldRetryRunFailure({
          connector_error: runNowResult.connector_error || null,
          failure_reason: runNowResult.failure_reason || null,
          known_gaps: runNowResult.known_gaps || null,
          terminal_reason: runNowResult.terminal_reason || null,
        })
      ) {
        await sleep(backoffDelayMs(attempt));
        continue;
      }

      persistLastRunTime(connectorId, connectorInstanceId, Date.now());
      if (runNowResult.status !== "succeeded" && runRequiresOwnerAuthRepair(runNowResult)) {
        markNeedsHuman(connectorId, connectorInstanceId);
      }
      const wasAnnouncedBackoff = runtime.announcedBackoffClass.has(connectorInstanceId);
      const wasAnnouncedBlocked = runtime.announcedBlockedClass.has(connectorInstanceId);
      const record = await recordAndNotifyDurably(
        buildManagedRunTerminalRecord(connectorId, connectorInstanceId, startedAt, runNowResult, attempt)
      );
      await emitBackoffClearedIfStreakEnded(
        record,
        connectorId,
        connectorInstanceId,
        wasAnnouncedBackoff,
        wasAnnouncedBlocked
      );
      return record;
    }

    throw new Error("unreachable managed run retry state");
  }

  // Phase 2 of launchRun: resolve connection-scoped static-secret credentials
  // BEFORE launching — parity with the manual path (`controller.ts::runNow`).
  // True static-secret connections must supply a source-scoped credential
  // through this seam; a resolver throw is fail-closed so the scheduler refuses
  // the launch rather than falling through to a deployment-wide provider-account
  // secret. Browser-session sources may return null when no optional stored
  // login credential exists; the connector can still reuse/repair the browser
  // session according to its automation policy.
  //
  // Returns EITHER the resolved env OR a terminal RunRecord (`earlyReturn`) that
  // launchRun must hand to recordAndNotify. Behavior-preserving extraction: the
  // resolver call, persistLastRunTime, isManual/ownerRepairCode branching,
  // markNeedsHuman, and both record builders are moved verbatim; recordAndNotify
  // is still invoked exactly once by launchRun on the returned record.
  async function resolveLaunchCredentials(
    connectorId: string,
    connectorInstanceId: string,
    ownerSubjectId: string,
    isManual: boolean
  ): Promise<{ env: Record<string, string> | null } | { earlyReturn: RunRecord }> {
    if (!resolveStaticSecretRunEnv) {
      return { env: null };
    }
    try {
      return { env: await resolveStaticSecretRunEnv({ connectorId, connectorInstanceId, ownerSubjectId }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      persistLastRunTime(connectorId, connectorInstanceId, Date.now());
      const ownerRepairCode = ownerRepairCredentialCode(err);
      if (!isManual && ownerRepairCode) {
        markNeedsHuman(connectorId, connectorInstanceId);
        return {
          earlyReturn: buildCredentialResolutionOwnerActionSkip(
            connectorId,
            ownerRepairCode,
            message,
            connectorInstanceId
          ),
        };
      }
      return { earlyReturn: buildCredentialResolutionFailure(connectorId, message, connectorInstanceId) };
    }
  }

  async function admitScheduledRunConnection(
    connectorId: string,
    connectorInstanceId: string,
    ownerSubjectId: string
  ): Promise<void> {
    if (!admitRunConnection) {
      if (resolveStaticSecretRunEnv) {
        throw new Error("scheduler run connection admission is required before credential resolution");
      }
      return;
    }
    const admittedConnection = await admitRunConnection({
      connectorId,
      connectorInstanceId,
      ownerSubjectId,
    });
    if (
      admittedConnection.connectorId !== connectorId ||
      admittedConnection.connectorInstanceId !== connectorInstanceId ||
      admittedConnection.ownerSubjectId !== ownerSubjectId
    ) {
      throw new Error("scheduler run admission did not authorize the claimed owner connection");
    }
  }

  // Phase 3 of launchRun: load prior state, derive collectionMode, and build the
  // onInteraction wrapper that marks an AUTOMATIC run needs-human the first time
  // it surfaces a human-attention interaction. The wrapper closes over a mutable
  // `currentRunId` box so the run id (set later by runWithRetries' onStarted)
  // flows into the interaction context without changing WHEN markNeedsHuman
  // fires. Extracted verbatim from launchRun.
  async function buildLaunchInteractionContext(
    schedule: ConnectorSchedule,
    isManual: boolean,
    currentRunIdBox: { value: string | null }
  ): Promise<{
    state: Record<string, unknown> | null;
    collectionMode: "full_refresh" | "incremental";
    wrappedInteraction: InteractionHandler;
  }> {
    const { connectorId, connectorInstanceId = connectorId, manifest } = schedule;
    const state = narrowState(await getState(connectorId, connectorInstanceId));
    const collectionMode: "full_refresh" | "incremental" = state ? "incremental" : "full_refresh";
    const connectorDisplayName = displayNameForScheduledConnector(manifest, connectorId);

    const wrappedInteraction: InteractionHandler = (interaction) => {
      if (!isManual) {
        markNeedsHuman(connectorId, connectorInstanceId);
      }
      return onInteraction(
        withSchedulerInteractionContext(interaction, {
          connectorDisplayName,
          connectorId,
          connectorInstanceId,
          runId: currentRunIdBox.value,
        })
      );
    };

    return { collectionMode, state, wrappedInteraction };
  }

  function launchRun(
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    options: { recoveryOnly?: boolean } = {}
  ): Promise<RunRecord> {
    const { connectorId, connectorInstanceId = connectorId, ownerSubjectId } = schedule;
    if (typeof ownerSubjectId !== "string" || ownerSubjectId.trim().length === 0) {
      return Promise.resolve(
        recordAndNotify(
          buildCredentialResolutionFailure(
            connectorId,
            "scheduler ownerSubjectId is required and must be nonblank",
            connectorInstanceId
          )
        )
      );
    }
    return launchRunWithValidatedOwner(schedule, isManual, automationPolicy, options);
  }

  async function launchRunWithValidatedOwner(
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    options: { recoveryOnly?: boolean } = {}
  ): Promise<RunRecord> {
    const recoveryOnly = options.recoveryOnly === true;
    const {
      connectorId,
      connectorInstanceId = connectorId,
      connectorPath,
      manifest,
      ownerToken,
      ownerSubjectId,
      grantAccessMode = "continuous",
    } = schedule;
    const persistState = grantAccessMode !== "single_use";

    try {
      await admitScheduledRunConnection(connectorId, connectorInstanceId, ownerSubjectId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return recordAndNotify(buildRunAdmissionFailure(connectorId, message, connectorInstanceId));
    }

    const credentials = await resolveLaunchCredentials(connectorId, connectorInstanceId, ownerSubjectId, isManual);
    if ("earlyReturn" in credentials) {
      return recordAndNotify(credentials.earlyReturn);
    }
    const staticSecretEnv = credentials.env;

    const currentRunIdBox: { value: string | null } = { value: null };
    const { state, collectionMode, wrappedInteraction } = await buildLaunchInteractionContext(
      schedule,
      isManual,
      currentRunIdBox
    );

    // ── Restart-race guard: managed connector with no routing seam → DEFER ────
    //
    // A managed (browser-surface-leased) connector MUST run through
    // `controller.runNow` so it acquires the warm neko surface (persistent
    // profile with a valid Cloudflare clearance cookie). If the managed-routing
    // seam (`runManagedConnectorViaController`) is not wired — e.g. the
    // controller's `browserSurfaceLeaseManager` was not yet available when
    // `createScheduler` ran, so the callback was constructed as `null` — a
    // SCHEDULED run would otherwise fall through to the cold `runConnector`
    // path below: fresh headless Chromium, empty profile, no clearance cookie →
    // a bot-detecting provider challenges and fails it, and every such cold
    // failure deepens the failure back-off (the live wedge's failure streak).
    //
    // Treat a missing seam exactly like a surface-capacity shortfall: a
    // DEFERRED SKIP (skip this tick, retry the next) rather than a cold launch.
    // The next tick — once the seam is wired — routes warm. Manual runs are
    // unaffected: the owner explicitly asked to retry now and bypasses this
    // gate entirely (and the manual path has its own surface acquisition).
    if (scheduledManagedConnectorLacksRoutingSeam(isManual, runManagedConnectorViaController, connectorId)) {
      return recordAndNotify(
        buildBrowserSurfaceUnavailableSkip(connectorId, "surface_routing_unavailable", connectorInstanceId)
      );
    }

    // ── Managed-connector scheduled run: route through controller.runNow ──────
    //
    // Manual runs already go through controller.runNow (the owner calls the
    // /_ref/run-now endpoint, which calls controller.runNow directly). For
    // SCHEDULED runs the scheduler previously called runConnector directly,
    // bypassing the managed-neko browser-surface lease. That meant:
    //   - No warm neko surface was acquired.
    //   - Chromium launched fresh with an EMPTY profile (no cf_clearance cookie).
    //   - Cloudflare challenged 100% of scheduled runs.
    //
    // Fix: route scheduled runs for managed connectors through controller.runNow,
    // which calls acquireManagedBrowserSurfaceForRun and hands the connector
    // the warm, persistent neko surface env. The callback embeds the
    // isManagedConnector check so non-managed connectors fall through unchanged.
    //
    // Lease release: controller.runNow wraps the connector spawn in:
    //   .finally(() => finalizeRunCleanup({...}))
    // which calls releaseBrowserSurfaceLeaseAfterRun → releaseBrowserSurfaceLease.
    // This release fires on EVERY exit path (success, failure, crash) so the
    // scheduler must NOT add a separate release call — that would double-release.
    //
    // controller_active_runs mutual exclusion: validateRunNowPreconditions checks
    // activeRuns.get(key) and throws run_already_active (ControllerError) when a
    // run is already in-flight for this connector. The scheduler's own
    // runtime.activeRuns.has(key) guard in executeRun prevents double-dispatch
    // from within the scheduler. Both guards stay intact.
    if (runManagedConnectorViaController && !isManual) {
      // Null return means connector is not managed — fall through to runWithRetries.
      const managedRunOptions: { maxRetries?: number; recoveryOnly?: boolean } = { recoveryOnly };
      if (schedule.maxRetries !== undefined) {
        managedRunOptions.maxRetries = schedule.maxRetries;
      }
      const managed = await routeScheduledManagedRun(
        runManagedConnectorViaController,
        connectorId,
        connectorInstanceId,
        ownerToken,
        ownerSubjectId,
        managedRunOptions
      );
      if (managed !== null) {
        return managed;
      }
    }

    return await runWithRetries(schedule, {
      ...(admitRunConnection ? { admitRunConnection } : {}),
      ...(approvedEnvironmentBindings ? { approvedEnvironmentBindings } : {}),
      ...(approvedProxyConnectorIds ? { approvedProxyConnectorIds } : {}),
      automationMode: automationPolicy.automation_mode,
      collectionMode,
      connectorId,
      connectorInstanceId,
      connectorPath,
      manifest,
      onInteraction: wrappedInteraction,
      onProgress: () => {
        // no-op; progress is driven by the runtime's own logging.
      },
      onStarted: (run) => {
        currentRunIdBox.value = typeof run?.run_id === "string" ? run.run_id : null;
      },
      ownerSubjectId,
      ownerToken,
      persistState,
      recoveryOnly,
      referenceBaseUrl,
      rsUrl,
      state,
      staticSecretEnv,
      triggerKind: automationPolicy.trigger_kind,
    });
  }

  return { launchRun };
}
