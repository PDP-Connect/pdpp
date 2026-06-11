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
   * Minimum inter-request interval (ms). The floor the AIMD fill rate can
   * reach via additive increase. Defaults to 0 (no floor below initial).
   */
  minIntervalMs?: number;
  /** Multiplicative decrease factor on each throttle signal. E.g. 0.5 = halve fill rate (double interval). Default: 0.5. */
  multiplicativeDecreaseFactor?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /**
   * Warm-start seed: the interval the controller had LEARNED at the end of a
   * prior run, restored so the AIMD descent compounds across runs instead of
   * resetting to `initialIntervalMs` at every boundary. Clamped to never be
   * faster than `minIntervalMs` (the rate ceiling). Absent → cold start at
   * `initialIntervalMs`. The caller owns the staleness guard (deciding whether a
   * persisted interval is fresh enough to restore at all).
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
    // restored value is honored — it means the prior run had backed off). The
    // caller decides freshness (staleness guard) before passing a value here.
    this._currentIntervalMs =
      options.restoredIntervalMs == null
        ? this.initialIntervalMs
        : Math.max(this.minIntervalMs, options.restoredIntervalMs);
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

  /** Record a successful response — additive increase (reduce interval toward minIntervalMs). */
  recordSuccess(): void {
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
    };
  }
}
