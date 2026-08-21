// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the two cursor defects that let Chase collection stall silently.
 *
 * 1. `chooseActivity` picked "Since last statement" whenever a cursor
 *    existed, with no check that the cursor was recent enough for that
 *    option's window to reach it. Chase's "Since last statement" covers the
 *    current cycle only (~30 days), so once a cursor fell behind, every
 *    scheduled run downloaded a QFX, saw nothing older, and reported
 *    success — no run could ever reach back across the gap.
 *
 * 2. `per_account` cursors were carried forward wholesale, so an account
 *    that disappeared from `discoverAccounts()` kept its cursor forever and
 *    was skipped silently with no gap emitted.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseActivity, cursorAgeInDays, prunePerAccountCursors } from "./parsers.ts";
import type { TransactionCursor, TransactionsStateShape } from "./types.ts";

const ACCOUNT = "acct-1";
const RUN_DATE = "2026-08-20";

function stateWithCursor(maxSeenDate: string): TransactionsStateShape {
  return { per_account: { [ACCOUNT]: { max_seen_date: maxSeenDate } as TransactionCursor } };
}

// ─── cursorAgeInDays ─────────────────────────────────────────────────────

test("cursorAgeInDays measures whole days between cursor and run date", () => {
  assert.equal(cursorAgeInDays("2026-08-10", RUN_DATE), 10);
  assert.equal(cursorAgeInDays("2026-08-20", RUN_DATE), 0);
});

test("cursorAgeInDays tolerates a full ISO timestamp", () => {
  assert.equal(cursorAgeInDays("2026-08-10T12:34:56Z", RUN_DATE), 10);
});

test("cursorAgeInDays returns null for an unparseable date", () => {
  // Must NOT read as fresh — the caller takes the safe path on null.
  assert.equal(cursorAgeInDays("not-a-date", RUN_DATE), null);
  assert.equal(cursorAgeInDays("", RUN_DATE), null);
});

// ─── chooseActivity: an explicit scope still wins ────────────────────────

test("chooseActivity honours an explicit time_range over any cursor", () => {
  const requested = new Map([["transactions", { time_range: { since: "2026-05-01", until: "2026-07-31" } }]]);
  const choice = chooseActivity(requested, stateWithCursor("2026-08-19"), "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "date_range");
  assert.deepEqual(choice.dateRange, { from: "2026-05-01", to: "2026-07-31" });
});

test("chooseActivity bootstraps with 'all' when there is no cursor", () => {
  const choice = chooseActivity(new Map(), {}, "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "all");
});

// ─── chooseActivity: the staleness fix ───────────────────────────────────

test("chooseActivity uses 'since_last_statement' for a FRESH cursor", () => {
  // The incremental fast path must still work — this is the common case.
  const choice = chooseActivity(new Map(), stateWithCursor("2026-08-19"), "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "since_last_statement");
});

test("chooseActivity still uses 'since_last_statement' at the freshness edge", () => {
  // 25 days: the last age that is still considered fresh.
  const choice = chooseActivity(new Map(), stateWithCursor("2026-07-26"), "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "since_last_statement");
});

test("chooseActivity falls back to a bounded date_range for a STALE cursor", () => {
  // This is the defect: a 90-day-old cursor previously still produced
  // "since_last_statement", whose window could not reach it, so the gap
  // between them was never re-downloaded by any scheduled run.
  const choice = chooseActivity(new Map(), stateWithCursor("2026-05-22"), "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "date_range");
  assert.deepEqual(choice.dateRange, { from: "2026-05-22", to: RUN_DATE });
});

test("chooseActivity date_range starts AT the cursor, keeping a safe overlap", () => {
  const choice = chooseActivity(new Map(), stateWithCursor("2026-01-15"), "transactions", ACCOUNT, RUN_DATE);
  // Starting at (not after) the cursor re-sees one day; stable transaction
  // ids make that a suppression, not a duplicate.
  assert.equal(choice.dateRange?.from, "2026-01-15");
});

test("chooseActivity treats an unparseable cursor as unprovable, not fresh", () => {
  const choice = chooseActivity(new Map(), stateWithCursor("garbage"), "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "date_range");
});

test("chooseActivity treats a future-dated cursor as unprovable", () => {
  // Clock skew must not be read as maximally fresh.
  const choice = chooseActivity(new Map(), stateWithCursor("2027-01-01"), "transactions", ACCOUNT, RUN_DATE);
  assert.equal(choice.activity, "date_range");
});

// ─── prunePerAccountCursors ──────────────────────────────────────────────

const CURSORS: Record<string, TransactionCursor> = {
  "acct-1": { max_seen_date: "2026-08-19" } as TransactionCursor,
  "acct-2": { max_seen_date: "2026-08-18" } as TransactionCursor,
  "acct-gone": { max_seen_date: "2025-01-01" } as TransactionCursor,
};

test("prunePerAccountCursors drops cursors for undiscovered accounts", () => {
  const { kept, dropped } = prunePerAccountCursors(CURSORS, new Set(["acct-1", "acct-2"]));
  assert.deepEqual(Object.keys(kept).sort(), ["acct-1", "acct-2"]);
  assert.deepEqual(dropped, ["acct-gone"]);
});

test("prunePerAccountCursors keeps every cursor when all accounts are present", () => {
  const { kept, dropped } = prunePerAccountCursors(CURSORS, new Set(["acct-1", "acct-2", "acct-gone"]));
  assert.deepEqual(Object.keys(kept).sort(), ["acct-1", "acct-2", "acct-gone"]);
  assert.deepEqual(dropped, []);
});

test("prunePerAccountCursors reports the drop rather than swallowing it", () => {
  // The orphaned cursor must be VISIBLE: a vanished account may be a closed
  // account or a discovery regression, and silently dropping it hides both.
  const { dropped } = prunePerAccountCursors(CURSORS, new Set(["acct-1"]));
  assert.deepEqual(
    [...dropped].sort((a, b) => a.localeCompare(b)),
    ["acct-2", "acct-gone"]
  );
});

test("prunePerAccountCursors handles an empty cursor map", () => {
  const { kept, dropped } = prunePerAccountCursors({}, new Set(["acct-1"]));
  assert.deepEqual(kept, {});
  assert.deepEqual(dropped, []);
});
