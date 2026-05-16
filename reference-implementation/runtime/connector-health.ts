/**
 * Connector health state classifier.
 *
 * Produces a single `HealthSnapshot` per connector that the dashboard
 * (or any other consumer) can render directly. The classifier is **pure**:
 * given the bounded recent-run history plus the scheduler-back-off state
 * + assistance + schedule rows, it deterministically emits one of six
 * `HealthState` values and the supporting fields a UI pill needs.
 *
 * The discipline: everything the UI ever needs to render a connector
 * health pill must be derivable from spine events and `RunRecord` history
 * without the UI inventing semantics on the fly. If the UI is computing
 * `consecutiveFailures` by scanning rows, the data layer is wrong.
 *
 * See `docs/connector-health-state-design-brief-2026-05-15.md` for the
 * decision-order rules this module encodes verbatim. The state machine is
 * adopted from Worker E's research; this file is the implementation seam.
 */

import { displayMessageFor } from "./display-messages.ts";
import type { RunRecord, RunStatus } from "./scheduler.ts";

// ─── Tunables ──────────────────────────────────────────────────────────────

/**
 * Number of consecutive same-class failures at which `cooling_off` is
 * promoted to `blocked`. Chosen so that a connector whose 24h back-off
 * ceiling has been the binding constraint for a week (≈ 7 attempts at
 * one-per-day) is loudly marked as broken instead of looking like a
 * connector that is "just resting". See brief §1.3.
 *
 * Exposed as a `const`, not a runtime tunable, on purpose: the threshold
 * is a product decision, not an operational knob. Adjust by source edit
 * and code review.
 */
export const BLOCKED_PROMOTION_THRESHOLD = 7;

// ─── Public types ──────────────────────────────────────────────────────────

export type HealthState = "blocked" | "cooling_off" | "degraded" | "healthy" | "idle" | "needs_attention";

/**
 * Everything the dashboard pill + secondary line + expander need. All
 * fields are derivable from the inputs to `computeConnectorHealth`; the
 * UI must not synthesize new fields from `reason_code` on the fly.
 */
export interface HealthSnapshot {
  readonly consecutive_failures: number;
  readonly display_message: string | null;
  readonly last_success_at: string | null;
  readonly manual_paused: boolean;
  readonly next_attempt_at: string | null;
  readonly reason_code: string | null;
  readonly state: HealthState;
}

/**
 * Schedule row projection — the minimum the classifier needs. Sourced
 * from the existing `schedules` table; we deliberately do not import the
 * full domain record so this module stays decoupled from the
 * scheduler-store package.
 */
export interface ScheduleRow {
  readonly enabled: boolean;
}

/**
 * Active assistance event. When non-null the connector is paused waiting
 * on the owner; the pill goes amber with `needs_attention` regardless of
 * any back-off state.
 */
export interface AssistanceEvent {
  readonly reason_code: string | null;
}

/**
 * Back-off projection from `scheduler-backoff.ts::computeNextRunWithBackoff`.
 * Kept as a structural interface so consumers can pass either the literal
 * `BackoffDecision` or a thin adapter without coupling to the scheduler
 * runtime types.
 */
export interface BackoffState {
  readonly backoffApplied: boolean;
  readonly consecutiveFailures: number;
  readonly nextRunAt: string | null;
  readonly reasonClass: string | null;
}

export interface ComputeConnectorHealthInput {
  readonly activeAssistance: AssistanceEvent | null;
  readonly backoffState: BackoffState | null;
  /** Newest-first run history, bounded by the caller (e.g. last 50). */
  readonly recentRuns: readonly RunRecord[];
  readonly schedule: ScheduleRow | null;
}

// ─── Classifier ────────────────────────────────────────────────────────────

/**
 * Decision order (brief §3.3):
 *
 *   1. `manual_paused` (schedule disabled) → `idle` with `manual_paused: true`
 *   2. No `recentRuns` at all → `idle`
 *   3. `activeAssistance != null` → `needs_attention`
 *   4. `backoffState.consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD` → `blocked`
 *   5. `backoffState.backoffApplied === true` → `cooling_off`
 *   6. Last run `succeeded_with_gaps` (i.e. `succeeded` + actionable/transient
 *      `knownGaps`) → `degraded`
 *   7. Last run `succeeded` → `healthy`
 *   8. Last run `failed` (no back-off applied yet) → `degraded`
 *
 * `display_message` is populated via the registry when `reason_code` is
 * present; the UI is responsible for the loud-and-honest fallback copy
 * (the classifier stays honest and returns `null` for unregistered
 * codes — registry completeness is enforced by a dedicated unit test).
 */
export function computeConnectorHealth(input: ComputeConnectorHealthInput): HealthSnapshot {
  const { recentRuns, schedule, activeAssistance, backoffState } = input;
  const lastSuccessAt = findLastSuccessAt(recentRuns);

  // 1. Manual pause beats every other signal.
  if (schedule && schedule.enabled === false) {
    return manualPausedSnapshot(backoffState, lastSuccessAt);
  }

  // 2. Never run: empty idle state.
  if (recentRuns.length === 0) {
    return emptyIdleSnapshot();
  }

  // 3. Assistance event in flight wins over scheduler back-off — the
  //    user can act and unblock; back-off is just the cadence.
  if (activeAssistance) {
    return needsAttentionSnapshot(activeAssistance, backoffState, lastSuccessAt);
  }

  // 4–5. Back-off-driven states.
  const backoffSnapshot = backoffSnapshotOrNull(backoffState, lastSuccessAt);
  if (backoffSnapshot) {
    return backoffSnapshot;
  }

  // 6–8. Outcome-driven states.
  return outcomeSnapshot(recentRuns[0], backoffState, lastSuccessAt);
}

// ─── Per-state snapshot builders ───────────────────────────────────────────

function manualPausedSnapshot(backoffState: BackoffState | null, lastSuccessAt: string | null): HealthSnapshot {
  return {
    state: "idle",
    reason_code: null,
    display_message: null,
    consecutive_failures: backoffState?.consecutiveFailures ?? 0,
    next_attempt_at: null,
    last_success_at: lastSuccessAt,
    manual_paused: true,
  };
}

function emptyIdleSnapshot(): HealthSnapshot {
  return {
    state: "idle",
    reason_code: null,
    display_message: null,
    consecutive_failures: 0,
    next_attempt_at: null,
    last_success_at: null,
    manual_paused: false,
  };
}

function needsAttentionSnapshot(
  activeAssistance: AssistanceEvent,
  backoffState: BackoffState | null,
  lastSuccessAt: string | null
): HealthSnapshot {
  const reason = activeAssistance.reason_code;
  return {
    state: "needs_attention",
    reason_code: reason,
    display_message: reason ? displayMessageFor(reason) : null,
    consecutive_failures: backoffState?.consecutiveFailures ?? 0,
    next_attempt_at: backoffState?.nextRunAt ?? null,
    last_success_at: lastSuccessAt,
    manual_paused: false,
  };
}

function backoffSnapshotOrNull(backoffState: BackoffState | null, lastSuccessAt: string | null): HealthSnapshot | null {
  if (!backoffState) {
    return null;
  }
  if (backoffState.consecutiveFailures >= BLOCKED_PROMOTION_THRESHOLD) {
    return backoffPillSnapshot("blocked", backoffState, lastSuccessAt);
  }
  if (backoffState.backoffApplied) {
    return backoffPillSnapshot("cooling_off", backoffState, lastSuccessAt);
  }
  return null;
}

function backoffPillSnapshot(
  state: "blocked" | "cooling_off",
  backoffState: BackoffState,
  lastSuccessAt: string | null
): HealthSnapshot {
  const reasonCode = stripClassPrefix(backoffState.reasonClass);
  return {
    state,
    reason_code: reasonCode,
    display_message: displayMessageFor(reasonCode),
    consecutive_failures: backoffState.consecutiveFailures,
    next_attempt_at: backoffState.nextRunAt,
    last_success_at: lastSuccessAt,
    manual_paused: false,
  };
}

function outcomeSnapshot(
  latest: RunRecord | undefined,
  backoffState: BackoffState | null,
  lastSuccessAt: string | null
): HealthSnapshot {
  if (latest && latest.status === "succeeded") {
    return succeededSnapshot(latest, backoffState, lastSuccessAt);
  }
  // Last run failed (no back-off yet, no assistance): degraded — the
  // connector is still under normal cadence and one failure is not yet
  // a streak. `cooling_off` and `blocked` are reserved for the
  // back-off-engaged shape (rules 4–5).
  const reason = lastRunReasonCode(latest);
  return {
    state: "degraded",
    reason_code: reason,
    display_message: reason ? displayMessageFor(reason) : null,
    consecutive_failures: backoffState?.consecutiveFailures ?? 0,
    next_attempt_at: backoffState?.nextRunAt ?? null,
    last_success_at: lastSuccessAt,
    manual_paused: false,
  };
}

function succeededSnapshot(
  latest: RunRecord,
  backoffState: BackoffState | null,
  lastSuccessAt: string | null
): HealthSnapshot {
  const reason = firstDegradingKnownGapReason(latest);
  if (reason) {
    return {
      state: "degraded",
      reason_code: reason,
      display_message: reason ? displayMessageFor(reason) : null,
      consecutive_failures: 0,
      next_attempt_at: backoffState?.nextRunAt ?? null,
      last_success_at: lastSuccessAt,
      manual_paused: false,
    };
  }
  return {
    state: "healthy",
    reason_code: null,
    display_message: null,
    consecutive_failures: 0,
    next_attempt_at: backoffState?.nextRunAt ?? null,
    last_success_at: lastSuccessAt,
    manual_paused: false,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * `scheduler-backoff.ts::reasonClassOf` prefixes the class with one of
 * `terminal:`, `failure:`, or `connector:` so the scheduler streak-
 * counter can disambiguate same-name codes across sources. The
 * dashboard pill wants the raw reason code (e.g. `reddit_login_unexpected_ui`),
 * not the prefixed class. Strip the prefix at the seam.
 */
function stripClassPrefix(reasonClass: string | null): string | null {
  if (!reasonClass) {
    return null;
  }
  const colon = reasonClass.indexOf(":");
  if (colon < 0) {
    return reasonClass;
  }
  const suffix = reasonClass.slice(colon + 1);
  return suffix.length > 0 ? suffix : null;
}

function findLastSuccessAt(recentRuns: readonly RunRecord[]): string | null {
  for (const run of recentRuns) {
    if (run.status === ("succeeded" satisfies RunStatus)) {
      return run.completedAt;
    }
  }
  return null;
}

function firstDegradingKnownGapReason(record: RunRecord): string | null {
  for (const gap of record.knownGaps) {
    if (gap && typeof gap === "object") {
      if (!isDegradingKnownGap(gap as Record<string, unknown>)) {
        continue;
      }
      const reason = (gap as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.length > 0) {
        return reason;
      }
    }
  }
  return null;
}

function isDegradingKnownGap(gap: Record<string, unknown>): boolean {
  const severity = gap.severity;
  if (severity === "informational" || severity === "recoverable") {
    return false;
  }
  if (severity === "actionable" || severity === "transient") {
    return true;
  }
  // Historical gaps lacked severity; treat them conservatively until a newer
  // classified run supersedes them.
  return true;
}

function lastRunReasonCode(record: RunRecord | undefined): string | null {
  if (!record) {
    return null;
  }
  if (record.terminalReason) {
    return record.terminalReason;
  }
  if (record.failureReason) {
    return record.failureReason;
  }
  const err = record.connectorError as { reason?: unknown } | null | undefined;
  if (err && typeof err === "object" && typeof err.reason === "string" && err.reason.length > 0) {
    return err.reason;
  }
  return null;
}
