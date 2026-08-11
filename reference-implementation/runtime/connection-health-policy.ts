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
 * Age of the oldest outbox row that has actually failed at least once
 * (`attempt_count > 0`, by `created_at`, never reset by a retry) at which a
 * fresh-heartbeat retrying/active outbox is treated as a stalled backlog
 * rather than healthy in-flight work. Keyed on real retry evidence, not
 * merely "ready" — a large healthy first drain enqueues rows that sit ready
 * for hours before their first attempt without ever failing, and an
 * age policy over the oldest-ready timestamp alone would falsely degrade
 * that in-progress, never-failed backlog. Distinct from
 * `OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS`: that constant detects a collector
 * that stopped checking in; this one detects a collector that keeps
 * checking in and keeps retrying the same failed row without ever
 * draining it (e.g. explicit-transient classification retrying an
 * endpoint that is actually permanently broken, not transiently backed
 * off).
 */
export const OUTBOX_STALE_RETRYING_BACKLOG_AGE_MS = 24 * 60 * 60 * 1000;
