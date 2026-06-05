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
  initialIntervalMs: number;
  /**
   * Minimum inter-request interval (ms). The floor the AIMD fill rate can
   * reach via additive increase. Defaults to 0 (no floor below initial).
   */
  minIntervalMs?: number;
  /** Multiplicative decrease factor on each throttle signal. E.g. 0.5 = halve fill rate (double interval). Default: 0.5. */
  multiplicativeDecreaseFactor?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
  /** Injectable sleep for tests. Default: real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ThrottleSignal {
  /** If present, honor this delay exactly for the next admit() call. */
  retryAfterMs?: number;
}

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

  constructor(options: PacingOptions) {
    this.initialIntervalMs = options.initialIntervalMs;
    this.minIntervalMs = options.minIntervalMs ?? 0;
    this.burstToleranceMs = options.burstToleranceMs ?? 2 * options.initialIntervalMs;
    this.additiveIncreaseMs = options.additiveIncreaseMs ?? 100;
    this.multiplicativeDecreaseFactor = options.multiplicativeDecreaseFactor ?? 0.5;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this._currentIntervalMs = options.initialIntervalMs;
  }

  /**
   * Wait until the next request is admitted per the current fill rate.
   * Returns immediately if the token is already available.
   */
  async admit(): Promise<void> {
    const nowMs = this.now();

    // Honor a pending Retry-After override exactly.
    if (this.nextRetryAfterMs !== null) {
      const delay = this.nextRetryAfterMs;
      this.nextRetryAfterMs = null;
      this.tat = nowMs + delay;
      if (delay > 0) {
        await this.sleep(delay);
      }
      return;
    }

    if (this.tat === null) {
      // First call: anchor TAT so the first request waits one full interval.
      this.tat = nowMs + this._currentIntervalMs;
      await this.sleep(this._currentIntervalMs);
      return;
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
    if (signal?.retryAfterMs != null) {
      this.nextRetryAfterMs = signal.retryAfterMs;
    }
    // Multiplicative decrease: divide fill rate (multiply interval).
    const decreased = this._currentIntervalMs / this.multiplicativeDecreaseFactor;
    // Throttle never decreases the interval below initialIntervalMs.
    this._currentIntervalMs = Math.max(this.initialIntervalMs, decreased);
  }

  /** Current inter-request interval (ms) for observability and tests. */
  get currentIntervalMs(): number {
    return this._currentIntervalMs;
  }
}
