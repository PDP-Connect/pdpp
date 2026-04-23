#!/usr/bin/env node
/**
 * PDPP Chase Connector (v0.1.0)
 *
 * Strategy: browser-drive chase.com's "Download account activity" affordance
 * to produce QFX (Quicken Web Connect) files, which parse canonically to
 * (account_id, fitid, date, amount, memo, name, type, checknum, refnum).
 *
 * Why QFX instead of Direct Connect or HTML scrape:
 * - Direct Connect is effectively dead for new personal-account enrollments
 *   as of 2025-2026 (see `design-notes/chase.md` — research done 2026-04-20).
 * - HTML scrape has hundreds of selectors subject to Chase's weekly UI
 *   churn. QFX splits the brittleness: only the ~5-selector download click
 *   path is fragile; the resulting file format has been stable since 2001.
 *
 * v0.1 streams (per `design-notes/chase.md`):
 *   - accounts: dashboard-scraped identity + QFX ACCTINFO augmentation
 *   - transactions: per-account, per-90-day-window QFX downloads + parse
 *   - statements: per-account monthly statement PDFs, hydrated to disk
 *   - balances: append_only point-in-time snapshots from QFX LEDGERBAL/AVAILBAL
 *
 * Selectors for the download UI are NOT verified live yet. This connector
 * emits diagnostic SKIP_RESULT with a DOM dump + screenshot when it can't
 * find the download affordance, so the first live run produces evidence
 * for the next iteration rather than silently failing with zero records.
 *
 * Auth: CHASE_USERNAME + CHASE_PASSWORD in env. 2FA via INTERACTION kind=otp.
 * CHASE_2FA_METHOD=text|voice|email (default text).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { ensureChaseSession } from "../../src/auto-login/chase.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  runConnector,
  type StreamScope,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";

const validateRecord = validateRecordRaw as ValidateRecord;

// ─── Tunables ─────────────────────────────────────────────────────────────

const NAV_TIMEOUT_MS = 30_000;
const DOM_WAIT_MS = 20_000;
const CLICK_TIMEOUT_MS = 10_000;
const SHORT_CLICK_TIMEOUT_MS = 5000;
const OPTION_WAIT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DATE_INPUT_WAIT_MS = 10_000;
const DATE_REFLECT_WAIT_MS = 3000;
const DATE_KEY_DELAY_MS = 40;
const ERROR_MESSAGE_SLICE = 120;
const ERROR_MESSAGE_SLICE_LONG = 160;
const ERROR_MESSAGE_SLICE_MAX = 200;
const HASH_SHORT_LEN = 16;
const HASH_SLUG_LEN = 32;
const CENTS_MULTIPLIER = 100;

// ─── Parsed shapes ────────────────────────────────────────────────────────

type ChaseAccountType = "credit_card" | "checking" | "savings" | "unknown";

interface ChaseAccount {
  internal_id: string;
  last_four: string | null;
  name: string;
  type: ChaseAccountType;
}

type ActivityKind = "all" | "since_last_statement" | "year_to_date" | "last_year" | "current" | "date_range";

interface DateRange {
  from?: string | undefined;
  to?: string | undefined;
}

interface DownloadOptions {
  activity?: ActivityKind;
  dateRange?: DateRange;
}

interface DownloadSuccess {
  activity: ActivityKind;
  downloaded: true;
  qfxPath: string;
}

interface DownloadFailure {
  downloaded: false;
  error: string;
}

type DownloadResult = DownloadSuccess | DownloadFailure;

interface DateFillOk {
  ok: true;
}

interface DateFillErr {
  error: string;
  ok: false;
}

type DateFillResult = DateFillOk | DateFillErr;

interface StatementRow {
  account_reference: string | null;
  date_delivered_raw: string;
  doc_kind: string;
  rowAnchorId: string;
  rowIdx: string | undefined;
  tableIdx: string | undefined;
  title: string;
}

interface StatementDownloadOk {
  ok: true;
  pdfPath: string;
  pdfSha256: string;
}

interface StatementDownloadErr {
  error: string;
  ok: false;
}

type StatementDownloadResult = StatementDownloadOk | StatementDownloadErr;

interface QfxTransaction {
  amount_cents: number;
  check_number: string | null;
  currency: string;
  date: string | null;
  fitid: string;
  memo: string | null;
  name: string | null;
  reference_number: string | null;
  type: string | null;
}

interface QfxBalance {
  as_of: string;
  available_cents: number | null;
  ledger_cents: number | null;
}

interface QfxExtracted {
  balance: QfxBalance | null;
  transactions: QfxTransaction[];
}

interface DashboardDiagnostics {
  body_preview: string;
  title: string;
  url: string;
}

interface TransactionCursor {
  last_activity?: string;
  last_fetched_at?: string;
  max_seen_date?: string | null;
}

interface TransactionsStateShape {
  per_account?: Record<string, TransactionCursor | undefined>;
}

interface ActivityChoice {
  activity: ActivityKind;
  dateRange?: DateRange;
}

// OFX parser output is deeply nested, loosely typed, and varies by ofx-js
// version. We model only what we read as nested `unknown`-backed objects.
type OfxValue = unknown;
type OfxRecord = Record<string, OfxValue>;

// ─── Helpers ──────────────────────────────────────────────────────────────

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function isOfxRecord(v: OfxValue): v is OfxRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ofxGet(v: OfxValue, key: string): OfxValue {
  return isOfxRecord(v) ? v[key] : undefined;
}

function ofxString(v: OfxValue): string | null {
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

function ofxNumber(v: OfxValue): number | null {
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

function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, HASH_SLUG_LEN);
}

function fileUrl(p: string | null | undefined): string | null {
  if (!p) {
    return null;
  }
  return pathToFileURL(p).href;
}

// ─── Dashboard scrape: enumerate accounts ─────────────────────────────────

async function discoverAccounts(page: Page): Promise<ChaseAccount[]> {
  // Navigate to dashboard overview — not the generic /dashboard URL which
  // often redirects to the last-viewed account. Overview consistently lists
  // all accounts.
  await page.goto("https://secure.chase.com/web/auth/dashboard#/dashboard/overview", {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for at least one account label to appear rather than a fixed delay —
  // the dashboard renders cards asynchronously from an XHR, so fixed sleeps
  // are both slow and flaky. Fail soft if the selector never appears (returns
  // empty accounts list; caller's SKIP_RESULT diagnostic fires).
  await page
    .locator('[id^="accounts-name-link-button-"][id$="-label"]')
    .first()
    .waitFor({ state: "attached", timeout: DOM_WAIT_MS })
    .catch((): undefined => undefined);

  // Verified pattern 2026-04-21: Chase renders each account as a
  // <span class="accessible-text" id="accounts-name-link-button-<INTERNAL_ID>-label">
  // with text like "Sapphire Preferred (...9241)". The internal id matches
  // the transactionDetails param and is what the download form's
  // account-selector expects.
  return page.evaluate((): ChaseAccount[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const ID_RE = /^accounts-name-link-button-(\d+)-label$/;
    const CARD_RE = /(Sapphire|Freedom|Ink|Amazon|Southwest|United|Hyatt|Disney|Marriott|IHG|Prime|Platinum|Slate)/i;
    const CHK_RE = /(Checking|Total Checking|Premier Checking)/i;
    const SAV_RE = /(Savings|Premier Savings)/i;
    const WS_RE = /\s+/g;
    const LAST4_RE = /\.\.\.(\d{3,4})/;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    interface El {
      id?: string;
      innerText?: string;
      querySelectorAll: (sel: string) => El[];
      shadowRoot?: El | null;
      textContent?: string;
    }

    function walk(root: El, out: El[] = []): El[] {
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) {
          walk(el.shadowRoot, out);
        }
      }
      return out;
    }

    // @ts-expect-error — browser context globals (document)
    const rootDoc: El = document;
    const labels = walk(rootDoc).filter((el) => Boolean(el.id) && ID_RE.test(el.id ?? ""));
    return labels.map((el): ChaseAccount => {
      const idMatch = ID_RE.exec(el.id ?? "");
      const displayName = (el.innerText || el.textContent || "").replace(WS_RE, " ").trim();
      const lastFourMatch = LAST4_RE.exec(displayName);
      // Infer type from the display name — rough heuristic; refined by
      // inspecting the BAC/DDA/ABS param in the transactions URL if needed.
      let typeHint: ChaseAccountType = "unknown";
      if (CARD_RE.test(displayName)) {
        typeHint = "credit_card";
      } else if (CHK_RE.test(displayName)) {
        typeHint = "checking";
      } else if (SAV_RE.test(displayName)) {
        typeHint = "savings";
      }
      return {
        internal_id: idMatch?.[1] ?? "",
        name: displayName,
        type: typeHint,
        last_four: lastFourMatch?.[1] ?? null,
      };
    });
  });
}

// ─── QFX download click-path ──────────────────────────────────────────────

// Activity options enumerated live from Chase's mds-select on 2026-04-21:
//   Current display, including filters / Year to date / Last year /
//   Since last statement / 2026 statements / 2025 statements /
//   2024 statements / All transactions / Choose a date range
// We use the visible labels as locators (Playwright's `getByRole('option')`
// pierces shadow DOM).
async function selectActivity(page: Page, optionLabel: string): Promise<void> {
  await page.locator("#select-downloadActivityOptionId").click({ timeout: CLICK_TIMEOUT_MS });
  const opt = page.getByRole("option", {
    name: new RegExp(`^${optionLabel}$`, "i"),
  });
  await opt.waitFor({ state: "visible", timeout: OPTION_WAIT_MS });
  await opt.click({ timeout: OPTION_WAIT_MS });
}

/**
 * Select File Type via click-driven dropdown selection. Chase's mds-select
 * ignores direct attribute mutation once any other form interaction has
 * happened — the first run's attribute-set worked only because nothing else
 * touched the form before Download, but re-renders (like selecting Date
 * Range on Activity) revert file type back to CSV. Clicking is durable.
 */
async function selectFileType(page: Page, label: string): Promise<void> {
  await page.locator("#select-downloadFileTypeOption").click({ timeout: CLICK_TIMEOUT_MS });
  const opt = page.getByRole("option", {
    name: new RegExp(`^${label}`, "i"),
  });
  await opt.waitFor({ state: "visible", timeout: OPTION_WAIT_MS });
  await opt.click({ timeout: OPTION_WAIT_MS });
}

const ACTIVITY_LABELS: Record<ActivityKind, string> = {
  all: "All transactions",
  since_last_statement: "Since last statement",
  year_to_date: "Year to date",
  last_year: "Last year",
  current: "Current display, including filters",
  date_range: "Choose a date range",
};

/** Drive a single QFX download. */
async function downloadQfx(
  page: Page,
  account: ChaseAccount,
  tmpDir: string,
  opts: DownloadOptions = {}
): Promise<DownloadResult> {
  const activity: ActivityKind = opts.activity ?? "all";

  // Chase URL params vary by product type. Verified 2026-04-21 for CARD,BAC
  // (credit card). Checking/savings shapes are speculative — see
  // `design-notes/chase.md`.
  let paramsFragment: string;
  if (account.type === "credit_card") {
    paramsFragment = `CARD,BAC,${account.internal_id}`;
  } else if (account.type === "checking") {
    paramsFragment = `DDA,PRIMARY,${account.internal_id},SECONDARY`;
  } else {
    paramsFragment = `CARD,BAC,${account.internal_id}`;
  }

  const url = `https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=${paramsFragment}`;
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  await page.locator("#downloadFileTypeOption").waitFor({ state: "attached", timeout: DOM_WAIT_MS });

  // Select activity option FIRST so the Date-Range pickers render before we
  // set file type. Chase's form re-renders when Activity changes; doing file
  // type after Activity keeps the selection stable through the re-render.
  const label = ACTIVITY_LABELS[activity];

  if (activity !== "current") {
    try {
      await selectActivity(page, label);
    } catch (err) {
      return {
        downloaded: false,
        error: `activity_select_failed (${label}): ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
      };
    }

    if (activity === "date_range") {
      const from = opts.dateRange?.from;
      const to = opts.dateRange?.to;
      if (!(from && to)) {
        return {
          downloaded: false,
          error: "date_range_missing_from_or_to",
        };
      }
      const ok = await fillDateRange(page, from, to);
      if (!ok.ok) {
        return {
          downloaded: false,
          error: `date_range_fill_failed: ${ok.error}`,
        };
      }
    }
  }

  // Now set File Type via click-select (attribute mutation gets clobbered
  // by Activity re-renders).
  try {
    await selectFileType(page, "Quicken Web Connect");
  } catch (err) {
    return {
      downloaded: false,
      error: `file_type_select_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  // Wait for the Download button to be enabled before clicking.
  await page.locator("mds-button#download").waitFor({ state: "visible", timeout: OPTION_WAIT_MS });

  const downloadPromise = page.waitForEvent("download", {
    timeout: DOWNLOAD_TIMEOUT_MS,
  });
  try {
    await page.locator("mds-button#download").click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    return {
      downloaded: false,
      error: `download_button_click_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  try {
    const dl = await downloadPromise;
    const qfxPath = join(tmpDir, `chase-${account.internal_id}-${activity}-${Date.now()}.qfx`);
    await dl.saveAs(qfxPath);
    return { downloaded: true, qfxPath, activity };
  } catch (err) {
    return {
      downloaded: false,
      error: `download_event_timeout: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }
}

/**
 * Fill the From + To date pickers that appear after selecting "Choose a date
 * range".
 *
 * mds-datepicker#accountActivityFromDate and #accountActivityToDate host
 * inner `<input>` elements in their shadow roots. The picker has min-date
 * and max-date attributes that cap the range at ~24 months before today
 * (empirically 04/20/2024 on 04/21/2026). Dates outside that range are
 * silently clamped by the component.
 *
 * The inputs accept mm/dd/yyyy typed character-by-character. Playwright's
 * pressSequentially on the shadow-piercing `input` locator works.
 */
function isoToPacked(iso: string): string | null {
  const parts = iso.split("-");
  const [y, m, d] = parts;
  if (!(y && m && d)) {
    return null;
  }
  return `${m}${d}${y}`;
}

async function fillDateRange(page: Page, from: string, to: string): Promise<DateFillResult> {
  const fromPacked = isoToPacked(from);
  const toPacked = isoToPacked(to);
  if (!(fromPacked && toPacked)) {
    return { ok: false, error: "bad_iso_date" };
  }

  try {
    const fromInput = page.locator("#accountActivityFromDate input").first();
    await fromInput.waitFor({ state: "visible", timeout: DATE_INPUT_WAIT_MS });
    await fromInput.click({ timeout: SHORT_CLICK_TIMEOUT_MS });
    await fromInput.pressSequentially(fromPacked, { delay: DATE_KEY_DELAY_MS });

    const toInput = page.locator("#accountActivityToDate input").first();
    await toInput.click({ timeout: SHORT_CLICK_TIMEOUT_MS });
    await toInput.pressSequentially(toPacked, { delay: DATE_KEY_DELAY_MS });

    // Give the component a moment to validate/reflect selection.
    await page
      .locator("#accountActivityFromDate[value]")
      .waitFor({ state: "attached", timeout: DATE_REFLECT_WAIT_MS })
      .catch((): undefined => undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: truncate(errMessage(err), ERROR_MESSAGE_SLICE) };
  }
}

// ─── Statements (PDF archive) ─────────────────────────────────────────────
//
// Navigate to Chase's Statements & Documents page and walk each row,
// clicking the `-download` anchor to save each monthly statement PDF.
// Pattern follows USAA's statements implementation (content-addressed
// storage, hash-based idempotence, per-account subfolders).
//
// Row structure verified live 2026-04-21:
//   table#accountsTable-0 (the account's statement table; index 0 = first
//     expanded account — Chase shows one account per table on the
//     Statements page, expanded via button#button-documentsAccordion-N).
//   Each row has three cells + action anchors:
//     Cell 0: date (e.g. "Apr 13, 2026")
//     Cell 1: "Statement" | "Tax document" | etc.
//     Cell 2: page count (e.g. "4 pages")
//     Cell 3: a.id=accountsTable-0-rowN-cell3-requestThisDocumentAnchor-download
//            (also -pdf which OPENS instead of saves)

const STATEMENT_ROOT = join(homedir(), ".pdpp", "chase-statements");
const ACCOUNT_SLUG_SAFE_RE = /^[A-Za-z0-9_-]+$/;
const LAST_FOUR_RE = /\.\.\.(\d{3,4})/;

async function navigateToStatementsPage(page: Page): Promise<void> {
  // Warm overview first — direct-nav to the documents URL can bounce through
  // login if the SPA isn't fully hydrated.
  await page.goto("https://secure.chase.com/web/auth/dashboard#/dashboard/overview", {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for any account label to render before routing onward.
  await page
    .locator('[id^="accounts-name-link-button-"][id$="-label"]')
    .first()
    .waitFor({ state: "attached", timeout: DOM_WAIT_MS })
    .catch((): undefined => undefined);

  await page.goto("https://secure.chase.com/web/auth/dashboard#/dashboard/documents/myDocs/index;mode=documents", {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for the accordion trigger to appear — confirms the page rendered.
  await page.locator('[id^="button-documentsAccordion-"]').first().waitFor({ state: "visible", timeout: DOM_WAIT_MS });
}

/**
 * Enumerate the statement rows currently visible on the Statements page.
 * Each row maps to one monthly statement PDF. Returns an array of rows in
 * DOM order (newest first, per Chase's default ordering).
 */
function enumerateStatementRows(page: Page): Promise<StatementRow[]> {
  return page.evaluate((): StatementRow[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const ANCHOR_ID_RE = /accountsTable-\d+-row\d+-cell\d+-requestThisDocumentAnchor-download/;
    const ACCORDION_ID_RE = /documentsAccordion-(\d+)/;
    const TABLE_ROW_RE = /accountsTable-(\d+)-row(\d+)-/;
    const STATEMENT_RE = /statement/i;
    const WS_RE = /\s+/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    interface El {
      id?: string;
      innerText?: string;
      parentElement: El | null;
      querySelectorAll: (sel: string) => El[];
      shadowRoot?: El | null;
      tagName?: string;
    }

    function walk(root: El, out: El[] = []): El[] {
      for (const el of root.querySelectorAll("*")) {
        out.push(el);
        if (el.shadowRoot) {
          walk(el.shadowRoot, out);
        }
      }
      return out;
    }

    // @ts-expect-error — browser context globals (document)
    const rootDoc: El = document;
    const els = walk(rootDoc);
    const anchors = els.filter((el) => el.tagName === "A" && ANCHOR_ID_RE.test(el.id ?? ""));
    // Parallel: find account accordion buttons, to associate each table with an account label.
    const accordions = [...document.querySelectorAll<HTMLElement>('[id^="button-documentsAccordion-"]')].map((b) => {
      const m = ACCORDION_ID_RE.exec(b.id);
      return {
        id: b.id,
        tableIdx: m?.[1],
        label: (b.innerText || "").replace(WS_RE, " ").trim(),
      };
    });
    const accountByTableIdx = new Map<string, string>();
    for (const a of accordions) {
      if (a.tableIdx) {
        accountByTableIdx.set(a.tableIdx, a.label);
      }
    }

    const rows: StatementRow[] = [];
    for (const a of anchors) {
      // anchor id: accountsTable-<T>-row<R>-cell3-requestThisDocumentAnchor-download
      const m = TABLE_ROW_RE.exec(a.id ?? "");
      const tableIdx = m?.[1];
      const rowIdx = m?.[2];
      // Walk up to the <tr> for date + type cells.
      let tr: El | null = a;
      while (tr && tr.tagName !== "TR") {
        tr = tr.parentElement;
      }
      const cells: El[] = tr ? [...tr.querySelectorAll("td, th")] : [];
      const date_delivered_raw = (cells[0]?.innerText || "").trim();
      const doc_kind = (cells[1]?.innerText || "").trim();
      const account_reference = tableIdx ? (accountByTableIdx.get(tableIdx) ?? null) : null;
      const title = [date_delivered_raw, doc_kind, account_reference].filter(Boolean).join(" ");
      if (!(doc_kind && STATEMENT_RE.test(doc_kind))) {
        continue;
      }
      rows.push({
        rowAnchorId: a.id ?? "",
        tableIdx,
        rowIdx,
        date_delivered_raw,
        doc_kind,
        account_reference,
        title,
      });
    }
    return rows;
  });
}

function parseDateDelivered(raw: string | null | undefined): string | null {
  // Chase renders "Apr 13, 2026"; `new Date` parses reliably on v8 for this.
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function yearMonthFromIso(iso: string | null): string {
  return iso ? iso.slice(0, 7) : "unknown";
}

function accountSlug(accountId: string | null): string {
  if (!accountId) {
    return "unknown";
  }
  if (ACCOUNT_SLUG_SAFE_RE.test(accountId)) {
    return accountId;
  }
  return shortHash(accountId);
}

/**
 * Click the row's download anchor and capture the PDF via Playwright's
 * download event. Save to disk under ~/.pdpp/chase-statements/<account>/
 * <YYYY-MM>-<sha16>.pdf.
 */
async function downloadStatementPdf(
  page: Page,
  row: StatementRow,
  accountId: string | null
): Promise<StatementDownloadResult> {
  // Chase's anchor ids are safe ASCII (only letters, digits, hyphens) so
  // we can inline them into a CSS selector without CSS.escape (which is
  // browser-only — not available in Node).
  const anchor = page.locator(`#${row.rowAnchorId}`);
  const exists = await anchor.count().catch((): number => 0);
  if (!exists) {
    return { ok: false, error: "anchor_not_found" };
  }

  const downloadPromise = page.waitForEvent("download", {
    timeout: DOWNLOAD_TIMEOUT_MS,
  });
  try {
    await anchor.click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    return {
      ok: false,
      error: `anchor_click_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  let dl: Awaited<typeof downloadPromise>;
  try {
    dl = await downloadPromise;
  } catch (err) {
    return {
      ok: false,
      error: `download_event_timeout: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  const internalPath = await dl.path();
  if (!internalPath) {
    return { ok: false, error: "download_no_path" };
  }
  const buffer = await readFile(internalPath);
  const pdfSha256 = sha256Hex(buffer);

  const isoDate = parseDateDelivered(row.date_delivered_raw);
  const slug = accountSlug(accountId);
  const dir = join(STATEMENT_ROOT, slug);
  await mkdir(dir, { recursive: true });
  const pdfPath = join(dir, `${yearMonthFromIso(isoDate)}-${pdfSha256.slice(0, HASH_SHORT_LEN)}.pdf`);

  // Idempotent: skip rewrite when the content is already at the expected path.
  const existing = await stat(pdfPath).catch((): null => null);
  if (!existing || existing.size !== buffer.length) {
    await writeFile(pdfPath, buffer);
  }

  return { ok: true, pdfPath, pdfSha256 };
}

/**
 * Resolve a statement row's `account_reference` text (e.g.
 * "SAPPHIRE PREFERRED (...9241)") to the stable Chase internal account id
 * from our accounts array.
 */
function resolveAccountIdForRow(row: StatementRow, accounts: readonly ChaseAccount[]): string | null {
  if (!row.account_reference) {
    return null;
  }
  const last4Match = LAST_FOUR_RE.exec(row.account_reference);
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

// ─── QFX parsing ──────────────────────────────────────────────────────────

interface OfxParser {
  parse: (content: string) => unknown;
}

function hasParse(v: unknown): v is OfxParser {
  return typeof v === "object" && v !== null && "parse" in v && typeof (v as { parse: unknown }).parse === "function";
}

async function parseQfxFile(path: string): Promise<unknown> {
  // ofx-js (0.2.x) ships no declaration file. The default export has
  // shifted shape across versions (top-level OFX, nested under default,
  // bare parse). Import as unknown and narrow structurally instead of
  // claiming a fixed module shape.
  // @ts-expect-error — ofx-js has no type declarations; narrowed via hasParse below
  // biome-ignore lint/correctness/noUnresolvedImports: ofx-js is declared in package.json; Biome's resolver can't follow its CJS/ESM conditional exports
  const mod: unknown = await import("ofx-js");
  const modObj = isOfxRecord(mod) ? mod : {};
  const defaultExport = modObj.default;
  const defaultObj = isOfxRecord(defaultExport) ? defaultExport : {};
  const candidates: unknown[] = [modObj.OFX, defaultExport, defaultObj.OFX, mod];
  const parser = candidates.find(hasParse);
  if (!parser) {
    throw new Error("ofx-js module shape not recognized");
  }
  const content = await readFile(path, "utf8");
  return parser.parse(content);
}

// OFX datetime format: YYYYMMDDHHMMSS[.sss][TZ] — strip to YYYY-MM-DD.
function ofxDateToIso(raw: OfxValue): string | null {
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

function ofxDateToFullIso(raw: OfxValue): string | null {
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

// Walk an ofx-js parsed structure and extract our canonical shape.
// ofx-js yields deeply-nested objects matching OFX XML. Credit cards live
// under CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS; checking/savings under
// BANKMSGSRSV1 > STMTTRNRS > STMTRS. Structure is otherwise parallel.
function extractFromQfx(parsed: unknown): QfxExtracted {
  const root: OfxValue = ofxGet(parsed, "OFX") ?? parsed;
  if (!isOfxRecord(root)) {
    return { transactions: [], balance: null };
  }

  const cc = ofxGet(ofxGet(ofxGet(root, "CREDITCARDMSGSRSV1"), "CCSTMTTRNRS"), "CCSTMTRS");
  const bank = ofxGet(ofxGet(ofxGet(root, "BANKMSGSRSV1"), "STMTTRNRS"), "STMTRS");
  let stmtRaw: OfxValue = null;
  if (isOfxRecord(cc)) {
    stmtRaw = cc;
  } else if (isOfxRecord(bank)) {
    stmtRaw = bank;
  }
  if (!stmtRaw) {
    return { transactions: [], balance: null };
  }

  const currency = ofxString(ofxGet(stmtRaw, "CURDEF")) ?? "USD";

  // Transactions — BANKTRANLIST > STMTTRN (can be a single object or an array).
  const trList = ofxGet(stmtRaw, "BANKTRANLIST");
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

  // Balance — LEDGERBAL + AVAILBAL.
  let balance: QfxBalance | null = null;
  const ledgerBal = ofxGet(stmtRaw, "LEDGERBAL");
  const availBal = ofxGet(stmtRaw, "AVAILBAL");
  if (ledgerBal || availBal) {
    const asOf = ofxDateToFullIso(ofxGet(ledgerBal, "DTASOF") ?? ofxGet(availBal, "DTASOF"));
    if (asOf) {
      const ledgerAmt = ofxNumber(ofxGet(ledgerBal, "BALAMT"));
      const availAmt = ofxNumber(ofxGet(availBal, "BALAMT"));
      balance = {
        as_of: asOf,
        ledger_cents: ledgerAmt == null ? null : Math.round(ledgerAmt * CENTS_MULTIPLIER),
        available_cents: availAmt == null ? null : Math.round(availAmt * CENTS_MULTIPLIER),
      };
    }
  }

  return { transactions, balance };
}

// ─── Main ─────────────────────────────────────────────────────────────────

function chooseActivity(
  requested: Map<string, StreamScope>,
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

runConnector({
  name: "chase",
  validateRecord,
  // Chase fingerprints the shared daemon profile and bounces it to
  // /#/logon/logon/error regardless of cookie state. See
  // `design-notes/chase-anti-bot.md`. Isolated-per-connector profile works.
  // Headful by default so Chase's login accepts the submission.
  browser: { profileName: "chase", headless: false },
  async ensureSession({ context, page, sendInteraction }): Promise<void> {
    await ensureChaseSession({
      context,
      page,
      sendInteraction,
    });
  },
  async collect(ctx: BrowserCollectContext): Promise<void> {
    const { state: startState, requested, page, emit, emitRecord, progress, capture, emittedAt } = ctx;
    const wantsAccounts = requested.has("accounts");
    const wantsTransactions = requested.has("transactions");
    const wantsBalances = requested.has("balances");
    const wantsStatements = requested.has("statements");

    // State is keyed by stream name at the runtime layer:
    //   { transactions: { per_account: {<id>: {max_seen_date, ...}} } }
    // Normalize to an inner shape the rest of the connector reads directly.
    const txState = (startState.transactions ?? startState) as TransactionsStateShape;

    // Track max_seen_date per account across this run so the STATE cursor
    // reflects "I've seen transactions up to this date" per account. Used
    // next run to pick the "since_last_statement" activity for incremental
    // fetches.
    const maxSeenByAccount: Record<string, TransactionCursor> = {
      ...(txState.per_account ?? {}),
    } as Record<string, TransactionCursor>;

    // Build resource filters per stream (runtime also filters at emit time;
    // we build locally so we can skip PDF downloads / download-page nav for
    // accounts the client didn't ask for).
    const resFilters = new Map<string, ReadonlySet<string> | null>();
    for (const [streamName, scope] of requested) {
      resFilters.set(streamName, resourceSet(scope));
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "pdpp-chase-"));

    try {
      await progress("Chase session verified; enumerating accounts");

      const accounts = await discoverAccounts(page);
      // Fixture capture: dashboard account-list DOM.
      if (capture) {
        await capture.captureDom(page, "dashboard-accounts");
      }
      if (accounts.length === 0) {
        const diag = await page
          .evaluate((): DashboardDiagnostics => {
            const WS = /\s+/g;
            return {
              url: location.href,
              title: document.title,
              body_preview: (document.body?.innerText || "").replace(WS, " ").slice(0, 500),
            };
          })
          .catch((): DashboardDiagnostics | null => null);
        await emit({
          type: "SKIP_RESULT",
          stream: "accounts",
          reason: "selectors_pending",
          message: "No accounts discovered from dashboard. Selectors need calibration against live DOM.",
          diagnostics: diag,
        });
        return; // runtime emits DONE succeeded
      }

      await progress(`Found ${accounts.length} account(s)`);

      // Apply the `accounts` stream's resources filter to the per-account
      // loop so we don't hit Chase's download page for accounts the client
      // didn't ask for.
      const accountsResFilter =
        resFilters.get("accounts") ?? resFilters.get("transactions") ?? resFilters.get("balances") ?? null;
      const filteredAccounts: ChaseAccount[] = accountsResFilter?.size
        ? accounts.filter((a) => accountsResFilter.has(a.internal_id))
        : accounts;

      // Emit accounts stream. Our record.id is Chase's internal account id
      // directly — stable, no hashing needed. Keeps transactions.account_id
      // aligned with the download URL param.
      if (wantsAccounts) {
        for (const a of filteredAccounts) {
          await emitRecord("accounts", {
            id: a.internal_id,
            name: a.name,
            type: a.type,
            last_four: a.last_four,
            balance_cents: null, // populated from QFX LEDGERBAL when downloads run
            available_balance_cents: null,
            credit_limit_cents: null,
            available_credit_cents: null,
            statement_balance_cents: null,
            status: null,
            balance_as_of: null,
            fetched_at: emittedAt,
          });
        }
      }

      // Transactions + balances: download QFX per account, parse, emit.
      if (wantsTransactions || wantsBalances) {
        for (const a of filteredAccounts) {
          const activityChoice = chooseActivity(
            requested,
            txState,
            wantsTransactions ? "transactions" : "balances",
            a.internal_id
          );
          await emit({
            type: "PROGRESS",
            stream: "transactions",
            message: `${a.name}: downloading QFX (activity=${activityChoice.activity})`,
          });

          const result = await downloadQfx(
            page,
            a,
            tmpDir,
            activityChoice.dateRange
              ? {
                  activity: activityChoice.activity,
                  dateRange: activityChoice.dateRange,
                }
              : { activity: activityChoice.activity }
          );
          if (!result.downloaded) {
            await emit({
              type: "SKIP_RESULT",
              stream: "transactions",
              reason: "qfx_download_failed",
              message: `${a.name}: ${result.error}`,
            });
            continue;
          }

          let parsed: unknown;
          try {
            parsed = await parseQfxFile(result.qfxPath);
          } catch (err) {
            await emit({
              type: "SKIP_RESULT",
              stream: "transactions",
              reason: "qfx_parse_failed",
              message: `${a.name}: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE_LONG)}`,
            });
            continue;
          }

          const { transactions, balance } = extractFromQfx(parsed);

          if (wantsTransactions) {
            const prior = maxSeenByAccount[a.internal_id];
            let maxDate: string | null = prior?.max_seen_date ?? null;
            for (const t of transactions) {
              if (!t.date) {
                continue;
              }
              await emitRecord("transactions", {
                id: `${a.internal_id}|${t.fitid}`,
                account_id: a.internal_id,
                account_name: a.name,
                fitid: t.fitid,
                date: t.date,
                amount: t.amount_cents,
                currency: t.currency,
                type: t.type,
                name: t.name,
                memo: t.memo,
                check_number: t.check_number,
                reference_number: t.reference_number,
                source: `qfx_download_${activityChoice.activity}_${t.date}`,
                fetched_at: emittedAt,
              });
              if (!maxDate || t.date > maxDate) {
                maxDate = t.date;
              }
            }
            if (maxDate) {
              maxSeenByAccount[a.internal_id] = {
                ...(prior ?? {}),
                max_seen_date: maxDate,
                last_activity: activityChoice.activity,
                last_fetched_at: emittedAt,
              };
            }
          }

          if (wantsBalances && balance) {
            await emitRecord("balances", {
              id: `${a.internal_id}|${balance.as_of}`,
              account_id: a.internal_id,
              as_of: balance.as_of,
              ledger_balance_cents: balance.ledger_cents,
              available_balance_cents: balance.available_cents,
              fetched_at: emittedAt,
            });
          }

          await emit({
            type: "PROGRESS",
            stream: "transactions",
            message: `${a.name}: emitted ${transactions.length} transactions`,
          });
        }
      }

      // Statements: navigate to Statements & Documents, enumerate rows,
      // download each PDF, emit one record per statement with
      // content-addressed path.
      if (wantsStatements) {
        try {
          await emit({
            type: "PROGRESS",
            stream: "statements",
            message: "Navigating to Statements & Documents",
          });
          await navigateToStatementsPage(page);
          // Fixture capture: statements list page DOM.
          if (capture) {
            await capture.captureDom(page, "statements-list");
          }
          const rows = await enumerateStatementRows(page);
          await emit({
            type: "PROGRESS",
            stream: "statements",
            message: `Found ${rows.length} statement row(s)`,
          });

          for (const row of rows) {
            try {
              const dateIso = parseDateDelivered(row.date_delivered_raw);
              const accountId = resolveAccountIdForRow(row, filteredAccounts) ?? resolveAccountIdForRow(row, accounts);

              // Apply resources filter: if the accounts res filter excludes
              // this statement's account, skip it. (emitRecord will also
              // skip, but doing it here saves the PDF download.)
              if (accountsResFilter?.size && accountId && !accountsResFilter.has(accountId)) {
                continue;
              }

              // Apply time_range filter: if client asked for statements.since
              // and this row predates it, skip the download.
              const stmtScope = requested.get("statements");
              if (stmtScope?.time_range?.since && dateIso && dateIso < stmtScope.time_range.since.slice(0, 10)) {
                continue;
              }
              if (stmtScope?.time_range?.until && dateIso && dateIso >= stmtScope.time_range.until.slice(0, 10)) {
                continue;
              }

              const id = shortHash(`${row.account_reference ?? ""}|${dateIso ?? row.date_delivered_raw}|${row.title}`);

              await emit({
                type: "PROGRESS",
                stream: "statements",
                message: `Downloading ${row.title}`,
              });

              const dlResult = await downloadStatementPdf(page, row, accountId);
              if (!dlResult.ok) {
                await emit({
                  type: "SKIP_RESULT",
                  stream: "statements",
                  reason: "pdf_download_failed",
                  message: `${row.title}: ${dlResult.error}`,
                });
                // Still emit the index row so the owner has a record the
                // statement exists, just without hydrated bytes.
                await emitRecord("statements", {
                  id,
                  account_id: accountId,
                  title: row.title,
                  date_delivered: dateIso,
                  account_reference: row.account_reference,
                  document_url: null,
                  pdf_path: null,
                  pdf_sha256: null,
                  fetched_at: emittedAt,
                });
                continue;
              }

              await emitRecord("statements", {
                id,
                account_id: accountId,
                title: row.title,
                date_delivered: dateIso,
                account_reference: row.account_reference,
                document_url: fileUrl(dlResult.pdfPath),
                pdf_path: dlResult.pdfPath,
                pdf_sha256: dlResult.pdfSha256,
                fetched_at: emittedAt,
              });
            } catch (rowErr) {
              await emit({
                type: "SKIP_RESULT",
                stream: "statements",
                reason: "row_exception",
                message: `${row.title}: ${truncate(errMessage(rowErr), ERROR_MESSAGE_SLICE_LONG)}`,
              });
            }
          }

          const stateMsg: Extract<EmittedMessage, { type: "STATE" }> = {
            type: "STATE",
            stream: "statements",
            cursor: { fetched_at: emittedAt },
          };
          await emit(stateMsg);
        } catch (err) {
          await emit({
            type: "SKIP_RESULT",
            stream: "statements",
            reason: "statements_scrape_failed",
            message: truncate(errMessage(err), ERROR_MESSAGE_SLICE_MAX),
          });
        }
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch((): undefined => undefined);
    }

    // Emit STATE for incremental resumption. The per_account cursor drives
    // the next run's chooseActivity() — when max_seen_date is present we'll
    // use "since_last_statement" instead of re-downloading all transactions.
    if (wantsTransactions && Object.keys(maxSeenByAccount).length > 0) {
      const stateMsg: Extract<EmittedMessage, { type: "STATE" }> = {
        type: "STATE",
        stream: "transactions",
        cursor: { per_account: maxSeenByAccount },
      };
      await emit(stateMsg);
    }
  },
});
