// Pure parsers for the USAA connector. Kept free of Playwright / Node I/O
// (except sha256 + pathToFileURL which are purely computational) so they
// can be unit-tested in isolation.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ClosingContext, ParsedStatementTxn, StatementClosing, TransactionRecord } from "./types.ts";

// ─── Tunables ────────────────────────────────────────────────────────────

const HASH_LENGTH = 32;
const CENTS_MULTIPLIER = 100;

// ─── Module-scope regexes (Biome useTopLevelRegex) ───────────────────────

const CURRENCY_RE = /-?\$?([\d,]+\.\d{2})/;
const NEGATIVE_PREFIX_RE = /^-|\(/;
const COMMA_RE = /,/g;
const CHECK_NUMBER_RE = /CHECK\s*#?\s*0*(\d+)/i;
const DESCRIPTION_HEADER_RE = /^(description|payee|merchant|memo)$/i;
const DATE_HEADER_RE = /date/i;
const ORIGINAL_HEADER_RE = /original/i;
const CATEGORY_HEADER_RE = /category/i;
const AMOUNT_HEADER_RE = /amount/i;
const BALANCE_HEADER_RE = /balance/i;

const SLUG_SAFE_RE = /^[A-Za-z0-9_-]+$/;
const CREDIT_CARD_CLOSING_RE = /Statement\s+Closing\s+Date\s+(\d{1,2})\/\d{1,2}\/(\d{2,4})/i;
const CHECKING_STATEMENT_PERIOD_RE =
  /Statement\s+Period\s+\d{1,2}\/\d{1,2}\/\d{4}\s*[-–]\s*(\d{1,2})\/\d{1,2}\/(\d{4})/i;
const FOUR_DIGIT_YEAR_RE = /\b(19|20)\d{2}\b/;
const LEADING_MINUS_RE = /^-/;
const TRAILING_MINUS_RE = /-\s*$/;
const LEADING_PAREN_RE = /\(/;
const NON_CURRENCY_CHARS_RE = /[^0-9.]/g;
const STMT_LINE_SPLIT_RE = /\r?\n/;
const MODERN_SECTION_START_RE =
  /^\s*(TRANSACTIONS|ACCOUNT\s+ACTIVITY|DEPOSITS?\s+AND\s+OTHER\s+CREDITS|WITHDRAWALS?\s+AND\s+OTHER\s+DEBITS)\s*$/i;
const MODERN_SECTION_END_RE = /^\s*(ENDING\s+BALANCE|TOTAL\s+FEES|FEE\s+SUMMARY|DAILY\s+BALANCE\s+SUMMARY)/i;
const MODERN_TXN_LINE_RE =
  /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(.+?)\s+(-?\$?[\d,]+\.\d{2})(?:\s+(-?\$?[\d,]+\.\d{2}))?\s*$/;
const WS_RUN_2PLUS_RE = /\s{2,}/g;
const CREDIT_SECTION_START_RE = /^\s*(TRANSACTIONS|PURCHASES|PAYMENTS\s+AND\s+CREDITS)\s*$/i;
const CREDIT_SECTION_TOTAL_RE = /^\s*TOTAL/i;
const CREDIT_SECTION_END_RE = /^\s*(TOTAL\b|FEES\s+CHARGED|INTEREST\s+CHARGED|YEAR-TO-DATE|IMPORTANT\s+ACCOUNT)/i;
const CREDIT_TXN_LINE_RE = /^(\d{1,2})\/(\d{1,2})\s+(\d{1,2})\/(\d{1,2})\s+(.+?)\s+(-?\$?[\d,]+\.\d{2}-?)\s*$/;

// ─── Hash + URL helpers ──────────────────────────────────────────────────

export function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, HASH_LENGTH);
}

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function fileUrlForPath(p: string): string {
  return pathToFileURL(p).toString();
}

export function safeAccountSlug(accountId: string | null | undefined, fallback: string | null | undefined): string {
  if (accountId && SLUG_SAFE_RE.test(accountId)) {
    return accountId;
  }
  if (accountId) {
    return createHash("sha256").update(accountId).digest("hex").slice(0, 16);
  }
  if (fallback && SLUG_SAFE_RE.test(fallback)) {
    return fallback;
  }
  return "unknown";
}

export function yearMonthFromDate(isoDateStr: string | null | undefined): string {
  // isoDateStr is "YYYY-MM-DD"; returns "YYYY-MM".
  if (!isoDateStr) {
    return "unknown";
  }
  return isoDateStr.slice(0, 7);
}

// ─── Currency helpers ────────────────────────────────────────────────────

/** CSV-path currency: "$-123.45" / "(123.45)" / "-123.45" → cents. */
export function currencyToCents(s: string | null | undefined): number | null {
  if (!s) {
    return null;
  }
  const str = String(s);
  const m = str.match(CURRENCY_RE);
  if (!m?.[1]) {
    return null;
  }
  const sign = NEGATIVE_PREFIX_RE.test(str) ? -1 : 1;
  const num = Number(m[1].replace(COMMA_RE, "")) * sign;
  return Math.round(num * CENTS_MULTIPLIER);
}

/**
 * Statement-PDF currency: handles trailing-minus ("$10.00-" = credit) and
 * accountants' parens in addition to leading-minus.
 */
export function currencyToCentsFromStatement(s: string | null | undefined): number | null {
  if (!s) {
    return null;
  }
  const trimmed = s.trim();
  const neg = LEADING_MINUS_RE.test(trimmed) || TRAILING_MINUS_RE.test(trimmed) || LEADING_PAREN_RE.test(trimmed);
  const numeric = trimmed.replace(NON_CURRENCY_CHARS_RE, "");
  if (!numeric) {
    return null;
  }
  const num = Number(numeric);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.round(num * CENTS_MULTIPLIER) * (neg ? -1 : 1);
}

// ─── Date helpers ────────────────────────────────────────────────────────

export function isoDate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

export function mmddyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

/**
 * Extract the statement's closing month + year from PDF text.
 * Credit-card: "Statement Closing Date MM/DD/YY".
 * Modern checking: "Statement Period MM/DD/YYYY - MM/DD/YYYY" (closing side).
 */
export function detectStatementClosing(text: string): StatementClosing | null {
  const cc = text.match(CREDIT_CARD_CLOSING_RE);
  if (cc?.[1] && cc[2]) {
    const mm = Number(cc[1]);
    const yy = Number(cc[2]);
    const year = yy < 100 ? 2000 + yy : yy;
    return { closingMonth: mm, closingYear: year };
  }
  const ck = text.match(CHECKING_STATEMENT_PERIOD_RE);
  if (ck?.[1] && ck[2]) {
    return { closingMonth: Number(ck[1]), closingYear: Number(ck[2]) };
  }
  return null;
}

/** Back-compat: some callers still want just the year. */
export function detectStatementYear(text: string): number | null {
  const c = detectStatementClosing(text);
  if (c) {
    return c.closingYear;
  }
  const m3 = text.slice(0, 800).match(FOUR_DIGIT_YEAR_RE);
  return m3 ? Number(m3[0]) : null;
}

function resolveClosingContext(ctx: ClosingContext): { closingMonth: number; closingYear: number } | null {
  if (typeof ctx === "number") {
    return { closingMonth: 12, closingYear: ctx };
  }
  if (ctx && typeof ctx === "object") {
    return {
      closingMonth: ctx.closingMonth || 12,
      closingYear: ctx.closingYear,
    };
  }
  return null;
}

/**
 * Assign a YYYY to an MM/DD transaction date extracted from a statement,
 * using the statement's closing month to decide whether the transaction
 * falls in the closing year or the prior year.
 */
export function toIso(mm: string | number, dd: string | number, ctx: ClosingContext): string | null {
  const m = Number(mm);
  const d = Number(dd);
  if (!m || m < 1 || m > 12 || !d || d < 1 || d > 31) {
    return null;
  }
  const resolved = resolveClosingContext(ctx);
  if (!resolved) {
    return null;
  }
  const { closingMonth, closingYear } = resolved;
  if (!closingYear || closingYear < 1990 || closingYear > 2100) {
    return null;
  }
  const year = m > closingMonth ? closingYear - 1 : closingYear;
  const mmStr = String(m).padStart(2, "0");
  const ddStr = String(d).padStart(2, "0");
  return `${year}-${mmStr}-${ddStr}`;
}

// ─── CSV parsing ─────────────────────────────────────────────────────────

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuote = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ",") {
      cur.push(field);
      field = "";
    } else if (c === "\n") {
      cur.push(field);
      field = "";
      rows.push(cur);
      cur = [];
    } else if (c === "\r") {
      // skip
    } else if (c !== undefined) {
      field += c;
    }
  }
  if (field !== "" || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  return rows;
}

interface CsvHeaderIndices {
  idxAmt: number;
  idxBal: number;
  idxCat: number;
  idxDate: number;
  idxDesc: number;
  idxOrig: number;
}

function csvHeaderIndices(header: string[]): CsvHeaderIndices {
  const lower = header.map((h) => h.trim().toLowerCase());
  return {
    idxDate: lower.findIndex((h) => DATE_HEADER_RE.test(h)),
    idxDesc: lower.findIndex((h) => DESCRIPTION_HEADER_RE.test(h)),
    idxOrig: lower.findIndex((h) => ORIGINAL_HEADER_RE.test(h)),
    idxCat: lower.findIndex((h) => CATEGORY_HEADER_RE.test(h)),
    idxAmt: lower.findIndex((h) => AMOUNT_HEADER_RE.test(h)),
    idxBal: lower.findIndex((h) => BALANCE_HEADER_RE.test(h)),
  };
}

interface RowToTxnArgs {
  accountId: string;
  accountName: string | null;
  fetchedAt: string;
  idx: CsvHeaderIndices;
  row: string[];
  tupleOrdinal: Map<string, number>;
}

function csvRowToTransaction({
  row,
  idx,
  accountId,
  accountName,
  fetchedAt,
  tupleOrdinal,
}: RowToTxnArgs): TransactionRecord | null {
  if (row.every((f) => !f?.trim())) {
    return null;
  }
  const rawDate = idx.idxDate >= 0 ? (row[idx.idxDate] ?? null) : null;
  const date = isoDate(rawDate);
  if (!date) {
    return null;
  }
  const description = idx.idxDesc >= 0 ? (row[idx.idxDesc] ?? "").trim() : "";
  const original = idx.idxOrig >= 0 ? (row[idx.idxOrig] ?? "").trim() || description : description;
  const amount = idx.idxAmt >= 0 ? (row[idx.idxAmt] ?? "").trim() : "";
  const tupleKey = `${date}|${amount}|${original}`;
  const ord = tupleOrdinal.get(tupleKey) || 0;
  tupleOrdinal.set(tupleKey, ord + 1);
  const checkMatch = original.match(CHECK_NUMBER_RE);
  const id = hashId(`${accountId}|${tupleKey}|#${ord}`);
  const categoryRaw = idx.idxCat >= 0 ? (row[idx.idxCat] ?? "").trim() || null : null;
  const balanceRaw = idx.idxBal >= 0 ? (row[idx.idxBal] ?? null) : null;
  return {
    id,
    account_id: accountId,
    account_name: accountName,
    date,
    description,
    original_description: original,
    category: categoryRaw,
    amount: currencyToCents(amount) ?? 0,
    currency: "USD",
    balance_after_cents: balanceRaw ? currencyToCents(balanceRaw) : null,
    check_number: checkMatch?.[1] ?? null,
    source: "csv_export",
    fetched_at: fetchedAt,
  };
}

export function rowsToTransactions(
  rows: string[][],
  { accountId, accountName, fetchedAt }: { accountId: string; accountName: string | null; fetchedAt: string }
): TransactionRecord[] {
  if (rows.length < 2) {
    return [];
  }
  const header = rows[0] ?? [];
  const idx = csvHeaderIndices(header);
  const out: TransactionRecord[] = [];
  const tupleOrdinal = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) {
      continue;
    }
    const rec = csvRowToTransaction({
      row,
      idx,
      accountId,
      accountName,
      fetchedAt,
      tupleOrdinal,
    });
    if (rec) {
      out.push(rec);
    }
  }
  return out;
}

// ─── Statement-PDF transaction parsers ───────────────────────────────────

interface EraParseArgs {
  closing: StatementClosing;
}

function resolveLineClosing(yRaw: string | undefined, closing: StatementClosing): ClosingContext {
  if (yRaw) {
    return yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
  }
  return closing;
}

function parseModernTxnLine(
  line: string,
  closing: StatementClosing,
  tupleOrd: Map<string, number>
): ParsedStatementTxn | null {
  const m = line.match(MODERN_TXN_LINE_RE);
  if (!m) {
    return null;
  }
  const [, mmRaw, ddRaw, yRaw, descRaw, amountRaw, balanceRaw] = m;
  if (!(mmRaw && ddRaw && descRaw && amountRaw)) {
    return null;
  }
  const ctx = resolveLineClosing(yRaw, closing);
  const iso = toIso(mmRaw, ddRaw, ctx);
  if (!iso) {
    return null;
  }
  const description = descRaw.replace(WS_RUN_2PLUS_RE, " ").trim();
  const amount = currencyToCentsFromStatement(amountRaw);
  const balance = balanceRaw ? currencyToCentsFromStatement(balanceRaw) : null;
  if (amount == null) {
    return null;
  }
  const tupleKey = `${iso}|${amount}|${description}`;
  const ord = tupleOrd.get(tupleKey) || 0;
  tupleOrd.set(tupleKey, ord + 1);
  return { iso, amount, description, balance, tupleKey, ord };
}

/**
 * Era A/B parser: line-by-line scan for rows that start with a date.
 * Handles "MM/DD" (inherits statement year) and "MM/DD/YY" formats.
 */
export function parseModernCheckingEra(text: string, { closing }: EraParseArgs): ParsedStatementTxn[] {
  const lines = text.split(STMT_LINE_SPLIT_RE);
  const txns: ParsedStatementTxn[] = [];
  let inTable = false;
  const tupleOrd = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (MODERN_SECTION_START_RE.test(line)) {
      inTable = true;
      continue;
    }
    if (MODERN_SECTION_END_RE.test(line)) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      continue;
    }
    const txn = parseModernTxnLine(line, closing, tupleOrd);
    if (txn) {
      txns.push(txn);
    }
  }
  return txns;
}

function parseCreditTxnLine(
  line: string,
  closing: StatementClosing,
  tupleOrd: Map<string, number>
): ParsedStatementTxn | null {
  const m = line.match(CREDIT_TXN_LINE_RE);
  if (!m) {
    return null;
  }
  const [, mmRaw, ddRaw, , , descRaw, amountRaw] = m;
  if (!(mmRaw && ddRaw && descRaw && amountRaw)) {
    return null;
  }
  const iso = toIso(mmRaw, ddRaw, closing);
  if (!iso) {
    return null;
  }
  const description = descRaw.replace(WS_RUN_2PLUS_RE, " ").trim();
  const amount = currencyToCentsFromStatement(amountRaw);
  if (amount == null) {
    return null;
  }
  const tupleKey = `${iso}|${amount}|${description}`;
  const ord = tupleOrd.get(tupleKey) || 0;
  tupleOrd.set(tupleKey, ord + 1);
  return { iso, amount, description, balance: null, tupleKey, ord };
}

/**
 * Era C parser for credit-card statements. Credit-card tables surface
 * "Trans Date | Post Date | Description | Amount" with "MM/DD" dates and
 * amounts (trailing minus = credit) in the rightmost column.
 */
export function parseCreditCardEra(text: string, { closing }: EraParseArgs): ParsedStatementTxn[] {
  const lines = text.split(STMT_LINE_SPLIT_RE);
  const txns: ParsedStatementTxn[] = [];
  let inTable = false;
  const tupleOrd = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (CREDIT_SECTION_START_RE.test(line) && !CREDIT_SECTION_TOTAL_RE.test(line)) {
      inTable = true;
      continue;
    }
    if (CREDIT_SECTION_END_RE.test(line)) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      continue;
    }
    const txn = parseCreditTxnLine(line, closing, tupleOrd);
    if (txn) {
      txns.push(txn);
    }
  }
  return txns;
}

// ─── Check-number extraction (shared) ────────────────────────────────────

export function checkNumberFromDescription(description: string): string | null {
  const m = description.match(CHECK_NUMBER_RE);
  return m?.[1] ?? null;
}
