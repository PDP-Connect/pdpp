// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export interface RunBudgetOptions {
  /** Max provider requests this run may make. Default: no cap. */
  maxRequests?: number;
  /** Max wall-clock ms for the run. Checked between requests, not mid-request. Default: no cap. */
  maxWallClockMs?: number;
  /** Injectable clock for tests. Default: Date.now. */
  now?: () => number;
}

export type RunBudgetTrip = "max_requests" | "max_wall_clock";

/**
 * Connector-agnostic per-run cap on provider requests and wall-clock time.
 * Either cap at Infinity (the default) is simply never the reason a run stops.
 * The wall-clock is lazily anchored on the first `tripReason()` call so idle
 * setup time is not charged.
 */
export class RunBudget {
  readonly maxRequests: number;
  readonly maxWallClockMs: number;
  private readonly now: () => number;
  private requestCount = 0;
  private startedAt: number | null = null;

  constructor(options: RunBudgetOptions = {}) {
    this.maxRequests = options.maxRequests ?? Number.POSITIVE_INFINITY;
    this.maxWallClockMs = options.maxWallClockMs ?? Number.POSITIVE_INFINITY;
    this.now = options.now ?? Date.now;
  }

  /** Call once per admitted provider request. */
  recordRequest(): void {
    this.requestCount += 1;
  }

  get count(): number {
    return this.requestCount;
  }

  /** Wall-clock elapsed since first tripReason() call, in ms. */
  elapsedMs(): number {
    if (this.startedAt == null) {
      return 0;
    }
    return Math.max(0, this.now() - this.startedAt);
  }

  /**
   * Wall-clock budget still available before the time cap trips, in ms.
   * `Infinity` when no wall-clock cap is configured. Anchors the clock on first
   * consult (same lazy start as `tripReason()`), so a caller that asks
   * "how long may I wait?" before any request gets the full budget, not zero.
   * Never negative — clamped at 0 once the cap is reached. Lets a transient
   * back-off (e.g. waiting out an open circuit) bound its sleep by the time the
   * run genuinely has left, instead of conflating "provider is pushing back"
   * with "we are out of budget".
   */
  remainingWallClockMs(): number {
    if (this.maxWallClockMs === Number.POSITIVE_INFINITY) {
      return Number.POSITIVE_INFINITY;
    }
    if (this.startedAt == null) {
      this.startedAt = this.now();
    }
    return Math.max(0, this.maxWallClockMs - this.elapsedMs());
  }

  /**
   * Returns the trip reason or null. Lazily anchors the clock on first call
   * so idle time before the active phase is not charged.
   * Request cap takes priority when both caps trip simultaneously.
   */
  tripReason(): RunBudgetTrip | null {
    if (this.startedAt == null) {
      this.startedAt = this.now();
    }
    if (this.requestCount >= this.maxRequests) {
      return "max_requests";
    }
    if (this.maxWallClockMs !== Number.POSITIVE_INFINITY && this.elapsedMs() >= this.maxWallClockMs) {
      return "max_wall_clock";
    }
    return null;
  }

  /** True once any cap has been reached. */
  shouldStop(): boolean {
    return this.tripReason() !== null;
  }
}
