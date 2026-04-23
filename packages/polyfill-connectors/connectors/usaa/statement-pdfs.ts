/**
 * USAA statement-PDF archive + parser.
 *
 * Phase A: for each row in /my/documents, drive the "Options" kebab -> "Download"
 * menu to trigger the PDF download. Save each PDF to
 *   ~/.pdpp/usaa-statements/<account_id>/<YYYY-MM>-<hash>.pdf
 * and return an array of hydrated-statement records (pdf_path, pdf_sha256,
 * document_url as file://) alongside pdf bytes.
 *
 * Phase B: run each PDF through pdf-parse, split the transaction table by
 * known USAA statement templates, and emit transactions with
 *   source: "pdf_statement_<YYYY-MM>"
 * and an id hash compatible with the CSV path so rows de-dupe cleanly.
 *
 * Selector strategy (live capture deferred — see design-notes/usaa-historical-
 * coverage-gap.md). The /my/documents UI on 2026-04-19 showed a table of rows
 * with the final cell containing an "Options" control; clicking it opens a
 * small menu with a "Download" item that fires a PDF download. The selectors
 * below try several shapes in order so the first-run failure emits diagnostics
 * rather than silently broken. If all fail we fall back to opening the row
 * link (`<a>`) which USAA sometimes surfaces as a direct-PDF link.
 */

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Locator, Page } from "playwright";
import type { DownloadQueue } from "../../src/download-queue.ts";

const STATEMENT_ROOT = join(homedir(), ".pdpp", "usaa-statements");

// Module-level regexes (Biome useTopLevelRegex) — compiled once, reused
// across parser passes and per-row driver calls.
const SLUG_SAFE_RE = /^[A-Za-z0-9_-]+$/;
const OPTIONS_BUTTON_TEXT_RE = /^\s*(Options|More|\.{3})\s*$/i;
const DOWNLOAD_MENU_ITEM_RE = /download/i;
const DOWNLOAD_BUTTON_TEXT_RE = /^\s*Download( PDF)?\s*$/i;
const DOCUMENTS_PATH_RE = /\/my\/documents/;
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
const CHECK_NUMBER_RE = /CHECK\s*#?\s*0*(\d+)/i;

// ─── Types ────────────────────────────────────────────────────────────────

/** Per-row input to hydrateStatementPdfs. */
export interface StatementRow {
  account_id: string | null;
  account_reference?: string | null;
  date_delivered: string | null;
  id: string;
  rowIndex: number;
  title: string | null;
}

interface DownloadOk {
  buffer: Buffer;
  ok: true;
  suggestedFilename: string;
}
interface DownloadFail {
  diag?: Record<string, unknown> | null;
  ok: false;
  reason: string;
}
type DownloadResult = DownloadOk | DownloadFail;

export interface HydratedStatement {
  buffer: Buffer;
  pdfPath: string;
  pdfSha256: string;
  statement: StatementRow;
  suggestedFilename: string;
}

/** {closingYear, closingMonth} or a bare year (legacy callers). */
type ClosingContext = number | { closingMonth: number; closingYear: number } | null | undefined;

interface ParsedTxn {
  amount: number;
  balance: number | null;
  description: string;
  iso: string;
  ord: number;
  tupleKey: string;
}

export interface StatementTxnRecord {
  account_id: string;
  account_name: string | null;
  amount: number;
  balance_after_cents: number | null;
  category: string | null;
  check_number: string | null;
  currency: "USD";
  date: string;
  description: string;
  fetched_at: string;
  id: string;
  original_description: string;
  source: string;
}

export interface ParseMetaOk {
  closingMonth?: number;
  era: string;
  year: number;
}
export interface ParseMetaUnknown {
  era: "unknown";
  rawTextSample: string;
  year: number;
}
export type ParseMeta = ParseMetaOk | ParseMetaUnknown;

// ─── Download orchestration ───────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeAccountSlug(accountId: string | null | undefined, fallback: string | null | undefined): string {
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

function yearMonthFromDate(isoDate: string | null | undefined): string {
  // isoDate is "YYYY-MM-DD"; returns "YYYY-MM".
  if (!isoDate) {
    return "unknown";
  }
  return isoDate.slice(0, 7);
}

/**
 * Locate the per-row "Options" trigger. USAA's documents table renders as a
 * standard <table> with the trailing cell containing either a button labeled
 * "Options" / "..." or an icon-only button with aria-label containing
 * "Options" or "More". Try each in order; the first match wins.
 */
async function locateRowOptionsButton(row: Locator): Promise<Locator | null> {
  const candidates: Locator[] = [
    row.locator('button[aria-label*="Options" i], button[aria-label*="More" i]').first(),
    row.locator('[role="button"][aria-label*="Options" i], [role="button"][aria-label*="More" i]').first(),
    row.locator("button", { hasText: OPTIONS_BUTTON_TEXT_RE }).first(),
    // Icon-only kebab: last button in the last cell.
    row.locator("td").last().locator('button, [role="button"]').last(),
  ];
  for (const c of candidates) {
    if (await c.count().catch(() => 0)) {
      return c;
    }
  }
  return null;
}

/**
 * Locate the "Download" / "Download PDF" menu item in an open menu. Menus
 * on USAA's SPA are usually `[role="menu"]` with `[role="menuitem"]`
 * children, but some legacy components use plain buttons/links. Try each.
 */
async function locateDownloadMenuItem(page: Page): Promise<Locator | null> {
  const candidates: Locator[] = [
    page.locator('[role="menuitem"]', { hasText: DOWNLOAD_MENU_ITEM_RE }).first(),
    page
      .locator('[role="menu"] a, [role="menu"] button', {
        hasText: DOWNLOAD_MENU_ITEM_RE,
      })
      .first(),
    page.locator("a, button").filter({ hasText: DOWNLOAD_BUTTON_TEXT_RE }).first(),
  ];
  for (const c of candidates) {
    if (await c.count().catch(() => 0)) {
      return c;
    }
  }
  return null;
}

/**
 * Drive a single statement row to capture its PDF. Returns
 *   { ok: true, buffer, suggestedFilename } on success
 *   { ok: false, reason, diag }            on failure
 */
async function downloadStatementFromRow({
  page,
  rowIndex,
  downloadQueue,
}: {
  page: Page;
  rowIndex: number;
  downloadQueue: DownloadQueue;
}): Promise<DownloadResult> {
  const row = page.locator("tbody tr").nth(rowIndex);
  if (!(await row.count().catch(() => 0))) {
    return { ok: false, reason: "row_missing" };
  }

  const optBtn = await locateRowOptionsButton(row);
  if (!optBtn) {
    // Fallback: if the row has a direct <a> pointing at a PDF, use that.
    const link = row.locator('a[href$=".pdf"], a[href*=".pdf?"]').first();
    if (await link.count().catch(() => 0)) {
      const dlPromise = downloadQueue.waitForNextDownload({
        timeoutMs: 180_000,
      });
      await link.click({ timeout: 5000 }).catch(() => {
        /* ignore */
      });
      try {
        const dl = await dlPromise;
        const path = await dl.path();
        if (!path) {
          return { ok: false, reason: "download_no_path" };
        }
        const { readFile } = await import("node:fs/promises");
        const buffer = await readFile(path);
        return { ok: true, buffer, suggestedFilename: dl.suggestedFilename() };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          reason: "direct_link_failed",
          diag: { error: msg.slice(0, 160) },
        };
      }
    }
    return { ok: false, reason: "no_options_affordance" };
  }

  try {
    await optBtn.click({ timeout: 5000 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "options_click_failed",
      diag: { error: msg.slice(0, 160) },
    };
  }
  await sleep(500);

  const dlItem = await locateDownloadMenuItem(page);
  if (!dlItem) {
    // Dump menu HTML to aid the next runner.
    const menuHtml = await page
      .locator('[role="menu"]')
      .first()
      .innerHTML()
      .catch(() => null);
    // Dismiss whatever popped open so we don't cascade-break the next row.
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    return {
      ok: false,
      reason: "no_download_menuitem",
      diag: {
        menu_html: menuHtml ? menuHtml.replace(/\s+/g, " ").slice(0, 500) : null,
      },
    };
  }

  const dlPromise = downloadQueue.waitForNextDownload({ timeoutMs: 180_000 });
  try {
    await dlItem.click({ timeout: 5000 });
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "download_click_failed",
      diag: { error: msg.slice(0, 160) },
    };
  }

  try {
    const dl = await dlPromise;
    const path = await dl.path();
    if (!path) {
      return { ok: false, reason: "download_no_path" };
    }
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(path);
    // Close any menu that may still be open before returning.
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    return { ok: true, buffer, suggestedFilename: dl.suggestedFilename() };
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "download_timeout",
      diag: { error: msg.slice(0, 160) },
    };
  }
}

/**
 * Persist a PDF to disk at ~/.pdpp/usaa-statements/<account_slug>/<YYYY-MM>-<sha8>.pdf.
 * Skips rewriting if the file already exists with the same content hash.
 * Returns { pdfPath, pdfSha256 }.
 */
async function persistPdf({
  buffer,
  accountId,
  dateDelivered,
}: {
  buffer: Buffer;
  accountId: string | null;
  dateDelivered: string | null;
}): Promise<{ pdfPath: string; pdfSha256: string }> {
  const pdfSha256 = sha256Hex(buffer);
  const slug = safeAccountSlug(accountId, "unknown");
  const dir = join(STATEMENT_ROOT, slug);
  await mkdir(dir, { recursive: true });
  const ym = yearMonthFromDate(dateDelivered);
  const pdfPath = join(dir, `${ym}-${pdfSha256.slice(0, 16)}.pdf`);
  // Re-write is a cheap idempotency guarantee; skip if already at same size.
  const existing = await stat(pdfPath).catch(() => null);
  if (!existing || existing.size !== buffer.length) {
    await writeFile(pdfPath, buffer);
  }
  return { pdfPath, pdfSha256 };
}

/**
 * Hydrate every row in the currently-loaded /my/documents table. Callers
 * pass `onRecord({ index, statement, result })` to react per-row as we go
 * (so the main connector can emit hydrated statement records incrementally
 * and still make progress if the page/session dies partway through).
 *
 * Returns an array of { statement, pdfPath, pdfSha256, buffer } for every
 * successful download, and emits SKIP-equivalent diagnostics via onSkip
 * for rows that failed.
 */
export async function hydrateStatementPdfs({
  page,
  statements,
  // statements: Array<{ rowIndex, id, account_id, date_delivered, title, account_reference }>
  downloadQueue, // see src/download-queue.js — MUST be attached before clicks
  onProgress,
  onSkip,
}: {
  page: Page;
  statements: StatementRow[];
  downloadQueue: DownloadQueue;
  onProgress?: (p: { index: number; total: number; title: string | null }) => void;
  onSkip?: (p: { statement: StatementRow; reason: string; diag: Record<string, unknown> | null }) => void;
}): Promise<HydratedStatement[]> {
  const hydrated: HydratedStatement[] = [];
  if (!statements.length) {
    return hydrated;
  }
  if (!downloadQueue) {
    throw new Error("hydrateStatementPdfs requires downloadQueue");
  }

  // Make sure we're on the documents page — caller is expected to have
  // navigated here already, but a defensive reload protects against state
  // drift if hydrateStatementPdfs is invoked after other flows ran.
  if (!DOCUMENTS_PATH_RE.test(page.url())) {
    await page
      .goto("https://www.usaa.com/my/documents", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch(() => {
        /* ignore */
      });
    await sleep(5000);
  }

  for (const s of statements) {
    if (onProgress) {
      onProgress({
        index: s.rowIndex,
        total: statements.length,
        title: s.title,
      });
    }
    const result = await downloadStatementFromRow({
      page,
      rowIndex: s.rowIndex,
      downloadQueue,
    });
    if (!result.ok) {
      if (onSkip) {
        onSkip({
          statement: s,
          reason: result.reason,
          diag: result.diag ?? null,
        });
      }
      continue;
    }
    try {
      const { pdfPath, pdfSha256 } = await persistPdf({
        buffer: result.buffer,
        accountId: s.account_id,
        dateDelivered: s.date_delivered,
      });
      hydrated.push({
        statement: s,
        pdfPath,
        pdfSha256,
        buffer: result.buffer,
        suggestedFilename: result.suggestedFilename,
      });
    } catch (err) {
      if (onSkip) {
        const msg = err instanceof Error ? err.message : String(err);
        onSkip({
          statement: s,
          reason: "persist_failed",
          diag: { error: msg.slice(0, 160) },
        });
      }
    }
    // Small jitter between rows so we don't visibly hammer USAA's SPA.
    await sleep(400);
  }
  return hydrated;
}

export function fileUrlForPath(p: string): string {
  return pathToFileURL(p).toString();
}

// ─── Phase B: PDF -> transactions ─────────────────────────────────────────

/**
 * USAA statement PDFs have shifted formats over time. Known eras:
 *
 * Era A ("modern", ~2022-present):
 *   - Columns: Date | Description | Amount | Balance
 *   - Dates formatted "MM/DD" or "MM/DD/YY"
 *   - Transactions section titled "TRANSACTIONS" or "Account Activity"
 *
 * Era B ("legacy", ~2015-2022):
 *   - Similar column layout but with "Posting Date / Description / Amount"
 *   - May wrap long descriptions across two lines
 *
 * Era C ("credit card"):
 *   - Columns: Trans Date | Post Date | Description | Amount
 *   - Section "Transactions" per card-holder
 *
 * We try each parser in order. If none match we emit SKIP_RESULT with the
 * first ~400 chars of raw text so the next iteration has evidence to
 * extend the parser. This mirrors the defensive pattern used elsewhere in
 * the USAA connector.
 */

/**
 * Extract the statement's *closing* month + year from the PDF text. Credit-
 * card statements carry "Statement Closing Date MM/DD/YY"; modern checking
 * uses "Statement Period MM/DD/YYYY - MM/DD/YYYY" (we take the closing side).
 * Returns {closingMonth, closingYear} or null if neither pattern hits.
 */
function detectStatementClosing(text: string): { closingMonth: number; closingYear: number } | null {
  // Credit-card: "Statement Closing Date 02/17/26"
  const cc = text.match(CREDIT_CARD_CLOSING_RE);
  if (cc?.[1] && cc[2]) {
    const mm = Number(cc[1]);
    const yy = Number(cc[2]);
    const year = yy < 100 ? 2000 + yy : yy;
    return { closingMonth: mm, closingYear: year };
  }
  // Modern checking: "Statement Period 01/01/2020 - 01/31/2020"
  const ck = text.match(CHECKING_STATEMENT_PERIOD_RE);
  if (ck?.[1] && ck[2]) {
    return { closingMonth: Number(ck[1]), closingYear: Number(ck[2]) };
  }
  return null;
}

// Back-compat: some callers still want just the year.
function detectStatementYear(text: string): number | null {
  const c = detectStatementClosing(text);
  if (c) {
    return c.closingYear;
  }
  const m3 = text.slice(0, 800).match(FOUR_DIGIT_YEAR_RE);
  return m3 ? Number(m3[0]) : null;
}

/**
 * Assign a YYYY to an MM/DD transaction date extracted from a statement,
 * using the statement's closing month to decide whether the transaction
 * falls in the closing year or the prior year. Credit-card statements
 * typically cover the month *before* the closing date, so a Jan-closing
 * statement contains mostly December transactions from the previous year.
 *
 * Rule: if the txn month is AFTER the closing month (interpreted circularly,
 * with a 6-month lookback window), the txn belongs to closingYear - 1.
 *
 * Example: closing 2026-01, txn 12/26 → 2025-12-26 (prior year).
 * Example: closing 2026-03, txn 02/14 → 2026-02-14 (same year).
 */
function toIso(mm: string | number, dd: string | number, closingContext: ClosingContext): string | null {
  const m = Number(mm);
  const d = Number(dd);
  if (!m || m < 1 || m > 12 || !d || d < 1 || d > 31) {
    return null;
  }

  // Support legacy callers that pass a bare year (pre-refactor).
  let closingMonth: number;
  let closingYear: number;
  if (typeof closingContext === "number") {
    closingMonth = 12; // assume Dec so no roll-back triggers
    closingYear = closingContext;
  } else if (closingContext && typeof closingContext === "object") {
    closingMonth = closingContext.closingMonth || 12;
    closingYear = closingContext.closingYear;
  } else {
    return null;
  }
  if (!closingYear || closingYear < 1990 || closingYear > 2100) {
    return null;
  }

  // Roll back a year when txn month is more than the closing month + 1
  // (allows the closing month itself plus a day or two into the next cycle,
  // but flips a December txn on a January statement to the prior year).
  const year = m > closingMonth ? closingYear - 1 : closingYear;
  const mmStr = String(m).padStart(2, "0");
  const ddStr = String(d).padStart(2, "0");
  return `${year}-${mmStr}-${ddStr}`;
}

function currencyToCentsFromStatement(s: string | null | undefined): number | null {
  if (!s) {
    return null;
  }
  // Sign detection: leading "-" (modern checking), trailing "-" (USAA credit
  // card statements: "$10.00-" = payment/credit), or accountants' parens
  // "(10.00)" = legacy negative.
  const trimmed = s.trim();
  const neg = LEADING_MINUS_RE.test(trimmed) || TRAILING_MINUS_RE.test(trimmed) || LEADING_PAREN_RE.test(trimmed);
  // Drop everything except digits and the single decimal point, then parse.
  const numeric = trimmed.replace(NON_CURRENCY_CHARS_RE, "");
  if (!numeric) {
    return null;
  }
  const num = Number(numeric);
  if (!Number.isFinite(num)) {
    return null;
  }
  return Math.round(num * 100) * (neg ? -1 : 1);
}

function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

/**
 * Era A/B parser: line-by-line scan for rows that start with a date.
 * Handles "MM/DD" (inherits statement year) and "MM/DD/YY" formats.
 */
function parseModernCheckingEra(
  text: string,
  { closing }: { closing: { closingMonth: number; closingYear: number } }
): ParsedTxn[] {
  const lines = text.split(STMT_LINE_SPLIT_RE);
  const txns: ParsedTxn[] = [];
  // We only enter rows once we see a "TRANSACTIONS" / "Account Activity"
  // heading. Otherwise we'd accidentally slurp fee-schedule tables etc.
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
    // "MM/DD <desc> <amount> <balance>" or "MM/DD/YY <desc> <amount>"
    const m = line.match(MODERN_TXN_LINE_RE);
    if (!m) {
      continue;
    }
    const [, mmRaw, ddRaw, yRaw, descRaw, amountRaw, balanceRaw] = m;
    if (!(mmRaw && ddRaw && descRaw && amountRaw)) {
      continue;
    }
    // If the line carries its own year, honor it via a bare-year context.
    // Otherwise use the statement-wide closing context so MM/DD gets the
    // correct year for the cycle.
    let ctx: ClosingContext;
    if (yRaw) {
      ctx = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    } else {
      ctx = closing;
    }
    const iso = toIso(mmRaw, ddRaw, ctx);
    if (!iso) {
      continue;
    }
    const description = descRaw.replace(WS_RUN_2PLUS_RE, " ").trim();
    const amount = currencyToCentsFromStatement(amountRaw);
    const balance = balanceRaw ? currencyToCentsFromStatement(balanceRaw) : null;
    if (amount == null) {
      continue;
    }
    const tupleKey = `${iso}|${amount}|${description}`;
    const ord = tupleOrd.get(tupleKey) || 0;
    tupleOrd.set(tupleKey, ord + 1);
    txns.push({ iso, amount, description, balance, tupleKey, ord });
  }
  return txns;
}

/**
 * Era C parser for credit-card statements. Credit card tables typically
 * surface "Trans Date | Post Date | Description | Amount" with "MM/DD"
 * dates and amounts in the rightmost column.
 */
function parseCreditCardEra(
  text: string,
  { closing }: { closing: { closingMonth: number; closingYear: number } }
): ParsedTxn[] {
  const lines = text.split(STMT_LINE_SPLIT_RE);
  const txns: ParsedTxn[] = [];
  let inTable = false;
  const tupleOrd = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    // Section starts: match full-line labels but not "Total Payments And Credits".
    if (CREDIT_SECTION_START_RE.test(line) && !CREDIT_SECTION_TOTAL_RE.test(line)) {
      inTable = true;
      continue;
    }
    // Section ends: any summary/total line inside a statement.
    if (CREDIT_SECTION_END_RE.test(line)) {
      inTable = false;
      continue;
    }
    if (!inTable) {
      continue;
    }
    // "MM/DD MM/DD [Ref#] <desc> <amount>". Amount supports trailing minus
    // (USAA prints payments as "$10.00-" not "-$10.00") and optional $.
    const m = line.match(CREDIT_TXN_LINE_RE);
    if (!m) {
      continue;
    }
    const [, mmRaw, ddRaw, , , descRaw, amountRaw] = m;
    if (!(mmRaw && ddRaw && descRaw && amountRaw)) {
      continue;
    }
    const iso = toIso(mmRaw, ddRaw, closing);
    if (!iso) {
      continue;
    }
    const description = descRaw.replace(/\s{2,}/g, " ").trim();
    const amount = currencyToCentsFromStatement(amountRaw);
    if (amount == null) {
      continue;
    }
    const tupleKey = `${iso}|${amount}|${description}`;
    const ord = tupleOrd.get(tupleKey) || 0;
    tupleOrd.set(tupleKey, ord + 1);
    txns.push({
      iso,
      amount,
      description,
      balance: null,
      tupleKey,
      ord,
    });
  }
  return txns;
}

/**
 * Parse one statement PDF's bytes into transaction records. Caller supplies
 *   accountId, accountName, period (YYYY-MM for provenance), originalDescription
 *   fallback.
 *
 * Returns { txns: Array<TxnRecord>, parseMeta: { era, rawTextSample, year } }.
 * When no parser matches, txns is [] and parseMeta.era === "unknown"; the
 * connector surfaces a SKIP_RESULT with the text sample.
 */
export async function parsePdfStatement({
  buffer,
  accountId,
  accountName,
  period,
}: {
  buffer: Buffer;
  accountId: string;
  accountName: string | null;
  period: string | null;
}): Promise<{ txns: StatementTxnRecord[]; parseMeta: ParseMeta }> {
  // Lazy-load pdf-parse so the connector doesn't pay startup cost on runs
  // that don't hit the PDF path.
  // biome-ignore lint/correctness/noUnresolvedImports: pdf-parse is declared in package.json; Biome's resolver can't follow its CJS/ESM conditional exports
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  let textResult: { text?: string };
  try {
    textResult = await parser.getText();
  } finally {
    await parser.destroy().catch(() => {
      /* ignore */
    });
  }
  const text = textResult.text || "";
  // Prefer the in-PDF closing date (most accurate). Fall back to the period
  // from the statement index (YYYY-MM) when the PDF text doesn't carry one.
  let closing = detectStatementClosing(text);
  if (!closing && period) {
    const [y, m] = period.split("-").map(Number);
    if (y && m) {
      closing = { closingYear: y, closingMonth: m };
    }
  }
  if (!closing) {
    closing = { closingYear: new Date().getFullYear(), closingMonth: 12 };
  }

  const attempts: Array<{
    era: string;
    fn: (t: string, c: { closing: { closingMonth: number; closingYear: number } }) => ParsedTxn[];
  }> = [
    { era: "modern_checking", fn: parseModernCheckingEra },
    { era: "credit_card", fn: parseCreditCardEra },
  ];
  let chosen: string | null = null;
  let best: ParsedTxn[] = [];
  for (const a of attempts) {
    const txns = a.fn(text, { closing });
    if (txns.length > best.length) {
      best = txns;
      chosen = a.era;
    }
  }
  if (!best.length) {
    return {
      txns: [],
      parseMeta: {
        era: "unknown",
        year: closing.closingYear,
        // Trim to keep SKIP_RESULT lines within JSONL-sane bounds.
        rawTextSample: text.replace(/\s+/g, " ").slice(0, 800),
      },
    };
  }

  const nowIso = new Date().toISOString();
  const provenance = `pdf_statement_${period || "unknown"}`;
  const records: StatementTxnRecord[] = best.map((t) => ({
    // Hash input is intentionally identical in shape to the CSV path so
    // the same logical transaction from both sources collapses to the same
    // id on ingest. See rowsToTransactions in index.js.
    id: hashId(`${accountId}|${t.tupleKey}|#${t.ord}`),
    account_id: accountId,
    account_name: accountName,
    date: t.iso,
    description: t.description,
    original_description: t.description,
    category: null,
    amount: t.amount,
    currency: "USD",
    balance_after_cents: t.balance,
    check_number: (t.description.match(CHECK_NUMBER_RE) || [])[1] || null,
    source: provenance,
    fetched_at: nowIso,
  }));
  return {
    txns: records,
    parseMeta: {
      era: chosen ?? "unknown",
      year: closing.closingYear,
      closingMonth: closing.closingMonth,
    },
  };
}

// Exposed for introspection / tests.
export const _internals = {
  parseModernCheckingEra,
  parseCreditCardEra,
  detectStatementYear,
  currencyToCentsFromStatement,
  STATEMENT_ROOT,
};
