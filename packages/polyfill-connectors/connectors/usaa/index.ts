#!/usr/bin/env node
/**
 * PDPP USAA Connector (v0.2.0)
 *
 * Uses shared Playwright persistent profile. Drives real selectors captured
 * from a live session on 2026-04-19.
 *
 * Streams: accounts, transactions, transfers, bill_payments,
 *          scheduled_transactions, credit_card_billing, statements,
 *          inbox_messages, external_accounts.
 *
 * Transactions path: drive the USAA "Export" button → "Select Date Range"
 * CSV flow. Primary key is a synthetic SHA-256 hash since USAA does not
 * expose transaction IDs (documented design choice — see design-notes/usaa.md).
 *
 * Session: cookie-based probe on UsaaMbWebMemberLoggedIn + LtpaToken2.
 * On session death, emits INTERACTION manual_action → inbox.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { ensureUsaaSession } from "../../src/auto-login/usaa.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  type InteractionRequest,
  type InteractionResponse,
  nowIso,
  politeDelay,
  type RecordData,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import {
  attachDownloadQueue,
  type DownloadQueue,
} from "../../src/download-queue.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";
import {
  fileUrlForPath,
  hydrateStatementPdfs,
  parsePdfStatement,
  type StatementRow,
} from "./statement-pdfs.ts";

const validateRecord = validateRecordRaw as ValidateRecord;

// ─── Module-scope regexes ────────────────────────────────────────────────

const CURRENCY_RE = /-?\$?([\d,]+\.\d{2})/;
const NEGATIVE_PREFIX_RE = /^-|\(/;
const COMMA_RE = /,/g;
const ACCOUNT_URL_PREFIXES =
  'a[href^="/my/checking"], a[href^="/my/savings"], a[href^="/my/credit-card"], a[href^="/my/external-account"], a[href^="/my/loan"], a[href^="/my/mortgage"], a[href^="/my/investing"], a[href^="/my/retirement"]';
const DASHBOARD_SELECTOR_WAIT =
  'a[href^="/my/checking"], a[href^="/my/credit-card"], a[href^="/my/external-account"]';
const LOGON_REDIRECT_RE =
  /\/my\/logon|\/access-management\/oauth2\/member\/authorize/;
const TRANSACTION_ACCOUNT_TYPE_RE = /checking|savings|credit-card/;
const CREDIT_CARD_TYPE_RE = /credit-card/;
const CHECK_NUMBER_RE = /CHECK\s*#?\s*0*(\d+)/i;
const DESCRIPTION_HEADER_RE = /^(description|payee|merchant|memo)$/i;
const STATEMENT_TITLE_RE = /STATEMENT/i;
const NON_STATEMENT_TITLE_RE =
  /(TERMS\b|AGREEMENT\b|NOTICE\b|DISCLOSURE\b|CONDITION)/i;
const UNREAD_RE = /UNREAD/i;
const MET_RE = /met/i;
const LAST4_REF_RE = /\*(\d{4})/;
const TEMP_DIR_PREFIX_RE = /\/[^/]+$/;

// ─── Timing + limits ────────────────────────────────────────────────────

const DASHBOARD_NAV_TIMEOUT_MS = 30_000;
const DASHBOARD_SELECTOR_TIMEOUT_MS = 20_000;
const DASHBOARD_SETTLE_DELAY_MS = 4000;
const DOCUMENTS_NAV_TIMEOUT_MS = 25_000;
const DOCUMENTS_SETTLE_DELAY_MS = 5000;
const ACCOUNT_NAV_TIMEOUT_MS = 30_000;
const ACCOUNT_SETTLE_DELAY_MS = 6000;
const INBOX_NAV_TIMEOUT_MS = 25_000;
const CC_SETTLE_DELAY_MS = 6000;
const EXPORT_DIALOG_DELAY_MS = 2500;
const EXPORT_STATE_DELAY_MS = 1500;
const EXPORT_CLICK_TIMEOUT_MS = 5000;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const KEY_TYPE_DELAY_MS = 30;
const MS_PER_DAY = 24 * 3600 * 1000;
const DAYS_PER_MONTH = 30;
const BACKFILL_DAYS_5Y = 5 * 365 * MS_PER_DAY;
const BACKFILL_DAYS_2Y = 2 * 365 * MS_PER_DAY;
const BACKFILL_DAYS_1Y = 365 * MS_PER_DAY;
const BACKFILL_DAYS_3MO = 90 * MS_PER_DAY;
const BACKFILL_17MO = 17 * DAYS_PER_MONTH * MS_PER_DAY;
const INCREMENTAL_OVERLAP_MS = 5 * MS_PER_DAY;
const HASH_LENGTH = 32;
const ID_TEXT_SNIP = 160;
const HTML_PREVIEW_MAX = 600;
const CENTS_MULTIPLIER = 100;

// ─── Local types ─────────────────────────────────────────────────────────

interface DashboardAccount {
  account_id_raw: string | null;
  account_type: string;
  account_url: string;
  balance_cents: number | null;
  last_four: string | null;
  name: string | null;
  raw_text: string;
}

interface AccountRecord extends RecordData {
  available_balance_cents: number | null;
  balance_cents: number | null;
  fetched_at: string;
  id: string;
  last_four: string | null;
  name: string | null;
  status: "open";
  type: string;
}

interface TransactionRecord extends RecordData {
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

interface InboxMessageRecord extends RecordData {
  date_received: string | null;
  fetched_at: string;
  id: string;
  preview: string;
  status: "unread" | "read";
  subject: string;
}

interface StatementRecord extends RecordData {
  account_id: string | null;
  account_reference: string | null;
  date_delivered: string | null;
  document_url: string | null;
  fetched_at: string;
  id: string;
  pdf_path: string | null;
  pdf_sha256: string | null;
  title: string | null;
}

interface CreditCardBillingRecord extends RecordData {
  account_id: string | null;
  account_nickname: string | null;
  annual_percent_rate: string | null;
  available_credit_cents: number | null;
  billing_status: string | null;
  card_holders: string | null;
  cash_advance_apr: string | null;
  cash_rewards_cents: number | null;
  credit_limit_cents: number | null;
  current_balance_cents: number | null;
  fetched_at: string;
  id: string;
  minimum_payment_met: boolean;
}

interface DiagnosticCandidate {
  cls: string;
  id: string | null;
  tag: string;
  text: string;
}

interface PageDiagnostics {
  dialog_html_preview?: string | null;
  dialogs_open: number;
  export_candidates: DiagnosticCandidate[];
  has_utility_bar: boolean;
  nav_candidates: DiagnosticCandidate[];
  title: string;
  url: string;
}

interface DiagnosticInfo {
  diag: PageDiagnostics | null;
  error?: string;
  phase: string;
}

interface DocRow {
  account_reference: string;
  date_delivered: string;
  rowIndex: number;
  title: string;
}

interface IndexRow extends StatementRow {
  account_id: string | null;
  account_reference: string;
  date_delivered: string | null;
  id: string;
  rowIndex: number;
  title: string;
}

interface HydrationResultSuccess {
  buffer: Buffer;
  pdfPath: string;
  pdfSha256: string;
}
interface HydrationResultError {
  diag?: Record<string, unknown> | null;
  err: string;
}
type HydrationResult = HydrationResultSuccess | HydrationResultError;

interface InboxRow {
  date_short: string;
  preview: string;
  status: string;
}

interface BillingKv {
  [label: string]: string | undefined;
}

interface TransactionsStreamCursor {
  [accountKey: string]: { last_date: string | null } | undefined;
}

interface TransactionsPriorState {
  [accountKey: string]: { last_date: string | null } | undefined;
}

interface DriveExportOptions {
  accountType?: string;
  downloadQueue: DownloadQueue;
  onDiagnostics?: (info: DiagnosticInfo) => void;
  sinceDate: string;
  untilDate: string;
}

interface LocatedExportPage {
  export: Locator;
  url: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function hashId(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, HASH_LENGTH);
}

function currencyToCents(s: string | null | undefined): number | null {
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

function isoDate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return null;
  }
  return d.toISOString().slice(0, 10);
}

function mmddyyyy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// ─── Account extraction from the /my/usaa dashboard ───────────────────────

async function extractAccounts(page: Page): Promise<DashboardAccount[]> {
  await page.goto("https://www.usaa.com/my/usaa", {
    waitUntil: "domcontentloaded",
    timeout: DASHBOARD_NAV_TIMEOUT_MS,
  });
  await page
    .waitForSelector(DASHBOARD_SELECTOR_WAIT, {
      timeout: DASHBOARD_SELECTOR_TIMEOUT_MS,
    })
    .catch((): undefined => undefined);
  await politeDelay(DASHBOARD_SETTLE_DELAY_MS);
  return page.evaluate((linkSelector: string): DashboardAccount[] => {
    const WHITESPACE_RE = /\s+/g;
    const SKIP_TEXT_RE =
      /^(Get started|Add account|View|Manage|Open|Apply|Browse)/i;
    const TYPE_URL_RE = /^\/my\/([^/?]+)/;
    const ACCOUNT_ID_RE = /(?:accountId|acctId)=([^&]+)/;
    const LAST4_RE = /\*(\d{4})/;
    const ENDING_IN_RE = /\bEnding in\b|\bending in\b/i;
    const DOLLAR_RE = /\$([\d,]+\.\d{2})/g;
    const COMMA_RE_LOCAL = /,/g;

    interface El {
      getAttribute: (name: string) => string | null;
      innerText?: string;
    }

    const out: DashboardAccount[] = [];
    const links = [
      // @ts-expect-error — browser context globals (document)
      ...document.querySelectorAll(linkSelector),
    ] as El[];
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const text = (a.innerText || "").replace(WHITESPACE_RE, " ").trim();
      // Skip nav/CTA links that happen to match the URL prefix but have generic text.
      if (!text || text.length < 12 || SKIP_TEXT_RE.test(text)) {
        continue;
      }
      const typeMatch = href.match(TYPE_URL_RE);
      const accountType = typeMatch?.[1] ?? "unknown";
      const idMatch = href.match(ACCOUNT_ID_RE);
      const accountId = idMatch?.[1] ? decodeURIComponent(idMatch[1]) : null;
      const last4Match = text.match(LAST4_RE);
      const splitByEnding = text.split(ENDING_IN_RE);
      const namePart = splitByEnding[0] ?? "";
      const name = namePart.trim();
      const amounts = [...text.matchAll(DOLLAR_RE)]
        .map((m) => (m[1] ? m[1] : null))
        .filter((v): v is string => Boolean(v));
      const firstAmount = amounts[0];
      const balanceCents = firstAmount
        ? Math.round(Number(firstAmount.replace(COMMA_RE_LOCAL, "")) * 100)
        : null;
      out.push({
        account_id_raw: accountId,
        account_url: href,
        account_type: accountType,
        name: name || null,
        last_four: last4Match?.[1] ?? null,
        balance_cents: balanceCents,
        raw_text: text.slice(0, 200),
      });
    }
    return out;
  }, ACCOUNT_URL_PREFIXES);
}

// ─── CSV export driver for transactions ───────────────────────────────────

async function findExportAffordance(page: Page): Promise<Locator | null> {
  const bankClass = page.locator("button.ent-as-utility-bar__item.export");
  if (await bankClass.count().catch((): number => 0)) {
    return bankClass.first();
  }

  const creditClass = page.locator(
    "button.as_credit__utility-bar-item.as_credit__export"
  );
  if (await creditClass.count().catch((): number => 0)) {
    return creditClass.first();
  }

  const buttonText = page
    .locator('button, [role="button"]')
    .filter({ hasText: /^\s*Export\s*$/i });
  if (await buttonText.count().catch((): number => 0)) {
    return buttonText.first();
  }

  return null;
}

function capturePageDiagnostics(page: Page): Promise<PageDiagnostics | null> {
  return page
    .evaluate((): PageDiagnostics => {
      const WS_RE = /\s+/g;
      const EXPORT_OR_DL_RE = /export|download/i;

      interface El {
        className?: string | { toString(): string };
        id?: string;
        innerText?: string;
        tagName: string;
      }

      const take = (sel: string, max = 8): DiagnosticCandidate[] => {
        // @ts-expect-error — browser context globals (document)
        const els = [...document.querySelectorAll(sel)] as El[];
        return els.slice(0, max).map((el) => ({
          tag: el.tagName,
          text: (el.innerText || "").replace(WS_RE, " ").trim().slice(0, 50),
          cls: (el.className ? String(el.className) : "").slice(0, 80),
          id: el.id || null,
        }));
      };
      return {
        // @ts-expect-error — browser context globals (location)
        url: location.href,
        // @ts-expect-error — browser context globals (document)
        title: document.title,
        has_utility_bar: Boolean(
          // @ts-expect-error — browser context globals (document)
          document.querySelector(
            '.ent-as-utility-bar, [class*="utility-bar" i]'
          )
        ),
        export_candidates: take('button, [role="button"]').filter((c) =>
          EXPORT_OR_DL_RE.test(c.text)
        ),
        nav_candidates: take(
          'a[href*="/my/credit-card"], a[role="tab"], [role="tab"]'
        ),
        dialogs_open:
          // @ts-expect-error — browser context globals (document)
          document.querySelectorAll('[role="dialog"]').length,
      };
    })
    .catch((): PageDiagnostics | null => null);
}

async function locateExportPage(
  page: Page,
  accountUrl: string
): Promise<LocatedExportPage | null> {
  const candidates = [accountUrl];

  const seen = new Set<string>();
  for (const url of candidates) {
    if (seen.has(url)) {
      continue;
    }
    seen.add(url);
    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: ACCOUNT_NAV_TIMEOUT_MS,
      });
    } catch {
      continue;
    }
    await politeDelay(ACCOUNT_SETTLE_DELAY_MS);
    const finalUrl = page.url();
    if (LOGON_REDIRECT_RE.test(finalUrl)) {
      throw new Error("session_dead_redirect_to_logon");
    }
    const btn = await findExportAffordance(page);
    if (btn) {
      return { url, export: btn };
    }
  }
  return null;
}

async function driveExport(
  page: Page,
  accountUrl: string,
  { sinceDate, untilDate, onDiagnostics, downloadQueue }: DriveExportOptions
): Promise<string | null> {
  const located = await locateExportPage(page, accountUrl);
  if (!located) {
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      onDiagnostics({ phase: "no_export_affordance", diag });
    }
    return null;
  }

  try {
    await located.export.click({ timeout: EXPORT_CLICK_TIMEOUT_MS });
  } catch (err) {
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      const msg = err instanceof Error ? err.message : String(err);
      onDiagnostics({
        phase: "export_click_failed",
        diag,
        error: msg.slice(0, ID_TEXT_SNIP),
      });
    }
    return null;
  }
  await politeDelay(EXPORT_DIALOG_DELAY_MS);

  const selectCount = await page
    .locator(
      '[role="dialog"] select[name="selectionType"], select[name="selectionType"]'
    )
    .count()
    .catch((): number => 0);
  if (!selectCount) {
    if (onDiagnostics) {
      const base = await capturePageDiagnostics(page);
      const dialogHtml = await page
        .locator('[role="dialog"]')
        .first()
        .innerHTML()
        .catch((): string | null => null);
      const preview = dialogHtml
        ? dialogHtml.replace(/\s+/g, " ").slice(0, HTML_PREVIEW_MAX)
        : null;
      onDiagnostics({
        phase: "export_dialog_unexpected_shape",
        diag: base
          ? { ...base, dialog_html_preview: preview }
          : {
              url: "",
              title: "",
              has_utility_bar: false,
              export_candidates: [],
              nav_candidates: [],
              dialogs_open: 0,
              dialog_html_preview: preview,
            },
      });
    }
    await page.keyboard.press("Escape").catch((): undefined => undefined);
    return null;
  }

  await page
    .selectOption('select[name="selectionType"]', "date-range")
    .catch((): string[] => []);
  await politeDelay(EXPORT_STATE_DELAY_MS);

  const fromIn = page
    .locator('input[name="fromDate"], input[name="startDate"]')
    .first();
  const endIn = page.locator('input[name="endDate"]').first();
  await fromIn.click().catch((): undefined => undefined);
  await page.keyboard.press("Control+A").catch((): undefined => undefined);
  await page.keyboard.press("Delete").catch((): undefined => undefined);
  await fromIn
    .pressSequentially(mmddyyyy(sinceDate), { delay: KEY_TYPE_DELAY_MS })
    .catch((): undefined => undefined);
  await endIn.click().catch((): undefined => undefined);
  await page.keyboard.press("Control+A").catch((): undefined => undefined);
  await page.keyboard.press("Delete").catch((): undefined => undefined);
  await endIn
    .pressSequentially(mmddyyyy(untilDate), { delay: KEY_TYPE_DELAY_MS })
    .catch((): undefined => undefined);
  await politeDelay(EXPORT_STATE_DELAY_MS);
  await politeDelay(EXPORT_STATE_DELAY_MS);

  const tempDir = mkdtempSync(join(tmpdir(), "usaa-export-"));
  const downloadPromise = downloadQueue.waitForNextDownload({
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  });

  const submit = page.locator('[role="dialog"] button[type="submit"]').first();
  await submit.click().catch((): undefined => undefined);

  const errorPromise = page
    .locator(
      '[role="dialog"] [class*="errorMessage"]:not(:empty), [role="dialog"] :text-matches("no transactions|nothing to export", "i")'
    )
    .first()
    .waitFor({ state: "visible", timeout: DOWNLOAD_TIMEOUT_MS })
    .then((): { kind: "error" } => ({ kind: "error" }))
    .catch((): Promise<never> => new Promise((): void => undefined));

  try {
    const outcome = await Promise.race<
      | {
          kind: "download";
          d: Awaited<ReturnType<DownloadQueue["waitForNextDownload"]>>;
        }
      | { kind: "error" }
    >([
      downloadPromise.then((d) => ({ kind: "download", d }) as const),
      errorPromise,
    ]);
    if (outcome.kind === "error") {
      rmSync(tempDir, { recursive: true, force: true });
      await page
        .locator('[role="dialog"] #export-cancel-button')
        .click()
        .catch((): undefined => undefined);
      return null;
    }
    const download = outcome.d;
    const suggested = download.suggestedFilename() || "usaa-export.csv";
    const targetPath = join(tempDir, suggested);
    await download.saveAs(targetPath);
    return targetPath;
  } catch {
    rmSync(tempDir, { recursive: true, force: true });
    return null;
  }
}

// ─── CSV parsing ──────────────────────────────────────────────────────────

function parseCsv(text: string): string[][] {
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

function rowsToTransactions(
  rows: string[][],
  { accountId, accountName }: { accountId: string; accountName: string | null }
): TransactionRecord[] {
  if (rows.length < 2) {
    return [];
  }
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const idxDate = header.findIndex((h) => /date/i.test(h));
  const idxDesc = header.findIndex((h) => DESCRIPTION_HEADER_RE.test(h));
  const idxOrig = header.findIndex((h) => /original/i.test(h));
  const idxCat = header.findIndex((h) => /category/i.test(h));
  const idxAmt = header.findIndex((h) => /amount/i.test(h));
  const idxBal = header.findIndex((h) => /balance/i.test(h));
  const out: TransactionRecord[] = [];
  const tupleOrdinal = new Map<string, number>();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((f) => !f?.trim())) {
      continue;
    }
    const rawDate = idxDate >= 0 ? (r[idxDate] ?? null) : null;
    const date = isoDate(rawDate);
    if (!date) {
      continue;
    }
    const description = idxDesc >= 0 ? (r[idxDesc] ?? "").trim() : "";
    const original =
      idxOrig >= 0 ? (r[idxOrig] ?? "").trim() || description : description;
    const amount = idxAmt >= 0 ? (r[idxAmt] ?? "").trim() : "";
    const tupleKey = `${date}|${amount}|${original}`;
    const ord = tupleOrdinal.get(tupleKey) || 0;
    tupleOrdinal.set(tupleKey, ord + 1);
    const checkMatch = original.match(CHECK_NUMBER_RE);
    const id = hashId(`${accountId}|${tupleKey}|#${ord}`);
    const categoryRaw = idxCat >= 0 ? (r[idxCat] ?? "").trim() || null : null;
    const balanceRaw = idxBal >= 0 ? (r[idxBal] ?? null) : null;
    out.push({
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
      fetched_at: nowIso(),
    });
  }
  return out;
}

// ─── Connector entry point ────────────────────────────────────────────────

runConnector({
  name: "usaa",
  validateRecord,
  browser: { profileName: "usaa" },
  async ensureSession({
    context,
    page,
    sendInteraction,
  }: {
    context: BrowserContext;
    page: Page;
    sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
  }): Promise<void> {
    await ensureUsaaSession({
      context,
      page,
      sendInteraction,
    });
  },
  async collect(ctx: BrowserCollectContext): Promise<void> {
    const {
      state,
      requested,
      context,
      page,
      emit,
      emitRecord,
      progress,
      capture,
      sendInteraction,
      emittedAt,
    } = ctx;

    // Page-level download listener — context.on('download') doesn't fire over
    // CDP; page.on does. Attach BEFORE any clicks that might download.
    const downloadQueue = attachDownloadQueue(page);

    try {
      // ACCOUNTS
      await progress("Extracting accounts from dashboard");
      if (capture) {
        await capture.captureDom(page, "dashboard-accounts");
      }
      const accounts = await extractAccounts(page);
      await progress(`Found ${accounts.length} account(s)`);

      const accountRecords: AccountRecord[] = accounts.map((a) => ({
        id: a.account_id_raw || hashId(a.raw_text),
        type: a.account_type,
        name: a.name,
        last_four: a.last_four,
        balance_cents: a.balance_cents,
        available_balance_cents: null,
        status: "open",
        fetched_at: emittedAt,
      }));

      if (requested.has("accounts")) {
        for (const a of accountRecords) {
          await emitRecord("accounts", a);
        }
        await emit({
          type: "STATE",
          stream: "accounts",
          cursor: { fetched_at: nowIso() },
        });
      }

      // Signal raised by the transactions loop when a page redirects to
      // /my/logon mid-run — meaning USAA's session has lapsed.
      let sessionDeadMidRun = false;

      // TRANSACTIONS — drive Export per account where applicable
      if (requested.has("transactions")) {
        const stream = requested.get("transactions");
        const sinceDateCfg = stream?.time_range?.since?.slice(0, 10);
        const seventeenMonthsAgo = new Date(Date.now() - BACKFILL_17MO)
          .toISOString()
          .slice(0, 10);

        const priorStateForTxns =
          (state.transactions as TransactionsPriorState | undefined) ?? {};
        const transactionsCursor: TransactionsStreamCursor = {
          ...priorStateForTxns,
        };

        for (const a of accounts) {
          if (sessionDeadMidRun) {
            break;
          }
          if (!TRANSACTION_ACCOUNT_TYPE_RE.test(a.account_type)) {
            continue;
          }
          const accountKey = a.account_id_raw || "";
          const perAccState = priorStateForTxns[accountKey];
          const priorLastDate = perAccState?.last_date ?? null;
          const desiredSince = priorLastDate
            ? new Date(Date.parse(priorLastDate) - INCREMENTAL_OVERLAP_MS)
                .toISOString()
                .slice(0, 10)
            : (sinceDateCfg ?? seventeenMonthsAgo);
          const todayIso = new Date().toISOString().slice(0, 10);

          // Ladder: desired → 5y → 2y → 1y → 3mo.
          const candidateStarts: string[] = [desiredSince];
          const fiveYearsAgo = new Date(Date.now() - BACKFILL_DAYS_5Y)
            .toISOString()
            .slice(0, 10);
          const twoYearsAgo = new Date(Date.now() - BACKFILL_DAYS_2Y)
            .toISOString()
            .slice(0, 10);
          const oneYearAgo = new Date(Date.now() - BACKFILL_DAYS_1Y)
            .toISOString()
            .slice(0, 10);
          const threeMonthsAgo = new Date(Date.now() - BACKFILL_DAYS_3MO)
            .toISOString()
            .slice(0, 10);
          if (fiveYearsAgo > desiredSince) {
            candidateStarts.push(fiveYearsAgo);
          }
          if (twoYearsAgo > desiredSince) {
            candidateStarts.push(twoYearsAgo);
          }
          if (oneYearAgo > desiredSince) {
            candidateStarts.push(oneYearAgo);
          }
          if (threeMonthsAgo > desiredSince) {
            candidateStarts.push(threeMonthsAgo);
          }

          let csvPath: string | null = null;
          let usedSince: string | null = null;
          let lastDiag: DiagnosticInfo | null = null;
          const onDiagnostics = (info: DiagnosticInfo): void => {
            lastDiag = info;
          };
          for (const sinceDate of candidateStarts) {
            await emit({
              type: "PROGRESS",
              stream: "transactions",
              message: `Export ${a.name ?? "?"} (${a.last_four || "n/a"}) from ${sinceDate} to ${todayIso}`,
            });
            try {
              csvPath = await driveExport(
                page,
                `https://www.usaa.com${a.account_url}`,
                {
                  sinceDate,
                  untilDate: todayIso,
                  accountType: a.account_type,
                  onDiagnostics,
                  downloadQueue,
                }
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg === "session_dead_redirect_to_logon") {
                await emit({
                  type: "PROGRESS",
                  stream: "transactions",
                  message: `${a.name ?? "?"}: session lapsed — re-authenticating before retry`,
                });
                try {
                  await ensureUsaaSession({
                    context,
                    page,
                    sendInteraction,
                  });
                  continue;
                } catch (reauthErr) {
                  sessionDeadMidRun = true;
                  const reauthMsg =
                    reauthErr instanceof Error
                      ? reauthErr.message
                      : String(reauthErr);
                  await emit({
                    type: "SKIP_RESULT",
                    stream: "transactions",
                    reason: "session_dead_reauth_failed",
                    message: `USAA session expired mid-run and re-auth failed (${reauthMsg.slice(0, 120)}). Remaining accounts and statements skipped.`,
                  });
                  break;
                }
              }
              await emit({
                type: "SKIP_RESULT",
                stream: "transactions",
                reason: "export_error",
                message: `${a.name ?? "?"}: ${msg.slice(0, ID_TEXT_SNIP)}`,
              });
              csvPath = null;
            }
            if (csvPath) {
              usedSince = sinceDate;
              break;
            }
            const diagNow = lastDiag as DiagnosticInfo | null;
            if (
              diagNow &&
              (diagNow.phase === "no_export_affordance" ||
                diagNow.phase === "export_dialog_unexpected_shape")
            ) {
              await emit({
                type: "PROGRESS",
                stream: "transactions",
                message: `${a.name ?? "?"}: ${diagNow.phase} — skipping retries`,
              });
              break;
            }
            await emit({
              type: "PROGRESS",
              stream: "transactions",
              message: `retrying ${a.name ?? "?"} with shorter range`,
            });
          }
          if (!csvPath) {
            const isCreditCard = CREDIT_CARD_TYPE_RE.test(a.account_type);
            const finalDiag = lastDiag as DiagnosticInfo | null;
            const baseMessage = finalDiag
              ? `${a.name ?? "?"}: ${finalDiag.phase} at ${finalDiag.diag?.url ?? "unknown url"}`
              : `${a.name ?? "?"}: export dialog didn't produce a download across all ranges — account may have no transactions or selectors shifted`;
            const ccSuffix = isCreditCard
              ? ' (credit-card export flow not verified live 2026-04-19 — see design-notes/usaa.md "Fallback path: DOM scrape")'
              : "";
            await emit({
              type: "SKIP_RESULT",
              stream: "transactions",
              reason: isCreditCard
                ? "credit_card_export_unverified"
                : "export_no_download",
              message: `${baseMessage}${ccSuffix}`,
              diagnostics: finalDiag,
            });
            continue;
          }
          const text = await readFile(csvPath, "utf8");
          const rows = parseCsv(text);
          const txnAccountId = a.account_id_raw || a.last_four || "unknown";
          const txns = rowsToTransactions(rows, {
            accountId: txnAccountId,
            accountName: a.name,
          });
          let latest: string | null = priorLastDate;
          for (const t of txns) {
            await emitRecord("transactions", t);
            if (!latest || t.date > latest) {
              latest = t.date;
            }
          }
          await unlink(csvPath).catch((): undefined => undefined);
          const dir = csvPath.replace(TEMP_DIR_PREFIX_RE, "");
          await readdir(dir)
            .then((f): void => {
              if (!f.length) {
                rmSync(dir, { recursive: true, force: true });
              }
            })
            .catch((): undefined => undefined);

          transactionsCursor[accountKey || a.last_four || "unknown"] = {
            last_date: latest || usedSince || null,
          };
          await emit({
            type: "STATE",
            stream: "transactions",
            cursor: transactionsCursor,
          });
        }
      }

      // STATEMENTS — scrape /my/documents table, then hydrate PDF blobs per row.
      if (
        (requested.has("statements") || requested.has("transactions")) &&
        !sessionDeadMidRun
      ) {
        try {
          await emit({
            type: "PROGRESS",
            stream: "statements",
            message: "Fetching statements index",
          });
          await page.goto("https://www.usaa.com/my/documents", {
            waitUntil: "domcontentloaded",
            timeout: DOCUMENTS_NAV_TIMEOUT_MS,
          });
          await politeDelay(DOCUMENTS_SETTLE_DELAY_MS);
          const docs = await page.evaluate((): DocRow[] => {
            const WS_RE = /\s+/g;

            interface El {
              innerText?: string;
              querySelectorAll: (s: string) => El[];
            }

            // @ts-expect-error — browser context globals (document)
            const t = document.querySelector("table") as El | null;
            if (!t) {
              return [];
            }
            return [...t.querySelectorAll("tbody tr")].map(
              (tr: El, rowIndex: number) => {
                const cells = [...tr.querySelectorAll("td")] as El[];
                const c0 = cells[0];
                const c1 = cells[1];
                const c2 = cells[2];
                return {
                  rowIndex,
                  title: (c0?.innerText || "").replace(WS_RE, " ").trim(),
                  date_delivered: (c1?.innerText || "").trim(),
                  account_reference: (c2?.innerText || "").trim(),
                };
              }
            );
          });

          const resolveAccountId = (ref: string): string | null => {
            if (!ref) {
              return null;
            }
            const last4Match = ref.match(LAST4_REF_RE);
            const last4 = last4Match?.[1] ?? null;
            if (last4) {
              const byLast4 = accounts.find((a) => a.last_four === last4);
              if (byLast4?.account_id_raw) {
                return byLast4.account_id_raw;
              }
            }
            const refLower = ref.toLowerCase();
            const byName = accounts.find(
              (a) => a.name && refLower.includes(a.name.toLowerCase())
            );
            if (byName?.account_id_raw) {
              return byName.account_id_raw;
            }
            return null;
          };

          const indexRows: IndexRow[] = docs
            .filter((d) => d.date_delivered)
            .map((d) => ({
              rowIndex: d.rowIndex,
              id: hashId(
                `${d.account_reference}|${d.date_delivered}|${d.title}`
              ),
              account_id: resolveAccountId(d.account_reference),
              title: d.title,
              date_delivered: isoDate(d.date_delivered),
              account_reference: d.account_reference,
            }));

          const accountById = new Map<string, DashboardAccount>(
            accounts
              .filter((a): a is DashboardAccount & { account_id_raw: string } =>
                Boolean(a.account_id_raw)
              )
              .map((a) => [a.account_id_raw, a])
          );

          const hydrationResults = new Map<number, HydrationResult>();
          let hydrationAttempts = 0;
          let hydrationSuccesses = 0;

          try {
            const hydrated = await hydrateStatementPdfs({
              page,
              statements: indexRows,
              downloadQueue,
              onProgress: ({ index, total, title }) => {
                hydrationAttempts = index + 1;
                // Fire-and-forget: hydrateStatementPdfs signature is sync callback.
                // Swallowing the promise keeps the emit ordering best-effort; a
                // failed write would be caught by the outer try/catch on next await.
                emit({
                  type: "PROGRESS",
                  stream: "statements",
                  message: `Downloading PDF ${index + 1}/${total}: ${(title ?? "").slice(0, 60)}`,
                }).catch((): undefined => undefined);
              },
              onSkip: ({ statement, reason, diag }) => {
                hydrationResults.set(statement.rowIndex, {
                  err: reason,
                  diag,
                });
                emit({
                  type: "SKIP_RESULT",
                  stream: "statements",
                  reason: `pdf_download_${reason}`,
                  message: `${statement.title ?? "?"}: ${reason}`,
                  diagnostics: diag,
                }).catch((): undefined => undefined);
              },
            });
            for (const h of hydrated) {
              hydrationSuccesses++;
              hydrationResults.set(h.statement.rowIndex, {
                pdfPath: h.pdfPath,
                pdfSha256: h.pdfSha256,
                buffer: h.buffer,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await emit({
              type: "SKIP_RESULT",
              stream: "statements",
              reason: "hydrate_crashed",
              message: msg.slice(0, ID_TEXT_SNIP),
            });
          }

          if (requested.has("statements")) {
            for (const row of indexRows) {
              const h = hydrationResults.get(row.rowIndex);
              const ok = h && "pdfPath" in h ? h : null;
              const rec: StatementRecord = {
                id: row.id,
                account_id: row.account_id,
                title: row.title,
                date_delivered: row.date_delivered,
                account_reference: row.account_reference,
                document_url: ok ? fileUrlForPath(ok.pdfPath) : null,
                pdf_sha256: ok?.pdfSha256 ?? null,
                pdf_path: ok?.pdfPath ?? null,
                fetched_at: nowIso(),
              };
              await emitRecord("statements", rec);
            }
            await emit({
              type: "PROGRESS",
              stream: "statements",
              message: `Hydrated ${hydrationSuccesses}/${hydrationAttempts || indexRows.length} PDFs`,
            });
            await emit({
              type: "STATE",
              stream: "statements",
              cursor: { fetched_at: nowIso() },
            });
          }

          // Phase B — parse every successfully-downloaded PDF into transactions.
          if (requested.has("transactions")) {
            let pdfTxnCount = 0;
            let parsedStatements = 0;
            let unknownTemplates = 0;
            for (const row of indexRows) {
              const h = hydrationResults.get(row.rowIndex);
              const ok = h && "pdfPath" in h ? h : null;
              if (!ok) {
                continue;
              }
              const title = row.title || "";
              if (
                !STATEMENT_TITLE_RE.test(title) ||
                NON_STATEMENT_TITLE_RE.test(title)
              ) {
                continue;
              }
              const period = (row.date_delivered || "").slice(0, 7) || null;
              const acct = row.account_id
                ? accountById.get(row.account_id)
                : null;
              const accountName = acct?.name ?? row.account_reference ?? null;
              try {
                const { txns, parseMeta } = await parsePdfStatement({
                  buffer: ok.buffer,
                  accountId:
                    row.account_id || row.account_reference || "unknown",
                  accountName,
                  period,
                });
                if (!txns.length) {
                  unknownTemplates++;
                  await emit({
                    type: "SKIP_RESULT",
                    stream: "transactions",
                    reason: "pdf_template_unknown",
                    message: `${row.title ?? "?"} (${period ?? "unknown"}): no parser matched (era=${parseMeta.era})`,
                    diagnostics: {
                      statement_id: row.id,
                      year: parseMeta.year,
                      raw_text_sample:
                        "rawTextSample" in parseMeta
                          ? parseMeta.rawTextSample
                          : null,
                    },
                  });
                  continue;
                }
                for (const t of txns) {
                  await emitRecord("transactions", { ...t });
                  pdfTxnCount++;
                }
                parsedStatements++;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                await emit({
                  type: "SKIP_RESULT",
                  stream: "transactions",
                  reason: "pdf_parse_failed",
                  message: `${row.title ?? "?"}: ${msg.slice(0, ID_TEXT_SNIP)}`,
                });
              }
            }
            await emit({
              type: "PROGRESS",
              stream: "transactions",
              message: `PDF parse: ${pdfTxnCount} txns across ${parsedStatements} statements (${unknownTemplates} unknown templates)`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emit({
            type: "SKIP_RESULT",
            stream: "statements",
            reason: "scrape_failed",
            message: msg.slice(0, ID_TEXT_SNIP),
          });
        }
      }

      // INBOX_MESSAGES — scrape /my/inbox table.
      if (requested.has("inbox_messages") && !sessionDeadMidRun) {
        try {
          await emit({
            type: "PROGRESS",
            stream: "inbox_messages",
            message: "Fetching inbox",
          });
          await page.goto("https://www.usaa.com/my/inbox", {
            waitUntil: "domcontentloaded",
            timeout: INBOX_NAV_TIMEOUT_MS,
          });
          await politeDelay(DOCUMENTS_SETTLE_DELAY_MS);
          const msgs = await page.evaluate((): InboxRow[] => {
            const WS_RE = /\s+/g;

            interface El {
              innerText?: string;
              querySelectorAll: (s: string) => El[];
            }

            // @ts-expect-error — browser context globals (document)
            const t = document.querySelector("table") as El | null;
            if (!t) {
              return [];
            }
            return [...t.querySelectorAll("tbody tr")].map((tr: El) => {
              const cells = [...tr.querySelectorAll("td")] as El[];
              const c0 = cells[0];
              const c1 = cells[1];
              const c2 = cells[2];
              return {
                status: (c0?.innerText || "").replace(WS_RE, " ").trim(),
                date_short: (c1?.innerText || "").replace(WS_RE, " ").trim(),
                preview: (c2?.innerText || "").replace(WS_RE, " ").trim(),
              };
            });
          });
          const year = new Date().getFullYear();
          for (const m of msgs) {
            if (!m.date_short) {
              continue;
            }
            const parsed = new Date(`${m.date_short} ${year}`);
            const iso = Number.isNaN(parsed.getTime())
              ? null
              : parsed.toISOString().slice(0, 10);
            const id = hashId(`${m.date_short}|${m.preview.slice(0, 120)}`);
            const record: InboxMessageRecord = {
              id,
              date_received: iso,
              status: UNREAD_RE.test(m.status) ? "unread" : "read",
              subject: m.preview.slice(0, 120),
              preview: m.preview,
              fetched_at: nowIso(),
            };
            await emitRecord("inbox_messages", record);
          }
          await emit({
            type: "STATE",
            stream: "inbox_messages",
            cursor: { fetched_at: nowIso() },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emit({
            type: "SKIP_RESULT",
            stream: "inbox_messages",
            reason: "scrape_failed",
            message: msg.slice(0, ID_TEXT_SNIP),
          });
        }
      }

      // CREDIT_CARD_BILLING — one record per credit-card account.
      if (requested.has("credit_card_billing") && !sessionDeadMidRun) {
        try {
          await emit({
            type: "PROGRESS",
            stream: "credit_card_billing",
            message: "Fetching credit card billing details",
          });
          const cards = accounts.filter((a) =>
            CREDIT_CARD_TYPE_RE.test(a.account_type)
          );
          for (const a of cards) {
            await page
              .goto(`https://www.usaa.com${a.account_url}`, {
                waitUntil: "domcontentloaded",
                timeout: ACCOUNT_NAV_TIMEOUT_MS,
              })
              .catch((): undefined => undefined);
            await politeDelay(CC_SETTLE_DELAY_MS);
            const billing = await page.evaluate((): BillingKv => {
              interface El {
                innerText?: string;
                nextElementSibling?: El | null;
              }
              const kv: BillingKv = {};
              const labels = [
                // @ts-expect-error — browser context globals (document)
                ...document.querySelectorAll("dt, .label, .field-label"),
              ] as El[];
              for (const el of labels) {
                const label = (el.innerText || "").trim();
                const value = (el.nextElementSibling?.innerText || "").trim();
                if (label && value && !kv[label]) {
                  kv[label] = value;
                }
              }
              return kv;
            });
            const id = a.account_id_raw || a.last_four || hashId(a.raw_text);
            const record: CreditCardBillingRecord = {
              id,
              account_id: a.account_id_raw,
              account_nickname:
                billing["Account Nickname"] ?? billing.Nickname ?? null,
              current_balance_cents: currencyToCents(
                billing["Current Balance"] ?? null
              ),
              available_credit_cents: currencyToCents(
                billing["Available Credit"] ?? null
              ),
              credit_limit_cents: currencyToCents(
                billing["Credit Limit"] ?? null
              ),
              annual_percent_rate: billing["Annual Percent Rate"] ?? null,
              cash_advance_apr: billing["Cash Advance APR"] ?? null,
              cash_rewards_cents: currencyToCents(
                billing["Cash Rewards"] ?? null
              ),
              billing_status: billing["Billing Information"] ?? null,
              minimum_payment_met: MET_RE.test(
                billing["Billing Information"] ?? ""
              ),
              card_holders: billing["Card Holders"] ?? null,
              fetched_at: nowIso(),
            };
            await emitRecord("credit_card_billing", record);
          }
          await emit({
            type: "STATE",
            stream: "credit_card_billing",
            cursor: { fetched_at: nowIso() },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await emit({
            type: "SKIP_RESULT",
            stream: "credit_card_billing",
            reason: "scrape_failed",
            message: msg.slice(0, ID_TEXT_SNIP),
          });
        }
      }

      // Still-deferred streams (need live DOM + more work):
      const deferred: string[] = [
        "transfers",
        "bill_payments",
        "scheduled_transactions",
        "external_accounts",
      ];
      for (const s of deferred) {
        if (requested.has(s)) {
          const msg: EmittedMessage = {
            type: "SKIP_RESULT",
            stream: s,
            reason: "selectors_pending",
            message: `${s} stream scaffolded in design-notes; click-chain or SPA-component wiring deferred.`,
          };
          await emit(msg);
        }
      }

      if (sessionDeadMidRun) {
        throw new Error(
          "usaa session expired mid-run; re-run with fresh auth to complete"
        );
      }
    } finally {
      try {
        downloadQueue.detach();
      } catch {
        /* ignore */
      }
    }
  },
});
