// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dispatch governor for the scheduler.
 *
 * Encapsulates WHEN to dispatch on each tick: evaluates failure back-off,
 * source-pressure cooldown, and recovery-only eligibility for a connector.
 * Called by the tick loop in `startScheduledLoops` (scheduler.ts).
 *
 * Owns:
 *   - evaluateBackoffDispatch — the main per-tick dispatch decision
 *   - resolveCooldownSkip     — one-shot cooling-off skip dedup
 *   - probeLastSuccessfulRunAt / probeSourcePressureGaps /
 *     probeNonPressureRecoverableCount — fail-open/fail-closed store probes
 *
 * Does NOT own: launchRun / executeRun (run-executor), pre-run gate
 * (scheduler/pre-run-gate.ts), timer ownership (startScheduledLoops in shell).
 */

import { filterFreshPressureRows, resolveRecoveryFirstMode } from "../recovery-decision.ts";
import { type BackoffDecision, computeNextRunWithBackoff } from "../scheduler-backoff.ts";
import type {
  ConnectorSchedule,
  GetLastSuccessfulRunAtHandler,
  GetNonPressureRecoverableCountHandler,
  GetSourcePressureGapsHandler,
  HumanRequiredStateEscalationHandler,
  RunRecord,
  RunSource,
} from "../scheduler-domain-types.ts";
import {
  computeConnectionSourcePressureCooldown,
  isSourcePressureCooldownDeferring,
  type PendingPressureGap,
  type SourcePressureCooldownDecision,
} from "../scheduler-source-pressure-cooldown.ts";

// ─── Dep types ───────────────────────────────────────────────────────────────

/**
 * Runtime state cells the dispatch governor reads and mutates.
 * Passed by reference so mutations take effect in the shared runtime.
 */
export interface DispatchGovernorRuntimeState {
  readonly announcedBackoffClass: Map<string, string>;
  readonly announcedBlockedClass: Map<string, string>;
  readonly history: RunRecord[];
  readonly lastRunTime: Map<string, number>;
  readonly notifiedCooldownIdentity: Map<string, string>;
}

export interface DispatchGovernorDeps {
  getLastSuccessfulRunAt: GetLastSuccessfulRunAtHandler;
  getNonPressureRecoverableCount: GetNonPressureRecoverableCountHandler;
  getSourcePressureGaps: GetSourcePressureGapsHandler;
  onHumanRequiredStateEscalation: HumanRequiredStateEscalationHandler;
  runtime: DispatchGovernorRuntimeState;
}

// ─── Local helpers (duplicated from scheduler.ts; pure — no runtime dep) ─────

function buildScheduledRunSource(connectorId: string): RunSource {
  return { kind: "connector", id: connectorId };
}

function runtimeKey(schedule: Pick<ConnectorSchedule, "connectorId" | "connectorInstanceId">): string {
  return schedule.connectorInstanceId || schedule.connectorId;
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

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Spine-event prefix constants ────────────────────────────────────────────

const BACKOFF_STARTED_PREFIX = "schedule.back_off.started:";
const GAVE_UP_PREFIX = "schedule.gave_up:";

// ─── Skip-record and event builders ──────────────────────────────────────────

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

function buildSourcePressureCooldownSkip(
  connectorId: string,
  decision: SourcePressureCooldownDecision,
  connectorInstanceId?: string
): RunRecord {
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
  const { error } = record;
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

/**
 * §10-B: consecutive no-progress cooldown-cycle count for a connection,
 * derived from the max recovery attempt_count across pending source-pressure gaps.
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

function filterFreshPendingPressureGaps(gaps: readonly PendingPressureGap[], now: number): PendingPressureGap[] {
  const rows = (gaps ?? []).map((gap, index) => ({
    attempt_count: gap.attemptCount ?? null,
    last_attempt_at: gap.lastPressureAt ?? null,
    next_attempt_after: gap.nextAttemptAfter ?? null,
    reason: gap.reason,
    index,
  }));
  const freshIndices = new Set(filterFreshPressureRows(rows, now).map((row) => row.index));
  return (gaps ?? []).filter((_, index) => freshIndices.has(index));
}

// ─── Pure back-off decision (decide/apply separation) ─────────────────────────

/**
 * Inputs to the PURE back-off dispatch decision. Everything the decision reads
 * is passed as a plain value — including the CURRENT one-shot dedup state
 * (`announcedBackoff`/`announcedBlocked`) and the persisted-in-history streak
 * markers — so the function performs no `runtime.*` reads/writes, no async, and
 * no event emission. This lets the ORDER-DEPENDENCE flow as data (the returned
 * `DecideBackoffDispatchValue`) rather than as mutation of shared locals.
 */
export interface DecideBackoffDispatchInputs {
  /** Current `announcedBackoffClass.get(key)`. */
  readonly announcedBackoff: string | undefined;
  /** Current `announcedBlockedClass.get(key)`. */
  readonly announcedBlocked: string | undefined;
  /** `decision.backoffApplied`. */
  readonly backoffApplied: boolean;
  /** `decision.recommendedHealthState === "blocked"`. */
  readonly blocked: boolean;
  /** Pre-computed forward-walk eligibility BEFORE the blocked override. */
  readonly eligible: boolean;
  /** Whether the current streak already persisted a `back_off.started` marker. */
  readonly persistedBackoffStarted: boolean;
  /** Whether the current streak already persisted a `gave_up` marker. */
  readonly persistedGaveUp: boolean;
  /** `decision.reasonClass` (null/undefined when no class is attributed). */
  readonly reasonClass: string | null | undefined;
  /** Pre-computed recovery-only flag BEFORE the blocked override. */
  readonly recoveryOnly: boolean;
}

/**
 * A one-shot transition the decision says WOULD fire this tick, as data. The
 * effectful shell turns each into the matching RunRecord(s) / callback:
 *   - `backoff_started` → a back-off skip record + a `back_off.started` event.
 *   - `gave_up`         → a `gave_up` event + the §10-F escalation callback
 *                         (coupled by design: same once-per-streak window).
 */
export type BackoffDispatchTransition = { kind: "backoff_started" } | { kind: "gave_up" };

/**
 * Map mutation the decision prescribes for a dedup cell:
 *   - `set`    → set the cell to `reasonClass`.
 *   - `delete` → delete the cell (streak broken).
 *   - `keep`   → leave the cell untouched.
 */
export type DedupCellMutation = "set" | "delete" | "keep";

/**
 * The PURE decision value: the post-override dispatch flags, the dedup-map
 * mutations to apply, and the ordered one-shot transitions to fire.
 */
export interface DecideBackoffDispatchValue {
  readonly announcedBackoffMutation: DedupCellMutation;
  readonly announcedBlockedMutation: DedupCellMutation;
  readonly eligible: boolean;
  readonly recoveryOnly: boolean;
  readonly transitions: readonly BackoffDispatchTransition[];
}

function shouldEmitBackoffTransition(
  announcedReasonClass: string | undefined,
  reasonClass: string,
  persistedTransition: boolean
): boolean {
  return !(announcedReasonClass === reasonClass || persistedTransition);
}

/**
 * PURE dispatch-decision core. Reproduces the exact back-off/blocked branching
 * that `evaluateBackoffDispatch` used to inline, but reads/writes nothing:
 * dedup state comes in as inputs, dedup mutations and one-shot transitions go
 * out as data. Total over all inputs. Oracle-testable.
 *
 * Branch table (must match the original inline logic byte-for-byte):
 *   - backoffApplied && reasonClass:
 *       announcedBackoff cell → `set` (always, both gate arms).
 *       emit `backoff_started` iff NOT (announced === reasonClass || persistedBackoffStarted).
 *       if blocked:
 *         announcedBlocked cell → `set` (always, both gate arms).
 *         emit `gave_up` (+ escalation) iff NOT (announcedBlocked === reasonClass || persistedGaveUp).
 *         override eligible=false, recoveryOnly=false (unconditionally).
 *   - !backoffApplied: announcedBackoff cell → `delete` (streak broken).
 *   - backoffApplied && !reasonClass: no mutation, no transition (both cells `keep`).
 */
export function decideBackoffDispatch(inputs: DecideBackoffDispatchInputs): DecideBackoffDispatchValue {
  const { reasonClass } = inputs;
  const transitions: BackoffDispatchTransition[] = [];
  let { eligible } = inputs;
  let { recoveryOnly } = inputs;
  let announcedBackoffMutation: DedupCellMutation = "keep";
  let announcedBlockedMutation: DedupCellMutation = "keep";

  if (inputs.backoffApplied && reasonClass) {
    // Back-off skip + `back_off.started` transition marker, one per streak.
    announcedBackoffMutation = "set";
    const shouldEmitBackoffStarted = shouldEmitBackoffTransition(
      inputs.announcedBackoff,
      reasonClass,
      inputs.persistedBackoffStarted
    );
    if (shouldEmitBackoffStarted) {
      transitions.push({ kind: "backoff_started" });
    }

    if (inputs.blocked) {
      // One-shot `gave_up` (+ §10-F escalation) per (connector, reason_class) streak.
      announcedBlockedMutation = "set";
      const shouldEmitGaveUp = shouldEmitBackoffTransition(
        inputs.announcedBlocked,
        reasonClass,
        inputs.persistedGaveUp
      );
      if (shouldEmitGaveUp) {
        transitions.push({ kind: "gave_up" });
      }
      // Auto-dispatch is suppressed for blocked connectors (even recovery-only).
      eligible = false;
      recoveryOnly = false;
    }
  } else if (!inputs.backoffApplied) {
    // Streak broken (success or different class): clear the announcement.
    announcedBackoffMutation = "delete";
  }

  return { eligible, recoveryOnly, announcedBackoffMutation, announcedBlockedMutation, transitions };
}

// ─── Public interface ─────────────────────────────────────────────────────────

export interface EvaluateBackoffDispatchResult {
  decision: BackoffDecision;
  eligible: boolean;
  eventsToEmit: RunRecord[];
  /** True when the run may only drain non-source-pressure recovery gaps (SLVP-ideal §4.3). */
  recoveryOnly: boolean;
  skipToEmit: RunRecord | null;
}

export interface DispatchGovernor {
  evaluateBackoffDispatch(schedule: ConnectorSchedule, now: number): Promise<EvaluateBackoffDispatchResult>;
  resolveCooldownSkip(
    schedule: ConnectorSchedule,
    key: string,
    cooldown: SourcePressureCooldownDecision,
    cooldownDefers: boolean,
    existingSkip: RunRecord | null
  ): RunRecord | null;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDispatchGovernor(deps: DispatchGovernorDeps): DispatchGovernor {
  const {
    getLastSuccessfulRunAt,
    getNonPressureRecoverableCount,
    getSourcePressureGaps,
    onHumanRequiredStateEscalation,
    runtime,
  } = deps;

  // Read the durable cross-path "latest successful run at" projection so the
  // back-off gate can clear a stale failure streak when a genuine success has
  // occurred since (on ANY trigger, including a manual `controller.runNow` the
  // scheduler never recorded in its own history). A probe failure returns
  // `null` (no evidence) — this probe may only ever SURFACE a real success to
  // break a wedge, never fabricate one (which would suppress a legitimate
  // back-off).
  async function probeLastSuccessfulRunAt(connectorId: string, connectorInstanceId: string): Promise<number | null> {
    try {
      const observed = await getLastSuccessfulRunAt(connectorId, connectorInstanceId);
      return typeof observed === "number" && Number.isFinite(observed) ? observed : null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] last-success probe failed for ${connectorId}: ${message}`);
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

  // Count durable pending detail gaps whose reason is NOT source pressure
  // (SLVP-ideal §4.3). These are the `run_cap_deferred`/`retry_exhausted` gaps
  // the source-pressure cooldown must NOT govern. A non-zero count makes a
  // cooldown-deferred tick eligible for a recovery-only launch.
  //
  // Fail-CLOSED to 0 (no recovery launch) on probe error: unlike the pressure
  // probe (which fails open so an unreadable store cannot silently pause a
  // schedule), here a false positive would launch a run INTO an active cooldown
  // window. When unsure whether recovery work exists, do not bypass the
  // cooldown — the next clean tick recovers it.
  async function probeNonPressureRecoverableCount(connectorId: string, connectorInstanceId: string): Promise<number> {
    try {
      const observed = await getNonPressureRecoverableCount(connectorId, connectorInstanceId);
      return Number.isFinite(observed) && observed > 0 ? observed : 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] non-pressure recovery probe failed for ${connectorId}: ${message}`);
      return 0;
    }
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

  // Effectful shell for the back-off decision: mutate the dedup maps and turn
  // the pure decision's `transitions` into the concrete RunRecord(s) / callback.
  // Order-dependence flows in as DATA (the `DecideBackoffDispatchValue`); this
  // shell only performs the prescribed effects. The §10-F escalation is coupled
  // to the `gave_up` transition, so it still fires in the SAME once-per-streak
  // window (with its error-swallowing intact).
  function applyBackoffDispatchDecision(
    value: DecideBackoffDispatchValue,
    schedule: ConnectorSchedule,
    key: string,
    decision: BackoffDecision,
    history: readonly RunRecord[]
  ): { skipToEmit: RunRecord | null; eventsToEmit: RunRecord[] } {
    const { connectorId } = schedule;
    const { reasonClass } = decision;
    if (value.announcedBackoffMutation === "set" && reasonClass) {
      runtime.announcedBackoffClass.set(key, reasonClass);
    } else if (value.announcedBackoffMutation === "delete") {
      runtime.announcedBackoffClass.delete(key);
    }
    if (value.announcedBlockedMutation === "set" && reasonClass) {
      runtime.announcedBlockedClass.set(key, reasonClass);
    }

    let skipToEmit: RunRecord | null = null;
    const eventsToEmit: RunRecord[] = [];
    for (const transition of value.transitions) {
      if (transition.kind === "backoff_started") {
        skipToEmit = buildBackoffSkip(connectorId, decision, schedule.connectorInstanceId);
        eventsToEmit.push(buildBackoffStartedEvent(connectorId, decision, schedule.connectorInstanceId));
      } else {
        eventsToEmit.push(
          buildGaveUpEvent(connectorId, decision, findLastSuccessAt(history, key), schedule.connectorInstanceId)
        );
        // §10-F: first entry into blocked state — emit one push escalation.
        // Errors are swallowed to match the scheduler's stance on observer
        // failures (never block dispatch).
        Promise.resolve(
          onHumanRequiredStateEscalation({
            connectorId,
            connectorInstanceId: schedule.connectorInstanceId ?? connectorId,
            reason: "blocked",
          })
        ).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[scheduler] §10-F escalation callback failed for ${connectorId}: ${message}`);
        });
      }
    }
    return { skipToEmit, eventsToEmit };
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
  ): Promise<EvaluateBackoffDispatchResult> {
    const { connectorId } = schedule;
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
    // Durable cross-path success: a manual/owner `controller.runNow` success is
    // invisible to `history` (only the scheduler's own dispatches land there).
    // Threading it into the back-off math lets a genuine recent success clear an
    // otherwise-immortal failure streak so automation resumes — the live wedge.
    const lastSuccessAtMs = await probeLastSuccessfulRunAt(connectorId, key);
    const decision = computeNextRunWithBackoff(history, scheduleIntervalMs, lastRun, { lastSuccessAtMs });

    // Cross-run source-pressure cooldown. Independent of failure back-off: a
    // connection that *succeeded* but deferred work under upstream pressure
    // has no failure streak, so back-off alone would fire on the normal
    // interval and re-hit the still-hot bucket. The cooldown reads the durable
    // pending pressure gaps and defers the next automatic dispatch on its own
    // capped curve. We take whichever governor defers the run further.
    const pendingPressureGaps = await probeSourcePressureGaps(connectorId, key);
    const freshPressureGaps = filterFreshPendingPressureGaps(pendingPressureGaps, now);
    // §10-B no-progress escalation is now WIRED (was dead before): resolve the
    // connector's cooldown profile (never null) and feed the consecutive
    // no-progress cycle count. A pending pressure gap's recovery attempt_count IS
    // the per-cycle counter — it increments once per cooldown cycle that fails to
    // recover the gap, and resets when the gap recovers (the pressure set empties
    // and the cooldown relaxes), so it equals "consecutive cycles with zero gap
    // recovery". This threads ADDITIVELY: it only sharpens the health-state
    // recommendation, never the dispatch/drain decision below.
    const consecutiveCooldownCycles = maxPressureGapAttemptCount(freshPressureGaps);
    const cooldown = computeConnectionSourcePressureCooldown(
      connectorId,
      freshPressureGaps,
      scheduleIntervalMs,
      lastRun,
      { consecutiveCooldownCycles }
    );
    const cooldownDefers = isSourcePressureCooldownDeferring(cooldown, now);

    const elapsed = now - lastRun;
    const intervalElapsed = elapsed >= decision.effectiveIntervalMs;
    // Forward-walk eligibility: gated by BOTH the failure-backoff interval AND
    // the source-pressure cooldown. New source-touching work (the forward walk
    // and its list-phase fetches) must respect both governors.
    let eligible = intervalElapsed && !cooldownDefers;

    // ─── Recovery-only eligibility (SLVP-ideal §4.3) ────────────────────────
    // Recovery of NON-source-pressure pending gaps (`run_cap_deferred` /
    // `retry_exhausted`) is a separate, work-conserving sub-flow. NEITHER
    // governor has a claim over it:
    //   - the source-pressure cooldown is reason-discriminated (reads only
    //     `upstream_pressure`/`rate_limited`), so it must not block non-pressure
    //     recovery (the live 942-gap head-of-line-blocking stall);
    //   - the failure-backoff `effectiveIntervalMs` is ALSO not a valid gate
    //     here. On this live connection a stale failure streak (months-old
    //     `failed` runs, never cleared because every tick since only `skipped`)
    //     inflated `effectiveIntervalMs` to 16h, deadlocking the connection:
    //     the backoff blocks the run, so no successful run ever clears the
    //     streak. Draining already-deferred non-pressure gaps cannot worsen a
    //     failure streak or re-pressure a hot bucket, so it must proceed on a
    //     minimal RECOVERY CADENCE (one base schedule interval), independent of
    //     both governors. The connector drains recovery-before-forward-walk and
    //     returns BEFORE the forward walk (riding the same pacer/circuit, so it
    //     still backs off on 429 and re-defers — not a raw-fetch bypass).
    // A genuinely `blocked` connection is still excluded below (nothing safe to
    // recover until the owner re-auths).
    //
    // Recovery-first: bounded existing recovery work takes priority over new
    // forward-walk work, not just over an otherwise-ineligible tick. Without
    // this, a tick where BOTH the forward walk is due AND eligible non-pressure
    // recovery gaps exist always launches ordinary forward collection — the
    // live 10,264-gap Gmail stall, where a due manual/ordinary run claimed a
    // fresh forward-walk page and made no bounded recovery progress for
    // 5+ minutes while a huge non-pressure backlog sat untouched. Checking the
    // recovery probe unconditionally on `recoveryCadenceElapsed` (rather than
    // only `!eligible`) lets bounded recovery win the tick whenever it is due,
    // regardless of ordinary forward-walk eligibility; forward collection still
    // runs normally once no eligible recovery remains (probe returns 0).
    const recoveryCadenceElapsed = elapsed >= scheduleIntervalMs;
    let recoveryOnly = false;
    if (recoveryCadenceElapsed) {
      const nonPressureRecoverable = await probeNonPressureRecoverableCount(connectorId, key);
      // Shared policy (recovery-decision.ts): a scheduled tick is always an
      // implicit, unscoped dispatch, so eligible non-pressure recovery work
      // wins the tick over fresh forward-walk work.
      if (resolveRecoveryFirstMode({ nonPressureRecoveryEligible: nonPressureRecoverable > 0 })) {
        eligible = true;
        recoveryOnly = true;
      }
    }

    // Decide (pure) then apply (effectful). The pure core reads the current
    // dedup state as inputs and returns the dispatch flags, the dedup-map
    // mutations, and the one-shot transitions to fire — all as data.
    const backoffDecision = decideBackoffDispatch({
      backoffApplied: decision.backoffApplied,
      reasonClass: decision.reasonClass,
      blocked: decision.recommendedHealthState === "blocked",
      eligible,
      recoveryOnly,
      announcedBackoff: runtime.announcedBackoffClass.get(key),
      announcedBlocked: runtime.announcedBlockedClass.get(key),
      persistedBackoffStarted:
        decision.reasonClass != null &&
        currentStreakHasSchedulerEvent(history, BACKOFF_STARTED_PREFIX, decision.reasonClass),
      persistedGaveUp:
        decision.reasonClass != null && currentStreakHasSchedulerEvent(history, GAVE_UP_PREFIX, decision.reasonClass),
    });
    ({ eligible: eligible } = backoffDecision);
    ({ recoveryOnly: recoveryOnly } = backoffDecision);
    const { skipToEmit: backoffSkip, eventsToEmit } = applyBackoffDispatchDecision(
      backoffDecision,
      schedule,
      key,
      decision,
      history
    );
    let skipToEmit: RunRecord | null = backoffSkip;

    // Source-pressure cooldown is layered on top of failure back-off. Pending
    // pressure gaps alone do not defer forever; only a future `nextRunAt` does.
    // `resolveCooldownSkip` emits at most one cooling-off skip per pressure
    // identity while the retry is too early, but only when back-off has not
    // already emitted its own skip this tick (back-off is the stronger signal
    // and already explains the quiet; double-emitting would be noise).
    // A recovery-only launch does NOT emit a cooling-off skip: the dispatch is
    // proceeding (to drain non-pressure work), so a "skipped, cooling off"
    // audit line would be dishonest. The cooldown skip is only for ticks that
    // genuinely defer. Forward-walk remains deferred; the skip rationale still
    // holds when we are NOT launching recovery.
    if (!recoveryOnly) {
      skipToEmit = resolveCooldownSkip(schedule, key, cooldown, cooldownDefers, skipToEmit);
    }

    return { decision, eligible, recoveryOnly, skipToEmit, eventsToEmit };
  }

  return { evaluateBackoffDispatch, resolveCooldownSkip };
}
