/**
 * Shared policy constants for the connection-health evidence model.
 *
 * Keep these separate from the projection implementation so scheduler,
 * runtime, and tests can share policy without importing a legacy UI
 * classifier or reimplementing health-state decisions.
 */

/**
 * Number of consecutive same-class failures at which retry/backoff is treated
 * as blocked rather than merely cooling off.
 */
export const BLOCKED_PROMOTION_THRESHOLD = 7;
