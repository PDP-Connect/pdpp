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

import type { SchedulerRunHistoryRecord } from "../../server/stores/scheduler-store.ts";
import { runConnector } from "../index.js";
import {
  type AutomationRefreshPolicy,
  projectRunAutomationPolicy,
  type RunAutomationMode,
  type RunTriggerKind,
} from "../run-automation-policy.ts";
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
  getState: GetStateHandler;
  handleGrantFailureDisable: (reason: string | null | undefined, connectorInstanceId: string) => void;
  isManagedConnector: IsManagedConnectorHandler;
  markNeedsHuman: NeedsHumanHandler;
  maxRunWallClockMs: number;
  onInteraction: InteractionHandler;
  onRunComplete: RunCompleteHandler;
  persistLastRunTime: (connectorId: string, connectorInstanceId: string, lastRunTimeMs: number) => void;
  recordAndNotify: (record: RunRecord) => RunRecord;
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
  launchRun(
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    options?: { recoveryOnly?: boolean }
  ): Promise<RunRecord>;
}

// ─── Local helpers (pure — no runtime dep) ───────────────────────────────────

function buildScheduledRunSource(connectorId: string): RunSource {
  return { kind: "connector", id: connectorId };
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

// ─── RunConnectorCall (internal) ──────────────────────────────────────────────

interface RunConnectorCall {
  automationMode?: RunAutomationMode;
  cancelSignal?: AbortSignal | null;
  collectionMode: "full_refresh" | "incremental";
  connectorId: string;
  connectorInstanceId?: string;
  connectorPath: string;
  manifest: SchedulerManifest;
  onInteraction: InteractionHandler;
  onProgress: () => void;
  onStarted?: (run: { run_id?: string | null; scenario_id?: string | null; trace_id?: string | null }) => void;
  ownerToken: string;
  persistState: boolean;
  recoveryOnly?: boolean;
  referenceBaseUrl?: string | null;
  rsUrl: string;
  state: Record<string, unknown> | null;
  staticSecretEnv?: Record<string, string> | null;
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
  cancel(): void;
  clear(): void;
  markProgress(): void;
  readonly signal: AbortSignal;
  timedOut(): boolean;
}

function createAttemptWatchdog(maxRunWallClockMs: number): AttemptWatchdog {
  const cancellation = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;

  const arm = () => {
    if (!(Number.isFinite(maxRunWallClockMs) && maxRunWallClockMs > 0) || timedOut || cancellation.signal.aborted) {
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

  if (Number.isFinite(maxRunWallClockMs) && maxRunWallClockMs > 0) {
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
    markProgress() {
      arm();
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
    connector_error: result.connector_error || { message },
    failure_reason: "run_timed_out",
    message,
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
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: schedulerStatusFromRuntimeResult(result.status),
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

const OWNER_REPAIR_CREDENTIAL_CODES = new Set(["credential_not_found", "credential_revoked", "credential_rejected"]);

function ownerRepairCredentialCode(err: unknown): string | null {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return null;
  }
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
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    source: buildScheduledRunSource(connectorId),
    status: "skipped",
    recordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    startedAt: nowIso(),
    completedAt: nowIso(),
    error: `needs_human_attention: ${code}: ${message}`,
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

function buildBrowserSurfaceUnavailableSkip(
  connectorId: string,
  status: string,
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
    error: `browser_surface_unavailable: ${status}`,
    attempt: 0,
  };
}

const BROWSER_SURFACE_UNAVAILABLE_STATUSES = new Set([
  "run_browser_surface_queued",
  "browser_surface_probe_failed",
  "browser_surface_lost",
  "surface_failed",
]);

function controllerRunNowDeferReason(err: unknown): string | null {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "run_already_active") {
    return "run_already_active";
  }
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  if (normalized.includes("run_already_active") || normalized.includes("already has an active run")) {
    return "run_already_active";
  }
  if (
    normalized.includes("idx_pg_browser_surface_leases_one_non_terminal_run") ||
    normalized.includes("browser_surface_leases") ||
    normalized.includes("non_terminal_run")
  ) {
    return "browser_surface_lease_active";
  }
  return null;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createRunExecutor(deps: RunExecutorDeps): RunExecutor {
  const {
    getState,
    handleGrantFailureDisable,
    isManagedConnector,
    markNeedsHuman,
    maxRunWallClockMs,
    onInteraction,
    onRunComplete,
    persistLastRunTime,
    recordAndNotify,
    referenceBaseUrl,
    registerRunCancellation,
    resolveStaticSecretRunEnv,
    rsUrl,
    runtime,
    runManagedConnectorViaController,
    schedulerStore,
    setState,
  } = deps;

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

  // The durable active-run lease + wall-clock watchdog for one attempt. Wraps the
  // caller's RunConnectorCall so `onStarted` persists an active-run row and
  // `onProgress` feeds the watchdog; `clear()` (run in runSingleAttempt's finally)
  // awaits the pending upsert then deletes the row. Extracted verbatim from the
  // former inline block in runSingleAttempt so the attempt body reads as pure
  // control flow; behavior (lease timing, error logging, watchdog) is unchanged.
  function createActiveRunAttemptLease(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number,
    startedAt: string
  ): { call: RunConnectorCall; watchdog: ReturnType<typeof createAttemptWatchdog>; clear: () => Promise<void> } {
    const { connectorId, connectorInstanceId = connectorId } = schedule;
    let activeRunId: string | null = null;
    let activeRunRegistration: Promise<void> | null = null;
    let unregisterCancellation: (() => void) | null = null;
    const originalOnStarted = call.onStarted;
    const originalOnProgress = call.onProgress;
    const activeRunStore =
      schedulerStore &&
      typeof schedulerStore.upsertActiveRun === "function" &&
      typeof schedulerStore.deleteActiveRun === "function"
        ? schedulerStore
        : null;
    const watchdog = createAttemptWatchdog(maxRunWallClockMs);

    const leasedCall: RunConnectorCall = {
      ...call,
      cancelSignal: watchdog.signal,
      onProgress: () => {
        watchdog.markProgress();
        originalOnProgress();
      },
      onStarted: (run) => {
        originalOnStarted?.(run);
        if (!activeRunStore) {
          return;
        }
        const startedRun = readStartedRunInfo(run);
        if (!startedRun) {
          return;
        }
        activeRunId = startedRun.runId;
        unregisterCancellation =
          registerRunCancellation?.({
            cancel: () => watchdog.cancel(),
            connectorId,
            connectorInstanceId,
            runId: startedRun.runId,
          }) ?? null;
        activeRunRegistration = Promise.resolve(
          activeRunStore.upsertActiveRun({
            connector_instance_id: connectorInstanceId,
            connector_id: connectorId,
            run_id: startedRun.runId,
            run_generation: attempt,
            trace_id: startedRun.traceId,
            scenario_id: startedRun.scenarioId,
            started_at: startedAt,
          })
        ).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] failed to persist active run for ${connectorId}: ${message}`);
        });
      },
    };

    const clear = async (): Promise<void> => {
      unregisterCancellation?.();
      unregisterCancellation = null;
      watchdog.clear();
      if (activeRunId && activeRunStore) {
        // Await the (possibly still-pending) upsert registration before deleting
        // so we never clear an active-run row before it was written.
        const pendingRegistration: Promise<void> | null = activeRunRegistration;
        if (pendingRegistration) {
          await pendingRegistration;
        }
        await Promise.resolve(activeRunStore.deleteActiveRun(connectorInstanceId, activeRunId)).catch(
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[scheduler] failed to clear active run ${activeRunId} for ${connectorId}: ${message}`);
          }
        );
      }
    };

    return { call: leasedCall, watchdog, clear };
  }

  async function runSingleAttempt(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number
  ): Promise<AttemptOutcome> {
    const { maxRetries = 2 } = schedule;
    const startedAt = nowIso();
    const lease = createActiveRunAttemptLease(schedule, call, attempt, startedAt);
    const { watchdog } = lease;

    try {
      const result = await invokeRunConnector(lease.call);
      if (watchdog.timedOut()) {
        return { kind: "give-up", error: runTimedOutError(result, maxRunWallClockMs) };
      }
      const candidateError: RunConnectorError = {
        failure_reason: result.terminal_reason === "connector_protocol_violation" ? result.terminal_reason : null,
        terminal_reason: result.terminal_reason || null,
        connector_error: result.connector_error || null,
        known_gaps: result.known_gaps || null,
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
    } finally {
      await lease.clear();
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
      connectorId,
      connectorInstanceId: connectorInstanceId ?? null,
      source: buildScheduledRunSource(connectorId),
      status: "failed",
      recordsEmitted: 0,
      checkpointSummary: null,
      knownGaps: [],
      startedAt,
      completedAt: nowIso(),
      error: `controller_run_now_failed: ${message}`,
      attempt,
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
      connectorId,
      connectorInstanceId: connectorInstanceId ?? null,
      source: buildScheduledRunSource(connectorId),
      status: schedulerStatusFromRuntimeResult(runNowResult.status),
      recordsEmitted: 0,
      checkpointSummary: null,
      knownGaps: runNowResult.known_gaps || [],
      connectorError: runNowResult.connector_error || null,
      failureReason: runNowResult.failure_reason || null,
      startedAt,
      completedAt: nowIso(),
      runId: runNowResult.run_id ?? null,
      terminalReason: runNowResult.terminal_reason || null,
      traceId: runNowResult.trace_id ?? null,
      attempt,
    };
  }

  async function routeScheduledManagedRun(
    via: RunManagedConnectorViaController,
    connectorId: string,
    connectorInstanceId: string,
    ownerToken: string,
    options: { maxRetries?: number; recoveryOnly?: boolean } = {}
  ): Promise<RunRecord | null> {
    const maxRetries =
      options.maxRetries !== undefined && Number.isFinite(options.maxRetries)
        ? Math.max(0, Math.trunc(options.maxRetries))
        : 2;
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;
      const startedAt = nowIso();
      let runNowResult: Awaited<ReturnType<RunManagedConnectorViaController>>;
      try {
        runNowResult = await via(connectorId, {
          connectorInstanceId,
          ownerToken,
          priorityClass: "scheduled_refresh",
          recoveryOnly: options.recoveryOnly === true,
          triggerKind: "scheduled",
          referenceBaseUrl,
          rsUrl,
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
      return recordAndNotify(buildManagedRunTerminalRecord(connectorId, connectorInstanceId, startedAt, runNowResult, attempt));
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
    isManual: boolean
  ): Promise<{ env: Record<string, string> | null } | { earlyReturn: RunRecord }> {
    if (!resolveStaticSecretRunEnv) {
      return { env: null };
    }
    try {
      return { env: await resolveStaticSecretRunEnv({ connectorId, connectorInstanceId }) };
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

    return { state, collectionMode, wrappedInteraction };
  }

  async function launchRun(
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
      grantAccessMode = "continuous",
    } = schedule;
    const persistState = grantAccessMode !== "single_use";

    const credentials = await resolveLaunchCredentials(connectorId, connectorInstanceId, isManual);
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
        managedRunOptions
      );
      if (managed !== null) {
        return managed;
      }
    }

    return await runWithRetries(schedule, {
      connectorPath,
      connectorId,
      connectorInstanceId,
      ownerToken,
      manifest,
      state,
      collectionMode,
      recoveryOnly,
      persistState,
      referenceBaseUrl,
      rsUrl,
      staticSecretEnv,
      triggerKind: automationPolicy.trigger_kind,
      automationMode: automationPolicy.automation_mode,
      onInteraction: wrappedInteraction,
      onStarted: (run) => {
        currentRunIdBox.value = typeof run?.run_id === "string" ? run.run_id : null;
      },
      onProgress: () => {
        // no-op; progress is driven by the runtime's own logging.
      },
    });
  }

  return { launchRun };
}
