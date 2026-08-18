// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import type { SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";
import {
  type AutomationRefreshPolicy,
  projectRunAutomationPolicy,
  type RunTriggerKind,
} from "./run-automation-policy.ts";
import { createRunLogger, NOOP_RUN_BASE_LOGGER } from "./run-logger.ts";
import { createDispatchGovernor } from "./scheduler/dispatch-governor.ts";
import { createPreRunGate } from "./scheduler/pre-run-gate.ts";
import { createRunExecutor } from "./scheduler/run-executor.ts";
import { resolveNonNegativeMsOrInfinity } from "./scheduler-config.ts";
import { isTerminalGrantFailure, type TerminalReason } from "./scheduler-retry-classifier.ts";

// ─── Shared domain types ────────────────────────────────────────────────────
//
// The shared domain-type vocabulary lives in `scheduler-domain-types.ts`, a
// type-only leaf, so the scheduler shell and its spokes can depend on it
// without a static import cycle back through this module. Imported here for
// the shell's own use, and re-exported below to preserve this module's public
// type surface (e.g. `controller.ts` imports `RunRecord` from here).

import type {
  ConnectorError,
  ConnectorSchedule,
  HasLegacySchedulerEventMarkerHandler,
  RunRecord,
  RunSource,
  SchedulerManifest,
  SchedulerOptions,
  TerminalGrantFailureReason,
} from "./scheduler-domain-types.ts";

export type {
  ConnectorError,
  ConnectorSchedule,
  GetLastSuccessfulRunAtHandler,
  GetNonPressureRecoverableCountHandler,
  GetSourcePressureGapsHandler,
  GetStateHandler,
  GrantAccessMode,
  HasLegacySchedulerEventMarkerHandler,
  HasUnresolvedAttentionHandler,
  HumanRequiredStateEscalationHandler,
  InteractionHandler,
  IsManagedConnectorHandler,
  IsNeedsHumanHandler,
  NeedsHumanHandler,
  RegisterRunCancellationHandler,
  ResolveStaticSecretRunEnv,
  RunCompleteHandler,
  RunConnectorResult,
  RunManagedConnectorViaController,
  RunRecord,
  RunSource,
  RunStatus,
  SchedulerManifest,
  SchedulerOptions,
  SchedulerReadinessChecker,
  SchedulerReadinessResult,
  SetStateHandler,
  TerminalGrantFailureReason,
  UnresolvedAttentionEvidence,
} from "./scheduler-domain-types.ts";

export interface SchedulerStats {
  readonly [connectorId: string]: {
    readonly failed: number;
    readonly lastRun: RunRecord | null;
    readonly succeeded: number;
    readonly totalRecords: number;
    readonly totalRuns: number;
  };
}

export interface Scheduler {
  getHistory: () => RunRecord[];
  getStats: () => SchedulerStats;
  start: () => void;
  stop: () => void;
}

// biome-ignore lint/performance/noBarrelFile: intentional facade — scheduler.ts is the single public entry point and re-exports the retry classifier's public surface so consumers keep one import path.
export * from "./scheduler-retry-classifier.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildScheduledRunSource(connectorId: string): RunSource {
  return { id: connectorId, kind: "connector" };
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

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeScheduleIntervalMs(intervalMs: number): number {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return 60_000;
  }
  return intervalMs;
}

function resolveMaxRunWallClockMs(value: number | undefined, envValue: string | undefined): number {
  return resolveNonNegativeMsOrInfinity(
    value,
    envValue,
    14_400_000, // 4 hours
    "maxRunWallClockMs",
    "PDPP_MAX_RUN_WALL_CLOCK_MS"
  );
}

// The connector-attempt watchdog (`maxRunWallClockMs`, hours-scale) only
// bounds `runExecutor.launchRun` -- the actual connector child. It has no
// visibility into `executeRun`'s OUTER wrapper: the pre-run gate (an
// injected, provider-neutral `readinessChecker`/`getState` async callback
// with no built-in timeout) and grant-state check run BEFORE launchRun is
// ever reached. If that wrapper's promise never settles, `executeRun`'s
// `finally` (which deletes the `runtime.activeRuns` entry) never runs
// either, and every future tick's `dispatchIfDue` guard sees the key as
// permanently occupied -- silent, no skip record, no back-off entry,
// forever, until process restart. This ceiling is a much shorter,
// independent budget for that outer wrapper specifically; it makes no
// assumption about which provider or connector is involved.
// 0 and Infinity both mean "disabled" (matches raceDispatchLivenessDeadline's
// own <= 0 check) -- 0 is accepted, not rejected, so the two callers agree.
function resolveDispatchLivenessCeilingMs(value: number | undefined, envValue: string | undefined): number {
  return resolveNonNegativeMsOrInfinity(
    value,
    envValue,
    1_800_000, // 30 minutes -- generous for an in-memory gate plus one readiness probe.
    "dispatchLivenessCeilingMs",
    "PDPP_DISPATCH_LIVENESS_CEILING_MS"
  );
}

/** Sentinel distinguishing "the deadline elapsed" from any real `GateOutcome`. */
const DISPATCH_LIVENESS_TIMEOUT = Symbol("dispatch-liveness-timeout");

/**
 * Races `pending` against `ceilingMs`. On timeout, returns the sentinel;
 * `pending` keeps running, unawaited -- there is no cancellation primitive
 * for an arbitrary injected callback's promise. Nothing else ever awaits
 * `pending` again, so a late resolution has no observable effect.
 */
function raceDispatchLivenessDeadline<T>(
  pending: Promise<T>,
  ceilingMs: number
): Promise<T | typeof DISPATCH_LIVENESS_TIMEOUT> {
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0) {
    return pending;
  }
  let timer: NodeJS.Timeout;
  const deadline = new Promise<typeof DISPATCH_LIVENESS_TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(DISPATCH_LIVENESS_TIMEOUT), ceilingMs);
    timer.unref?.();
  });
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer));
}

function dispatchWedgedRecord(connectorId: string, connectorInstanceId: string | undefined): RunRecord {
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: "scheduler_dispatch_wedged: pre-launch dispatch gate did not settle within its liveness ceiling",
    // Same token as `terminalReason`, duplicated on `failureReason` because the
    // product health read model surfaces `failureReason ?? error` as the run's
    // `failure_reason`/health reasonCode -- without it the wedge classifies by
    // the prose `error` sentence above instead of a typed code.
    failureReason: "scheduler_dispatch_wedged",
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "failed",
    terminalReason: "scheduler_dispatch_wedged",
  };
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
    notifiedAttentionSkips: new Map(),
    notifiedCooldownIdentity: new Map(),
    notifiedDisabledGrantFailures: new Set(),
    notifiedNeedsHumanSkips: new Set(),
    notifiedNotReadySkips: new Map(),
    running: false,
    timers: [],
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

function fromStoredRunRecord(record: SchedulerRunHistoryRecord): RunRecord {
  let sourceId = record.connectorId;
  if (typeof record.source.id === "string") {
    sourceId = record.source.id;
  }
  const restored: RunRecord = {
    attempt: record.attempt,
    checkpointSummary: record.checkpointSummary,
    completedAt: record.completedAt,
    connectorId: record.connectorId,
    connectorInstanceId: record.connectorInstanceId ?? null,
    failureReason: record.failureReason ?? null,
    knownGaps: record.knownGaps,
    recordsEmitted: record.recordsEmitted,
    reportedRecordsEmitted: record.reportedRecordsEmitted ?? null,
    runId: record.runId ?? null,
    source: {
      id: sourceId,
      kind: "connector",
    },
    startedAt: record.startedAt,
    status: record.status,
    terminalReason: (record.terminalReason ?? null) as TerminalReason | null,
    traceId: record.traceId ?? null,
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
    approvedEnvironmentBindings,
    approvedProxyConnectorIds,
    admitRunConnection = null,
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
    getForwardEvidenceDebt = async () => false,
    getLastSuccessfulRunAt = async () => null,
    isManagedConnector = () => false,
    logger: baseLogger = NOOP_RUN_BASE_LOGGER,
    maxRunWallClockMs,
    dispatchLivenessCeilingMs,
    registerRunCancellation,
    resolveStaticSecretRunEnv = null,
    runManagedConnectorViaController = null,
  } = opts;

  const schedulerMaxRunWallClockMs = resolveMaxRunWallClockMs(
    maxRunWallClockMs,
    process.env.PDPP_MAX_RUN_WALL_CLOCK_MS
  );
  const schedulerDispatchLivenessCeilingMs = resolveDispatchLivenessCeilingMs(
    dispatchLivenessCeilingMs,
    process.env.PDPP_DISPATCH_LIVENESS_CEILING_MS
  );

  const runtime = buildRuntime();
  let hydrationStarted = false;

  function logRunHistoryPersistFailure(record: RunRecord, message: string): void {
    createRunLogger(baseLogger, {
      connectorId: record.connectorId,
      connectorInstanceId: record.connectorInstanceId,
      runId: record.runId,
    }).error(`failed to persist run history: ${message}`, { phase: "run_history_persist" });
  }

  function recordAndNotify(record: RunRecord): RunRecord {
    runtime.history.push(record);
    if (schedulerStore) {
      Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${record.connectorId}: ${message}`);
        logRunHistoryPersistFailure(record, message);
      });
    }
    onRunComplete(record);
    return record;
  }

  async function recordAndNotifyAwaited(record: RunRecord): Promise<RunRecord> {
    runtime.history.push(record);
    if (schedulerStore) {
      await Promise.resolve(schedulerStore.appendRunHistory(toStoredRunRecord(record))).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler] failed to persist run history for ${record.connectorId}: ${message}`);
        logRunHistoryPersistFailure(record, message);
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
    recordAndNotify,
    runtime,
  });

  const runExecutor = createRunExecutor({
    admitRunConnection,
    ...(approvedEnvironmentBindings ? { approvedEnvironmentBindings } : {}),
    ...(approvedProxyConnectorIds ? { approvedProxyConnectorIds } : {}),
    getState,
    handleGrantFailureDisable,
    isManagedConnector,
    logger: baseLogger,
    markNeedsHuman,
    maxRunWallClockMs: schedulerMaxRunWallClockMs,
    onInteraction,
    onRunComplete,
    persistLastRunTime,
    recordAndNotify,
    recordAndNotifyAwaited,
    referenceBaseUrl,
    registerRunCancellation,
    resolveStaticSecretRunEnv,
    rsUrl,
    runManagedConnectorViaController,
    runtime,
    schedulerStore,
    setState,
  });

  async function executeRun(
    schedule: ConnectorSchedule,
    isManual = false,
    options: { recoveryOnly?: boolean } = {}
  ): Promise<RunRecord | null> {
    const { connectorId, connectorInstanceId, manifest, grantAccessMode = "continuous" } = schedule;
    if (!connectorInstanceId) {
      throw new Error("scheduler requires an admitted connectorInstanceId before creating a run");
    }
    const key = connectorInstanceId;
    const recoveryOnly = options.recoveryOnly === true;
    const triggerKind: RunTriggerKind = isManual ? "manual" : "scheduled";
    const automationPolicy = projectRunAutomationPolicy({
      refreshPolicy: getManifestRefreshPolicy(manifest),
      triggerKind,
    });

    if (runtime.activeRuns.has(key)) {
      return null;
    }
    runtime.activeRuns.add(key);

    try {
      if (!isManual) {
        // The gate's injected callbacks (readinessChecker, getState) have
        // no built-in timeout and nothing can cancel them, so on timeout we
        // just stop awaiting: `finally` below still clears `activeRuns`
        // normally, and the abandoned promise is never awaited again by
        // anyone, so a late resolution cannot trigger a second emission or
        // launch.
        const preflight = await raceDispatchLivenessDeadline(
          preRunGate.runAutomaticPreflight(schedule, key, automationPolicy),
          schedulerDispatchLivenessCeilingMs
        );
        if (preflight === DISPATCH_LIVENESS_TIMEOUT) {
          return recordAndNotify(dispatchWedgedRecord(connectorId, connectorInstanceId));
        }
        if (preflight !== "proceed") {
          return preflight;
        }
      }
      const grantDecision = preRunGate.gateGrantState(connectorId, connectorInstanceId, grantAccessMode);
      if (grantDecision !== "proceed") {
        return grantDecision;
      }
      // Not deadlined: `launchRun` owns its own much longer connector-attempt
      // watchdog (`maxRunWallClockMs`, hours-scale) once actually launched.
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
    getForwardEvidenceDebt,
    getLastSuccessfulRunAt,
    getNonPressureRecoverableCount,
    getSourcePressureGaps,
    hasLegacySchedulerEventMarker: async (...args: Parameters<HasLegacySchedulerEventMarkerHandler>) =>
      (await schedulerStore?.hasLegacySchedulerEventMarker?.(...args)) ?? false,
    onHumanRequiredStateEscalation,
    runtime,
  });

  function startScheduledLoops(): void {
    if (runtime.timers.length > 0) {
      return;
    }
    async function dispatchIfDue(schedule: ConnectorSchedule): Promise<void> {
      // Why: `elapsed = now - lastRunTime` keeps growing while a run is in
      // flight, so an unguarded tick kept probing `getForwardEvidenceDebt`'s
      // reconcile write against the SAME connector instance every tick —
      // contending with the run's own writes on `withConnectorInstanceWrite`'s
      // per-instance mutex and turning successful batches into retryable
      // `connector_instance_busy` / `ingest_batch_storage_error` failures
      // (live GroupMe UAT incident run_1786410860909_1; see commit message
      // and scheduler-active-run-suppresses-dispatch-probes.test.ts for the
      // full mechanism and reproduction).
      // How: mirror the guard `executeRun` already applies one step later —
      // skip dispatch evaluation entirely for an instance with a run already
      // in `runtime.activeRuns`. Connector-agnostic; no observable scheduling
      // change for an instance that isn't running (`executeRun` would have
      // no-oped on this key anyway).
      //
      // A wedged pre-run gate does not leave this key stuck: `executeRun`
      // deadlines it (see `dispatchLivenessCeilingMs`) and always clears
      // the key on timeout, so this guard re-opens on its own.
      if (runtime.activeRuns.has(runtimeKey(schedule))) {
        return;
      }
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
        failed: runs.filter((r) => r.status === "failed").length,
        lastRun: runs.at(-1) ?? null,
        succeeded: runs.filter((r) => r.status === "succeeded").length,
        totalRecords: runs.reduce((sum, r) => sum + r.recordsEmitted, 0),
        totalRuns: runs.length,
      };
    }
    return stats;
  }

  return { getHistory, getStats, start, stop };
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
