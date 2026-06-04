/**
 * Cross-run source-pressure cooldown governor.
 *
 * Problem: a connector run can defer work under upstream/source pressure and
 * still terminate `succeeded`. ChatGPT does exactly this — when a private
 * detail endpoint returns bare 429s, the run degrades the remaining
 * conversations to resumable `DETAIL_GAP` records (reason `upstream_pressure`
 * or `rate_limited`) and exits with a clean `succeeded` status rather than
 * grinding the hot account. That is the correct connector behaviour.
 *
 * But the scheduler's failure-class back-off (`scheduler-backoff.ts`) only
 * counts `failed` records. A `succeeded`-with-pending-pressure run resets the
 * failure streak to zero, so the next scheduled tick fires on the normal
 * interval and re-hits the *same* account-level throttle bucket that is still
 * cooling. Unattended cadence then keeps re-pressuring the source.
 *
 * Solution: a second, independent governor that reads the durable pending
 * pressure gaps for a connection and defers the next *automatic* dispatch with
 * a decaying/exponential inter-run cooldown, capped to a reasonable upper
 * bound. The cooldown grows the longer pressure persists (driven by the gaps'
 * recovery attempt counts) and relaxes the moment the gaps recover (the
 * pending set becomes empty), so a clean/recovered run is never stuck.
 *
 * This module is **pure**, mirroring `scheduler-backoff.ts`: it takes the
 * pending pressure gaps + the connector's base interval and returns a
 * decision. No I/O, no timers, no store access. The scheduler reads the
 * durable gaps through an injected probe and feeds them here; the controller
 * projection feeds the same shape so the dashboard renders an honest
 * `cooling_off` pill instead of bare green while pressure gaps remain.
 *
 * The cooldown is deliberately orthogonal to failure back-off: a connection
 * can be failing (back-off) *and* carrying pressure gaps (cooldown) at the
 * same time. The scheduler takes whichever defers the next run further. The
 * cooldown only ever makes a schedule more conservative; manual `Sync now`
 * bypasses it entirely (the owner is explicitly asking to retry now).
 */

// ─── Pressure reasons ───────────────────────────────────────────────────────

/**
 * Detail-gap reasons that represent account/source-level pressure — the gap
 * was deferred because the upstream throttled or was transiently unavailable,
 * not because of a connector defect or a missing-data decision. Only these
 * reasons drive the cooldown. A gap with any other reason (or none) is ignored
 * here so unrelated gap bookkeeping cannot throttle the schedule.
 *
 * `upstream_pressure` and `rate_limited` are the two source-pressure reasons a
 * connector emits on a `DETAIL_GAP` (see
 * `packages/polyfill-connectors/src/connector-runtime-protocol.ts`).
 */
export const SOURCE_PRESSURE_GAP_REASONS: ReadonlySet<string> = new Set(["rate_limited", "upstream_pressure"]);

// ─── Tunables ──────────────────────────────────────────────────────────────

/**
 * Floor multiplier applied to the base interval the first time pressure gaps
 * are observed (before any recovery attempt has been made against them). At
 * minimum we wait one full base interval beyond the normal cadence so the
 * next tick does not immediately re-hit a bucket that just throttled.
 */
export const DEFAULT_COOLDOWN_MIN_MULTIPLIER = 1;

/**
 * Hard ceiling on the exponent applied to the base interval. The cooldown
 * multiplier is `2^min(attempt, MAX_COOLDOWN_EXP)`. With the default 6h cap
 * below this is rarely binding, but it guards against absurd intervals.
 */
export const DEFAULT_MAX_COOLDOWN_EXP = 6;

/**
 * Absolute ceiling on the cooldown delay (6 hours by default). Source pressure
 * is per-account and time-varying — the 2026-06-02 ChatGPT probes showed it
 * recovers over minutes-to-hours, not days. A 6h cap is well above the
 * observed recovery curve while staying below the failure-back-off 24h cap, so
 * even a persistently-pressured connection is retried a few times a day to
 * pick up recovery without owner intervention.
 */
export const DEFAULT_MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * One pending pressure gap as the governor needs to see it. This is the
 * minimal projection of a `connector_detail_gaps` row (see
 * `reference-implementation/server/stores/connector-detail-gap-store.js`)
 * that drives the cooldown. The scheduler probe and the controller projection
 * both map durable rows onto this shape.
 */
export interface PendingPressureGap {
  /**
   * How many times the runtime has already tried to recover this gap. Drives
   * the exponential growth: a gap that has survived more recovery attempts is
   * more persistent and earns a longer cooldown. Defaults to 0 when absent.
   */
  readonly attemptCount?: number | null;
  /**
   * Optional connector/runtime-authored floor for the next attempt (ISO). When
   * present and later than the computed cooldown, it is honoured as the
   * `nextRunAt`. This lets a connector that *does* learn a concrete wait (e.g.
   * a `Retry-After`) push the schedule out further without the governor
   * guessing.
   */
  readonly nextAttemptAfter?: string | null;
  /** Source-pressure reason. Only `SOURCE_PRESSURE_GAP_REASONS` count. */
  readonly reason: string | null;
}

export interface ComputeCooldownOptions {
  /** Owner-triggered run: bypass cooldown entirely. */
  readonly manual?: boolean;
  /** Max exponent applied to the base interval. */
  readonly maxCooldownExp?: number;
  /** Absolute ceiling (ms) on the cooldown delay. */
  readonly maxCooldownMs?: number;
  /** Floor multiplier on first observation. */
  readonly minMultiplier?: number;
}

export interface SourcePressureCooldownDecision {
  /** True when the scheduler should defer the next automatic dispatch. */
  readonly cooldownApplied: boolean;
  /** Effective interval (ms) the scheduler should wait from `lastRunAt`. */
  readonly effectiveIntervalMs: number;
  /**
   * Stable identity of this cooldown shape, or null when not cooling. The
   * scheduler dedupes its one-shot cooling-off skip record on this string, so
   * it changes only when the pressure picture meaningfully changes (gap count
   * or persistence), re-arming the audit line. Reasons are sorted so identity
   * is order-independent.
   */
  readonly identity: string | null;
  /**
   * Max recovery-attempt count across the pending pressure gaps. Exposed so
   * the dashboard/audit can show how persistent the pressure is.
   */
  readonly maxAttemptCount: number;
  /** ISO timestamp of when the next dispatch becomes eligible. */
  readonly nextRunAt: string;
  /** Count of pending source-pressure gaps that drove the decision. */
  readonly pendingPressureGapCount: number;
  /**
   * Health-state recommendation for the dashboard pill. Always `cooling_off`
   * when a cooldown is applied (never `blocked` — source pressure is expected
   * to recover, unlike a chronic failure streak), else `null`.
   */
  readonly recommendedHealthState: "cooling_off" | null;
}

// ─── Core helper ────────────────────────────────────────────────────────────

/**
 * Compute the cross-run cooldown for a connection given its pending durable
 * pressure gaps.
 *
 * @param pendingGaps    Pending detail gaps for *this* connection. Only gaps
 *                       whose reason is in `SOURCE_PRESSURE_GAP_REASONS` are
 *                       counted; everything else is ignored.
 * @param baseIntervalMs The configured scheduling interval (ms).
 * @param lastRunAtMs    Epoch ms of the most recent run; the next-run time is
 *                       computed relative to this. Pass `0` if never run.
 * @param options        Tunables + manual bypass.
 */
export function computeSourcePressureCooldown(
  pendingGaps: readonly PendingPressureGap[],
  baseIntervalMs: number,
  lastRunAtMs: number,
  options: ComputeCooldownOptions = {}
): SourcePressureCooldownDecision {
  const minMultiplier = normalizePositiveInteger(options.minMultiplier, DEFAULT_COOLDOWN_MIN_MULTIPLIER);
  const maxExp = normalizeNonNegativeInteger(options.maxCooldownExp, DEFAULT_MAX_COOLDOWN_EXP);
  const maxMs = normalizeFiniteNonNegativeMs(options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS, DEFAULT_MAX_COOLDOWN_MS);
  const normalizedBaseIntervalMs = normalizeFiniteNonNegativeMs(baseIntervalMs, 0);
  const normalizedLastRunAtMs = normalizeFiniteNonNegativeMs(lastRunAtMs, 0);
  const manual = options.manual === true;

  const pressureGaps = (pendingGaps ?? []).filter(
    (gap) => gap && typeof gap.reason === "string" && SOURCE_PRESSURE_GAP_REASONS.has(gap.reason)
  );

  // Manual run or no pressure → no cooldown. A recovered run (pending pressure
  // set becomes empty) lands here, so the connection is never stuck cooling.
  if (manual || pressureGaps.length === 0) {
    return {
      cooldownApplied: false,
      pendingPressureGapCount: 0,
      maxAttemptCount: 0,
      effectiveIntervalMs: manual ? 0 : normalizedBaseIntervalMs,
      nextRunAt: toIsoTimestamp(manual ? 0 : normalizedLastRunAtMs + normalizedBaseIntervalMs),
      identity: null,
      recommendedHealthState: null,
    };
  }

  const maxAttemptCount = pressureGaps.reduce(
    (max, gap) => Math.max(max, normalizeNonNegativeInteger(gap.attemptCount ?? undefined, 0)),
    0
  );

  // Multiplier grows with persistence: 2^attempt, floored at `minMultiplier`,
  // capped at `2^maxExp`. A freshly-observed gap (attempt 0) yields the floor
  // multiplier; each unrecovered run doubles the wait.
  const exponent = Math.min(maxAttemptCount, maxExp);
  const multiplier = Math.max(minMultiplier, 2 ** exponent);
  const rawDelay = normalizedBaseIntervalMs * multiplier;
  const effectiveIntervalMs = Math.min(rawDelay, maxMs);

  const computedNextRunMs = normalizedLastRunAtMs + effectiveIntervalMs;
  // Honour a connector/runtime-authored `next_attempt_after` floor when it
  // pushes the schedule out further than our computed cooldown.
  const explicitFloorMs = maxNextAttemptAfterMs(pressureGaps);
  const nextRunMs = Math.max(computedNextRunMs, explicitFloorMs);

  const reasonSummary = summarizeReasons(pressureGaps);

  return {
    cooldownApplied: true,
    pendingPressureGapCount: pressureGaps.length,
    maxAttemptCount,
    effectiveIntervalMs,
    nextRunAt: toIsoTimestamp(nextRunMs),
    identity: `source_pressure:${reasonSummary}:gaps=${pressureGaps.length}:attempt=${maxAttemptCount}`,
    recommendedHealthState: "cooling_off",
  };
}

function summarizeReasons(gaps: readonly PendingPressureGap[]): string {
  const reasons = new Set<string>();
  for (const gap of gaps) {
    if (typeof gap.reason === "string") {
      reasons.add(gap.reason);
    }
  }
  return [...reasons].sort().join(",");
}

function maxNextAttemptAfterMs(gaps: readonly PendingPressureGap[]): number {
  let max = 0;
  for (const gap of gaps) {
    if (typeof gap.nextAttemptAfter !== "string") {
      continue;
    }
    const parsed = Date.parse(gap.nextAttemptAfter);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }
  return max;
}

function normalizeFiniteNonNegativeMs(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return value;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function toIsoTimestamp(epochMs: number): string {
  const safeEpochMs = normalizeFiniteNonNegativeMs(epochMs, 0);
  return new Date(safeEpochMs).toISOString();
}
