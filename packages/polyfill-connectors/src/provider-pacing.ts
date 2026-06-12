export interface PacingOptions {
  /**
   * Base additive-increase step (ms) per successful response — the GENTLE step
   * applied in the ceiling-discovery region (interval at or below
   * `initialIntervalMs`). This is the step Chiu & Jain's AIMD proof requires
   * near the operating point: a small, conservative linear increase so the probe
   * toward the rate ceiling never overshoots into a ban. Default: 100ms.
   */
  additiveIncreaseMs?: number;
  /**
   * Maximum credit (ms of pacing head-room) the bucket may accumulate while
   * the connector is idle between runs. Prevents a burst on resume.
   * Corresponds to GCRA burst tolerance L. Defaults to 2 × initialIntervalMs.
   */
  burstToleranceMs?: number;
  /**
   * Inter-request interval (ms) at the initial conservative rate.
   * The AIMD fill rate starts here and adjusts from this baseline.
   */
  initialIntervalMs?: number;
  /**
   * §10-E (SLVP-ideal): the maximum age (ms) at which a warm-start interval is
   * still considered valid. If `now() - restoredAtMs > maxWarmStartAgeMs` the
   * restored interval is discarded and the controller cold-starts at
   * `initialIntervalMs`. This prevents a burst into a quota the provider may
   * have tightened during a long idle period.
   *
   * A value equivalent to the scheduler's maximum cross-run cooldown delay
   * (DEFAULT_MAX_COOLDOWN_MS = 6h) is the recommended default: after an idle
   * span that long the provider's quota window has certainly cycled and the
   * prior learned rate is no longer a safe entry point.
   *
   * Absent (or absent `restoredAtMs`) → staleness checking disabled; caller
   * owns freshness (backward-compatible).
   */
  maxWarmStartAgeMs?: number;
  /**
   * Minimum inter-request interval (ms). The floor the AIMD fill rate can
   * reach via additive increase. Defaults to 0 (no floor below initial).
   */
  minIntervalMs?: number;
  /** Multiplicative decrease factor on each throttle signal. E.g. 0.5 = halve fill rate (double interval). Default: 0.5. */
  multiplicativeDecreaseFactor?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /**
   * Distance-proportional recovery gain for the additive step ABOVE the
   * operating point. The per-success step is:
   *
   *   step = additiveIncreaseMs + recoveryGain × max(0, interval − initialIntervalMs)
   *
   * This makes recovery fast when the interval is far above `initialIntervalMs`
   * (a transient over-backoff from a burst of real 429s — NOT ceiling discovery,
   * and ban-safe to unwind because every step keeps us SLOWER than the rate that
   * already succeeded), while decaying continuously to the gentle base step at
   * and below the operating point (where caution is mandatory). It is the direct
   * analogue of AWS adaptive-mode CUBIC: "faster growth far below the ceiling,
   * slow linear growth near it" (prior-art §1).
   *
   * THEORY CONSTRAINT (do not violate): this remains ADDITIVE in the Chiu-Jain
   * sense — each success applies a FIXED increment determined by the current
   * state, never a multiplication of the controlled variable toward the ceiling.
   * Recovery is therefore convergent and the probe near the operating point
   * stays the base step. Default: 0.1 (≈0% boost at the operating point, growing
   * to a ~10% fraction of the over-backoff distance per success — e.g. a 29s
   * spike recovers in ~40 successes vs ~290 at the flat base step, while the
   * region from `initialIntervalMs` down to `minIntervalMs` is still walked at
   * exactly the gentle base step). Set to 0 to restore the legacy flat step.
   *
   * Tunable via PDPP_CHATGPT_PACING_RECOVERY_GAIN at the ChatGPT call site.
   */
  recoveryGain?: number;
  /**
   * Timestamp (ms since epoch, e.g. Date.now()) when `restoredIntervalMs` was
   * persisted. Used together with `maxWarmStartAgeMs` to enforce the §10-E
   * staleness guard inside the constructor. Ignored if `maxWarmStartAgeMs` is
   * absent or `restoredIntervalMs` is absent.
   */
  restoredAtMs?: number;
  /**
   * Warm-start seed: the interval the controller had LEARNED at the end of a
   * prior run, restored so the AIMD descent compounds across runs instead of
   * resetting to `initialIntervalMs` at every boundary. Clamped to never be
   * faster than `minIntervalMs` (the rate ceiling). Absent → cold start at
   * `initialIntervalMs`.
   *
   * §10-E (SLVP-ideal): if `restoredAtMs` + `maxWarmStartAgeMs` are also
   * supplied, the staleness guard is enforced here — a persisted interval older
   * than `maxWarmStartAgeMs` is treated as stale and the controller cold-starts
   * at `initialIntervalMs` instead. Without those two fields, the caller owns
   * the staleness decision (backward-compatible behaviour).
   */
  restoredIntervalMs?: number;
  /** Injectable sleep for tests. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ThrottleSignal {
  /** If present, honor this delay exactly for the next admit() call. */
  retryAfterMs?: number;
}

/** Why the controller last backed off, for operator-legible rate state. */
export type PacingBackoffReason = "retry_after" | "throttle";

export interface PacingBackoff {
  /** The interval (ms) the controller increased TO when this back-off fired. */
  atIntervalMs: number;
  reason: PacingBackoffReason;
}

/**
 * Operator-legible snapshot of the controller's live rate state. `intervalMs` is
 * the durable value to persist for warm-start; `minIntervalMs` is the rate
 * ceiling; `lastBackoff` makes the most recent slow-down visible.
 */
export interface PacingSnapshot {
  /**
   * The cold-start baseline interval (the conservative one-time AIMD entry
   * point). Exposed so callers persisting a warm-start interval can cap it at the
   * cold-start floor — a run that ended deep in throttle must not persist an
   * interval SLOWER than a cold start, which would poison the next run's seed.
   */
  initialIntervalMs: number;
  intervalMs: number;
  lastBackoff: PacingBackoff | null;
  minIntervalMs: number;
}

const DEFAULT_INITIAL_INTERVAL_MS = 1000;
const DEFAULT_ADDITIVE_INCREASE_MS = 100;
/**
 * Default distance-proportional recovery gain (see PacingOptions.recoveryGain).
 * 0.1 unwinds a deep transient back-off in tens of successes while keeping the
 * step within ~10% of the base step in the discovery region just above the
 * operating point — the AWS-CUBIC-shaped fast-far / gentle-near asymmetry.
 */
const DEFAULT_RECOVERY_GAIN = 0.1;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GCRA-compatible token-bucket pacing with rate-based AIMD fill-rate adjustment.
 *
 * The bucket tracks a Theoretical Arrival Time (TAT): the earliest moment the
 * next request may be admitted. On idle gap the TAT is reset to
 * `now + currentIntervalMs` (capped to burstToleranceMs ahead), preventing
 * unbounded credit accumulation between scheduled runs.
 */
export class ProviderPacing {
  private readonly initialIntervalMs: number;
  private readonly minIntervalMs: number;
  private readonly burstToleranceMs: number;
  private readonly additiveIncreaseMs: number;
  private readonly recoveryGain: number;
  private readonly multiplicativeDecreaseFactor: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private _currentIntervalMs: number;
  /** Theoretical Arrival Time: earliest moment the next request is admitted. */
  private tat: number | null = null;
  /** Override for the next admit() call (from retryAfterMs). */
  private nextRetryAfterMs: number | null = null;
  /** Most recent back-off event, for operator-legible rate state. */
  private _lastBackoff: PacingBackoff | null = null;

  constructor(options: PacingOptions) {
    this.initialIntervalMs = options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.burstToleranceMs = options.burstToleranceMs ?? 2 * this.initialIntervalMs;
    this.additiveIncreaseMs = options.additiveIncreaseMs ?? DEFAULT_ADDITIVE_INCREASE_MS;
    // Clamp the recovery gain to a non-negative, finite value. A negative or
    // NaN gain would invert/poison the additive step; 0 restores the legacy
    // flat-step behaviour.
    this.recoveryGain =
      typeof options.recoveryGain === "number" && Number.isFinite(options.recoveryGain) && options.recoveryGain >= 0
        ? options.recoveryGain
        : DEFAULT_RECOVERY_GAIN;
    this.multiplicativeDecreaseFactor = options.multiplicativeDecreaseFactor ?? 0.5;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    // Warm-start: seed from the prior run's learned interval when supplied,
    // clamped to never be faster than the rate ceiling (minIntervalMs). A
    // restored value is never trusted to be faster than the operator's ceiling,
    // and never slower-than-useless past the cold seed is irrelevant (a slower
    // restored value is honored — it means the prior run had backed off).
    //
    // §10-E (SLVP-ideal): if restoredAtMs + maxWarmStartAgeMs are provided,
    // enforce a staleness guard: a persisted interval that is older than the
    // staleness window is treated as cold (the provider may have tightened its
    // quota during a long idle and the prior learned rate is no longer a safe
    // entry point). Without those fields the caller owns freshness — backward-
    // compatible with pre-§10-E callers who do their own staleness check.
    this._currentIntervalMs = ProviderPacing.resolveInitialInterval(
      options,
      this.initialIntervalMs,
      this.minIntervalMs,
      this.now
    );
  }

  /**
   * §10-E: resolve the initial _currentIntervalMs from constructor options,
   * applying the staleness guard when restoredAtMs + maxWarmStartAgeMs are both
   * present. Extracted as a static pure helper so it is testable without
   * constructing a full instance.
   *
   * Decision table:
   *   restoredIntervalMs absent          → initialIntervalMs (cold start)
   *   restoredAtMs or maxWarmStartAgeMs absent → Math.max(min, restored)  (caller-owned freshness)
   *   now() - restoredAtMs > maxWarmStartAgeMs → initialIntervalMs (stale → cold)
   *   otherwise                           → Math.max(min, restored)  (fresh → warm)
   */
  private static resolveInitialInterval(
    options: PacingOptions,
    initialIntervalMs: number,
    minIntervalMs: number,
    now: () => number
  ): number {
    if (options.restoredIntervalMs == null) {
      return initialIntervalMs;
    }
    // Apply staleness guard only when both staleness fields are provided.
    if (options.restoredAtMs != null && options.maxWarmStartAgeMs != null) {
      const ageMs = now() - options.restoredAtMs;
      if (ageMs > options.maxWarmStartAgeMs) {
        // Stale: cold-start so the pacer does not burst into a potentially
        // tightened quota after a long idle (§10-E).
        return initialIntervalMs;
      }
    }
    return Math.max(minIntervalMs, options.restoredIntervalMs);
  }

  /**
   * Compute the pre-flight delay (ms) the next request owes per the current
   * fill rate and advance the GCRA Theoretical Arrival Time as if that request
   * were admitted now. PURE OF SLEEP: the caller owns the wait. This is the
   * `SendDelayHint` seam — it lets the single send governor fold pacing into
   * its own one pre-flight wait instead of pacing running a second `await`.
   *
   * Calling `nextDelayMs()` consumes the same TAT/Retry-After state `admit()`
   * would, so `admit()` is exactly `sleep(nextDelayMs())`.
   */
  nextDelayMs(): number {
    const nowMs = this.now();

    // Honor a pending Retry-After override exactly.
    if (this.nextRetryAfterMs !== null) {
      const delay = this.nextRetryAfterMs;
      this.nextRetryAfterMs = null;
      this.tat = nowMs + delay;
      return Math.max(0, delay);
    }

    if (this.tat === null) {
      // First call: anchor TAT so the first request waits one full interval.
      this.tat = nowMs + this._currentIntervalMs;
      return this._currentIntervalMs;
    }

    // GCRA: if there's been a long idle gap, cap the accumulated credit to
    // burstToleranceMs. This prevents a burst on resume.
    const maxTat = nowMs + this.burstToleranceMs;
    if (this.tat < nowMs - this.burstToleranceMs) {
      this.tat = nowMs - this.burstToleranceMs;
    }

    const nextTat = this.tat + this._currentIntervalMs;
    const delay = Math.max(0, nextTat - nowMs);
    this.tat = Math.min(nextTat, maxTat);
    return delay;
  }

  /**
   * Wait until the next request is admitted per the current fill rate.
   * Returns immediately if the token is already available. Equivalent to
   * sleeping for {@link nextDelayMs}; retained for connectors that run pacing
   * as their own pre-flight wait (legacy, pre-convergence default).
   */
  async admit(): Promise<void> {
    const delay = this.nextDelayMs();
    if (delay > 0) {
      await this.sleep(delay);
    }
  }

  /**
   * Record a successful response — additive increase (reduce interval toward minIntervalMs).
   *
   * The per-success step is distance-proportional but bounded and ADDITIVE
   * (Chiu-Jain): a fixed increment per success that is the gentle base step in
   * the ceiling-discovery region (interval at or below `initialIntervalMs`) and
   * grows with the over-backoff distance above it. This unwinds a transient
   * spike (a burst of real 429s pushed the interval far above the operating
   * point) in tens of successes instead of hundreds, while keeping the probe
   * toward the rate ceiling gentle — recovering fast above the operating point
   * is ban-safe because every intermediate interval is still SLOWER than the
   * rate that already succeeded; only near `initialIntervalMs`/`minIntervalMs`
   * are we discovering the true ceiling, and there the step stays the base step.
   * See {@link PacingOptions.recoveryGain} for the theory constraint. The step
   * is never multiplicative, so convergence is preserved, and the result is
   * always floored at `minIntervalMs` — the ceiling is never crossed.
   *
   * §10-D (SLVP-ideal): pass `{ suppressAdditiveIncrease: true }` to suppress
   * the decrease while a source-pressure cooldown is active. The recovery lane
   * calls this so its successes do NOT un-learn the back-off the cooldown is
   * protecting. Throttle signals still fire unconditionally — recovery may
   * DECELERATE the shared pacer, never ACCELERATE it during cooldown.
   */
  recordSuccess(opts?: { suppressAdditiveIncrease?: boolean }): void {
    if (opts?.suppressAdditiveIncrease === true) {
      // §10-D: cooldown-exempt recovery lane — leave interval unchanged.
      return;
    }
    this._currentIntervalMs = Math.max(this.minIntervalMs, this._currentIntervalMs - this.additiveStepMs());
  }

  /**
   * The additive-increase step (ms) to apply for the current interval. Gentle
   * base step in the ceiling-discovery region (interval ≤ initialIntervalMs),
   * growing linearly with the over-backoff distance above it (transient-spike
   * unwinding). PURE: reads only, mutates nothing.
   */
  private additiveStepMs(): number {
    const overBackoffMs = Math.max(0, this._currentIntervalMs - this.initialIntervalMs);
    // Floor to whole ms so intervals stay integer-valued (operator-legible logs
    // and an integer warm-start persisted value, matching the legacy flat step)
    // and no IEEE-754 drift accumulates. At/below the operating point the
    // overshoot is 0, so this is exactly `additiveIncreaseMs` — the gentle base
    // step — preserving cautious ceiling discovery.
    return Math.floor(this.additiveIncreaseMs + this.recoveryGain * overBackoffMs);
  }

  /**
   * Record a throttle signal — multiplicative decrease (increase interval, never below initialIntervalMs).
   * If `signal.retryAfterMs` is set, the next admit() will honor it exactly.
   *
   * Part B (steady-state honesty): a Retry-After is a ONE-SHOT instruction —
   * "wait exactly this long THIS time" — not a statement about the sustained
   * rate. The wait is already enforced via `nextRetryAfterMs` (consumed by the
   * very next admit()). Baking that same delay into `_currentIntervalMs` would
   * double-penalize: a ~100s Retry-After would also become the ongoing
   * inter-request interval and take ~1000 successes (~hours) of additive
   * recovery to undo. So a `retry_after` signal sets the one-shot wait WITHOUT
   * multiplicatively decreasing the sustained interval. A plain throttle (no
   * retryAfterMs) still does its normal ×(1/multiplicativeDecreaseFactor)
   * decrease — that is the AIMD signal for an unquantified slow-down.
   */
  recordThrottle(signal?: ThrottleSignal): void {
    const hasRetryAfter = signal?.retryAfterMs != null;
    const reason: PacingBackoffReason = hasRetryAfter ? "retry_after" : "throttle";
    if (hasRetryAfter) {
      // One-shot wait only: honor it exactly on the next admit(), but do NOT
      // adopt it as the sustained interval (see method doc, Part B).
      this.nextRetryAfterMs = signal?.retryAfterMs ?? null;
      this._lastBackoff = { atIntervalMs: this._currentIntervalMs, reason };
      return;
    }
    // Plain throttle: multiplicative decrease (divide fill rate → multiply
    // interval). Never decreases the interval below initialIntervalMs (the
    // conservative baseline), so a single throttle bounces the rate back toward
    // the cold floor even when warm-start had restored a faster learned interval.
    const decreased = this._currentIntervalMs / this.multiplicativeDecreaseFactor;
    this._currentIntervalMs = Math.max(this.initialIntervalMs, decreased);
    this._lastBackoff = { atIntervalMs: this._currentIntervalMs, reason };
  }

  /** Current inter-request interval (ms) for observability and tests. */
  get currentIntervalMs(): number {
    return this._currentIntervalMs;
  }

  /**
   * Operator-legible snapshot of the controller's live rate state. `intervalMs`
   * is the durable value the connector persists for warm-start across runs;
   * `minIntervalMs` is the rate ceiling; `lastBackoff` surfaces the most recent
   * slow-down. PURE: reads only, never advances GCRA state.
   */
  snapshot(): PacingSnapshot {
    return {
      intervalMs: this._currentIntervalMs,
      lastBackoff: this._lastBackoff,
      minIntervalMs: this.minIntervalMs,
      initialIntervalMs: this.initialIntervalMs,
    };
  }
}
