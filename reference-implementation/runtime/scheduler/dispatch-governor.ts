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

import {
  decideForwardEvidenceReproof,
  type ForwardEvidenceReproofOptions,
  filterFreshPressureRows,
  resolveRecoveryFirstMode,
} from "../recovery-decision.ts";
import { type BackoffDecision, computeNextRunWithBackoff } from "../scheduler-backoff.ts";
import type {
  ConnectorSchedule,
  ForwardEvidenceInvalidationProbeResult,
  GetForwardEvidenceDebtHandler,
  GetForwardEvidenceInvalidatedAtMsHandler,
  GetLastSuccessfulRunAtHandler,
  GetNonPressureRecoverableCountHandler,
  GetSourcePressureGapsHandler,
  HasUnresolvedAttentionHandler,
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
import {
  decideSynthesizedRevalidation,
  type SynthesizedRevalidationOptions as SynthesizedRevalidationOptionsInput,
  type SynthesizedRevalidationStore,
} from "./synthesized-attention-revalidation.ts";

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
  getForwardEvidenceDebt: GetForwardEvidenceDebtHandler;
  /**
   * Optional. See `GetForwardEvidenceInvalidatedAtMsHandler`'s doc comment.
   * Defaults to `() => null` when omitted — `decideForwardEvidenceReproof`
   * then falls back to its unconditional-admit branch rather than silently
   * withholding a reprove attempt forever for a host that cannot supply
   * this anchor.
   */
  getForwardEvidenceInvalidatedAtMs?: GetForwardEvidenceInvalidatedAtMsHandler;
  getLastSuccessfulRunAt: GetLastSuccessfulRunAtHandler;
  getNonPressureRecoverableCount: GetNonPressureRecoverableCountHandler;
  getSourcePressureGaps: GetSourcePressureGapsHandler;
  /**
   * Same probe `pre-run-gate.ts::gateAttention` uses. Consulted ONLY when
   * ordinary same-class-failure backoff has escalated a connection to
   * `blocked`, to check whether the connection is blocked on SYNTHESIZED
   * owner-action evidence with a due bounded revalidation probe — see
   * `synthesizedRevalidationDue`'s doc comment on `DecideBackoffDispatchInputs`.
   * A throw or `undefined` here (e.g. no attention handler configured, or
   * the probe fails) is treated as "not due" — this preserves today's
   * `blocked` behavior exactly and never widens eligibility on a probe
   * failure (contrast `probeUnresolvedAttention`'s fail-OPEN stance, which
   * governs whether an ORDINARY run is admitted; here fail-closed is
   * correct because the default, pre-fix behavior — permanently blocked —
   * is already the safe fallback).
   */
  getUnresolvedAttention?: HasUnresolvedAttentionHandler;
  onHumanRequiredStateEscalation: HumanRequiredStateEscalationHandler;
  /**
   * Optional tuning for `decideForwardEvidenceReproof` (ceiling, jitter
   * span). Defaults to production constants when omitted — tests use this
   * to avoid waiting on real wall-clock ceilings.
   */
  reproofOptions?: ForwardEvidenceReproofOptions;
  runtime: DispatchGovernorRuntimeState;
  synthesizedRevalidationOptions?: SynthesizedRevalidationOptionsInput;
  /**
   * Same durable per-connection cadence-anchor store `pre-run-gate.ts`
   * consults — see `SynthesizedRevalidationStore`'s doc comment
   * (synthesized-attention-revalidation.ts). Read-only here: this module
   * never creates/advances/clears the anchor, only checks whether a due
   * probe should be let through a `blocked` tick. Optional: when omitted,
   * `probeSynthesizedRevalidationDue` always returns `false` (today's
   * `blocked` behavior).
   */
  synthesizedRevalidationStore?: SynthesizedRevalidationStore;
}

// ─── Local helpers (duplicated from scheduler.ts; pure — no runtime dep) ─────

function buildScheduledRunSource(connectorId: string): RunSource {
  return { id: connectorId, kind: "connector" };
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
  // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
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

/**
 * The bounded forward-evidence reproof sub-flow only ever has a chance to
 * widen dispatch: it must never run when the tick is already dispatching
 * something else, and must never override a genuinely `blocked` connection
 * (see `resolveRecoveryAndReproofEligibility`'s doc comment).
 */
function shouldConsultReproof(input: { blocked: boolean; eligible: boolean }): boolean {
  return !(input.eligible || input.blocked);
}

/**
 * Resolve the recovery-only (SLVP-ideal §4.3) and bounded forward-evidence
 * reproof (fix-uat-manifest-reproof-governor) sub-flows together, since both
 * read/write the same `eligible`/`recoveryOnly` pair and share one memoized
 * `forwardEvidenceDebt` probe. Extracted from `evaluateBackoffDispatch` to
 * keep that function's branching within the repo's cognitive-complexity
 * budget — this is the same probe/decide sequence that function inlined
 * before, unchanged in behavior, just isolated as its own unit.
 *
 * ─── Recovery-only eligibility (SLVP-ideal §4.3) ──────────────────────────
 * Recovery of NON-source-pressure pending gaps (`run_cap_deferred` /
 * `retry_exhausted`) is a separate, work-conserving sub-flow. NEITHER the
 * failure-backoff interval NOR the source-pressure cooldown has a claim over
 * it — see the historical Gmail-stall/16h-backoff-deadlock evidence this
 * sub-flow fixes (design.md §4.3). It proceeds on a minimal RECOVERY CADENCE
 * (one base schedule interval), independent of both governors, and takes
 * priority over fresh forward-walk work once both are due (the live
 * 10,264-gap Gmail stall this repo's `dispatch-governor-recovery-first.test.ts`
 * pins). A genuinely `blocked` connection is excluded (nothing safe to
 * recover until the owner re-auths) — enforced by the caller never invoking
 * this helper for a blocked tick's eligibility override elsewhere in
 * `evaluateBackoffDispatch`.
 *
 * Forward-evidence-debt (`hasForwardEvidenceDebt`) bounds the otherwise-
 * unbounded recovery-first default: debt diverts one tick to forward
 * collection so recovery-first cannot starve fact-carrying evidence
 * indefinitely (live: Gmail's last fact-carrying forward run was 5+ days and
 * ~640 runs ago).
 *
 * ─── Bounded forward-evidence reproof (fix-uat-manifest-reproof-governor) ──
 * Closes the gap the recovery-only sub-flow above cannot reach: a
 * connection with an EMPTY non-pressure recovery backlog never triggers the
 * recovery-cadence debt check above, and even when it does, that check is
 * itself gated behind `scheduleIntervalMs` — which can be up to 12h for a
 * slow-cadence connector (live: Amazon/Reddit reading `runtime_evidence_missing`
 * for up to 12h after a manifest-generation bump, per
 * connector-summary-read-model.ts's `terminal_facts_state: 'stale'`/
 * `terminal_facts_historical` transition). Independent of both governors:
 * probe `inScope`/anchor whenever the tick is not ALREADY dispatching
 * something, and admit a bounded early run once `decideForwardEvidenceReproof`'s
 * own ceiling+jitter cadence — measured from the durable
 * `terminal_facts_invalidated_at` anchor, NOT last-run time (see
 * `decideForwardEvidenceReproof`'s doc comment for why a gate REVISE
 * reverted the last-run-anchored first version) — says a reprove attempt is
 * due.
 *
 * SCOPE (second gate REVISE, 2026-08-03): this consults
 * `probeForwardEvidenceInvalidatedAtMs`'s `inScope` flag directly —
 * deliberately NOT the recovery-only sub-flow's `forwardEvidenceDebt`
 * boolean (which also covers a structurally distinct, out-of-scope debt
 * class: a `current`-state row with a stale/missing per-stream fact map,
 * which never has an invalidation anchor stamped for it at all and whose
 * remediation is an explicitly separate concern). Gating on the broad
 * boolean previously let that out-of-scope class reach
 * `decideForwardEvidenceReproof` with a permanently-null anchor, and a
 * shared periodic fold-sweep stall correlated every connection in that
 * class onto the identical tick with the identical null-anchor shape — the
 * confirmed correlated-cohort defect this narrowing closes. A `null`
 * anchor (missing backfill, or a probe read failure) never admits either
 * (see `decideForwardEvidenceReproof`) — it only skips this tick's early-
 * reproof optimization, never the connection's ordinary scheduled cadence.
 *
 * Never overrides `blocked` — a genuinely blocked connection has no safe
 * automatic run, reproof included; a reproof run is still admitted through
 * the ordinary `automation_mode`/`background_safe` choke point exactly like
 * any other scheduled dispatch (`gateAutomationPolicy` in pre-run-gate.ts),
 * so a manual/unsafe connector's declared policy still blocks it.
 */
async function resolveRecoveryAndReproofEligibility(input: {
  blocked: boolean;
  connectorId: string;
  elapsed: number;
  eligible: boolean;
  key: string;
  now: number;
  probeForwardEvidenceDebt: (
    connectorId: string,
    connectorInstanceId: string,
    scheduleIntervalMs: number
  ) => Promise<boolean>;
  probeForwardEvidenceInvalidatedAtMs: (
    connectorId: string,
    connectorInstanceId: string
  ) => Promise<ForwardEvidenceInvalidationProbeResult>;
  probeNonPressureRecoverableCount: (connectorId: string, connectorInstanceId: string) => Promise<number>;
  reproofOptions: ForwardEvidenceReproofOptions;
  scheduleIntervalMs: number;
}): Promise<{ eligible: boolean; recoveryOnly: boolean }> {
  const {
    blocked,
    connectorId,
    elapsed,
    key,
    now,
    probeForwardEvidenceDebt,
    probeForwardEvidenceInvalidatedAtMs,
    probeNonPressureRecoverableCount,
    reproofOptions,
    scheduleIntervalMs,
  } = input;
  // biome-ignore lint/style/useDestructuring: `eligible` is reassigned below; destructuring `input.eligible` alongside `const` fields would shadow oddly.
  let eligible = input.eligible;
  let recoveryOnly = false;

  // Forward-evidence-debt is memoized here (shared by both sub-flows below)
  // so a healthy, debt-free connection never pays the probe twice.
  let forwardEvidenceDebt: boolean | null = null;
  let forwardEvidenceDebtProbed = false;
  async function probeForwardEvidenceDebtOnce(): Promise<boolean> {
    if (!forwardEvidenceDebtProbed) {
      forwardEvidenceDebt = await probeForwardEvidenceDebt(connectorId, key, scheduleIntervalMs);
      forwardEvidenceDebtProbed = true;
    }
    return forwardEvidenceDebt ?? false;
  }

  const recoveryCadenceElapsed = elapsed >= scheduleIntervalMs;
  if (recoveryCadenceElapsed) {
    const nonPressureRecoverable = await probeNonPressureRecoverableCount(connectorId, key);
    const nonPressureRecoveryEligible = nonPressureRecoverable > 0;
    const debtForRecoveryBound = nonPressureRecoveryEligible ? await probeForwardEvidenceDebtOnce() : false;
    const recoveryFirst = resolveRecoveryFirstMode({
      forwardEvidenceDebt: debtForRecoveryBound,
      nonPressureRecoveryEligible,
    });
    if (recoveryFirst) {
      eligible = true;
      recoveryOnly = true;
    } else if (nonPressureRecoveryEligible && debtForRecoveryBound && !eligible) {
      // Debt selected forward collection over recovery-first, but forward is
      // NOT otherwise eligible this tick. Dispatching nothing would regress
      // the recovery-cadence anti-deadlock (a failure-streak-inflated
      // `effectiveIntervalMs` can run to 16h+): the debt bound may only
      // PREFER forward when forward is genuinely permitted, never veto
      // recovery's own independent cadence. Fall back to recovery-only
      // exactly as if no debt existed.
      eligible = true;
      recoveryOnly = true;
    }
  }

  if (shouldConsultReproof({ blocked, eligible })) {
    // Gates on `inScope` (isManifestGenerationInvalidatedDebt), NOT the
    // broader forward-evidence-debt boolean the recovery-only sub-flow
    // above uses — this is the second gate REVISE's required narrowing.
    // The OTHER debt class (current-state, stale/missing fact map) never
    // has an anchor stamped for it (state never leaves `current`), so
    // gating on the broad boolean would let a shared fold-sweep stall
    // correlate every connection in THAT class onto the same
    // permanently-null-anchor, unconditional-admit tick. inScope=false
    // short-circuits before ever probing the anchor or calling
    // decideForwardEvidenceReproof for that class.
    const { inScope, invalidatedAtMs } = await probeForwardEvidenceInvalidatedAtMs(connectorId, key);
    if (inScope) {
      const reproof = decideForwardEvidenceReproof(invalidatedAtMs, now, key, scheduleIntervalMs, reproofOptions);
      if (reproof.admit) {
        eligible = true;
        recoveryOnly = false;
      }
    }
  }

  return { eligible, recoveryOnly };
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
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `scheduler_backoff_applied: ${failures} consecutive ${reason} failures; next attempt at ${next}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildBackoffStartedEvent(
  connectorId: string,
  decision: BackoffDecision,
  connectorInstanceId?: string
): RunRecord {
  const payload = JSON.stringify({
    consecutive_failures: decision.consecutiveFailures,
    next_attempt_at: decision.nextRunAt,
    reason_class: decision.reasonClass,
  });
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `${BACKOFF_STARTED_PREFIX} ${payload}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function buildGaveUpEvent(
  connectorId: string,
  decision: BackoffDecision,
  lastSuccessAt: string | null,
  connectorInstanceId?: string
): RunRecord {
  const payload = JSON.stringify({
    final_consecutive_failures: decision.consecutiveFailures,
    last_success_at: lastSuccessAt,
    reason_class: decision.reasonClass,
  });
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `${GAVE_UP_PREFIX} ${payload}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
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
    attempt: 0,
    checkpointSummary: null,
    completedAt: nowIso(),
    connectorId,
    connectorInstanceId: connectorInstanceId ?? null,
    error: `source_pressure_cooldown_applied: ${gaps} pending source-pressure gap(s), persistence ${attempts}; next attempt at ${next}`,
    knownGaps: [],
    recordsEmitted: 0,
    source: buildScheduledRunSource(connectorId),
    startedAt: nowIso(),
    status: "skipped",
  };
}

function findLastSuccessAt(history: readonly RunRecord[], connectorKey: string): string | null {
  // biome-ignore lint/style/noIncrementDecrement: The explicit counter update preserves this loop’s evaluation order.
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
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
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
    index,
    last_attempt_at: gap.lastPressureAt ?? null,
    next_attempt_after: gap.nextAttemptAfter ?? null,
    reason: gap.reason,
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
  /**
   * True when `decideSynthesizedRevalidation` (synthesized-attention-
   * revalidation.ts) says a bounded, non-interactive confirming run is due
   * for SYNTHESIZED owner-action evidence currently blocking this connector.
   * Ordinary same-class-failure backoff (this module) has no knowledge of
   * attention evidence — computed forever independently — so without this
   * input, a connection that crosses `BLOCKED_PROMOTION_THRESHOLD` on
   * ordinary failures stays `eligible=false` FOREVER even once the
   * revalidation cadence says a probe is due: `executeRun` (and therefore
   * `gateAttention`, the only place that actually admits the probe) is never
   * reached, because `evaluateBackoffDispatch` gates whether `executeRun` is
   * called at all. When `blocked && synthesizedRevalidationDue`, `eligible`
   * is allowed through so the pre-run gate gets a chance to independently
   * re-verify cadence and admit exactly the bounded probe — never an
   * ordinary forward-walk dispatch (`recoveryOnly` stays forced `false`
   * either way; the probe's own noninteractive-by-construction gate is
   * `run-automation-policy.ts`'s `triggerKind: "revalidation"` projection,
   * not this flag). Defaults to `false` when the caller doesn't probe it
   * (e.g. no attention handler configured), preserving today's `blocked`
   * behavior exactly.
   */
  readonly synthesizedRevalidationDue: boolean;
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
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const reasonClass = inputs.reasonClass;
  const transitions: BackoffDispatchTransition[] = [];
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  let eligible = inputs.eligible;
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  let recoveryOnly = inputs.recoveryOnly;
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
      // Auto-dispatch is suppressed for blocked connectors (even recovery-only)
      // — EXCEPT a due bounded revalidation probe for synthesized owner-action
      // evidence (see `synthesizedRevalidationDue`'s doc comment above): that
      // is the ONE tick type still admitted through `blocked`, so a stale
      // reason can eventually receive a fresh, noninteractive-by-construction
      // probe even while ordinary same-class-failure backoff has escalated to
      // `blocked`. `recoveryOnly` stays forced false either way — the probe is
      // gated by `gateAttention`/`triggerKind: "revalidation"`, not recovery.
      eligible = inputs.synthesizedRevalidationDue;
      recoveryOnly = false;
    }
  } else if (!inputs.backoffApplied) {
    // Streak broken (success or different class): clear the announcement.
    announcedBackoffMutation = "delete";
  }

  return { announcedBackoffMutation, announcedBlockedMutation, eligible, recoveryOnly, transitions };
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
  evaluateBackoffDispatch: (schedule: ConnectorSchedule, now: number) => Promise<EvaluateBackoffDispatchResult>;
  resolveCooldownSkip: (
    schedule: ConnectorSchedule,
    key: string,
    cooldown: SourcePressureCooldownDecision,
    cooldownDefers: boolean,
    existingSkip: RunRecord | null
  ) => RunRecord | null;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDispatchGovernor(deps: DispatchGovernorDeps): DispatchGovernor {
  const {
    getForwardEvidenceDebt,
    getForwardEvidenceInvalidatedAtMs = () => ({ inScope: false, invalidatedAtMs: null }),
    getUnresolvedAttention,
    getLastSuccessfulRunAt,
    getNonPressureRecoverableCount,
    getSourcePressureGaps,
    onHumanRequiredStateEscalation,
    reproofOptions = {},
    runtime,
    synthesizedRevalidationOptions = {},
    synthesizedRevalidationStore,
  } = deps;

  // Fail-closed to `{ inScope: false, invalidatedAtMs: null }` on any probe
  // error — a probe failure must NEVER be read as "in scope with no anchor"
  // (which `decideForwardEvidenceReproof` itself now also refuses to admit
  // on, per the second gate REVISE, but `inScope: false` additionally
  // ensures this connector's tick never even calls that function on a
  // read failure, matching a host that never wired the probe at all).
  async function probeForwardEvidenceInvalidatedAtMs(
    connectorId: string,
    key: string
  ): Promise<ForwardEvidenceInvalidationProbeResult> {
    try {
      const result = await getForwardEvidenceInvalidatedAtMs(connectorId, key);
      const invalidatedAtMs =
        typeof result.invalidatedAtMs === "number" && Number.isFinite(result.invalidatedAtMs)
          ? result.invalidatedAtMs
          : null;
      return { inScope: result.inScope === true, invalidatedAtMs };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] forward-evidence-invalidated-at probe failed for ${connectorId}: ${message}`);
      return { inScope: false, invalidatedAtMs: null };
    }
  }

  // Consulted ONLY when the tick is otherwise `blocked` — see
  // `synthesizedRevalidationDue`'s doc comment on `DecideBackoffDispatchInputs`.
  // Fail-closed (returns false) on any probe error, when no attention
  // handler is configured, or when no durable anchor store is injected:
  // preserves today's `blocked` behavior exactly.
  async function probeSynthesizedRevalidationDue(connectorId: string, key: string): Promise<boolean> {
    if (!(getUnresolvedAttention && synthesizedRevalidationStore)) {
      return false;
    }
    try {
      const evidence = await getUnresolvedAttention(connectorId, key);
      if (!evidence?.key || evidence.source !== "synthesized") {
        return false;
      }
      const anchor = await Promise.resolve(synthesizedRevalidationStore.get(key));
      return decideSynthesizedRevalidation(anchor, Date.now(), synthesizedRevalidationOptions).admit;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] synthesized-revalidation probe failed for ${connectorId}: ${message}`);
      return false;
    }
  }

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

  // Read whether this connection currently has forward-evidence debt (its
  // terminal facts are not current, or are older than
  // `forwardEvidenceMaxAgeMs`) — the bound on recovery-first selection
  // (`resolveRecoveryFirstMode`'s `forwardEvidenceDebt` input; design:
  // recovery-first SHALL NOT starve forward evidence).
  //
  // Fail-CLOSED to `false` (no debt) on probe error, mirroring the
  // non-pressure recovery probe's stance: a false positive here would divert
  // a tick to forward collection on every failure of this probe, which is a
  // strictly worse failure mode than occasionally missing one debt-bounded
  // forward run. The next clean tick re-evaluates.
  async function probeForwardEvidenceDebt(
    connectorId: string,
    connectorInstanceId: string,
    scheduleIntervalMs: number
  ): Promise<boolean> {
    try {
      return Boolean(await getForwardEvidenceDebt(connectorId, connectorInstanceId, scheduleIntervalMs));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] forward-evidence-debt probe failed for ${connectorId}: ${message}`);
      return false;
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
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const connectorId = schedule.connectorId;
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const reasonClass = decision.reasonClass;
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
    return { eventsToEmit, skipToEmit };
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
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const connectorId = schedule.connectorId;
    const key = runtimeKey(schedule);
    const history = runtime.history.filter((r) => (r.connectorInstanceId || r.connectorId) === key);
    // `scheduler_last_run_times` and `run_history` (renamed from
    // `scheduler_run_history`) are persisted through separate writes. If a
    // process is killed between them — or if an older runtime never wrote
    // `last_run_time` at all — we hydrate history with failed records but
    // no last-run timestamp. Computing
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
    // `blocked` gates the reproof admission (inside the helper below) and the
    // synthesized-revalidation probe further down — computed once and
    // shared, since both read the identical `decision.recommendedHealthState`.
    const blocked = decision.recommendedHealthState === "blocked";

    const recoveryAndReproof = await resolveRecoveryAndReproofEligibility({
      blocked,
      connectorId,
      elapsed,
      eligible,
      key,
      now,
      probeForwardEvidenceDebt,
      probeForwardEvidenceInvalidatedAtMs,
      probeNonPressureRecoverableCount,
      reproofOptions,
      scheduleIntervalMs,
    });
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    eligible = recoveryAndReproof.eligible;
    // biome-ignore lint/style/useDestructuring: `recoveryOnly` is reassigned below by `backoffDecision`.
    let recoveryOnly = recoveryAndReproof.recoveryOnly;

    // Only probe synthesized-revalidation cadence when the tick is actually
    // `blocked` — this is the ONLY branch `synthesizedRevalidationDue`
    // affects (see its doc comment), so probing otherwise would be a wasted
    // async round-trip on every eligible/backing-off tick.
    const synthesizedRevalidationDue = blocked ? await probeSynthesizedRevalidationDue(connectorId, key) : false;

    // Decide (pure) then apply (effectful). The pure core reads the current
    // dedup state as inputs and returns the dispatch flags, the dedup-map
    // mutations, and the one-shot transitions to fire — all as data.
    const backoffDecision = decideBackoffDispatch({
      announcedBackoff: runtime.announcedBackoffClass.get(key),
      announcedBlocked: runtime.announcedBlockedClass.get(key),
      backoffApplied: decision.backoffApplied,
      blocked,
      eligible,
      persistedBackoffStarted:
        decision.reasonClass !== null &&
        decision.reasonClass !== undefined &&
        currentStreakHasSchedulerEvent(history, BACKOFF_STARTED_PREFIX, decision.reasonClass),
      persistedGaveUp:
        decision.reasonClass !== null &&
        decision.reasonClass !== undefined &&
        currentStreakHasSchedulerEvent(history, GAVE_UP_PREFIX, decision.reasonClass),
      reasonClass: decision.reasonClass,
      recoveryOnly,
      synthesizedRevalidationDue,
    });
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    eligible = backoffDecision.eligible;
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    recoveryOnly = backoffDecision.recoveryOnly;
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

    return { decision, eligible, eventsToEmit, recoveryOnly, skipToEmit };
  }

  return { evaluateBackoffDispatch, resolveCooldownSkip };
}
