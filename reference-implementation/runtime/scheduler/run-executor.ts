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
 *   - finalizeManagedRunTerminal — persist + notify a managed-controller terminal record
 *   - routeScheduledManagedRun — managed-connector scheduled routing via controller
 *   - scheduledManagedConnectorLacksRoutingSeam — defer guard for missing seam
 *
 * Does NOT own: executeRun (the orchestration shell that sequences active-run
 * guard → preRunGate → launchRun), pre-run gate, or dispatch governor.
 */

import { createTraceContext, generateRunId, type SpineTraceContext } from "../../lib/spine.ts";
import type { SchedulerRunHistoryRecord } from "../../server/stores/scheduler-store.ts";
import { runConnector } from "../index.ts";
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
  admitRunConnection:
    | ((input: {
        connectorId: string;
        connectorInstanceId: string | null;
        ownerSubjectId: string | null;
      }) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }>)
    | null;
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
  /**
   * Settles the durable synthesized-revalidation cadence anchor for a
   * terminal DISPATCHED revalidation probe record: a FAILED probe advances
   * the attempt count, a SUCCEEDED probe clears the anchor. A no-op for
   * every other record shape. Defined in scheduler.ts (which owns
   * `synthesizedRevalidationStore`'s construction) — called here because
   * `finalizeSuccessOrFailure`/`finalizeExhaustedFailure`/
   * `finalizeManagedRunTerminal` are the ACTUAL funnels for dispatched-run
   * terminal outcomes, not scheduler.ts's `recordAndNotify` (which only ever
   * sees pre-dispatch skip records and non-probe transition markers in this
   * module's calls — never a real success/failure RunRecord). MUST be
   * awaited before the run's terminal completion becomes externally
   * observable — see its doc comment in scheduler.ts.
   */
  settleRevalidationProbeAnchor: (record: RunRecord) => Promise<void>;
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface RunExecutor {
  launchRun: (
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    options?: { recoveryOnly?: boolean; revalidationOnly?: boolean }
  ) => Promise<RunRecord>;
}

// ─── Local helpers (pure — no runtime dep) ───────────────────────────────────

function buildScheduledRunSource(connectorId: string, revalidationProbe = false): RunSource {
  return { id: connectorId, kind: "connector", ...(revalidationProbe ? { revalidationProbe: true as const } : {}) };
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

// Exported (pure, no closure over RunExecutorDeps) so the run-id mint
// behavior on the direct-scheduler retry path can be exercised directly in
// tests without spawning a real connector process through createRunExecutor.
export function buildAttemptCall(
  schedule: ConnectorSchedule,
  call: RunConnectorCall,
  attempt: number
): RunConnectorCall {
  // A revalidation probe (see run-automation-policy.ts's `RunTriggerKind` doc
  // comment) must stay noninteractive by construction on EVERY attempt, not
  // just the first: `projectRunAutomationPolicy`/`buildAvailableBindings`
  // both key their noninteractive override on `triggerKind === "revalidation"`
  // specifically, so collapsing attempt 2+ to the ordinary `"retry"` kind
  // would silently regain interactivity on retry — reopening exactly the P1
  // this trigger kind exists to close.
  let attemptTriggerKind: RunTriggerKind;
  if (call.triggerKind === "revalidation") {
    attemptTriggerKind = "revalidation";
  } else if (attempt === 1) {
    attemptTriggerKind = call.triggerKind ?? "scheduled";
  } else {
    attemptTriggerKind = "retry";
  }
  const attemptPolicy = projectRunAutomationPolicy({
    refreshPolicy: getManifestRefreshPolicy(schedule.manifest),
    triggerKind: attemptTriggerKind,
  });
  return {
    ...call,
    automationMode: attemptPolicy.automation_mode,
    runId: call.runId ?? generateRunId(),
    traceContext: call.traceContext ?? createTraceContext(),
    triggerKind: attemptPolicy.trigger_kind,
  };
}

function describeFailedRunResult(result: RunConnectorResult): RunConnectorError {
  return {
    checkpoint_summary: result.checkpoint_summary || null,
    connector_error: result.connector_error || null,
    failure_reason: result.terminal_reason === "connector_protocol_violation" ? result.terminal_reason : null,
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

function coerceRunError(err: unknown): RunConnectorError {
  if (err && typeof err === "object") {
    const candidate = err as RunConnectorError;
    const message = candidate.message ?? (err instanceof Error ? err.message : "unknown");
    return {
      ...candidate,
      message,
      ...(message.includes("admitted run connection") || message.includes("admission did not authorize")
        ? { failure_reason: "permission_error", terminal_reason: "permission_error" as const }
        : {}),
    };
  }
  const message = typeof err === "string" ? err : "unknown";
  return message.includes("admitted run connection") || message.includes("admission did not authorize")
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
// Exported so buildAttemptCall's mint behavior can be tested directly (see
// the export comment above buildAttemptCall).

export interface RunConnectorCall {
  admitRunConnection?: Exclude<RunExecutorDeps["admitRunConnection"], null>;
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
  markProgress: () => void;
  readonly signal: AbortSignal;
  timedOut: () => boolean;
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
  revalidationProbe = false,
  startedAt,
  attempt,
}: {
  attempt: number;
  connectorId: string;
  connectorInstanceId?: string;
  result: RunConnectorResult;
  revalidationProbe?: boolean;
  startedAt: string;
}): RunRecord {
  return {
    attempt,
    checkpointSummary: result.checkpoint_summary || null,
    completedAt: nowIso(),
    connectorError: result.connector_error || null,
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    failureReason: null,
    knownGaps: result.known_gaps || [],
    recordsEmitted: result.records_emitted || 0,
    reportedRecordsEmitted: result.reported_records_emitted ?? null,
    runId: result.run_id || null,
    source: buildScheduledRunSource(connectorId, revalidationProbe),
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
  revalidationProbe = false,
}: {
  attempt: number;
  connectorId: string;
  connectorInstanceId?: string;
  lastError: RunConnectorError | null;
  revalidationProbe?: boolean;
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
    source: buildScheduledRunSource(connectorId, revalidationProbe),
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

const CONTROLLER_RUN_NOW_FAILED_REASON = "controller_run_now_failed";

function controllerRunNowDeferReason(err: unknown): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  if (code === "run_already_active") {
    return "run_already_active";
  }
  // A controller-run invocation can race an already-pending browser-surface
  // launch after a restart. The controller deliberately exposes this as a
  // typed lifecycle collision, not a connector failure. Preserve that meaning
  // here so the scheduler coalesces onto the incumbent run instead of
  // recording an untyped failed attempt from the error message.
  if (code === "run_browser_surface_queued") {
    return "run_browser_surface_queued";
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
    admitRunConnection,
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
    settleRevalidationProbeAnchor,
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
      attempt,
      connectorId,
      connectorInstanceId,
      result,
      revalidationProbe: call.triggerKind === "revalidation",
      startedAt,
    });

    // Load-bearing and MUST run before ANY terminal publication —
    // `runtime.history.push` (synchronous, instantly makes the record
    // in-process-visible to `getHistory()`/`getStats()`),
    // `schedulerStore.appendRunHistory` (SQLite's `exec()` is itself
    // synchronous — the row is durably committed before this async
    // function's next `await` even runs, i.e. before the `.catch(...)`
    // handler is attached), and `onRunComplete` (spine/UI notification).
    // Settling first closes the crash window where a process death between
    // history-append and anchor-settle would leave a durable terminal
    // record with a stale/unsettled anchor. Awaited WITHOUT a catch: a
    // durable-store failure here propagates out of
    // `finalizeSuccessOrFailure` (and therefore out of `launchRun`/
    // `runNow`) BEFORE any history row or notification exists for this
    // record — no external consumer, on a crash immediately after, could
    // ever observe this run at all, durably or otherwise.
    //
    // Crash-window safety of the two directions this can advance:
    //   - FAILED probe (attempt count advances): conservative. A crash
    //     between settling and history-append means the doubling delay was
    //     applied slightly before the failure became visible elsewhere —
    //     it can only make the NEXT probe wait longer or equal, never
    //     admit more often than intended.
    //   - SUCCEEDED probe (anchor cleared): also safe on a crash right
    //     after. If the success record never durably lands (process dies
    //     before `appendRunHistory` completes), the synthesized evidence
    //     this cadence exists to reprobe is re-derived from `run_history`/
    //     `connector_summary_evidence` on the next tick — since the
    //     success never landed there, the stale evidence is still present,
    //     `gateAttention` observes it as a FRESH sighting (no anchor), and
    //     re-arms the FULL initial delay. Worst case is one extra
    //     wait-the-initial-delay cycle, never a silently-suppressed
    //     connector and never a faster-than-intended re-probe.
    await settleRevalidationProbeAnchor(record);

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

    // `onRunComplete` is a general-purpose notification hook (spine events,
    // UI, logging) — awaited so an async handler's work is ordered before
    // this function returns, but its failure does not fail the run's
    // terminal completion. Reached only once the anchor has already
    // settled (above) AND history has already been appended.
    await Promise.resolve(onRunComplete(record)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] onRunComplete handler failed for ${connectorId}: ${message}`);
    });

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
    const runId = call.runId || generateRunId();
    const traceContext = call.traceContext ?? createTraceContext();
    let admitted = true;
    if (activeRunStore) {
      admitted =
        (await Promise.resolve(
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
          return false;
        })) !== false;
    }

    const leasedCall: RunConnectorCall = {
      ...call,
      cancelSignal: watchdog.signal,
      onProgress: () => {
        watchdog.markProgress();
        originalOnProgress();
      },
      onStarted: (run) => {
        originalOnStarted?.(run);
        if (!admitted) {
          return;
        }
        const startedRun = readStartedRunInfo(run);
        if (!startedRun) {
          return;
        }
        unregisterCancellation =
          registerRunCancellation?.({
            cancel: () => watchdog.cancel(),
            connectorId,
            connectorInstanceId,
            runId: startedRun.runId,
          }) ?? null;
      },
      runId,
      traceContext,
    };

    const clear = async (): Promise<void> => {
      unregisterCancellation?.();
      unregisterCancellation = null;
      watchdog.clear();
      if (admitted && activeRunStore) {
        await Promise.resolve(activeRunStore.deleteActiveRun(connectorInstanceId, runId)).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] failed to clear active run ${runId} for ${connectorId}: ${message}`);
        });
      }
    };

    return { admitted, call: leasedCall, clear, watchdog };
  }

  // Outcome of the connector-invocation phase alone (before
  // `finalizeSuccessOrFailure` runs): "finalize" carries what that call
  // needs; "retry"/"give-up" mirror `AttemptOutcome`'s same-named kinds one
  // level up. Kept distinct from `AttemptOutcome` so a `finalizeSuccessOrFailure`
  // rejection (handled by the caller, `runSingleAttempt`, OUTSIDE this
  // phase's try/catch) can never be reclassified as a connector failure.
  type InvocationOutcome =
    | { kind: "finalize"; result: RunConnectorResult }
    | { kind: "give-up"; error: RunConnectorError | null }
    | { kind: "retry"; error: RunConnectorError };

  async function invokeAndClassifyAttempt(
    schedule: ConnectorSchedule,
    attempt: number,
    lease: Awaited<ReturnType<typeof createActiveRunAttemptLease>>
  ): Promise<InvocationOutcome> {
    const { maxRetries = 2 } = schedule;
    const { watchdog } = lease;
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
    return { kind: "finalize", result };
  }

  async function runSingleAttempt(
    schedule: ConnectorSchedule,
    call: RunConnectorCall,
    attempt: number
  ): Promise<AttemptOutcome> {
    const { maxRetries = 2 } = schedule;
    const startedAt = nowIso();
    const lease = await createActiveRunAttemptLease(schedule, call, attempt, startedAt);

    try {
      if (!lease.admitted) {
        return {
          kind: "done",
          record: recordAndNotify(
            buildBrowserSurfaceUnavailableSkip(schedule.connectorId, "run_already_active", schedule.connectorInstanceId)
          ),
        };
      }

      let invocation: InvocationOutcome;
      try {
        invocation = await invokeAndClassifyAttempt(schedule, attempt, lease);
      } catch (err) {
        const error = coerceRunError(err);
        if (attempt <= maxRetries && shouldRetryRunFailure(error)) {
          return { error, kind: "retry" };
        }
        return { error, kind: "give-up" };
      }
      if (invocation.kind !== "finalize") {
        return invocation;
      }

      // `finalizeSuccessOrFailure` deliberately runs OUTSIDE the inner
      // try/catch above: it has already built and persisted the terminal
      // record (and may have already reported it via `onRunComplete`) by
      // the time `settleRevalidationProbeAnchor` runs inside it. A
      // rejection here is a durable-anchor persistence failure on an
      // ALREADY-DETERMINED outcome (frequently a genuine SUCCESS), never a
      // signal that the connector attempt itself should be
      // retried/reclassified as a failure — reclassifying it that way
      // would record a FALSE failed run (via `finalizeExhaustedFailure`)
      // for a connector that actually succeeded. It propagates directly
      // out of `runSingleAttempt` (uncaught here) and therefore out of
      // `launchRun`.
      const record = await finalizeSuccessOrFailure(schedule, call, invocation.result, startedAt, attempt);
      return { kind: "done", record };
    } finally {
      await lease.clear();
    }
  }

  // Drains the durable failure record for an exhausted-retries run: history,
  // store append, last-run timestamp, terminal-grant handling, completion
  // notification. Pulled out so `runWithRetries` only orchestrates the retry
  // loop and trusts this helper for the failure tail.
  async function finalizeExhaustedFailure(
    schedule: ConnectorSchedule,
    lastError: RunConnectorError | null,
    attempt: number,
    revalidationProbe = false
  ): Promise<RunRecord> {
    const { connectorId, connectorInstanceId = connectorId } = schedule;
    const failRecord = buildExhaustedFailureRecord({
      attempt,
      connectorId,
      connectorInstanceId,
      lastError,
      revalidationProbe,
    });
    // See finalizeSuccessOrFailure's identical comment: settlement is
    // load-bearing and MUST run before ANY terminal publication (history
    // append, notification) — a `finalizeExhaustedFailure` record is
    // always a FAILED record, so this is always the conservative
    // attempt-count-advance direction (a crash right after can only make
    // the next probe wait longer, never fire early).
    await settleRevalidationProbeAnchor(failRecord);

    runtime.history.push(failRecord);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(failRecord))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${connectorId}: ${message}`);
      });
    }
    persistLastRunTime(connectorId, connectorInstanceId, Date.now());
    handleGrantFailureDisable(failRecord.terminalReason ?? failRecord.failureReason, connectorInstanceId);
    await Promise.resolve(onRunComplete(failRecord)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] onRunComplete handler failed for ${connectorId}: ${message}`);
    });
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

    return finalizeExhaustedFailure(schedule, lastError, attempt, call.triggerKind === "revalidation");
  }

  function scheduledManagedConnectorLacksRoutingSeam(
    isManual: boolean,
    via: RunManagedConnectorViaController | null | undefined,
    connectorId: string
  ): boolean {
    return !(isManual || via) && isManagedConnector(connectorId);
  }

  // Terminal publisher for the managed-controller route (routeScheduledManagedRun):
  // a genuine succeeded/failed RunRecord (buildManagedRunTerminalRecord /
  // buildManagedRunControllerFailure), NOT a pre-dispatch skip. Mirrors
  // finalizeSuccessOrFailure/finalizeExhaustedFailure's settlement-before-
  // publication ordering (see their identical comments): awaits
  // settleRevalidationProbeAnchor BEFORE runtime.history, the durable append,
  // and onRunComplete, and does NOT catch/swallow a settlement rejection — it
  // propagates out of routeScheduledManagedRun/launchRun so a durable-store
  // failure fails the run's terminal completion rather than reporting a
  // false-clean result while the anchor is left stale.
  //
  // Deliberately bypasses `recordAndNotify` (the scheduler.ts dep) for this
  // record: that function performs its own fire-and-forget settle call meant
  // for the pre-dispatch skip records it otherwise only ever sees (see its
  // doc comment on RunExecutorDeps.recordAndNotify) — calling it here as well
  // would settle the SAME terminal record twice, double-incrementing a
  // failed-probe's attempt counter. Ordinary skip records built in this
  // function (buildBrowserSurfaceUnavailableSkip) are unaffected and keep
  // going through recordAndNotify's synchronous/best-effort path: their
  // status is never "succeeded"/"failed", so settleRevalidationProbeAnchor
  // no-ops on them regardless of which path they take.
  async function finalizeManagedRunTerminal(record: RunRecord): Promise<RunRecord> {
    await settleRevalidationProbeAnchor(record);
    runtime.history.push(record);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${record.connectorId}: ${message}`);
      });
    }
    await Promise.resolve(onRunComplete(record)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] onRunComplete handler failed for ${record.connectorId}: ${message}`);
    });
    return record;
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
    attempt = 1,
    revalidationProbe = false
  ): RunRecord {
    return {
      attempt,
      checkpointSummary: null,
      completedAt: nowIso(),
      connectorId,
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      connectorInstanceId: connectorInstanceId ?? null,
      // The caught exception is a controller-boundary failure, not a provider
      // terminal result. Keep only this stable, server-authored cause in
      // scheduler history; genuine provider failures arrive through
      // buildManagedRunTerminalRecord with their runtime-authored evidence.
      error: CONTROLLER_RUN_NOW_FAILED_REASON,
      failureReason: CONTROLLER_RUN_NOW_FAILED_REASON,
      knownGaps: [],
      recordsEmitted: 0,
      source: buildScheduledRunSource(connectorId, revalidationProbe),
      startedAt,
      status: "failed",
      terminalReason: CONTROLLER_RUN_NOW_FAILED_REASON,
    };
  }

  // Terminal RunRecord for a managed run whose controller `runNow` RETURNED a
  // result (succeeded/failed). Extracted from routeScheduledManagedRun verbatim.
  function buildManagedRunTerminalRecord(
    connectorId: string,
    connectorInstanceId: string,
    startedAt: string,
    runNowResult: NonNullable<Awaited<ReturnType<RunManagedConnectorViaController>>>,
    attempt = 1,
    revalidationProbe = false
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
      source: buildScheduledRunSource(connectorId, revalidationProbe),
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
    options: { maxRetries?: number; recoveryOnly?: boolean; revalidationProbe?: boolean } = {}
  ): Promise<RunRecord | null> {
    const maxRetries =
      options.maxRetries !== undefined && Number.isFinite(options.maxRetries)
        ? Math.max(0, Math.trunc(options.maxRetries))
        : 2;
    const revalidationProbe = options.revalidationProbe === true;
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
          triggerKind: revalidationProbe ? "revalidation" : "scheduled",
        });
      } catch (err) {
        const deferReason = controllerRunNowDeferReason(err);
        if (deferReason) {
          return recordAndNotify(buildBrowserSurfaceUnavailableSkip(connectorId, deferReason, connectorInstanceId));
        }
        persistLastRunTime(connectorId, connectorInstanceId, Date.now());
        return finalizeManagedRunTerminal(
          buildManagedRunControllerFailure(connectorId, connectorInstanceId, startedAt, attempt, revalidationProbe)
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
      return finalizeManagedRunTerminal(
        buildManagedRunTerminalRecord(
          connectorId,
          connectorInstanceId,
          startedAt,
          runNowResult,
          attempt,
          revalidationProbe
        )
      );
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

    return { collectionMode, state, wrappedInteraction };
  }

  async function launchRun(
    schedule: ConnectorSchedule,
    isManual: boolean,
    automationPolicy: ReturnType<typeof projectRunAutomationPolicy>,
    options: { recoveryOnly?: boolean; revalidationOnly?: boolean } = {}
  ): Promise<RunRecord> {
    const recoveryOnly = options.recoveryOnly === true;
    const {
      connectorId,
      connectorInstanceId = connectorId,
      connectorPath,
      manifest,
      ownerToken,
      ownerSubjectId = "",
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
      const managedRunOptions: { maxRetries?: number; recoveryOnly?: boolean; revalidationProbe?: boolean } = {
        recoveryOnly,
        revalidationProbe: automationPolicy.trigger_kind === "revalidation",
      };
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
