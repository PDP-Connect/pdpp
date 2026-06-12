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
   * Cap on the elapsed-time weight applied to the over-backoff recovery term.
   * When the pacer has been throttled and fetches are slow (one per ~51s), the
   * time between successes is large. The elapsed-weight multiplies ONLY the
   * `recoveryGain × overBackoffMs` term (NOT the base `additiveIncreaseMs`), so
   * a long inflated wait recovers faster while the gentle base step is preserved
   * near the ceiling (overBackoffMs ≈ 0 → elapsed weight doesn't matter there).
   * Mirrors EIP-1559's 1/8 saturation step: at 8× elapsed the over-backoff
   * term is credited 8× — a pacer at 51s between successes unwinds ~8× faster
   * than the un-weighted gain. Default: 8.
   */
  elapsedRecoveryCap?: number;
  /**
   * Inter-request interval (ms) at the initial conservative rate.
   * The AIMD fill rate starts here and adjusts from this baseline.
   */
  initialIntervalMs?: number;
  /**
   * Hard ceiling on how far plain throttle signals can push the interval (ms).
   * Bounds the blast radius of a burst of 429s so recovery time is bounded even
   * at extreme back-off depths. Does NOT affect retry-after one-shot waits (those
   * are honored exactly and are not the sustained interval). Default: Infinity
   * (no clamp), keeping non-ChatGPT callers unaffected.
   */
  maxIntervalMs?: number;
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
  /** Multiplicative decrease factor on each throttle signal. Retained for the retry-after/hard path and backward compat; the plain-throttle path now uses `softThrottleGain` instead. Default: 0.5. */
  multiplicativeDecreaseFactor?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /**
   * Distance-proportional recovery gain for the additive step ABOVE the
   * operating point. The per-success step is elapsed-weighted on the over-backoff
   * term only:
   *
   *   overBackoffMs = max(0, interval − initialIntervalMs)
   *   recoverWeight = clamp(elapsedMs / initialIntervalMs, 1, elapsedRecoveryCap)
   *   step = additiveIncreaseMs + recoveryGain × overBackoffMs × recoverWeight
   *
   * The base `additiveIncreaseMs` is FLAT — elapsed time does NOT multiply it.
   * This preserves gentle ceiling discovery (overBackoffMs ≈ 0 near the operating
   * point, so the weight cancels out) while allowing fast unwinding from deep
   * transient spikes: when fetches are slow (~51s each), the large elapsed gap
   * provides up to `elapsedRecoveryCap`× credit on the over-backoff term.
   *
   * THEORY CONSTRAINT (do not violate): this remains ADDITIVE in the Chiu-Jain /
   * MAIMD N=1 sense — each success applies a FIXED increment determined by the
   * current state and elapsed time, never a multiplication toward the ceiling.
   * N=1 has no fairness line so convergence is safe, and the minIntervalMs floor
   * is a hard ceiling that is never crossed. Recovery is therefore convergent and
   * the probe near the operating point stays the base step. Default: 0.1. Set to
   * 0 to restore the legacy flat step (no over-backoff boost).
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
  /**
   * Gain on plain (non-retry-after) throttle signals. The interval is multiplied
   * by `(1 + softThrottleGain)` instead of the old ÷0.5 (×2). Default 0.5 gives
   * a 1.5× step, which sits inside the Leonardos stable band (< 2×) and roughly
   * halves the blast radius vs the prior ×2 step. Combined with `maxIntervalMs`
   * this bounds how deep back-off can go. Default: 0.5.
   */
  softThrottleGain?: number;
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
 * ceiling; `lastBackoff` makes the most recent slow-down visible. Recovery is
 * elapsed-weighted on the over-backoff term (see PacingOptions.recoveryGain +
 * elapsedRecoveryCap); throttle is bounded by softThrottleGain + maxIntervalMs.
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
/**
 * Default elapsed-time recovery cap (see PacingOptions.elapsedRecoveryCap).
 * Mirrors EIP-1559's 1/8 saturation step: at 8× the normal cadence elapsed, the
 * over-backoff recovery term is credited 8× — a pacer at 51s between successes
 * unwinds ~8× faster than the un-weighted gain would allow.
 */
const DEFAULT_ELAPSED_RECOVERY_CAP = 8;
/**
 * Default soft-throttle gain (see PacingOptions.softThrottleGain).
 * A 1.5× step sits inside the Leonardos stable band (< 2×) and halves the
 * blast radius of the old ×2 multiplicative decrease.
 */
const DEFAULT_SOFT_THROTTLE_GAIN = 0.5;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * GCRA-compatible token-bucket pacing with elapsed-weighted MAIMD fill-rate
 * adjustment (Multiplicative-decrease / Additive-increase, N=1 single flow).
 *
 * Recovery (additive increase) is elapsed-time-weighted on the over-backoff term
 * only — the base `additiveIncreaseMs` stays flat so ceiling discovery remains
 * gentle, while deep transient spikes unwind faster when fetches are slow.
 * Throttle (multiplicative decrease) is bounded via `softThrottleGain` (1.5×
 * default, inside the Leonardos stable band) and clamped to `maxIntervalMs`.
 *
 * N=1 has no fairness line so convergence is safe; the `minIntervalMs` floor is
 * a hard ceiling that is never crossed.
 *
 * The bucket tracks a Theoretical Arrival Time (TAT): the earliest moment the
 * next request may be admitted. On idle gap the TAT is reset to
 * `now + currentIntervalMs` (capped to burstToleranceMs ahead), preventing
 * unbounded credit accumulation between scheduled runs.
 */
export class ProviderPacing {
  private readonly initialIntervalMs: number;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly burstToleranceMs: number;
  private readonly additiveIncreaseMs: number;
  private readonly recoveryGain: number;
  private readonly elapsedRecoveryCap: number;
  private readonly softThrottleGain: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private _currentIntervalMs: number;
  /** Theoretical Arrival Time: earliest moment the next request is admitted. */
  private tat: number | null = null;
  /** Override for the next admit() call (from retryAfterMs). */
  private nextRetryAfterMs: number | null = null;
  /** Most recent back-off event, for operator-legible rate state. */
  private _lastBackoff: PacingBackoff | null = null;
  /** Timestamp of the last non-suppressed recordSuccess() call, for elapsed-time weighting. */
  private lastSuccessAtMs: number | null = null;

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
    // Elapsed recovery cap must be finite and >= 1 (weight < 1 would invert the
    // elapsed correction and slow recovery below the un-weighted gain).
    this.elapsedRecoveryCap =
      typeof options.elapsedRecoveryCap === "number" &&
      Number.isFinite(options.elapsedRecoveryCap) &&
      options.elapsedRecoveryCap >= 1
        ? options.elapsedRecoveryCap
        : DEFAULT_ELAPSED_RECOVERY_CAP;
    // Soft-throttle gain must be non-negative and finite.
    this.softThrottleGain =
      typeof options.softThrottleGain === "number" &&
      Number.isFinite(options.softThrottleGain) &&
      options.softThrottleGain >= 0
        ? options.softThrottleGain
        : DEFAULT_SOFT_THROTTLE_GAIN;
    // maxIntervalMs defaults to Infinity so non-ChatGPT callers are unaffected.
    this.maxIntervalMs =
      typeof options.maxIntervalMs === "number" && Number.isFinite(options.maxIntervalMs) && options.maxIntervalMs > 0
        ? options.maxIntervalMs
        : Number.POSITIVE_INFINITY;
    // multiplicativeDecreaseFactor: the option is retained for backward compat
    // (callers may pass it; it is simply no longer used internally since the plain
    // throttle path now uses softThrottleGain). Not stored — no runtime need.
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
      // §10-D: cooldown-exempt recovery lane — leave interval AND lastSuccessAtMs
      // unchanged. A suppressed success is not a real recovery tick and must not
      // advance the elapsed-time baseline (which would compress future real ticks).
      return;
    }
    // Read the elapsed-based step BEFORE updating lastSuccessAtMs (additiveStepMs
    // reads lastSuccessAtMs; updating first would collapse elapsed to 0).
    const step = this.additiveStepMs();
    this._currentIntervalMs = Math.max(this.minIntervalMs, this._currentIntervalMs - step);
    this.lastSuccessAtMs = this.now();
  }

  /**
   * The additive-increase step (ms) to apply for the current interval. The base
   * `additiveIncreaseMs` is FLAT regardless of elapsed time — this preserves
   * gentle ceiling discovery (overBackoffMs ≈ 0 near the operating point). The
   * elapsed-time weight multiplies ONLY the `recoveryGain × overBackoffMs` term,
   * so a long inflated wait accelerates unwinding from deep transient spikes
   * without collapsing a near-ceiling interval to the floor in one step.
   * PURE: reads only, mutates nothing.
   */
  private additiveStepMs(): number {
    const overBackoffMs = Math.max(0, this._currentIntervalMs - this.initialIntervalMs);
    // Elapsed since the last real success tick. On the very first success (null)
    // treat elapsed as one normal-cadence interval (weight = 1, backward-compat).
    const elapsedMs =
      this.lastSuccessAtMs == null ? this.initialIntervalMs : Math.max(0, this.now() - this.lastSuccessAtMs);
    // Normalize by initialIntervalMs: one normal-cadence success → weight 1.
    // A long throttled wait → up to elapsedRecoveryCap× the over-backoff term.
    // The base step is NOT multiplied — it stays flat near the ceiling.
    const recoverWeight = Math.min(this.elapsedRecoveryCap, Math.max(1, elapsedMs / this.initialIntervalMs));
    // Floor to whole ms so intervals stay integer-valued (operator-legible logs
    // and an integer warm-start persisted value, matching the legacy flat step)
    // and no IEEE-754 drift accumulates. At/below the operating point
    // overBackoffMs is 0, so this is exactly `additiveIncreaseMs` — the gentle
    // base step — preserving cautious ceiling discovery regardless of elapsed time.
    return Math.floor(this.additiveIncreaseMs + this.recoveryGain * overBackoffMs * recoverWeight);
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
   * changing the sustained interval. A plain throttle (no retryAfterMs) applies
   * a bounded ×(1 + softThrottleGain) step (default 1.5×, inside the Leonardos
   * stable band) clamped to `maxIntervalMs` — that is the MAIMD signal for an
   * unquantified slow-down with bounded blast radius.
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
    // Plain throttle: bounded multiplicative step. Multiply by (1 + softThrottleGain)
    // instead of the old ÷multiplicativeDecreaseFactor (×2). Default softThrottleGain=0.5
    // gives a 1.5× step, inside the Leonardos stable band. Clamped to maxIntervalMs
    // to bound the blast radius of a burst of 429s. Never goes below initialIntervalMs.
    const increased = this._currentIntervalMs * (1 + this.softThrottleGain);
    this._currentIntervalMs = Math.min(this.maxIntervalMs, Math.max(this.initialIntervalMs, increased));
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
