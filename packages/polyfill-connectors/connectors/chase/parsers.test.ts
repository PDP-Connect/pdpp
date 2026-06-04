import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  accountSlug,
  chooseActivity,
  currentActivityId,
  extractFromQfx,
  fileUrl,
  isOfxRecord,
  isoToPacked,
  isUsablePdfBuffer,
  ofxDateToFullIso,
  ofxDateToIso,
  ofxGet,
  ofxNumber,
  ofxString,
  parseCurrentActivityDom,
  parseDashboardAccountsDom,
  parseDateDelivered,
  parseStatementsListDom,
  resolveAccountIdForRow,
  sha256Hex,
  shortHash,
  truncate,
} from "./parsers.ts";
import type { ChaseAccount, StatementRow, TransactionsStateShape } from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");
const LOCAL_RAW_DIR = join(__dirname, "..", "..", "fixtures", "chase", "raw");

function readFixture(relPath: string): string {
  return readFileSync(join(FIXTURE_DIR, relPath), "utf8");
}

function latestLocalRawDir(): string | null {
  if (!existsSync(LOCAL_RAW_DIR)) {
    return null;
  }
  try {
    const candidates = readdirSync(LOCAL_RAW_DIR)
      .map((name) => join(LOCAL_RAW_DIR, name, "dom"))
      .filter((p) => existsSync(p) && statSync(p).isDirectory())
      .sort();
    return candidates.at(-1) ?? null;
  } catch {
    return null;
  }
}

// ─── truncate / errMessage ────────────────────────────────────────────────

test("truncate: returns string as-is when short enough", () => {
  assert.equal(truncate("hi", 10), "hi");
});

test("truncate: slices to max when longer", () => {
  assert.equal(truncate("abcdefghij", 5), "abcde");
});

// ─── isoToPacked ─────────────────────────────────────────────────────────

test("isoToPacked: valid ISO date → MMDDYYYY", () => {
  assert.equal(isoToPacked("2026-04-21"), "04212026");
  assert.equal(isoToPacked("2024-12-01"), "12012024");
});

test("isoToPacked: malformed input returns null", () => {
  assert.equal(isoToPacked(""), null);
  assert.equal(isoToPacked("2026"), null);
  assert.equal(isoToPacked("2026-04"), null);
  // NB: split by '-' also parses malformed three-part strings. Documenting
  // current behavior: two empty parts survive, so this returns a weird
  // packed string. Not a bug, not relied on by callers.
  assert.equal(isoToPacked("--"), null);
});

// ─── parseDateDelivered ──────────────────────────────────────────────────

test("parseDateDelivered: common Chase date forms", () => {
  const cases: [string, string][] = [
    ["Apr 13, 2026", "2026-04-13"],
    ["April 13, 2026", "2026-04-13"],
    ["January 5, 2024", "2024-01-05"],
    ["2024-01-05", "2024-01-05"],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(parseDateDelivered(raw), expected, `input=${JSON.stringify(raw)}`);
  }
});

test("parseDateDelivered: nullish / empty / malformed returns null", () => {
  assert.equal(parseDateDelivered(undefined), null);
  assert.equal(parseDateDelivered(null), null);
  assert.equal(parseDateDelivered(""), null);
  assert.equal(parseDateDelivered("not a date"), null);
});

// ─── sha256Hex / shortHash ───────────────────────────────────────────────

test("sha256Hex: matches known digest for ASCII buffer", () => {
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("shortHash: deterministic, 32-char slice of sha256", () => {
  const h = shortHash("abc");
  assert.equal(h.length, 32);
  assert.equal(h, "ba7816bf8f01cfea414140de5dae2223");
});

// ─── isUsablePdfBuffer ───────────────────────────────────────────────────

test("isUsablePdfBuffer: a real PDF (with %PDF magic) is usable", () => {
  assert.equal(isUsablePdfBuffer(Buffer.from("%PDF-1.7\n%âãÏÓ\n1 0 obj", "latin1")), true);
});

test("isUsablePdfBuffer: an empty buffer is NOT usable (the empty-sha256 churn bug)", () => {
  // The empty buffer otherwise hashes to the empty-string sha256, which is
  // the exact value observed flapping in live chase/statements history.
  const empty = Buffer.alloc(0);
  assert.equal(isUsablePdfBuffer(empty), false);
  assert.equal(sha256Hex(empty), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("isUsablePdfBuffer: an HTML error page served as 200 is NOT usable", () => {
  assert.equal(isUsablePdfBuffer(Buffer.from("<!DOCTYPE html><html>Error</html>")), false);
});

test("isUsablePdfBuffer: a sub-magic-length buffer is NOT usable", () => {
  assert.equal(isUsablePdfBuffer(Buffer.from("%PD")), false);
});

// ─── fileUrl ─────────────────────────────────────────────────────────────

test("fileUrl: absolute path → file:// URL", () => {
  const u = fileUrl("/tmp/x.pdf");
  assert.ok(u?.startsWith("file:///tmp/x.pdf"));
});

test("fileUrl: nullish returns null", () => {
  assert.equal(fileUrl(null), null);
  assert.equal(fileUrl(undefined), null);
  assert.equal(fileUrl(""), null);
});

// ─── accountSlug ─────────────────────────────────────────────────────────

test("accountSlug: safe ASCII id returned as-is", () => {
  assert.equal(accountSlug("123456789"), "123456789");
  assert.equal(accountSlug("acct_abc-def"), "acct_abc-def");
});

test("accountSlug: null returns 'unknown'", () => {
  assert.equal(accountSlug(null), "unknown");
});

test("accountSlug: unsafe characters get hashed", () => {
  const slug = accountSlug("bad/slash");
  // Must be a 32-char hex slug (shortHash output)
  assert.equal(slug.length, 32);
  assert.match(slug, /^[0-9a-f]{32}$/);
});

// ─── OFX value helpers ───────────────────────────────────────────────────

test("isOfxRecord: true only for plain non-array objects", () => {
  assert.equal(isOfxRecord({}), true);
  assert.equal(isOfxRecord({ a: 1 }), true);
  assert.equal(isOfxRecord([]), false);
  assert.equal(isOfxRecord(null), false);
  assert.equal(isOfxRecord("x"), false);
  assert.equal(isOfxRecord(42), false);
});

test("ofxGet: returns field value when present, undefined otherwise", () => {
  assert.equal(ofxGet({ A: "hi" }, "A"), "hi");
  assert.equal(ofxGet({ A: "hi" }, "B"), undefined);
  assert.equal(ofxGet(null, "A"), undefined);
  assert.equal(ofxGet([1, 2], "0"), undefined); // arrays are excluded by design
});

test("ofxString: coerces string/number/boolean, otherwise null", () => {
  assert.equal(ofxString("abc"), "abc");
  assert.equal(ofxString(42), "42");
  assert.equal(ofxString(true), "true");
  assert.equal(ofxString(null), null);
  assert.equal(ofxString(undefined), null);
  assert.equal(ofxString({}), null);
  assert.equal(ofxString([]), null);
});

test("ofxNumber: coerces numeric strings, returns null otherwise", () => {
  assert.equal(ofxNumber("42.5"), 42.5);
  assert.equal(ofxNumber(7), 7);
  assert.equal(ofxNumber(""), null);
  assert.equal(ofxNumber("not a num"), null);
  assert.equal(ofxNumber(null), null);
  assert.equal(ofxNumber(undefined), null);
});

// ─── ofxDateToIso / ofxDateToFullIso ─────────────────────────────────────

test("ofxDateToIso: first 8 chars → YYYY-MM-DD", () => {
  assert.equal(ofxDateToIso("20260421"), "2026-04-21");
  assert.equal(ofxDateToIso("20260421120000"), "2026-04-21");
  // with timezone suffix
  assert.equal(ofxDateToIso("20260421120000.000[-4:EDT]"), "2026-04-21");
});

test("ofxDateToIso: too short / nullish returns null", () => {
  assert.equal(ofxDateToIso("20260"), null);
  assert.equal(ofxDateToIso(""), null);
  assert.equal(ofxDateToIso(null), null);
});

test("ofxDateToFullIso: date + HHMMSS → ISO with Z", () => {
  assert.equal(ofxDateToFullIso("20260421120030"), "2026-04-21T12:00:30Z");
});

test("ofxDateToFullIso: bare date → midnight Z", () => {
  assert.equal(ofxDateToFullIso("20260421"), "2026-04-21T00:00:00Z");
});

test("ofxDateToFullIso: malformed returns null", () => {
  assert.equal(ofxDateToFullIso(null), null);
  assert.equal(ofxDateToFullIso(""), null);
  assert.equal(ofxDateToFullIso("abc"), null);
});

// ─── extractFromQfx ──────────────────────────────────────────────────────

test("extractFromQfx: credit-card OFX tree with single STMTTRN", () => {
  const parsed = {
    OFX: {
      CREDITCARDMSGSRSV1: {
        CCSTMTTRNRS: {
          CCSTMTRS: {
            CURDEF: "USD",
            BANKTRANLIST: {
              STMTTRN: {
                TRNTYPE: "DEBIT",
                DTPOSTED: "20260421120000",
                TRNAMT: "-42.99",
                FITID: "FITIDX1",
                NAME: "COFFEE SHOP",
                MEMO: "downtown",
              },
            },
            LEDGERBAL: {
              BALAMT: "-1250.55",
              DTASOF: "20260422000000",
            },
            AVAILBAL: {
              BALAMT: "8749.45",
              DTASOF: "20260422000000",
            },
          },
        },
      },
    },
  };
  const out = extractFromQfx(parsed);
  assert.equal(out.transactions.length, 1);
  const t = out.transactions[0];
  assert.ok(t);
  assert.equal(t.fitid, "FITIDX1");
  assert.equal(t.date, "2026-04-21");
  assert.equal(t.amount_cents, -4299);
  assert.equal(t.currency, "USD");
  assert.equal(t.type, "DEBIT");
  assert.equal(t.name, "COFFEE SHOP");
  assert.equal(t.memo, "downtown");
  assert.ok(out.balance);
  assert.equal(out.balance.ledger_cents, -125_055);
  assert.equal(out.balance.available_cents, 874_945);
  assert.equal(out.balance.as_of, "2026-04-22T00:00:00Z");
});

test("extractFromQfx: checking OFX with array STMTTRN", () => {
  const parsed = {
    OFX: {
      BANKMSGSRSV1: {
        STMTTRNRS: {
          STMTRS: {
            CURDEF: "USD",
            BANKTRANLIST: {
              STMTTRN: [
                { TRNTYPE: "CREDIT", DTPOSTED: "20260410", TRNAMT: "1000.00", FITID: "A" },
                { TRNTYPE: "CHECK", DTPOSTED: "20260411", TRNAMT: "-50.00", FITID: "B", CHECKNUM: "1234" },
              ],
            },
            LEDGERBAL: { BALAMT: "1000.00", DTASOF: "20260412" },
          },
        },
      },
    },
  };
  const out = extractFromQfx(parsed);
  assert.equal(out.transactions.length, 2);
  assert.equal(out.transactions[0]?.fitid, "A");
  assert.equal(out.transactions[0]?.amount_cents, 100_000);
  assert.equal(out.transactions[1]?.check_number, "1234");
  assert.ok(out.balance);
  assert.equal(out.balance.ledger_cents, 100_000);
  assert.equal(out.balance.available_cents, null);
});

test("extractFromQfx: skips transactions missing FITID or DTPOSTED", () => {
  const parsed = {
    OFX: {
      BANKMSGSRSV1: {
        STMTTRNRS: {
          STMTRS: {
            CURDEF: "USD",
            BANKTRANLIST: {
              STMTTRN: [
                { TRNTYPE: "CREDIT", DTPOSTED: "20260410", TRNAMT: "10.00", FITID: "OK" },
                { TRNTYPE: "CREDIT", DTPOSTED: "20260410", TRNAMT: "10.00" }, // missing FITID
                { TRNTYPE: "CREDIT", TRNAMT: "10.00", FITID: "NODATE" }, // missing DTPOSTED
              ],
            },
          },
        },
      },
    },
  };
  const out = extractFromQfx(parsed);
  assert.equal(out.transactions.length, 1);
  assert.equal(out.transactions[0]?.fitid, "OK");
});

test("extractFromQfx: empty / unrecognized shape returns empty", () => {
  assert.deepEqual(extractFromQfx(null), { transactions: [], balance: null });
  assert.deepEqual(extractFromQfx({}), { transactions: [], balance: null });
  assert.deepEqual(extractFromQfx({ OFX: { NOTHING: {} } }), { transactions: [], balance: null });
});

// ─── parseDashboardAccountsDom ───────────────────────────────────────────

test("parseDashboardAccountsDom: synthetic minimal fixture extracts 4 accounts", () => {
  const html = readFixture("dashboard-accounts-minimal.html");
  const accounts = parseDashboardAccountsDom(html);
  assert.equal(accounts.length, 4);
  // Credit card match (Sapphire)
  const sapphire = accounts.find((a) => a.internal_id === "123456789");
  assert.ok(sapphire);
  assert.equal(sapphire.type, "credit_card");
  assert.equal(sapphire.last_four, "9241");
  assert.match(sapphire.name, /Sapphire Preferred/);
  // Checking
  const checking = accounts.find((a) => a.internal_id === "222333444");
  assert.ok(checking);
  assert.equal(checking.type, "checking");
  assert.equal(checking.last_four, "1234");
  // Savings
  const savings = accounts.find((a) => a.internal_id === "555666777");
  assert.ok(savings);
  assert.equal(savings.type, "savings");
  assert.equal(savings.last_four, "7777");
  // Unknown product
  const other = accounts.find((a) => a.internal_id === "888999000");
  assert.ok(other);
  assert.equal(other.type, "unknown");
  assert.equal(other.last_four, "0000");
});

test("parseDashboardAccountsDom: current button-shaped account tiles extract accounts", () => {
  const html = readFixture("dashboard-accounts-button-shape.html");
  const accounts = parseDashboardAccountsDom(html);
  assert.equal(accounts.length, 2);

  const card = accounts.find((a) => a.internal_id === "1212486749");
  assert.ok(card);
  assert.equal(card.type, "credit_card");
  assert.equal(card.last_four, "6749");
  assert.match(card.name, /Freedom Unlimited/);

  const checking = accounts.find((a) => a.internal_id === "222333444");
  assert.ok(checking);
  assert.equal(checking.type, "checking");
  assert.equal(checking.last_four, "3444");
});

test("parseDashboardAccountsDom: empty page returns []", () => {
  assert.deepEqual(parseDashboardAccountsDom("<!doctype html><html><body></body></html>"), []);
  assert.deepEqual(parseDashboardAccountsDom(""), []);
});

test("parseDashboardAccountsDom: label without numeric id is skipped", () => {
  const html = `<!doctype html><html><body>
    <span id="accounts-name-link-button-not-a-number-label">Junk</span>
  </body></html>`;
  assert.deepEqual(parseDashboardAccountsDom(html), []);
});

// ─── parseCurrentActivityDom ────────────────────────────────────────────

test("parseCurrentActivityDom: extracts pending and posted UI-visible rows", () => {
  const rows = parseCurrentActivityDom(readFixture("current-activity-minimal.html"), "2026-05-15");
  assert.equal(rows.length, 2);

  const pending = rows[0];
  assert.ok(pending);
  assert.equal(pending.status, "pending");
  assert.equal(pending.activity_date, "2026-05-14");
  assert.equal(pending.posted_date, null);
  assert.equal(pending.amount_cents, -4217);
  assert.equal(pending.description, "Whole Foods Market");
  assert.equal(pending.ui_transaction_id, "txn_20260514_A1");

  const posted = rows[1];
  assert.ok(posted);
  assert.equal(posted.status, "posted");
  assert.equal(posted.activity_date, "2026-05-13");
  assert.equal(posted.posted_date, "2026-05-13");
  assert.equal(posted.amount_cents, 125_000);
  assert.equal(posted.description, "ACH Deposit Payroll");
  assert.equal(posted.ui_transaction_id, null);
});

test("currentActivityId: prefers UI id and otherwise uses deterministic fallback", () => {
  const [withUiId, withoutUiId] = parseCurrentActivityDom(readFixture("current-activity-minimal.html"), "2026-05-15");
  assert.ok(withUiId);
  assert.ok(withoutUiId);
  assert.equal(currentActivityId("ACC", withUiId), "ACC|txn_20260514_A1");
  const fallback = currentActivityId("ACC", withoutUiId);
  assert.match(fallback, /^ACC\|fallback:[0-9a-f]{32}$/);
  assert.equal(currentActivityId("ACC", withoutUiId), fallback);
});

test("parseCurrentActivityDom: ignores ancestor activity containers and emits only leaf rows", () => {
  const rows = parseCurrentActivityDom(readFixture("current-activity-wrapped-rows.html"), "2026-05-15");
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.description),
    ["Whole Foods Market", "ACH Deposit Payroll"]
  );
  assert.deepEqual(
    rows.map((r) => r.amount_cents),
    [-4217, 125_000]
  );
});

// ─── Surface routing pins ────────────────────────────────────────────────
//
// The connector's `runCurrentActivity` (index.ts) routes current_activity
// scraping to the Chase dashboard OVERVIEW DOM, NOT to the QFX
// "Download account activity" form. The pre-fix wiring tried to nav back to
// the overview after the download form had loaded — but that's a
// same-document hash change which doesn't re-render the SPA, so the
// download form's DOM was still in `page.content()`. These two tests pin
// the surface decision: the parser must produce rows from the overview
// shape, and zero rows from the broken-surface shape, so any future
// re-routing regression fails loudly here.

test("parseCurrentActivityDom: real dashboard overview shape (committed extract) yields all 5 MDS rows", () => {
  const rows = parseCurrentActivityDom(readFixture("current-activity-dashboard-overview-real.html"), "2026-05-15");
  // 2 pending rows + 3 May-14 posted rows = 5 (matches the real captured run).
  assert.equal(rows.length, 5);
  const pending = rows.filter((r) => r.status === "pending");
  const posted = rows.filter((r) => r.status === "posted");
  assert.equal(pending.length, 2);
  assert.equal(posted.length, 3);
  assert.deepEqual(
    rows.map((r) => r.amount_cents),
    [15_804, 10_124, 3908, 9884, 7099]
  );
  for (const r of rows) {
    assert.match(
      r.ui_transaction_id ?? "",
      /^ovd-recent-activity-table-dataTableId-row-\d+$/,
      "MDS row tr#id should propagate as ui_transaction_id"
    );
  }
});

test("parseCurrentActivityDom: QFX download form (broken surface) yields zero rows", () => {
  // This is the surface the pre-fix wiring was scraping for current_activity.
  // The parser correctly produces zero rows here; the bug was upstream in
  // index.ts (re-navigating to the overview hash route after the download
  // form had loaded is a no-op SPA-route change). Pinning this here means
  // any future routing regression that points current_activity back at the
  // download form will visibly emit `selectors_pending` instead of
  // silently succeeding.
  const rows = parseCurrentActivityDom(readFixture("current-activity-download-form-no-rows.html"), "2026-05-15");
  assert.equal(rows.length, 0);
});

test("parseCurrentActivityDom: local real capture — dashboard-accounts.html parses ≥1 MDS row", {
  skip: latestLocalRawDir() === null,
}, () => {
  const dir = latestLocalRawDir();
  if (!dir) {
    return;
  }
  // The dashboard-accounts.html capture (taken during discoverAccounts, while
  // the page is on the overview SPA route) contains the MDS recent-activity
  // table. The current-activity-<accountId>.html capture from older runs is
  // the BROKEN surface — see the run report. This gate proves the right
  // surface, not the wrong one.
  const path = join(dir, "dashboard-accounts.html");
  if (!existsSync(path)) {
    return;
  }
  const html = readFileSync(path, "utf8");
  const rows = parseCurrentActivityDom(html, "2026-05-15");
  assert.ok(
    rows.length >= 1,
    `expected ≥1 MDS current_activity row from local dashboard-accounts.html, got ${rows.length}`
  );
});

test("parseCurrentActivityDom: extracts Chase MDS dashboard rows from data-values", () => {
  const rows = parseCurrentActivityDom(readFixture("current-activity-mds-overview.html"), "2026-05-15");
  assert.equal(rows.length, 3);

  assert.deepEqual(
    rows.map((r) => r.status),
    ["pending", "posted", "posted"]
  );
  assert.deepEqual(
    rows.map((r) => r.activity_date),
    ["2026-05-15", "2026-05-14", "2026-05-14"]
  );
  assert.deepEqual(
    rows.map((r) => r.posted_date),
    [null, "2026-05-14", "2026-05-14"]
  );
  assert.deepEqual(
    rows.map((r) => r.description),
    ["CARD MERCHANT", "STORE MERCHANT", "COMMA, MERCHANT"]
  );
  assert.deepEqual(
    rows.map((r) => r.amount_cents),
    [15_804, 3908, 9884]
  );
});

// ─── parseStatementsListDom ──────────────────────────────────────────────

test("parseStatementsListDom: extracts statement rows (tax documents skipped)", () => {
  const html = readFixture("statements-list-minimal.html");
  const rows = parseStatementsListDom(html);
  // Tax document row is filtered out; 3 statement rows remain (2 from table 0, 1 from table 1)
  assert.equal(rows.length, 3);
  const first = rows[0];
  assert.ok(first);
  assert.equal(first.rowAnchorId, "accountsTable-0-row0-cell3-requestThisDocumentAnchor-download");
  assert.equal(first.tableIdx, "0");
  assert.equal(first.rowIdx, "0");
  assert.equal(first.date_delivered_raw, "Apr 13, 2026");
  assert.equal(first.doc_kind, "Statement");
  assert.equal(first.account_reference, "SAPPHIRE PREFERRED (...9241)");
  assert.match(first.title, /Apr 13, 2026 Statement SAPPHIRE PREFERRED/);
  // Second-row checks
  const second = rows[1];
  assert.ok(second);
  assert.equal(second.rowAnchorId, "accountsTable-0-row1-cell3-requestThisDocumentAnchor-download");
  assert.equal(second.doc_kind, "Statement");
  // Third row is on a different table idx, so account_reference flips
  const third = rows[2];
  assert.ok(third);
  assert.equal(third.tableIdx, "1");
  assert.equal(third.account_reference, "TOTAL CHECKING (...1234)");
});

test("parseStatementsListDom: empty page returns []", () => {
  assert.deepEqual(parseStatementsListDom("<!doctype html><html><body></body></html>"), []);
});

// ─── resolveAccountIdForRow ──────────────────────────────────────────────

function makeAccount(overrides: Partial<ChaseAccount> = {}): ChaseAccount {
  return {
    internal_id: "ID",
    name: "",
    type: "unknown",
    last_four: null,
    ...overrides,
  };
}

function makeRow(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    rowAnchorId: "anchor",
    tableIdx: "0",
    rowIdx: "0",
    date_delivered_raw: "Apr 13, 2026",
    doc_kind: "Statement",
    account_reference: null,
    title: "title",
    ...overrides,
  };
}

test("resolveAccountIdForRow: matches by last-four first", () => {
  const accounts: ChaseAccount[] = [
    makeAccount({ internal_id: "A", name: "Sapphire", last_four: "9241" }),
    makeAccount({ internal_id: "B", name: "Freedom", last_four: "1111" }),
  ];
  const row = makeRow({ account_reference: "SAPPHIRE PREFERRED (...9241)" });
  assert.equal(resolveAccountIdForRow(row, accounts), "A");
});

test("resolveAccountIdForRow: falls back to name substring match", () => {
  const accounts: ChaseAccount[] = [makeAccount({ internal_id: "A", name: "Total Checking", last_four: null })];
  const row = makeRow({ account_reference: "my total checking account" });
  assert.equal(resolveAccountIdForRow(row, accounts), "A");
});

test("resolveAccountIdForRow: null account_reference returns null", () => {
  assert.equal(resolveAccountIdForRow(makeRow({ account_reference: null }), []), null);
});

test("resolveAccountIdForRow: no match returns null", () => {
  const accounts: ChaseAccount[] = [makeAccount({ internal_id: "A", name: "Foo", last_four: "0000" })];
  const row = makeRow({ account_reference: "UNRELATED (...9999)" });
  assert.equal(resolveAccountIdForRow(row, accounts), null);
});

// ─── chooseActivity ──────────────────────────────────────────────────────

test("chooseActivity: explicit time_range → date_range", () => {
  const requested = new Map([
    ["transactions", { time_range: { since: "2026-01-01T00:00:00Z", until: "2026-04-01T00:00:00Z" } }],
  ]);
  const choice = chooseActivity(requested, {}, "transactions", "ID");
  assert.equal(choice.activity, "date_range");
  assert.deepEqual(choice.dateRange, { from: "2026-01-01", to: "2026-04-01" });
});

test("chooseActivity: cursor max_seen_date → since_last_statement", () => {
  const state: TransactionsStateShape = {
    per_account: { ID: { max_seen_date: "2026-03-01" } },
  };
  const choice = chooseActivity(new Map(), state, "transactions", "ID");
  assert.equal(choice.activity, "since_last_statement");
});

test("chooseActivity: no hints → all (bootstrap)", () => {
  assert.equal(chooseActivity(new Map(), {}, "transactions", "ID").activity, "all");
});

// ─── Real-fixture gates (skipped if no local raw captures) ───────────────

test("parseDashboardAccountsDom: local real capture parses ≥1 account", { skip: latestLocalRawDir() === null }, () => {
  const dir = latestLocalRawDir();
  if (!dir) {
    return;
  }
  const path = join(dir, "dashboard-accounts.html");
  if (!existsSync(path)) {
    return;
  }
  const html = readFileSync(path, "utf8");
  const accounts = parseDashboardAccountsDom(html);
  assert.ok(accounts.length >= 1, `expected ≥1 account, got ${accounts.length}`);
  for (const a of accounts) {
    assert.match(a.internal_id, /^\d+$/);
    assert.ok(a.name.length > 0);
  }
});

test("parseStatementsListDom: local real capture parses ≥1 statement row", {
  skip: latestLocalRawDir() === null,
}, () => {
  const dir = latestLocalRawDir();
  if (!dir) {
    return;
  }
  const path = join(dir, "statements-list.html");
  if (!existsSync(path)) {
    return;
  }
  const html = readFileSync(path, "utf8");
  const rows = parseStatementsListDom(html);
  assert.ok(rows.length >= 1, `expected ≥1 row, got ${rows.length}`);
  for (const r of rows) {
    assert.match(r.rowAnchorId, /accountsTable-\d+-row\d+-cell\d+-requestThisDocumentAnchor-download/);
    assert.ok(r.date_delivered_raw.length > 0);
  }
});
