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

import { mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import type { DownloadQueue } from "../../src/download-queue.ts";
import { readPlaywrightDownloadBuffer } from "../../src/playwright-download.ts";
import {
  currencyToCentsFromStatement as _currencyFromStatement,
  detectStatementClosing,
  detectStatementYear,
  hashId,
  parseCreditCardEra,
  parseModernCheckingEra,
  fileUrlForPath as parsersFileUrlForPath,
  safeAccountSlug,
  sha256Hex,
  yearMonthFromDate,
} from "./parsers.ts";
import type {
  DownloadFail,
  DownloadResult,
  HydratedStatement,
  ParsedStatementTxn,
  ParseMeta,
  StatementClosing,
  StatementRow,
  StatementTxnRecord,
} from "./types.ts";

const STATEMENT_ROOT = join(homedir(), ".pdpp", "usaa-statements");

// ─── Selector regexes (kept here; Node-side, not pure data) ──────────────
const OPTIONS_BUTTON_TEXT_RE = /^\s*(Options|More|\.{3})\s*$/i;
const DOWNLOAD_MENU_ITEM_RE = /download/i;
const DOWNLOAD_BUTTON_TEXT_RE = /^\s*Download( PDF)?\s*$/i;
const DOCUMENTS_PATH_RE = /\/my\/documents/;
const MENU_WS_RE = /\s+/g;
const WS_CLEANUP_RE = /\s+/g;
const CHECK_NUMBER_RE = /CHECK\s*#?\s*0*(\d+)/i;

// ─── Timing constants ────────────────────────────────────────────────────
const DOWNLOAD_TIMEOUT_MS = 180_000;
const DOCUMENTS_NAV_TIMEOUT_MS = 30_000;
const DOCUMENTS_RELOAD_SETTLE_MS = 5000;
const CLICK_TIMEOUT_MS = 5000;
const OPTIONS_MENU_SETTLE_MS = 500;
const ROW_JITTER_MS = 400;
const MAX_ERROR_MSG = 160;
const MAX_MENU_HTML_SAMPLE = 500;
const MAX_RAW_TEXT_SAMPLE = 800;

// ─── Tiny helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MSG);
}

// ─── Download orchestration ──────────────────────────────────────────────

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

/** Read a queued download's bytes off disk. */
async function consumeDownload(
  dlPromise: ReturnType<DownloadQueue["waitForNextDownload"]>
): Promise<{ buffer: Buffer; suggestedFilename: string } | null> {
  const dl = await dlPromise;
  const buffer = await readPlaywrightDownloadBuffer(dl);
  if (buffer.length === 0) {
    return null;
  }
  return { buffer, suggestedFilename: dl.suggestedFilename() };
}

/** Fallback path: the row has a direct <a href="*.pdf"> link. */
async function downloadViaDirectLink(row: Locator, downloadQueue: DownloadQueue): Promise<DownloadResult | null> {
  const link = row.locator('a[href$=".pdf"], a[href*=".pdf?"]').first();
  if (!(await link.count().catch(() => 0))) {
    return null;
  }
  const dlPromise = downloadQueue.waitForNextDownload({
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });
  await link.click({ timeout: CLICK_TIMEOUT_MS }).catch(() => {
    /* ignore */
  });
  try {
    const result = await consumeDownload(dlPromise);
    if (!result) {
      return { ok: false, reason: "download_empty" };
    }
    return { ok: true, buffer: result.buffer, suggestedFilename: result.suggestedFilename };
  } catch (err) {
    return {
      ok: false,
      reason: "direct_link_failed",
      diag: { error: errMsg(err) },
    };
  }
}

/** Open the per-row Options menu. Returns the DownloadResult on failure, null on success. */
async function openOptionsMenu(optBtn: Locator): Promise<DownloadFail | null> {
  try {
    await optBtn.click({ timeout: CLICK_TIMEOUT_MS });
    return null;
  } catch (err) {
    return {
      ok: false,
      reason: "options_click_failed",
      diag: { error: errMsg(err) },
    };
  }
}

/** Capture menu HTML + dismiss the menu when no Download menuitem was found. */
async function noDownloadMenuitemFailure(page: Page): Promise<DownloadFail> {
  const menuHtml = await page
    .locator('[role="menu"]')
    .first()
    .innerHTML()
    .catch(() => null);
  await page.keyboard.press("Escape").catch(() => {
    /* ignore */
  });
  return {
    ok: false,
    reason: "no_download_menuitem",
    diag: {
      menu_html: menuHtml ? menuHtml.replace(MENU_WS_RE, " ").slice(0, MAX_MENU_HTML_SAMPLE) : null,
    },
  };
}

/** Click the Download menuitem and consume the resulting download. */
async function clickDownloadAndConsume(
  page: Page,
  dlItem: Locator,
  downloadQueue: DownloadQueue
): Promise<DownloadResult> {
  const dlPromise = downloadQueue.waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS });
  try {
    await dlItem.click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    return {
      ok: false,
      reason: "download_click_failed",
      diag: { error: errMsg(err) },
    };
  }
  try {
    const result = await consumeDownload(dlPromise);
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    if (!result) {
      return { ok: false, reason: "download_empty" };
    }
    return { ok: true, buffer: result.buffer, suggestedFilename: result.suggestedFilename };
  } catch (err) {
    await page.keyboard.press("Escape").catch(() => {
      /* ignore */
    });
    return {
      ok: false,
      reason: "download_timeout",
      diag: { error: errMsg(err) },
    };
  }
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
    const direct = await downloadViaDirectLink(row, downloadQueue);
    return direct ?? { ok: false, reason: "no_options_affordance" };
  }

  const openErr = await openOptionsMenu(optBtn);
  if (openErr) {
    return openErr;
  }
  await sleep(OPTIONS_MENU_SETTLE_MS);

  const dlItem = await locateDownloadMenuItem(page);
  if (!dlItem) {
    return await noDownloadMenuitemFailure(page);
  }

  return await clickDownloadAndConsume(page, dlItem, downloadQueue);
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

/** Defensively (re-)navigate to /my/documents if we're not already there. */
async function ensureOnDocumentsPage(page: Page): Promise<void> {
  if (DOCUMENTS_PATH_RE.test(page.url())) {
    return;
  }
  await page
    .goto("https://www.usaa.com/my/documents", {
      waitUntil: "domcontentloaded",
      timeout: DOCUMENTS_NAV_TIMEOUT_MS,
    })
    .catch(() => {
      /* ignore */
    });
  await sleep(DOCUMENTS_RELOAD_SETTLE_MS);
}

interface HydrateCallbacks {
  onProgress?: ((p: { index: number; total: number; title: string | null }) => void) | undefined;
  onSkip?: ((p: { statement: StatementRow; reason: string; diag: Record<string, unknown> | null }) => void) | undefined;
}

/** Persist a single downloaded PDF and append to the hydrated list. */
async function persistHydratedStatement(
  statement: StatementRow,
  download: { buffer: Buffer; suggestedFilename: string },
  hydrated: HydratedStatement[],
  onSkip: HydrateCallbacks["onSkip"]
): Promise<void> {
  try {
    const { pdfPath, pdfSha256 } = await persistPdf({
      buffer: download.buffer,
      accountId: statement.account_id,
      dateDelivered: statement.date_delivered,
    });
    hydrated.push({
      statement,
      pdfPath,
      pdfSha256,
      buffer: download.buffer,
      suggestedFilename: download.suggestedFilename,
    });
  } catch (err) {
    if (onSkip) {
      onSkip({
        statement,
        reason: "persist_failed",
        diag: { error: errMsg(err) },
      });
    }
  }
}

/** Handle one statement row: download, persist, emit callbacks. */
async function hydrateOneStatement(
  page: Page,
  statement: StatementRow,
  total: number,
  downloadQueue: DownloadQueue,
  hydrated: HydratedStatement[],
  { onProgress, onSkip }: HydrateCallbacks
): Promise<void> {
  if (onProgress) {
    onProgress({
      index: statement.rowIndex,
      total,
      title: statement.title,
    });
  }
  const result = await downloadStatementFromRow({
    page,
    rowIndex: statement.rowIndex,
    downloadQueue,
  });
  if (!result.ok) {
    if (onSkip) {
      onSkip({
        statement,
        reason: result.reason,
        diag: result.diag ?? null,
      });
    }
    return;
  }
  await persistHydratedStatement(statement, result, hydrated, onSkip);
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
  downloadQueue,
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

  await ensureOnDocumentsPage(page);

  for (const s of statements) {
    await hydrateOneStatement(page, s, statements.length, downloadQueue, hydrated, {
      onProgress,
      onSkip,
    });
    // Small jitter between rows so we don't visibly hammer USAA's SPA.
    await sleep(ROW_JITTER_MS);
  }
  return hydrated;
}

export function fileUrlForPath(p: string): string {
  return parsersFileUrlForPath(p);
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
 * first ~800 chars of raw text so the next iteration has evidence to
 * extend the parser. This mirrors the defensive pattern used elsewhere in
 * the USAA connector.
 */

async function extractPdfText(buffer: Buffer): Promise<string> {
  // Lazy-load pdf-parse so the connector doesn't pay startup cost on runs
  // that don't hit the PDF path.
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
  return textResult.text || "";
}

/**
 * Determine the statement's closing context: prefer the in-PDF closing date,
 * then the period supplied by the statement index (YYYY-MM), then current
 * year as last resort.
 */
function resolveClosing(text: string, period: string | null): StatementClosing {
  const fromText = detectStatementClosing(text);
  if (fromText) {
    return fromText;
  }
  if (period) {
    const [y, m] = period.split("-").map(Number);
    if (y && m) {
      return { closingYear: y, closingMonth: m };
    }
  }
  return { closingYear: new Date().getFullYear(), closingMonth: 12 };
}

/** Try each era parser; keep the one that produced the most transactions. */
function runEraParsers(text: string, closing: StatementClosing): { chosen: string | null; best: ParsedStatementTxn[] } {
  const attempts: Array<{
    era: string;
    fn: (t: string, c: { closing: StatementClosing }) => ParsedStatementTxn[];
  }> = [
    { era: "modern_checking", fn: parseModernCheckingEra },
    { era: "credit_card", fn: parseCreditCardEra },
  ];
  let chosen: string | null = null;
  let best: ParsedStatementTxn[] = [];
  for (const a of attempts) {
    const txns = a.fn(text, { closing });
    if (txns.length > best.length) {
      best = txns;
      chosen = a.era;
    }
  }
  return { chosen, best };
}

/** Shape parsed transactions into emitted records, hashing ids compatibly with CSV path. */
function buildStatementRecords(
  best: ParsedStatementTxn[],
  { accountId, accountName, period }: { accountId: string; accountName: string | null; period: string | null }
): StatementTxnRecord[] {
  const nowIso = new Date().toISOString();
  const provenance = `pdf_statement_${period || "unknown"}`;
  return best.map((t) => ({
    // Hash input is intentionally identical in shape to the CSV path so
    // the same logical transaction from both sources collapses to the same
    // id on ingest. See rowsToTransactions in parsers.ts.
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
  const text = await extractPdfText(buffer);
  const closing = resolveClosing(text, period);
  const { chosen, best } = runEraParsers(text, closing);

  if (!best.length) {
    return {
      txns: [],
      parseMeta: {
        era: "unknown",
        year: closing.closingYear,
        // Trim to keep SKIP_RESULT lines within JSONL-sane bounds.
        rawTextSample: text.replace(WS_CLEANUP_RE, " ").slice(0, MAX_RAW_TEXT_SAMPLE),
      },
    };
  }

  const records = buildStatementRecords(best, { accountId, accountName, period });
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
  currencyToCentsFromStatement: _currencyFromStatement,
  STATEMENT_ROOT,
};
