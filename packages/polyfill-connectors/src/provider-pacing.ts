export interface PacingOptions {
  /** Additive increase step (ms) per successful response. Default: 100ms. */
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
    this.additiveIncreaseMs = options.additiveIncreaseMs ?? 100;
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
    this._currentIntervalMs = Math.max(this.minIntervalMs, this._currentIntervalMs - this.additiveIncreaseMs);
  }

  /**
   * Record a throttle signal — multiplicative decrease (increase interval, never below initialIntervalMs).
   * If `signal.retryAfterMs` is set, the next admit() will honor it exactly.
   */
  recordThrottle(signal?: ThrottleSignal): void {
    const reason: PacingBackoffReason = signal?.retryAfterMs == null ? "throttle" : "retry_after";
    if (signal?.retryAfterMs != null) {
      this.nextRetryAfterMs = signal.retryAfterMs;
    }
    // Multiplicative decrease: divide fill rate (multiply interval).
    const decreased = this._currentIntervalMs / this.multiplicativeDecreaseFactor;
    // Throttle never decreases the interval below initialIntervalMs (the
    // conservative baseline), so a single throttle bounces the rate back toward
    // the cold floor even when warm-start had restored a faster learned interval.
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
