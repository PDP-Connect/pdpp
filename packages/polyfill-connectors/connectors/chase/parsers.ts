// Pure parsers for the Chase connector. Kept free of Playwright / Node
// I/O (except sha256 + fs path helpers that are purely computational)
// so they can be unit-tested in isolation.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: linkedom is declared in package.json; Biome's resolver can't follow its conditional exports
import { parseHTML } from "linkedom";
import type {
  ActivityChoice,
  ActivityKind,
  ChaseAccount,
  ChaseAccountType,
  CurrentActivityRow,
  CurrentActivityStatus,
  OfxRecord,
  OfxValue,
  QfxBalance,
  QfxExtracted,
  QfxTransaction,
  StatementRow,
  TransactionsStateShape,
} from "./types.ts";

// ─── Tunables shared with the connector entry ────────────────────────────

const HASH_SLUG_LEN = 32;
const CENTS_MULTIPLIER = 100;

// ─── Shared module-scope regexes (Biome useTopLevelRegex) ────────────────
// These were hoisted from page.evaluate() callbacks when we moved DOM
// parsing from the browser bridge to linkedom. In-Node regexes can live
// at module scope; they previously had to be redeclared inside the
// browser callback because module-scoped values can't cross the
// serialization boundary.
const DASHBOARD_ACCOUNT_ID_RE = /^accounts-name-link-button-(\d+)(?:-label)?$/;
const CARD_RE = /(Sapphire|Freedom|Ink|Amazon|Southwest|United|Hyatt|Disney|Marriott|IHG|Prime|Platinum|Slate)/i;
const CHECKING_RE = /(Checking|Total Checking|Premier Checking)/i;
const SAVINGS_RE = /(Savings|Premier Savings)/i;
const WS_RE = /\s+/g;
const LAST4_RE = /\.\.\.(\d{3,4})/;

const ANCHOR_ID_RE = /accountsTable-\d+-row\d+-cell\d+-requestThisDocumentAnchor-download/;
const ACCORDION_ID_RE = /documentsAccordion-(\d+)/;
const TABLE_ROW_RE = /accountsTable-(\d+)-row(\d+)-/;
const STATEMENT_RE = /statement/i;

const ACCOUNT_SLUG_SAFE_RE = /^[A-Za-z0-9_-]+$/;
const STATEMENT_LAST_FOUR_RE = /\.\.\.(\d{3,4})/;
const AMOUNT_RE = /(?:[-+]?\s*\$\s*\d[\d,]*(?:\.\d{2})?|\(\s*\$?\s*\d[\d,]*(?:\.\d{2})?\s*\))/;
const DATE_NUMERIC_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const DATE_MONTH_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i;
const ACTIVITY_DEBIT_RE = /-|\(|\bwithdrawal\b|\bpurchase\b|\bdebit\b/i;
const PENDING_RE = /\bpending\b/i;
const POSTED_RE = /\bposted\b|\bcompleted\b/i;
const MONTH_DOT_RE = /\.$/;
const DIGIT_RE = /\d/;
const CURRENT_ACTIVITY_SELECTOR =
  '[data-testid*="transaction" i], [data-testid*="activity" i], [id*="transaction" i], [id*="activity" i], tr';
const UI_TRANSACTION_ID_ATTRS = [
  "data-transaction-id",
  "data-transactionid",
  "data-activity-id",
  "data-id",
  "id",
] as const;
const HASHED_ID_RE = /^(?:row-|transaction-|activity-)?[A-Za-z0-9_-]{8,}$/;

const MONTH_INDEX: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

// ─── Text helpers ─────────────────────────────────────────────────────────

function textOf(el: Element | null | undefined): string {
  if (!el) {
    return "";
  }
  // linkedom exposes innerText on HTMLElement-ish nodes; fall back to
  // textContent for safety. Both collapse similarly after /\s+/ normalization.
  const maybe = (el as { innerText?: string }).innerText;
  return typeof maybe === "string" ? maybe : (el.textContent ?? "");
}

function normWhitespace(s: string): string {
  return s.replace(WS_RE, " ").trim();
}

// ─── Error-message helpers (also used by the runtime entry) ──────────────

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// ─── Hash + URL helpers ──────────────────────────────────────────────────

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

export function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, HASH_SLUG_LEN);
}

export function fileUrl(p: string | null | undefined): string | null {
  if (!p) {
    return null;
  }
  return pathToFileURL(p).href;
}

// ─── Date helpers ─────────────────────────────────────────────────────────

/**
 * "YYYY-MM-DD" → "MMDDYYYY" (Chase date-picker's accepted packed form).
 * Returns null if the input is missing any of the three date parts.
 */
export function isoToPacked(iso: string): string | null {
  const parts = iso.split("-");
  const [y, m, d] = parts;
  if (!(y && m && d)) {
    return null;
  }
  return `${m}${d}${y}`;
}

/**
 * Chase's Statements page renders dates like "Apr 13, 2026". v8's Date
 * parser handles that reliably; we lower-cap into YYYY-MM-DD.
 */
export function parseDateDelivered(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

export function yearMonthFromIso(iso: string | null): string {
  return iso ? iso.slice(0, 7) : "unknown";
}

export function accountSlug(accountId: string | null): string {
  if (!accountId) {
    return "unknown";
  }
  if (ACCOUNT_SLUG_SAFE_RE.test(accountId)) {
    return accountId;
  }
  return shortHash(accountId);
}

// ─── OFX value helpers ────────────────────────────────────────────────────

export function isOfxRecord(v: OfxValue): v is OfxRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function ofxGet(v: OfxValue, key: string): OfxValue {
  return isOfxRecord(v) ? v[key] : undefined;
}

export function ofxString(v: OfxValue): string | null {
  if (v == null) {
    return null;
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return null;
}

export function ofxNumber(v: OfxValue): number | null {
  if (v == null) {
    return null;
  }
  let s: string;
  if (typeof v === "string") {
    s = v;
  } else if (typeof v === "number") {
    s = String(v);
  } else {
    s = "";
  }
  if (!s) {
    return null;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// OFX datetime format: YYYYMMDDHHMMSS[.sss][TZ] — strip to YYYY-MM-DD.
export function ofxDateToIso(raw: OfxValue): string | null {
  const src = ofxString(raw);
  if (!src) {
    return null;
  }
  const s = src.trim();
  if (s.length < 8) {
    return null;
  }
  const y = s.slice(0, 4);
  const m = s.slice(4, 6);
  const d = s.slice(6, 8);
  return `${y}-${m}-${d}`;
}

export function ofxDateToFullIso(raw: OfxValue): string | null {
  const src = ofxString(raw);
  if (!src) {
    return null;
  }
  const s = src.trim();
  if (s.length < 8) {
    return null;
  }
  const date = ofxDateToIso(s);
  if (!date) {
    return null;
  }
  const hh = s.slice(8, 10) || "00";
  const mm = s.slice(10, 12) || "00";
  const ss = s.slice(12, 14) || "00";
  return `${date}T${hh}:${mm}:${ss}Z`;
}

// ─── Dashboard DOM parsing (accounts list) ────────────────────────────────

function classifyAccountType(displayName: string): ChaseAccountType {
  if (CARD_RE.test(displayName)) {
    return "credit_card";
  }
  if (CHECKING_RE.test(displayName)) {
    return "checking";
  }
  if (SAVINGS_RE.test(displayName)) {
    return "savings";
  }
  return "unknown";
}

/**
 * Parse the Chase dashboard-overview HTML into ChaseAccount rows. Mirrors
 * the former page.evaluate() callback but runs in Node via linkedom so it
 * can be unit-tested offline.
 *
 * Chase has rendered account cards in two observed shapes:
 *   <span id="accounts-name-link-button-<INTERNAL_ID>-label">...</span>
 *   <button id="accounts-name-link-button-<INTERNAL_ID>">...</button>
 *
 * The INTERNAL_ID is stable and is what the download form's account selector
 * expects. We pull every supported label/button, extract the id, name, last
 * four, and heuristic type.
 */
export function parseDashboardAccountsDom(html: string): ChaseAccount[] {
  const { document } = parseHTML(html);
  const labels = [
    ...document.querySelectorAll<HTMLElement>(
      '[id^="accounts-name-link-button-"][id$="-label"], button[id^="accounts-name-link-button-"], button[data-testid^="accounts-name-link-button-"]'
    ),
  ];
  const results: ChaseAccount[] = [];
  const seen = new Set<string>();
  for (const el of labels) {
    const id = el.id || el.getAttribute("data-testid") || "";
    const idMatch = DASHBOARD_ACCOUNT_ID_RE.exec(id);
    if (!idMatch?.[1]) {
      continue;
    }
    if (seen.has(idMatch[1])) {
      continue;
    }
    seen.add(idMatch[1]);
    const displayName = normWhitespace(textOf(el));
    const lastFourMatch = LAST4_RE.exec(displayName);
    results.push({
      internal_id: idMatch[1],
      name: displayName,
      type: classifyAccountType(displayName),
      last_four: lastFourMatch?.[1] ?? null,
    });
  }
  return results;
}

function parseVisibleAmount(text: string): number | null {
  const match = AMOUNT_RE.exec(text.replace(/\u2212/g, "-"));
  if (!match?.[0]) {
    return null;
  }
  const raw = match[0];
  const sign = ACTIVITY_DEBIT_RE.test(text) ? -1 : 1;
  const normalized = raw.replace(/[$,\s+-]/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? Math.round(n * CENTS_MULTIPLIER) * sign : null;
}

function inferActivityStatus(text: string): CurrentActivityStatus {
  if (PENDING_RE.test(text)) {
    return "pending";
  }
  if (POSTED_RE.test(text)) {
    return "posted";
  }
  return "unknown";
}

function parseVisibleDate(text: string, referenceDateIso: string): string | null {
  const month = DATE_MONTH_RE.exec(text);
  if (month?.[1] && month[2]) {
    const monthNum = MONTH_INDEX[month[1].toLowerCase().replace(MONTH_DOT_RE, "")];
    const year = month[3] ?? referenceDateIso.slice(0, 4);
    if (monthNum) {
      return `${year.padStart(4, "20")}-${monthNum}-${month[2].padStart(2, "0")}`;
    }
  }
  const numeric = DATE_NUMERIC_RE.exec(text);
  if (numeric?.[1] && numeric[2]) {
    const yearRaw = numeric[3] ?? referenceDateIso.slice(0, 4);
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    return `${year}-${numeric[1].padStart(2, "0")}-${numeric[2].padStart(2, "0")}`;
  }
  return null;
}

function extractUiTransactionId(el: Element): string | null {
  for (const attr of UI_TRANSACTION_ID_ATTRS) {
    const value = el.getAttribute(attr);
    if (value && HASHED_ID_RE.test(value)) {
      return value;
    }
  }
  return null;
}

function normalizeDescription(text: string): string {
  return normWhitespace(
    text
      .replace(AMOUNT_RE, " ")
      .replace(DATE_MONTH_RE, " ")
      .replace(DATE_NUMERIC_RE, " ")
      .replace(/\b(Pending|Posted|Completed)\b/gi, " ")
  );
}

export function currentActivityId(accountId: string, row: CurrentActivityRow): string {
  if (row.ui_transaction_id) {
    return `${accountId}|${row.ui_transaction_id}`;
  }
  return `${accountId}|fallback:${shortHash(
    [row.status, row.activity_date, row.posted_date ?? "", row.amount_cents, row.description.toLowerCase()].join("|")
  )}`;
}

/**
 * Parse Chase account-activity DOM visible to the signed-in UI. This parser is
 * intentionally conservative: a candidate row must contain both a recognizable
 * date and amount, and the remaining text becomes the visible descriptor.
 */
export function parseCurrentActivityDom(html: string, referenceDateIso: string): CurrentActivityRow[] {
  const { document } = parseHTML(html);
  const rows: CurrentActivityRow[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll<HTMLElement>(CURRENT_ACTIVITY_SELECTOR)) {
    const text = normWhitespace(textOf(el));
    if (!(text && DIGIT_RE.test(text))) {
      continue;
    }
    const activityDate = parseVisibleDate(text, referenceDateIso);
    const amountCents = parseVisibleAmount(text);
    if (!(activityDate && amountCents !== null)) {
      continue;
    }
    const description = normalizeDescription(text);
    if (!description || description.length > 240) {
      continue;
    }
    const uiTransactionId = extractUiTransactionId(el);
    const row: CurrentActivityRow = {
      activity_date: activityDate,
      amount_cents: amountCents,
      description,
      memo: null,
      posted_date: inferActivityStatus(text) === "posted" ? activityDate : null,
      status: inferActivityStatus(text),
      ui_transaction_id: uiTransactionId,
    };
    const dedupeKey = [uiTransactionId ?? "", row.status, row.activity_date, row.amount_cents, row.description].join(
      "|"
    );
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    rows.push(row);
  }
  return rows;
}

// ─── Statements DOM parsing ──────────────────────────────────────────────

interface AccordionInfo {
  label: string;
  tableIdx: string | undefined;
}

function collectAccordions(document: Document): Map<string, string> {
  const accordions: AccordionInfo[] = [
    ...document.querySelectorAll<HTMLElement>('[id^="button-documentsAccordion-"]'),
  ].map((b): AccordionInfo => {
    const m = ACCORDION_ID_RE.exec(b.id);
    return {
      tableIdx: m?.[1],
      label: normWhitespace(textOf(b)),
    };
  });
  const accountByTableIdx = new Map<string, string>();
  for (const a of accordions) {
    if (a.tableIdx) {
      accountByTableIdx.set(a.tableIdx, a.label);
    }
  }
  return accountByTableIdx;
}

function findParentRow(el: Element): Element | null {
  let tr: Element | null = el;
  while (tr && tr.tagName !== "TR") {
    tr = tr.parentElement;
  }
  return tr;
}

/**
 * Enumerate the statement rows rendered on Chase's Statements & Documents
 * page. Mirrors the prior page.evaluate() body, now run via linkedom in
 * Node. Each statement row maps to one monthly PDF download anchor.
 *
 * Only rows whose doc_kind matches /statement/i are returned — tax
 * documents and other row kinds are skipped at the parse layer so the
 * caller doesn't need to filter.
 */
export function parseStatementsListDom(html: string): StatementRow[] {
  const { document } = parseHTML(html);
  const accountByTableIdx = collectAccordions(document);
  const anchors = [...document.querySelectorAll<HTMLElement>("a[id]")].filter((el) => ANCHOR_ID_RE.test(el.id ?? ""));
  const rows: StatementRow[] = [];
  for (const a of anchors) {
    const anchorId = a.id ?? "";
    const m = TABLE_ROW_RE.exec(anchorId);
    const tableIdx = m?.[1];
    const rowIdx = m?.[2];
    const tr = findParentRow(a);
    const cells: Element[] = tr ? [...tr.querySelectorAll("td, th")] : [];
    const date_delivered_raw = textOf(cells[0]).trim();
    const doc_kind = textOf(cells[1]).trim();
    if (!(doc_kind && STATEMENT_RE.test(doc_kind))) {
      continue;
    }
    const account_reference = tableIdx ? (accountByTableIdx.get(tableIdx) ?? null) : null;
    const title = [date_delivered_raw, doc_kind, account_reference].filter(Boolean).join(" ");
    rows.push({
      rowAnchorId: anchorId,
      tableIdx,
      rowIdx,
      date_delivered_raw,
      doc_kind,
      account_reference,
      title,
    });
  }
  return rows;
}

/**
 * Resolve a statement row's `account_reference` text (e.g.
 * "SAPPHIRE PREFERRED (...9241)") to the stable Chase internal account id
 * from our accounts array. Matches last-four first, then name substring.
 */
export function resolveAccountIdForRow(row: StatementRow, accounts: readonly ChaseAccount[]): string | null {
  if (!row.account_reference) {
    return null;
  }
  const last4Match = STATEMENT_LAST_FOUR_RE.exec(row.account_reference);
  if (last4Match?.[1]) {
    const byLast4 = accounts.find((a) => a.last_four === last4Match[1]);
    if (byLast4) {
      return byLast4.internal_id;
    }
  }
  const refLower = row.account_reference.toLowerCase();
  const byName = accounts.find((a) => a.name && refLower.includes(a.name.toLowerCase()));
  return byName ? byName.internal_id : null;
}

// ─── QFX structural extraction ───────────────────────────────────────────

function extractTransactions(stmt: OfxValue, currency: string): QfxTransaction[] {
  const trList = ofxGet(stmt, "BANKTRANLIST");
  const rawTxns = ofxGet(trList, "STMTTRN");
  let txnArray: OfxValue[];
  if (Array.isArray(rawTxns)) {
    txnArray = rawTxns;
  } else if (rawTxns) {
    txnArray = [rawTxns];
  } else {
    txnArray = [];
  }
  const transactions: QfxTransaction[] = [];
  for (const t of txnArray) {
    const amtStr = (ofxString(ofxGet(t, "TRNAMT")) ?? "0").trim();
    const amountCents = Math.round(Number(amtStr) * CENTS_MULTIPLIER);
    const fitid = ofxString(ofxGet(t, "FITID")) ?? "";
    const date = ofxDateToIso(ofxGet(t, "DTPOSTED"));
    if (!(fitid && date)) {
      continue;
    }
    transactions.push({
      fitid,
      date,
      amount_cents: amountCents,
      currency,
      type: ofxString(ofxGet(t, "TRNTYPE")),
      name: ofxString(ofxGet(t, "NAME")),
      memo: ofxString(ofxGet(t, "MEMO")),
      check_number: ofxString(ofxGet(t, "CHECKNUM")),
      reference_number: ofxString(ofxGet(t, "REFNUM")),
    });
  }
  return transactions;
}

function extractBalance(stmt: OfxValue): QfxBalance | null {
  const ledgerBal = ofxGet(stmt, "LEDGERBAL");
  const availBal = ofxGet(stmt, "AVAILBAL");
  if (!(ledgerBal || availBal)) {
    return null;
  }
  const asOf = ofxDateToFullIso(ofxGet(ledgerBal, "DTASOF") ?? ofxGet(availBal, "DTASOF"));
  if (!asOf) {
    return null;
  }
  const ledgerAmt = ofxNumber(ofxGet(ledgerBal, "BALAMT"));
  const availAmt = ofxNumber(ofxGet(availBal, "BALAMT"));
  return {
    as_of: asOf,
    ledger_cents: ledgerAmt == null ? null : Math.round(ledgerAmt * CENTS_MULTIPLIER),
    available_cents: availAmt == null ? null : Math.round(availAmt * CENTS_MULTIPLIER),
  };
}

/**
 * Walk an ofx-js parsed structure and extract our canonical shape.
 * Credit cards live under CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS;
 * checking/savings under BANKMSGSRSV1 > STMTTRNRS > STMTRS. Structures
 * are otherwise parallel.
 */
export function extractFromQfx(parsed: unknown): QfxExtracted {
  const root: OfxValue = ofxGet(parsed, "OFX") ?? parsed;
  if (!isOfxRecord(root)) {
    return { transactions: [], balance: null };
  }

  const cc = ofxGet(ofxGet(ofxGet(root, "CREDITCARDMSGSRSV1"), "CCSTMTTRNRS"), "CCSTMTRS");
  const bank = ofxGet(ofxGet(ofxGet(root, "BANKMSGSRSV1"), "STMTTRNRS"), "STMTRS");
  let stmt: OfxValue = null;
  if (isOfxRecord(cc)) {
    stmt = cc;
  } else if (isOfxRecord(bank)) {
    stmt = bank;
  }
  if (!stmt) {
    return { transactions: [], balance: null };
  }

  const currency = ofxString(ofxGet(stmt, "CURDEF")) ?? "USD";
  const transactions = extractTransactions(stmt, currency);
  const balance = extractBalance(stmt);
  return { transactions, balance };
}

// ─── Activity choice (cursor + scope → ActivityKind) ─────────────────────

// Minimal shape for the time_range slice we consume from StreamScope,
// duplicated here so parsers.ts doesn't reach into connector-runtime.ts.
interface TimeRange {
  since?: string;
  until?: string;
}

export interface StreamScopeLike {
  time_range?: TimeRange;
}

/**
 * Pick the QFX download "activity" option for a given account based on
 * (1) an explicit scope time_range, (2) an existing cursor's
 * max_seen_date, or (3) "all" as the bootstrap default.
 */
export function chooseActivity(
  requested: Map<string, StreamScopeLike>,
  state: TransactionsStateShape,
  stream: string,
  accountId: string
): ActivityChoice {
  const streamScope = requested.get(stream);
  const timeRange = streamScope?.time_range;
  if (timeRange?.since || timeRange?.until) {
    return {
      activity: "date_range",
      dateRange: {
        from: timeRange.since?.slice(0, 10),
        to: timeRange.until?.slice(0, 10),
      },
    };
  }
  const cursor = state.per_account?.[accountId];
  if (cursor?.max_seen_date) {
    return { activity: "since_last_statement" };
  }
  return { activity: "all" };
}

// ─── Public labels used by the click-path (exported for entry point) ──────

export const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  all: "All transactions",
  since_last_statement: "Since last statement",
  year_to_date: "Year to date",
  last_year: "Last year",
  current: "Current display, including filters",
  date_range: "Choose a date range",
};
