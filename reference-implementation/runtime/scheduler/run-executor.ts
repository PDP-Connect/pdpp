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
  ConnectorError,
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
} from "../scheduler.ts";
import { type RunConnectorError, shouldRetryRunFailure } from "../scheduler-retry-classifier.ts";

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

interface AttemptWatchdog {
  cancel(): void;
  clear(): void;
  markProgress(): void;
  readonly signal: AbortSignal;
  timedOut(): boolean;
}

type ActiveRunStore = Pick<NonNullable<SchedulerOptions["schedulerStore"]>, "deleteActiveRun" | "upsertActiveRun">;

function activeRunStoreFrom(schedulerStore: RunExecutorDeps["schedulerStore"]): ActiveRunStore | null {
  return schedulerStore &&
    typeof schedulerStore.upsertActiveRun === "function" &&
    typeof schedulerStore.deleteActiveRun === "function"
    ? schedulerStore
    : null;
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

function createActiveRunLease(input: {
  readonly attempt: number;
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly registerRunCancellation: RegisterRunCancellationHandler | null | undefined;
  readonly startedAt: string;
  readonly store: ActiveRunStore | null;
  readonly cancelRun: () => void;
}): {
  clear(): Promise<void>;
  register(run: Parameters<NonNullable<RunConnectorCall["onStarted"]>>[0]): void;
} {
  let activeRunId: string | null = null;
  let activeRunRegistration: Promise<void> | null = null;
  let unregisterCancellation: (() => void) | null = null;

  return {
    async clear() {
      unregisterCancellation?.();
      unregisterCancellation = null;
      if (!(activeRunId && input.store)) {
        return;
      }
      await activeRunRegistration;
      await Promise.resolve(input.store.deleteActiveRun(input.connectorInstanceId, activeRunId)).catch(
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] failed to clear active run ${activeRunId} for ${input.connectorId}: ${message}`);
        }
      );
    },
    register(run) {
      if (!input.store) {
        return;
      }
      const startedRun = readStartedRunInfo(run);
      if (!startedRun) {
        return;
      }
      activeRunId = startedRun.runId;
      unregisterCancellation =
        input.registerRunCancellation?.({
          cancel: input.cancelRun,
          connectorId: input.connectorId,
          connectorInstanceId: input.connectorInstanceId,
          runId: startedRun.runId,
        }) ?? null;
      activeRunRegistration = Promise.resolve(
        input.store.upsertActiveRun({
          connector_instance_id: input.connectorInstanceId,
          connector_id: input.connectorId,
          run_id: startedRun.runId,
          run_generation: input.attempt,
          trace_id: startedRun.traceId,
          scenario_id: startedRun.scenarioId,
          started_at: input.startedAt,
        })
      ).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist active run for ${input.connectorId}: ${message}`);
      });
    },
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

const OWNER_AUTH_REPAIR_ACTIONS = new Set(["manual_action_required", "refresh_credentials"]);
const OWNER_AUTH_REPAIR_MESSAGE_RE =
  /(?:^|[^a-z0-9])(?:401|403|auth_missing|credentials?_required|credential_rejected|invalid_token|manual_action_required|reauth|session_expired|session_failed|session_required|unauthorized|forbidden)(?:$|[^a-z0-9])/iu;

function knownGapRecoveryAction(gap: Record<string, unknown>): string | null {
  const recoveryHint = gap.recovery_hint;
  if (!recoveryHint || typeof recoveryHint !== "object" || Array.isArray(recoveryHint)) {
    return null;
  }
  const action = (recoveryHint as { action?: unknown }).action;
  return typeof action === "string" && action.trim() ? action.trim() : null;
}

function knownGapReason(gap: Record<string, unknown>): string | null {
  const reason = gap.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

function knownGapMessage(gap: Record<string, unknown>): string | null {
  const message = gap.message;
  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function managedRunRequiresOwnerAuthRepair(run: {
  readonly connector_error?: ConnectorError | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
}): boolean {
  for (const gap of run.known_gaps ?? []) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      continue;
    }
    const action = knownGapRecoveryAction(gap);
    if (action && OWNER_AUTH_REPAIR_ACTIONS.has(action)) {
      return true;
    }
    const reason = knownGapReason(gap);
    if (reason && OWNER_AUTH_REPAIR_ACTIONS.has(reason)) {
      return true;
    }
    const message = knownGapMessage(gap);
    if (message && OWNER_AUTH_REPAIR_MESSAGE_RE.test(message)) {
      return true;
    }
  }
  const message = run.connector_error?.message;
  if (typeof message === "string" && OWNER_AUTH_REPAIR_MESSAGE_RE.test(message)) {
    return true;
  }
  return typeof run.failure_reason === "string" && OWNER_AUTH_REPAIR_MESSAGE_RE.test(run.failure_reason);
}

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

  async function runSingleAttempt(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number
  ): Promise<AttemptOutcome> {
    const { connectorId, connectorInstanceId = connectorId, maxRetries = 2 } = schedule;
    const startedAt = nowIso();
    const originalOnStarted = call.onStarted;
    const watchdog = createAttemptWatchdog(maxRunWallClockMs);
    const activeRunLease = createActiveRunLease({
      attempt,
      cancelRun: () => watchdog.cancel(),
      connectorId,
      connectorInstanceId,
      registerRunCancellation,
      startedAt,
      store: activeRunStoreFrom(schedulerStore),
    });

    const callWithActiveLease: RunConnectorCall = {
      ...call,
      cancelSignal: watchdog.signal,
      onStarted: (run) => {
        originalOnStarted?.(run);
        activeRunLease.register(run);
      },
      onProgress: () => {
        watchdog.markProgress();
        call.onProgress();
      },
    };

    try {
      const result = await invokeRunConnector(callWithActiveLease);
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
      watchdog.clear();
      await activeRunLease.clear();
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

  type ManagedRunNowResult = Awaited<ReturnType<RunManagedConnectorViaController>>;

  type ManagedRunAttemptOutcome =
    | { kind: "controller-error"; message: string }
    | { kind: "not-managed" }
    | { kind: "surface-unavailable"; status: string }
    | { kind: "terminal"; result: Exclude<ManagedRunNowResult, null> };

  function normalizeManagedMaxRetries(maxRetries: number | undefined): number {
    return Number.isFinite(maxRetries) && maxRetries !== undefined ? Math.max(0, Math.trunc(maxRetries)) : 2;
  }

  async function tryScheduledManagedRun(
    via: RunManagedConnectorViaController,
    connectorId: string,
    connectorInstanceId: string,
    ownerToken: string,
    recoveryOnly: boolean
  ): Promise<ManagedRunAttemptOutcome> {
    try {
      const result = await via(connectorId, {
        connectorInstanceId,
        ownerToken,
        priorityClass: "scheduled_refresh",
        recoveryOnly,
        triggerKind: "scheduled",
        referenceBaseUrl,
        rsUrl,
      });
      if (result === null) {
        return { kind: "not-managed" };
      }
      if (result.status && BROWSER_SURFACE_UNAVAILABLE_STATUSES.has(result.status)) {
        return { kind: "surface-unavailable", status: result.status };
      }
      return { kind: "terminal", result };
    } catch (err) {
      const deferReason = controllerRunNowDeferReason(err);
      if (deferReason) {
        return { kind: "surface-unavailable", status: deferReason };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "controller-error", message };
    }
  }

  function shouldRetryManagedRunResult(
    result: Exclude<ManagedRunNowResult, null>,
    attempt: number,
    maxRetries: number
  ): boolean {
    return (
      result.status !== "succeeded" &&
      attempt <= maxRetries &&
      shouldRetryRunFailure({
        connector_error: result.connector_error || null,
        failure_reason: result.failure_reason || null,
        known_gaps: result.known_gaps || null,
        terminal_reason: result.terminal_reason || null,
      })
    );
  }

  function buildControllerRunNowFailureRecord(
    connectorId: string,
    connectorInstanceId: string,
    message: string,
    startedAt: string,
    attempt: number
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

  function buildManagedRunRecord(
    connectorId: string,
    connectorInstanceId: string,
    result: Exclude<ManagedRunNowResult, null>,
    startedAt: string,
    attempt: number
  ): RunRecord {
    const status = schedulerStatusFromRuntimeResult(result.status);
    return {
      connectorId,
      connectorInstanceId: connectorInstanceId ?? null,
      source: buildScheduledRunSource(connectorId),
      status,
      recordsEmitted: 0,
      checkpointSummary: null,
      knownGaps: result.known_gaps || [],
      connectorError: result.connector_error || null,
      failureReason: result.failure_reason || null,
      startedAt,
      completedAt: nowIso(),
      runId: result.run_id ?? null,
      terminalReason: result.terminal_reason || null,
      traceId: result.trace_id ?? null,
      attempt,
    };
  }

  function buildManagedRetryExhaustedRecord(
    connectorId: string,
    connectorInstanceId: string,
    result: ManagedRunNowResult,
    attempt: number
  ): RunRecord {
    return {
      connectorId,
      connectorInstanceId: connectorInstanceId ?? null,
      source: buildScheduledRunSource(connectorId),
      status: "failed",
      recordsEmitted: 0,
      checkpointSummary: null,
      knownGaps: result?.known_gaps || [],
      connectorError: result?.connector_error || null,
      failureReason: result?.failure_reason || null,
      startedAt: nowIso(),
      completedAt: nowIso(),
      runId: result?.run_id ?? null,
      terminalReason: result?.terminal_reason || null,
      traceId: result?.trace_id ?? null,
      attempt,
    };
  }

  // Routes a scheduled managed-connector run through controller.runNow and
  // maps every outcome (contention, controller failure, surface unavailable,
  // terminal success/failure) to a RunRecord. Returns null when runNowResult
  // is null, signalling that the connector is not managed and launchRun should
  // fall through to the runWithRetries path.
  async function routeScheduledManagedRun(
    via: RunManagedConnectorViaController,
    connectorId: string,
    connectorInstanceId: string,
    ownerToken: string,
    options: { maxRetries?: number; recoveryOnly?: boolean } = {}
  ): Promise<RunRecord | null> {
    const maxRetries = normalizeManagedMaxRetries(options.maxRetries);
    let attempt = 0;
    let lastRetryableFailure: ManagedRunNowResult = null;

    while (attempt <= maxRetries) {
      attempt++;
      const startedAt = nowIso();
      const outcome = await tryScheduledManagedRun(
        via,
        connectorId,
        connectorInstanceId,
        ownerToken,
        options.recoveryOnly === true
      );

      if (outcome.kind === "not-managed") {
        return null;
      }
      if (outcome.kind === "surface-unavailable") {
        return recordAndNotify(buildBrowserSurfaceUnavailableSkip(connectorId, outcome.status, connectorInstanceId));
      }
      if (outcome.kind === "controller-error") {
        persistLastRunTime(connectorId, connectorInstanceId, Date.now());
        return recordAndNotify(
          buildControllerRunNowFailureRecord(connectorId, connectorInstanceId, outcome.message, startedAt, attempt)
        );
      }

      if (shouldRetryManagedRunResult(outcome.result, attempt, maxRetries)) {
        lastRetryableFailure = outcome.result;
        await sleep(backoffDelayMs(attempt));
        continue;
      }

      persistLastRunTime(connectorId, connectorInstanceId, Date.now());
      if (outcome.result.status !== "succeeded" && managedRunRequiresOwnerAuthRepair(outcome.result)) {
        markNeedsHuman(connectorId, connectorInstanceId);
      }
      return recordAndNotify(
        buildManagedRunRecord(connectorId, connectorInstanceId, outcome.result, startedAt, attempt)
      );
    }

    persistLastRunTime(connectorId, connectorInstanceId, Date.now());
    return recordAndNotify(
      buildManagedRetryExhaustedRecord(connectorId, connectorInstanceId, lastRetryableFailure, attempt)
    );
  }

  type StaticSecretLaunchResolution =
    | { kind: "ready"; staticSecretEnv: Record<string, string> | null }
    | { kind: "record"; record: RunRecord };

  async function resolveStaticSecretForLaunch(
    schedule: ConnectorSchedule,
    isManual: boolean,
    connectorInstanceId: string
  ): Promise<StaticSecretLaunchResolution> {
    if (!resolveStaticSecretRunEnv) {
      return { kind: "ready", staticSecretEnv: null };
    }

    try {
      const staticSecretEnv = await resolveStaticSecretRunEnv({
        connectorId: schedule.connectorId,
        connectorInstanceId,
      });
      return { kind: "ready", staticSecretEnv };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      persistLastRunTime(schedule.connectorId, connectorInstanceId, Date.now());
      const ownerRepairCode = ownerRepairCredentialCode(err);
      if (!isManual && ownerRepairCode) {
        markNeedsHuman(schedule.connectorId, connectorInstanceId);
        return {
          kind: "record",
          record: recordAndNotify(
            buildCredentialResolutionOwnerActionSkip(
              schedule.connectorId,
              ownerRepairCode,
              message,
              connectorInstanceId
            )
          ),
        };
      }
      return {
        kind: "record",
        record: recordAndNotify(buildCredentialResolutionFailure(schedule.connectorId, message, connectorInstanceId)),
      };
    }
  }

  type ManagedScheduledLaunchResolution = { kind: "fallthrough" } | { kind: "record"; record: RunRecord };

  async function routeManagedScheduledLaunch(
    schedule: ConnectorSchedule,
    isManual: boolean,
    connectorInstanceId: string,
    ownerToken: string,
    recoveryOnly: boolean
  ): Promise<ManagedScheduledLaunchResolution> {
    const { connectorId } = schedule;
    if (scheduledManagedConnectorLacksRoutingSeam(isManual, runManagedConnectorViaController, connectorId)) {
      return {
        kind: "record",
        record: recordAndNotify(
          buildBrowserSurfaceUnavailableSkip(connectorId, "surface_routing_unavailable", connectorInstanceId)
        ),
      };
    }
    if (!(runManagedConnectorViaController && !isManual)) {
      return { kind: "fallthrough" };
    }

    const managedOptions: { maxRetries?: number; recoveryOnly?: boolean } = { recoveryOnly };
    if (schedule.maxRetries !== undefined) {
      managedOptions.maxRetries = schedule.maxRetries;
    }
    const managed = await routeScheduledManagedRun(
      runManagedConnectorViaController,
      connectorId,
      connectorInstanceId,
      ownerToken,
      managedOptions
    );
    return managed === null ? { kind: "fallthrough" } : { kind: "record", record: managed };
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

    // Resolve connection-scoped static-secret credentials BEFORE launching —
    // parity with the manual path (`controller.ts::runNow`). True static-secret
    // connections must supply a source-scoped credential through this seam; a
    // resolver throw is fail-closed so the scheduler refuses the launch rather
    // than falling through to a deployment-wide provider-account secret.
    // Browser-session sources may return null when no optional stored login
    // credential exists; the connector can still reuse/repair the browser
    // session according to its automation policy.
    const staticSecretResolution = await resolveStaticSecretForLaunch(schedule, isManual, connectorInstanceId);
    if (staticSecretResolution.kind === "record") {
      return staticSecretResolution.record;
    }
    const { staticSecretEnv } = staticSecretResolution;

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
    const managedLaunch = await routeManagedScheduledLaunch(
      schedule,
      isManual,
      connectorInstanceId,
      ownerToken,
      recoveryOnly
    );
    if (managedLaunch.kind === "record") {
      return managedLaunch.record;
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
        currentRunId = typeof run?.run_id === "string" ? run.run_id : null;
      },
      onProgress: () => {
        // no-op; progress is driven by the runtime's own logging.
      },
    });
  }

  return { launchRun };
}
