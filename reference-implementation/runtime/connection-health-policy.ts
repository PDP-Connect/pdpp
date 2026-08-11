// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

/**
 * Age of the oldest still-pending outbox row (by `created_at`, never reset
 * by a retry) at which a fresh-heartbeat retrying/active outbox is treated
 * as a stalled backlog rather than healthy in-flight work. Distinct from
 * `OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS`: that constant detects a collector
 * that stopped checking in; this one detects a collector that keeps
 * checking in and keeps retrying the same row without ever draining it
 * (e.g. explicit-transient classification retrying an endpoint that is
 * actually permanently broken, not transiently backed off).
 */
export const OUTBOX_STALE_PENDING_BACKLOG_AGE_MS = 24 * 60 * 60 * 1000;
