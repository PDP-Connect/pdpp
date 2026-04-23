import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BACKFILL_17MO,
  buildAccountRecord,
  buildCandidateStarts,
  buildCreditCardBillingRecord,
  buildInboxMessageRecord,
  checkNumberFromDescription,
  currencyToCents,
  currencyToCentsFromStatement,
  detectStatementClosing,
  detectStatementYear,
  fileUrlForPath,
  hashId,
  INCREMENTAL_OVERLAP_MS,
  isoDate,
  mmddyyyy,
  parseCreditCardEra,
  parseCsv,
  parseModernCheckingEra,
  resolveAccountIdForRef,
  rowsToTransactions,
  safeAccountSlug,
  sha256Hex,
  toIso,
  yearMonthFromDate,
} from "./parsers.ts";
import type { BillingKv, DashboardAccount, InboxRow, StatementClosing } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");
const LOCAL_RAW_DIR = join(__dirname, "..", "..", "fixtures", "usaa", "raw");

function readFixture(relPath: string): string {
  return readFileSync(join(FIXTURE_DIR, relPath), "utf8");
}

function latestLocalRawDir(): string | null {
  if (!existsSync(LOCAL_RAW_DIR)) {
    return null;
  }
  try {
    const candidates = readdirSync(LOCAL_RAW_DIR)
      .map((name) => join(LOCAL_RAW_DIR, name))
      .filter((p) => existsSync(p) && statSync(p).isDirectory())
      .sort();
    return candidates.at(-1) ?? null;
  } catch {
    return null;
  }
}

// ─── hashId / sha256Hex ──────────────────────────────────────────────────

test("sha256Hex: matches known digest for ASCII buffer", () => {
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("hashId: deterministic 32-char prefix of sha256", () => {
  const h = hashId("abc");
  assert.equal(h.length, 32);
  assert.equal(h, "ba7816bf8f01cfea414140de5dae2223");
});

// ─── safeAccountSlug ─────────────────────────────────────────────────────

test("safeAccountSlug: safe ASCII id returned as-is", () => {
  assert.equal(safeAccountSlug("123456789", null), "123456789");
  assert.equal(safeAccountSlug("acct_abc-def", null), "acct_abc-def");
});

test("safeAccountSlug: unsafe id is hashed to 16-char hex", () => {
  const slug = safeAccountSlug("bad/slash", null);
  assert.equal(slug.length, 16);
  assert.match(slug, /^[0-9a-f]{16}$/);
});

test("safeAccountSlug: null accountId falls through to fallback / unknown", () => {
  assert.equal(safeAccountSlug(null, "safe-fallback"), "safe-fallback");
  assert.equal(safeAccountSlug(null, "unsafe/fallback"), "unknown");
  assert.equal(safeAccountSlug(null, null), "unknown");
});

// ─── yearMonthFromDate ───────────────────────────────────────────────────

test("yearMonthFromDate: YYYY-MM-DD → YYYY-MM", () => {
  assert.equal(yearMonthFromDate("2026-04-13"), "2026-04");
});

test("yearMonthFromDate: nullish returns 'unknown'", () => {
  assert.equal(yearMonthFromDate(null), "unknown");
  assert.equal(yearMonthFromDate(undefined), "unknown");
  assert.equal(yearMonthFromDate(""), "unknown");
});

// ─── currencyToCents (CSV path) ──────────────────────────────────────────

test("currencyToCents: positive and negative with/without $", () => {
  assert.equal(currencyToCents("$12.34"), 1234);
  assert.equal(currencyToCents("12.34"), 1234);
  assert.equal(currencyToCents("-$12.34"), -1234);
  assert.equal(currencyToCents("-12.34"), -1234);
  assert.equal(currencyToCents("$1,234.56"), 123_456);
});

test("currencyToCents: accountants' parens treated as negative", () => {
  assert.equal(currencyToCents("(12.34)"), -1234);
});

test("currencyToCents: nullish / non-currency returns null", () => {
  assert.equal(currencyToCents(null), null);
  assert.equal(currencyToCents(undefined), null);
  assert.equal(currencyToCents(""), null);
  assert.equal(currencyToCents("not a number"), null);
});

// ─── currencyToCentsFromStatement (PDF path) ─────────────────────────────

test("currencyToCentsFromStatement: trailing-minus (credit-card credits)", () => {
  assert.equal(currencyToCentsFromStatement("$10.00-"), -1000);
  assert.equal(currencyToCentsFromStatement("10.00-"), -1000);
});

test("currencyToCentsFromStatement: leading-minus / parens", () => {
  assert.equal(currencyToCentsFromStatement("-10.00"), -1000);
  assert.equal(currencyToCentsFromStatement("(10.00)"), -1000);
});

test("currencyToCentsFromStatement: plain positive", () => {
  assert.equal(currencyToCentsFromStatement("$1,234.56"), 123_456);
});

test("currencyToCentsFromStatement: nullish / empty / NaN returns null", () => {
  assert.equal(currencyToCentsFromStatement(null), null);
  assert.equal(currencyToCentsFromStatement(""), null);
  assert.equal(currencyToCentsFromStatement("$-"), null);
});

// ─── isoDate / mmddyyyy ──────────────────────────────────────────────────

test("isoDate: common date forms → YYYY-MM-DD", () => {
  assert.equal(isoDate("04/13/2026"), "2026-04-13");
  assert.equal(isoDate("2026-04-13"), "2026-04-13");
});

test("isoDate: nullish / malformed returns null", () => {
  assert.equal(isoDate(null), null);
  assert.equal(isoDate(undefined), null);
  assert.equal(isoDate(""), null);
  assert.equal(isoDate("not a date"), null);
});

test("mmddyyyy: YYYY-MM-DD → MM/DD/YYYY", () => {
  assert.equal(mmddyyyy("2026-04-13"), "04/13/2026");
});

// ─── detectStatementClosing / detectStatementYear ────────────────────────

test("detectStatementClosing: credit-card 'Statement Closing Date MM/DD/YY'", () => {
  const text = "Header ...\nStatement Closing Date 02/17/26\n... more";
  assert.deepEqual(detectStatementClosing(text), { closingMonth: 2, closingYear: 2026 });
});

test("detectStatementClosing: modern checking period 'MM/DD/YYYY - MM/DD/YYYY'", () => {
  const text = "...\nStatement Period 01/01/2020 - 01/31/2020\n...";
  assert.deepEqual(detectStatementClosing(text), { closingMonth: 1, closingYear: 2020 });
});

test("detectStatementClosing: neither → null", () => {
  assert.equal(detectStatementClosing("no closing date anywhere"), null);
});

test("detectStatementYear: falls back to first 4-digit year in first 800 chars", () => {
  assert.equal(detectStatementYear("some text 2024 more"), 2024);
});

test("detectStatementYear: prefers closing match over loose year scan", () => {
  // Loose year 2018 appears first, closing says 2020 → closing wins.
  const text = "note from 2018\nStatement Period 01/01/2020 - 01/31/2020";
  assert.equal(detectStatementYear(text), 2020);
});

// ─── toIso ───────────────────────────────────────────────────────────────

test("toIso: inherits closing year when month <= closing month", () => {
  assert.equal(toIso("02", "14", { closingMonth: 3, closingYear: 2026 }), "2026-02-14");
});

test("toIso: rolls back to prior year when month > closing month", () => {
  assert.equal(toIso("12", "26", { closingMonth: 1, closingYear: 2026 }), "2025-12-26");
});

test("toIso: bare-year context (legacy callers)", () => {
  // Bare year implies closingMonth=12, so no rollback triggers.
  assert.equal(toIso("11", "05", 2024), "2024-11-05");
});

test("toIso: invalid month/day returns null", () => {
  assert.equal(toIso("13", "01", { closingMonth: 6, closingYear: 2026 }), null);
  assert.equal(toIso("01", "32", { closingMonth: 6, closingYear: 2026 }), null);
  assert.equal(toIso("0", "0", { closingMonth: 6, closingYear: 2026 }), null);
});

test("toIso: nullish context returns null", () => {
  assert.equal(toIso("01", "01", null), null);
  assert.equal(toIso("01", "01", undefined), null);
});

test("toIso: out-of-range closing year returns null", () => {
  assert.equal(toIso("01", "01", { closingMonth: 1, closingYear: 1800 }), null);
  assert.equal(toIso("01", "01", { closingMonth: 1, closingYear: 2300 }), null);
});

// ─── parseCsv ────────────────────────────────────────────────────────────

test("parseCsv: simple header + one row", () => {
  const text = "date,description,amount\n2026-04-13,Coffee,-4.50\n";
  assert.deepEqual(parseCsv(text), [
    ["date", "description", "amount"],
    ["2026-04-13", "Coffee", "-4.50"],
  ]);
});

test("parseCsv: quoted fields with embedded commas + escaped quotes", () => {
  const text = 'a,b\n"hi, world","he said ""ok"""\n';
  assert.deepEqual(parseCsv(text), [
    ["a", "b"],
    ["hi, world", 'he said "ok"'],
  ]);
});

test("parseCsv: handles missing trailing newline", () => {
  const text = "a,b\n1,2";
  assert.deepEqual(parseCsv(text), [
    ["a", "b"],
    ["1", "2"],
  ]);
});

// ─── rowsToTransactions ──────────────────────────────────────────────────

test("rowsToTransactions: maps a normal USAA CSV header layout", () => {
  const rows = [
    ["Date", "Description", "Original Description", "Category", "Amount", "Balance"],
    ["04/13/2026", "Coffee Shop", "COFFEE SHOP #123", "Food", "-4.50", "100.00"],
    ["04/14/2026", "Paycheck", "", "Income", "2000.00", "2100.00"],
  ];
  const txns = rowsToTransactions(rows, {
    accountId: "ACCT",
    accountName: "Checking",
    fetchedAt: "2026-04-22T00:00:00Z",
  });
  assert.equal(txns.length, 2);
  const first = txns[0];
  assert.ok(first);
  assert.equal(first.account_id, "ACCT");
  assert.equal(first.account_name, "Checking");
  assert.equal(first.date, "2026-04-13");
  assert.equal(first.description, "Coffee Shop");
  assert.equal(first.original_description, "COFFEE SHOP #123");
  assert.equal(first.category, "Food");
  assert.equal(first.amount, -450);
  assert.equal(first.balance_after_cents, 10_000);
  assert.equal(first.source, "csv_export");
  assert.equal(first.fetched_at, "2026-04-22T00:00:00Z");
});

test("rowsToTransactions: empty description falls back to original; empty original falls back to description", () => {
  const rows = [
    ["Date", "Description", "Original Description", "Amount"],
    ["04/13/2026", "Paycheck", "", "2000.00"],
  ];
  const txns = rowsToTransactions(rows, {
    accountId: "A",
    accountName: null,
    fetchedAt: "2026-04-22T00:00:00Z",
  });
  assert.equal(txns[0]?.original_description, "Paycheck");
});

test("rowsToTransactions: dedup ids via tupleOrdinal for duplicate (date,amount,orig)", () => {
  const rows = [
    ["Date", "Description", "Amount"],
    ["04/13/2026", "Same txn", "1.00"],
    ["04/13/2026", "Same txn", "1.00"],
  ];
  const txns = rowsToTransactions(rows, {
    accountId: "A",
    accountName: null,
    fetchedAt: "now",
  });
  assert.equal(txns.length, 2);
  assert.notEqual(txns[0]?.id, txns[1]?.id);
});

test("rowsToTransactions: skips rows with blank fields and unparseable dates", () => {
  const rows = [
    ["Date", "Description", "Amount"],
    ["", "", ""],
    ["garbage", "x", "1.00"],
    ["04/13/2026", "ok", "1.00"],
  ];
  const txns = rowsToTransactions(rows, {
    accountId: "A",
    accountName: null,
    fetchedAt: "now",
  });
  assert.equal(txns.length, 1);
  assert.equal(txns[0]?.description, "ok");
});

test("rowsToTransactions: extracts check number from description when present", () => {
  const rows = [
    ["Date", "Description", "Amount"],
    ["04/13/2026", "CHECK #001234 Acme", "-50.00"],
  ];
  const txns = rowsToTransactions(rows, {
    accountId: "A",
    accountName: null,
    fetchedAt: "now",
  });
  assert.equal(txns[0]?.check_number, "1234");
});

test("rowsToTransactions: empty rows or header-only → []", () => {
  assert.deepEqual(rowsToTransactions([], { accountId: "A", accountName: null, fetchedAt: "t" }), []);
  assert.deepEqual(rowsToTransactions([["Date", "Amount"]], { accountId: "A", accountName: null, fetchedAt: "t" }), []);
});

// ─── parseModernCheckingEra ──────────────────────────────────────────────

const MODERN_FIXTURE = `
Header stuff
Statement Period 04/01/2026 - 04/30/2026

TRANSACTIONS
04/02 COFFEE SHOP #45   -4.50   95.50
04/05 PAYCHECK   2000.00   2095.50
04/05/26 OVERRIDE YEAR   -1.00   2094.50
ENDING BALANCE 2094.50

FEE SUMMARY
(ignored)
`;

test("parseModernCheckingEra: extracts transactions inside TRANSACTIONS ... ENDING BALANCE", () => {
  const closing: StatementClosing = { closingMonth: 4, closingYear: 2026 };
  const txns = parseModernCheckingEra(MODERN_FIXTURE, { closing });
  assert.equal(txns.length, 3);
  const first = txns[0];
  assert.ok(first);
  assert.equal(first.iso, "2026-04-02");
  assert.equal(first.description, "COFFEE SHOP #45");
  assert.equal(first.amount, -450);
  assert.equal(first.balance, 9550);
  // Line with its own YY overrides the statement-wide closing.
  assert.equal(txns[2]?.iso, "2026-04-05");
});

test("parseModernCheckingEra: ignores lines outside section markers", () => {
  const text = "04/02 OUTSIDE 1.00\nTRANSACTIONS\n04/03 INSIDE 2.00\nENDING BALANCE\n04/04 AFTER 3.00";
  const txns = parseModernCheckingEra(text, { closing: { closingMonth: 12, closingYear: 2026 } });
  assert.equal(txns.length, 1);
  assert.equal(txns[0]?.description, "INSIDE");
});

// ─── parseCreditCardEra ──────────────────────────────────────────────────

const CREDIT_FIXTURE = `
Statement Closing Date 01/17/26

PAYMENTS AND CREDITS
12/28 12/29 REF9 AUTOPAY THANK YOU  500.00-
TOTAL PAYMENTS AND CREDITS 500.00-

PURCHASES
12/15 12/16 REF1 COFFEE SHOP   4.50
12/20 12/21 REF2 GAS STATION   40.00
TOTAL PURCHASES 44.50

FEES CHARGED
(ignored)
`;

test("parseCreditCardEra: extracts rows from PURCHASES / PAYMENTS AND CREDITS sections", () => {
  const closing: StatementClosing = { closingMonth: 1, closingYear: 2026 };
  const txns = parseCreditCardEra(CREDIT_FIXTURE, { closing });
  // 1 credit (trailing-minus) + 2 purchases
  assert.equal(txns.length, 3);
  const credit = txns.find((t) => t.description === "REF9 AUTOPAY THANK YOU");
  assert.ok(credit);
  assert.equal(credit.amount, -50_000);
  // Jan closing, Dec txn → prior year 2025.
  assert.equal(credit.iso, "2025-12-28");
  const coffee = txns.find((t) => t.description === "REF1 COFFEE SHOP");
  assert.ok(coffee);
  assert.equal(coffee.amount, 450);
  assert.equal(coffee.iso, "2025-12-15");
});

test("parseCreditCardEra: empty body returns []", () => {
  assert.deepEqual(parseCreditCardEra("", { closing: { closingMonth: 12, closingYear: 2026 } }), []);
});

// ─── checkNumberFromDescription ──────────────────────────────────────────

test("checkNumberFromDescription: pulls digits after 'CHECK #' (leading zeros stripped)", () => {
  assert.equal(checkNumberFromDescription("CHECK #001234 Memo"), "1234");
  assert.equal(checkNumberFromDescription("Check 42"), "42");
  assert.equal(checkNumberFromDescription("no check here"), null);
});

// ─── Record builders ─────────────────────────────────────────────────────

function makeAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT1",
    account_type: "checking",
    account_url: "/my/checking?acctId=ACCT1",
    balance_cents: 10_000,
    last_four: "1234",
    name: "Primary Checking",
    raw_text: "Primary Checking Ending in 1234 $100.00",
    ...overrides,
  };
}

test("buildAccountRecord: happy path", () => {
  const rec = buildAccountRecord(makeAccount(), "2026-04-22T00:00:00Z");
  assert.equal(rec.id, "ACCT1");
  assert.equal(rec.type, "checking");
  assert.equal(rec.name, "Primary Checking");
  assert.equal(rec.last_four, "1234");
  assert.equal(rec.balance_cents, 10_000);
  assert.equal(rec.status, "open");
  assert.equal(rec.fetched_at, "2026-04-22T00:00:00Z");
});

test("buildAccountRecord: falls back to hashed raw_text when account_id_raw is null", () => {
  const rec = buildAccountRecord(makeAccount({ account_id_raw: null, raw_text: "abc" }), "t");
  assert.equal(rec.id, "ba7816bf8f01cfea414140de5dae2223");
});

test("buildInboxMessageRecord: maps UNREAD status and slices subject", () => {
  const m: InboxRow = { status: "UNREAD", date_short: "Apr 13", preview: "A".repeat(200) };
  const rec = buildInboxMessageRecord(m, 2026, "2026-04-22T00:00:00Z");
  assert.ok(rec);
  assert.equal(rec.status, "unread");
  assert.equal(rec.subject.length, 120);
  assert.equal(rec.preview.length, 200);
});

test("buildInboxMessageRecord: null when date_short missing", () => {
  const m: InboxRow = { status: "Read", date_short: "", preview: "x" };
  assert.equal(buildInboxMessageRecord(m, 2026, "t"), null);
});

test("buildInboxMessageRecord: parses 'MMM DD' + year into ISO date", () => {
  const m: InboxRow = { status: "Read", date_short: "Apr 13", preview: "hi" };
  const rec = buildInboxMessageRecord(m, 2026, "t");
  assert.ok(rec);
  assert.equal(rec.date_received, "2026-04-13");
});

test("buildCreditCardBillingRecord: maps label-keyed kv into the record shape", () => {
  const billing: BillingKv = {
    "Account Nickname": "My Card",
    "Current Balance": "$123.45",
    "Available Credit": "$500.00",
    "Credit Limit": "$1,000.00",
    "Annual Percent Rate": "20.24%",
    "Cash Advance APR": "25.99%",
    "Cash Rewards": "$5.00",
    "Billing Information": "Minimum payment met",
    "Card Holders": "Jane Doe",
  };
  const rec = buildCreditCardBillingRecord(
    makeAccount({ account_id_raw: "CC1", account_type: "credit-card" }),
    billing,
    "t"
  );
  assert.equal(rec.id, "CC1");
  assert.equal(rec.account_nickname, "My Card");
  assert.equal(rec.current_balance_cents, 12_345);
  assert.equal(rec.available_credit_cents, 50_000);
  assert.equal(rec.credit_limit_cents, 100_000);
  assert.equal(rec.cash_rewards_cents, 500);
  assert.equal(rec.billing_status, "Minimum payment met");
  assert.equal(rec.minimum_payment_met, true);
});

test("buildCreditCardBillingRecord: minimum_payment_met=false when label absent", () => {
  const rec = buildCreditCardBillingRecord(makeAccount(), {}, "t");
  assert.equal(rec.minimum_payment_met, false);
});

// ─── resolveAccountIdForRef ──────────────────────────────────────────────

test("resolveAccountIdForRef: matches by last-four first", () => {
  const accounts = [
    makeAccount({ account_id_raw: "A", name: "Checking", last_four: "9241" }),
    makeAccount({ account_id_raw: "B", name: "Savings", last_four: "1111" }),
  ];
  assert.equal(resolveAccountIdForRef("STMT *9241 Apr 2026", accounts), "A");
});

test("resolveAccountIdForRef: falls back to name substring match (case-insensitive)", () => {
  const accounts = [makeAccount({ account_id_raw: "A", name: "Total Checking", last_four: null })];
  assert.equal(resolveAccountIdForRef("my total checking document", accounts), "A");
});

test("resolveAccountIdForRef: empty / unmatched returns null", () => {
  assert.equal(resolveAccountIdForRef("", []), null);
  const accounts = [makeAccount({ account_id_raw: "A", name: "Foo", last_four: "0000" })];
  assert.equal(resolveAccountIdForRef("UNRELATED *9999", accounts), null);
});

// ─── buildCandidateStarts ────────────────────────────────────────────────

test("buildCandidateStarts: all ladder rungs newer than desiredSince are appended", () => {
  const now = Date.parse("2026-04-22T00:00:00Z");
  // Desired is ancient so every rung (5y/2y/1y/3mo) is newer and gets added.
  const starts = buildCandidateStarts("1990-01-01", now);
  assert.equal(starts.length, 5);
  assert.equal(starts[0], "1990-01-01");
  assert.ok(starts.slice(1).every((d) => d > "1990-01-01"));
});

test("buildCandidateStarts: omits rungs older/equal to desiredSince", () => {
  const now = Date.parse("2026-04-22T00:00:00Z");
  // Desired is very recent → every ladder entry is older → skipped.
  const starts = buildCandidateStarts("2030-01-01", now);
  assert.equal(starts.length, 1);
  assert.equal(starts[0], "2030-01-01");
});

// ─── fileUrlForPath ──────────────────────────────────────────────────────

test("fileUrlForPath: absolute path → file:// URL", () => {
  assert.ok(fileUrlForPath("/tmp/x.pdf").startsWith("file:///tmp/x.pdf"));
});

// ─── Exported constants sanity ───────────────────────────────────────────

test("BACKFILL_17MO / INCREMENTAL_OVERLAP_MS: expected values", () => {
  const MS_PER_DAY = 24 * 3600 * 1000;
  assert.equal(BACKFILL_17MO, 17 * 30 * MS_PER_DAY);
  assert.equal(INCREMENTAL_OVERLAP_MS, 5 * MS_PER_DAY);
});

// ─── Real-fixture gate (skipped if no local raw captures) ────────────────

test("parseModernCheckingEra: local statement text parses ≥1 txn (smoke)", {
  skip: latestLocalRawDir() === null,
}, () => {
  const dir = latestLocalRawDir();
  if (!dir) {
    return;
  }
  const path = join(dir, "sample-modern-checking.txt");
  if (!existsSync(path)) {
    return;
  }
  const text = readFileSync(path, "utf8");
  const closing = detectStatementClosing(text) ?? { closingMonth: 12, closingYear: 2026 };
  const txns = parseModernCheckingEra(text, { closing });
  assert.ok(txns.length >= 1, `expected ≥1 txn, got ${txns.length}`);
});

// ─── Synthetic USAA CSV fixture (smoke) ──────────────────────────────────

test("rowsToTransactions: synthetic CSV fixture parses the expected count", {
  skip: !existsSync(join(FIXTURE_DIR, "csv-export-minimal.csv")),
}, () => {
  const text = readFixture("csv-export-minimal.csv");
  const rows = parseCsv(text);
  const txns = rowsToTransactions(rows, {
    accountId: "ACCT",
    accountName: "Checking",
    fetchedAt: "t",
  });
  assert.ok(txns.length >= 1);
  for (const t of txns) {
    assert.equal(t.source, "csv_export");
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});
