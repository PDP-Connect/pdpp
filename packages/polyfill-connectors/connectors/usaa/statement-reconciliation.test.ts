// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the USAA `transactions` stream.
 *
 * The anchor is USAA's own printed period totals. Every line shape asserted
 * here was taken verbatim from this owner's real statement PDFs (extracted
 * via the connector's own `extractStatementPdfTextAndPages`), not invented —
 * including the summary row that caused the live defect:
 *
 *     "02/04 Ending Balance -- -- $33,821.48"
 *
 * which the modern-era transaction regex matched, storing a $33,821.48
 * closing BALANCE as a transaction AMOUNT. Fourteen such rows reached this
 * owner's `transactions` stream, the most recent three days before these
 * tests were written.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModernCheckingEra } from "./parsers.ts";
import {
  buildReconciliationDiagnostics,
  currencyToCents,
  extractPeriodBalances,
  isStatementSummaryDescription,
  reconcileStatementPeriod,
} from "./statement-reconciliation.ts";
import type { ParsedStatementTxn } from "./types.ts";

function txn(amount: number, description = "MERCHANT"): ParsedStatementTxn {
  return { iso: "2026-02-01", amount, description, balance: null, tupleKey: `k${amount}`, ord: 0 };
}

/** The real header + summary shape of a USAA checking statement, verbatim
 *  from 2026-02 (account ...hVAG), with the transaction body elided. */
const REAL_CHECKING_HEADER = [
  "Statement Period: 01/03/2026 to 02/04/2026",
  "Beginning Balance $38,586.78",
  "Ending Balance $33,821.48",
].join("\n");

// ─── isStatementSummaryDescription: the guard that stops the corruption ──

test("isStatementSummaryDescription rejects the real Ending Balance summary row", () => {
  // Verbatim from the 2026-02 statement, post-regex description capture.
  assert.equal(isStatementSummaryDescription("Ending Balance -- --"), true);
});

test("isStatementSummaryDescription rejects the real Beginning Balance summary row", () => {
  assert.equal(isStatementSummaryDescription("Beginning Balance 0 0"), true);
});

test("isStatementSummaryDescription is case- and whitespace-insensitive", () => {
  assert.equal(isStatementSummaryDescription("  ending   balance -- --"), true);
  assert.equal(isStatementSummaryDescription("ENDING BALANCE"), true);
});

test("isStatementSummaryDescription keeps a merchant that merely mentions the words", () => {
  // A real transaction must not be dropped because its description contains
  // the phrase later in the string. The match is anchored at the start.
  assert.equal(isStatementSummaryDescription("PAYMENT FOR ENDING BALANCE SERVICES"), false);
  assert.equal(isStatementSummaryDescription("BALANCE ENDING LLC"), false);
});

test("isStatementSummaryDescription keeps ordinary merchants", () => {
  assert.equal(isStatementSummaryDescription("2469216GFBND9G02E AMAZON MKTPL"), false);
  assert.equal(isStatementSummaryDescription("ACH WITHDRAWAL 012026"), false);
});

// ─── The parser no longer emits summary rows as transactions ─────────────

test("parseModernCheckingEra drops the summary row that produced the live defect", () => {
  // This is the exact table shape from the 2026-02 statement: a real
  // one-line transaction plus the two summary rows.
  const text = [
    "Transactions",
    "Date Description Debits Credits Balance",
    "01/03 Beginning Balance 0 0",
    "01/20 ACH WITHDRAWAL PREAUTHDFT $152.05",
    "02/04 Ending Balance -- -- $33,821.48",
    "ENDING BALANCE",
  ].join("\n");
  const txns = parseModernCheckingEra(text, { closing: { closingMonth: 2, closingYear: 2026 } });
  const descriptions = txns.map((t) => t.description);
  assert.deepEqual(descriptions, ["ACH WITHDRAWAL PREAUTHDFT"]);
  // The specific corruption: the closing balance must never appear as an amount.
  assert.equal(
    txns.some((t) => t.amount === 3_382_148),
    false,
    "closing balance leaked into transactions as an amount"
  );
});

// ─── currencyToCents ─────────────────────────────────────────────────────

test("currencyToCents parses the real balance figures", () => {
  assert.equal(currencyToCents("$33,821.48"), 3_382_148);
  assert.equal(currencyToCents("$648.10"), 64_810);
  assert.equal(currencyToCents("-$8.65"), -865);
});

test("currencyToCents refuses malformed currency rather than coercing it", () => {
  // A malformed summary must yield "no anchor", never a wrong anchor.
  assert.equal(currencyToCents("--"), null);
  assert.equal(currencyToCents("$12"), null);
  assert.equal(currencyToCents(""), null);
  assert.equal(currencyToCents("abc"), null);
});

// ─── extractPeriodBalances: fail closed, never fabricate ─────────────────

test("extractPeriodBalances reads the real statement summary", () => {
  assert.deepEqual(extractPeriodBalances(REAL_CHECKING_HEADER), {
    beginningCents: 3_858_678,
    endingCents: 3_382_148,
  });
});

test("extractPeriodBalances returns null when the era prints no summary", () => {
  // The real credit-card era: a closing DATE but no balance summary. This is
  // the "no sound anchor" case and must not be papered over.
  assert.equal(extractPeriodBalances("Statement Closing Date 01/20/26\nTransactions"), null);
});

test("extractPeriodBalances requires BOTH balances", () => {
  // One without the other proves nothing about a period.
  assert.equal(extractPeriodBalances("Beginning Balance $100.00"), null);
  assert.equal(extractPeriodBalances("Ending Balance $100.00"), null);
});

test("extractPeriodBalances ignores an in-table row rather than misreading it", () => {
  // "02/04 Ending Balance -- -- $33,821.48" is NOT the standalone summary;
  // the anchored regex must not accept it, or a statement could be anchored
  // against a row the parser also treats as data.
  assert.equal(extractPeriodBalances("02/04 Ending Balance -- -- $33,821.48\n01/03 Beginning Balance 0 0"), null);
});

// ─── reconcileStatementPeriod: the anchor itself ─────────────────────────

test("reconcileStatementPeriod confirms a period whose transactions close the balance", () => {
  // -476,530 cents is the real 2026-02 delta (38,586.78 -> 33,821.48).
  const result = reconcileStatementPeriod(REAL_CHECKING_HEADER, [txn(-400_000), txn(-76_530)]);
  assert.equal(result.status, "reconciled");
  assert.equal(result.status === "reconciled" && result.expectedDeltaCents, -476_530);
  assert.equal(result.status === "reconciled" && result.observedDeltaCents, -476_530);
});

test("reconcileStatementPeriod catches a MISSING transaction", () => {
  // The whole point of the anchor: drop one and the identity fails.
  const result = reconcileStatementPeriod(REAL_CHECKING_HEADER, [txn(-400_000)]);
  assert.equal(result.status, "mismatched");
  assert.equal(result.status === "mismatched" && result.differenceCents, -76_530);
});

test("reconcileStatementPeriod catches an INVENTED transaction", () => {
  // An equality check detects fabrication as surely as loss — a shortfall
  // check would not.
  const result = reconcileStatementPeriod(REAL_CHECKING_HEADER, [txn(-400_000), txn(-76_530), txn(-1000)]);
  assert.equal(result.status, "mismatched");
  assert.equal(result.status === "mismatched" && result.differenceCents, 1000);
});

test("reconcileStatementPeriod flags the real multi-line parse failure", () => {
  // This is this owner's ACTUAL live state: the checking-era table wraps
  // each transaction across several lines, so the line-oriented parser
  // extracts ZERO real transactions while the balance genuinely moved.
  // A zero-transaction period must NOT be auto-passed.
  const result = reconcileStatementPeriod(REAL_CHECKING_HEADER, []);
  assert.equal(result.status, "mismatched");
  assert.equal(result.status === "mismatched" && result.differenceCents, -476_530);
});

test("reconcileStatementPeriod accepts a genuinely still period", () => {
  // Zero transactions AND no balance movement is a real, complete period.
  const still = "Beginning Balance $100.00\nEnding Balance $100.00";
  assert.equal(reconcileStatementPeriod(still, []).status, "reconciled");
});

test("reconcileStatementPeriod excludes summary rows from the sum", () => {
  // Were a summary row to reach the sum, it would add the closing balance
  // and break the identity on every statement.
  const result = reconcileStatementPeriod(REAL_CHECKING_HEADER, [
    txn(-476_530),
    txn(3_382_148, "Ending Balance -- --"),
    txn(0, "Beginning Balance 0 0"),
  ]);
  assert.equal(result.status, "reconciled");
});

test("reconcileStatementPeriod reports unavailable when no anchor exists", () => {
  // "Cannot check" must stay distinct from "checked and wrong".
  const result = reconcileStatementPeriod("Statement Closing Date 01/20/26", [txn(-100)]);
  assert.equal(result.status, "unavailable");
  assert.equal(result.status === "unavailable" && result.reason, "no_period_balances");
});

// ─── Diagnostics stay redacted ───────────────────────────────────────────

test("buildReconciliationDiagnostics emits only integers and the opaque id", () => {
  const result = reconcileStatementPeriod(REAL_CHECKING_HEADER, [txn(-400_000, "AMAZON MKTPL SECRET")]);
  assert.equal(result.status, "mismatched");
  if (result.status !== "mismatched") {
    return;
  }
  const diag = buildReconciliationDiagnostics("abc123", result);
  assert.deepEqual(Object.keys(diag).sort(), [
    "difference_cents",
    "expected_delta_cents",
    "observed_delta_cents",
    "statement_id",
  ]);
  // No merchant text may ride along in the diagnostic.
  assert.equal(JSON.stringify(diag).includes("AMAZON"), false);
});
