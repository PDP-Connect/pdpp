// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Per-run detail-coverage evidence for the USAA `inbox_messages` stream.
//
// `inbox_messages` is `checkpoint_window`: the connector re-scans the inbox
// page in full every run and suppresses byte-identical rows via a fingerprint
// cursor, so `collected` is a changed-row count, not a coverage numerator. A
// measured `considered` boundary (every row the page listed) plus an
// objective `covered` accounting (rows the run actually resolved into a
// record, whether emitted or suppressed-as-unchanged) is what proves
// coverage — never the raw row count alone, because `buildInboxMessageRecord`
// drops a row whose date could not be parsed, and a dropped row must NOT
// silently inflate `covered`.
//
// Kept as a pure, dependency-free leaf (mirrors statement-coverage.ts) so the
// considered/covered arithmetic is unit-testable without a live Playwright
// Page or its real scrape delays.

/** One inbox row the page listed, already resolved to whether it produced a
 *  record (`buildInboxMessageRecord` returned non-null) — passed in so this
 *  module never imports the connector's own parsing or `index.ts`. */
export interface InboxCoverageRow {
  resolved: boolean;
}

export interface InboxCoverageResult {
  considered: number;
  covered: number;
}

/** Compute the inbox `considered`/`covered` pair from the resolved rows.
 *  `considered` is every row the enumeration saw; `covered` counts only rows
 *  that resolved into a record (emitted or suppressed-unchanged — the caller
 *  does not need to distinguish those two here, since both are "accounted
 *  for"). A row that failed to resolve (unparseable date) lowers `covered`
 *  below `considered`, so the caller reads an honest `partial`, not a false
 *  `complete`. `rows.length === 0` (a genuinely empty inbox) still returns
 *  `{ considered: 0, covered: 0 }` — verified-empty, not unmeasured. */
export function computeInboxCoverage(rows: readonly InboxCoverageRow[]): InboxCoverageResult {
  let covered = 0;
  for (const row of rows) {
    if (row.resolved) {
      covered += 1;
    }
  }
  return { considered: rows.length, covered };
}
