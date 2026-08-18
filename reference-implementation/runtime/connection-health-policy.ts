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

/**
 * Maximum `backlog_open` count that a `blocked` heartbeat with zero dead
 * letters and zero pending records tolerates before it is treated as a
 * genuine state-read failure.
 *
 * A device-side "gap" outbox row is counted `backlog_open` while its status
 * is `ready`, `leased`, OR `succeeded` — for a gap row, `succeeded` means
 * "the gap NOTIFICATION uploaded fine", not "the gap is resolved" (see
 * `local-device-outbox.ts::countOpenGaps`). A failed collector attempt that
 * is immediately superseded by a successful one leaves exactly this kind of
 * debris: a handful of already-delivered notification rows that will never
 * be picked up again by a later `succeeded`/`healthy` heartbeat, because
 * nothing re-drains a `succeeded` row.
 *
 * Below this bound, a `blocked` heartbeat with no dead letters and no
 * pending work is read as stray notification debris from a superseded run,
 * not a broken exporter — the owner cannot act on "there is one stale row in
 * a local SQLite file," and the collection evidence (records, batches,
 * summary state) is the trustworthy signal here, not the heartbeat status
 * alone. At or above this bound, the same `blocked` heartbeat still reads as
 * `state_read_failed`: a large open-gap count is either a real stuck
 * exporter or a runaway debris accumulation, and both need the owner to
 * re-run the collector rather than being silently absorbed.
 */
export const OUTBOX_BLOCKED_BACKLOG_TOLERANCE = 3;
