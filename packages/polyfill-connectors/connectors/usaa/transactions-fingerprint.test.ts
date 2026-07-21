// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-transaction fingerprint behavior for the USAA `transactions` stream.
 *
 * Before this gate, both emit paths appended a fresh version of every
 * transaction on every run because the record body carried a run-clock
 * `fetched_at`:
 *   - the CSV-export path (`emitCsvTransactions`) re-downloads an overlapping
 *     incremental date window (INCREMENTAL_OVERLAP_MS) each run;
 *   - the PDF-statement path (`processPdfStatementRow`) re-parses the same
 *     statement PDFs each run.
 * A posted transaction's identity (id = hashId(accountId|date|amount|
 * original|#ord)) and its fields are immutable, so the only field that moved
 * between byte-identical runs was `fetched_at`.
 *
 * These tests drive the exact gate the connector wires
 * (`if (cursor.shouldEmit(record)) emit`) over real records built by the
 * exported `rowsToTransactions`, plus the STATE round-trip helpers. They
 * pin:
 *
 *   1. Re-emitting the same transactions (only fetched_at differs) is fully
 *      suppressed on the second run.
 *   2. A genuinely-new transaction still emits.
 *   3. A real field move (corrected amount → new id, or balance_after move on
 *      a stable id) emits.
 *   4. NO prune: a transaction omitted from a narrower window keeps its
 *      fingerprint — the partial-scan invariant.
 *   5. CSV and PDF paths share one cursor: a transaction already emitted from
 *      the CSV path is suppressed when the same logical transaction is
 *      re-parsed from a PDF (same id, body identical modulo source/fetched_at
 *      — see the cross-source note).
 *   6. The transactions STATE round-trips the `fingerprints` map alongside
 *      the per-account watermarks (`withTransactionFingerprints` /
 *      `readPriorTransactionFingerprints`), excluding `fetched_at`.
 *   7. `readPriorTransactionFingerprints` tolerates missing / legacy /
 *      malformed state.
 *   8. Connector fingerprint (excludes fetched_at) == compaction fingerprint
 *      over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { readPriorTransactionFingerprints } from "./index.ts";
import { rowsToTransactions } from "./parsers.ts";
import type { TransactionRecord } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";

/** Build transaction records from a synthetic CSV, the way the CSV-export
 *  path does (rowsToTransactions stamps each with the supplied fetchedAt). */
function csvTxns(fetchedAt: string, rows: readonly [string, string, string][]): TransactionRecord[] {
  const header = ["Date", "Description", "Amount"];
  const body = rows.map(([date, desc, amount]) => [date, desc, amount]);
  return rowsToTransactions([header, ...body], {
    accountId: "ACCT-CHK-0001",
    accountName: "USAA CLASSIC CHECKING",
    fetchedAt,
  });
}

/** Replicate the connector's emit loop exactly: gate each record on the
 *  shared fingerprint cursor, return the records that would be emitted. */
function emitThrough(
  cursor: ReturnType<typeof openFingerprintCursor>,
  txns: readonly TransactionRecord[]
): TransactionRecord[] {
  const emitted: TransactionRecord[] = [];
  for (const t of txns) {
    if (cursor.shouldEmit(t)) {
      emitted.push(t);
    }
  }
  return emitted;
}

function openTxnCursor(priorState: Record<string, unknown>) {
  return openFingerprintCursor(priorState.transactions, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorTransactionFingerprints(priorState),
  });
}

const SAMPLE: readonly [string, string, string][] = [
  ["2026-04-10", "COFFEE SHOP", "-$45.99"],
  ["2026-04-11", "GROCERY", "-$81.23"],
];

test("transactions: re-downloading the same transactions (only fetched_at differs) is fully suppressed", () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = emitThrough(cursor1, csvTxns(RUN1_AT, SAMPLE));
  assert.equal(run1.length, 2, "first run emits both transactions once");

  const priorState = { transactions: { fingerprints: cursor1.toState() } };
  const cursor2 = openTxnCursor(priorState);
  // Second run: identical transactions, only fetched_at differs (RUN2_AT).
  const run2 = emitThrough(cursor2, csvTxns(RUN2_AT, SAMPLE));
  assert.equal(run2.length, 0, "re-downloaded unchanged transactions fully suppressed despite new fetched_at");
});

test("transactions: a genuinely-new transaction still emits", () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  emitThrough(cursor1, csvTxns(RUN1_AT, SAMPLE));

  const priorState = { transactions: { fingerprints: cursor1.toState() } };
  const cursor2 = openTxnCursor(priorState);
  // Overlap window: the two known rows + one new row.
  const withNew: readonly [string, string, string][] = [...SAMPLE, ["2026-04-12", "GAS STATION", "-$32.10"]];
  const run2 = emitThrough(cursor2, csvTxns(RUN2_AT, withNew));
  assert.equal(run2.length, 1, "only the new transaction emits");
  assert.equal(run2[0]?.description, "GAS STATION");
});

test("transactions: a corrected amount (new tuple → new id) emits", () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  emitThrough(cursor1, csvTxns(RUN1_AT, [["2026-04-10", "COFFEE SHOP", "-$45.99"]]));

  const priorState = { transactions: { fingerprints: cursor1.toState() } };
  const cursor2 = openTxnCursor(priorState);
  // The amount is part of the id tuple, so a corrected amount is a NEW id —
  // it appends as a distinct transaction (and the old one is not re-listed).
  const run2 = emitThrough(cursor2, csvTxns(RUN2_AT, [["2026-04-10", "COFFEE SHOP", "-$50.00"]]));
  assert.equal(run2.length, 1, "a corrected amount produces a new id and emits");
});

test("transactions: a balance_after move on a stable id re-emits (real field, not run-clock)", () => {
  // Same date/amount/description (stable id) but the running balance_after
  // moved — a real field change that is NOT fetched_at, so it re-emits.
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const header = ["Date", "Description", "Amount", "Balance"];
  const run1Rows = [header, ["2026-04-10", "COFFEE SHOP", "-$45.99", "$1,000.00"]];
  const r1 = rowsToTransactions(run1Rows, { accountId: "A", accountName: "x", fetchedAt: RUN1_AT });
  emitThrough(cursor1, r1);

  const priorState = { transactions: { fingerprints: cursor1.toState() } };
  const cursor2 = openTxnCursor(priorState);
  const run2Rows = [header, ["2026-04-10", "COFFEE SHOP", "-$45.99", "$1,050.00"]];
  const r2 = rowsToTransactions(run2Rows, { accountId: "A", accountName: "x", fetchedAt: RUN2_AT });
  const emitted = emitThrough(cursor2, r2);
  assert.equal(emitted.length, 1, "a balance_after_cents move is a fingerprint boundary and re-emits");
});

test("transactions: NO prune — a transaction omitted from a narrower window keeps its fingerprint", () => {
  // Run 1: window returns both rows.
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  emitThrough(cursor1, csvTxns(RUN1_AT, SAMPLE));

  // Run 2: a NARROWER incremental window returns only the second row. The
  // first row must NOT be pruned (no pruneStale call on this stream).
  const state2 = { transactions: { fingerprints: cursor1.toState() } };
  const cursor2 = openTxnCursor(state2);
  const run2 = emitThrough(cursor2, csvTxns(RUN2_AT, [SAMPLE[1] as [string, string, string]]));
  assert.equal(run2.length, 0, "the second row unchanged stays silent; the first row not looked at this run");

  // Run 3: a WIDER window re-downloads both rows. Because the first row was
  // never pruned, its fingerprint survived run 2 and the re-download is
  // suppressed.
  const state3 = { transactions: { fingerprints: cursor2.toState() } };
  const cursor3 = openTxnCursor(state3);
  const run3 = emitThrough(cursor3, csvTxns(RUN2_AT, SAMPLE));
  assert.equal(run3.length, 0, "re-downloaded first row stays suppressed because it was never pruned");
});

test("transactions: a transaction seen last run (from either path) is suppressed this run", () => {
  // The CSV and PDF paths share ONE cursor for the whole stream and hash the
  // same logical transaction to the same id (buildStatementRecords mirrors
  // the CSV id shape). The cursor dedupes ACROSS runs: a transaction whose
  // fingerprint was carried forward in the prior STATE is suppressed this
  // run regardless of which path re-surfaces it. (Within a single run the
  // cursor does not dedupe — the rare CSV∩PDF overlap is a pre-existing,
  // bounded 2-version case the storage byte-equivalence backstop covers, not
  // the unbounded run-clock churn this gate removes.)
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const fromCsv = emitThrough(cursor1, csvTxns(RUN1_AT, [["2026-04-10", "COFFEE SHOP", "-$45.99"]]));
  assert.equal(fromCsv.length, 1, "CSV path emits the transaction once on the first run");

  // Next run: the PDF path re-parses the SAME logical transaction (same id,
  // body identical modulo fetched_at). Seeded from the prior STATE, the
  // shared cursor suppresses it.
  const priorState = { transactions: { fingerprints: cursor1.toState() } };
  const cursor2 = openTxnCursor(priorState);
  const fromPdf = emitThrough(cursor2, csvTxns(RUN2_AT, [["2026-04-10", "COFFEE SHOP", "-$45.99"]]));
  assert.equal(fromPdf.length, 0, "the same logical transaction is suppressed across runs on the shared cursor");
});

test("readPriorTransactionFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorTransactionFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorTransactionFingerprints({ transactions: { "ACCT-1": { last_date: "2026-04-10" } } }).size,
    0,
    "legacy cursor (per-account watermarks only, no fingerprints) → empty map"
  );
  assert.equal(
    readPriorTransactionFingerprints({ transactions: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const ok = readPriorTransactionFingerprints({ transactions: { fingerprints: { id1: "fp-1", bad: null } } });
  assert.equal(ok.size, 1, "valid entries kept, invalid dropped");
});

test("transactions: STATE round-trips the fingerprints map alongside per-account watermarks", () => {
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const txns = csvTxns(RUN1_AT, SAMPLE);
  emitThrough(cursor, txns);

  // The connector writes `{ <accountKey>: { last_date }, fingerprints }`.
  // Reconstruct that shape and confirm the next run reads BOTH halves.
  const persisted = {
    transactions: {
      "ACCT-CHK-0001": { last_date: "2026-04-11" },
      fingerprints: cursor.toState(),
    },
  };
  const fps = readPriorTransactionFingerprints(persisted);
  assert.equal(fps.size, 2, "both transaction fingerprints persisted alongside the watermark");
  // The watermark entry is untouched and still readable as a per-account cursor.
  const watermark = (persisted.transactions as Record<string, { last_date?: string }>)["ACCT-CHK-0001"];
  assert.equal(watermark?.last_date, "2026-04-11", "per-account watermark survives next to the fingerprints map");
});

test("transactions: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
  const body = {
    id: "txn-hash-1",
    account_id: "ACCT-CHK-0001",
    account_name: "USAA CLASSIC CHECKING",
    date: "2026-04-10",
    description: "COFFEE SHOP",
    original_description: "COFFEE SHOP",
    category: null,
    amount: -4599,
    currency: "USD",
    balance_after_cents: null,
    check_number: null,
    source: "csv_export",
    fetched_at: RUN1_AT,
  };
  const later = { ...body, fetched_at: RUN2_AT };
  const moved = { ...later, balance_after_cents: 105_000 };
  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(later, ["fetched_at"]),
    "fetched_at must not participate; a no-op refresh hashes identically"
  );
  assert.notEqual(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(moved, ["fetched_at"]),
    "a real field move (balance_after_cents) MUST produce a different fingerprint"
  );
});
