// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Recency predicate for `run_history` time windows in the UAT verifier.
//
// Extracted from `uat-verify.mjs` so it can be tested hermetically: that script
// runs its checks at import time (docker exec + authenticated HTTP), so the
// predicate cannot be imported from there without executing the whole verifier.
//
// THE DEFECT THIS EXISTS TO PREVENT
//
// `run_history.started_at` is stored as an ISO-8601 string
// (`new Date().toISOString()`, e.g. `2026-08-10T01:08:57.334Z`), but SQLite's
// `datetime('now', ...)` renders a SPACE separator (`2026-08-10 13:32:47`).
// Comparing them with `>` is a LEXICOGRAPHIC string compare, and 'T' (0x54)
// sorts after ' ' (0x20) — so EVERY row sharing the current UTC date compares
// as "newer" regardless of how many hours old it actually is.
//
// That silently widened a 1-hour window to as much as ~24 hours and reported a
// long-dead condition as currently live: `scheduler.no-self-poisoning-skip-loop`
// FAILed on jellyfin skips 13.4h and 14.5h old while that connector's five most
// recent runs had all SUCCEEDED. Rows from EARLIER days compare correctly, which
// is why the bug reads as a plausible "still looping" result instead of an
// obvious always-fail.
//
// `julianday()` parses both formats into a numeric instant, making the
// comparison a real time comparison. Every recency window in the verifier must
// go through this helper.

/**
 * SQL fragment asserting `column` holds an instant within the last `hours`.
 *
 * @param {string} column - column holding an ISO-8601 or SQLite datetime string
 * @param {number} [hours] - window size in hours (default 1)
 * @returns {string} a SQL boolean expression
 */
export function withinLastHours(column, hours = 1) {
  return `julianday(${column}) > julianday('now','-${hours} hours')`;
}
