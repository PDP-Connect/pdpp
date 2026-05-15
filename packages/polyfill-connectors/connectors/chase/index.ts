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

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, Response } from "playwright";
import { ensureChaseSession } from "../../src/auto-login/chase.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { attachDownloadQueue } from "../../src/download-queue.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { savePlaywrightDownload } from "../../src/playwright-download.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import {
  ACTIVITY_LABELS,
  accountSlug,
  chooseActivity,
  currentActivityId,
  errMessage,
  extractFromQfx,
  fileUrl,
  isOfxRecord,
  isoToPacked,
  parseCurrentActivityDom,
  parseDashboardAccountsDom,
  parseDateDelivered,
  parseStatementsListDom,
  resolveAccountIdForRow,
  sha256Hex,
  shortHash,
  truncate,
  yearMonthFromIso,
} from "./parsers.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";
import type {
  ActivityKind,
  ChaseAccount,
  DashboardDiagnostics,
  DateFillResult,
  DownloadOptions,
  DownloadResult,
  StatementDownloadResult,
  StatementRow,
  TransactionCursor,
  TransactionsStateShape,
} from "./types.ts";

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
const DOWNLOAD_RESPONSE_HINT_RE = /filename|attachment|octet-stream|x-ofx|qfx/iu;
const NO_ACTIVITY_CONFIRMATION_RE = /we couldn't find any activity that matched the date range you chose/iu;
const FILENAME_PLAIN_RE = /filename="?([^";]+)"?/iu;
const FILENAME_UTF8_RE = /filename\*=UTF-8''([^;]+)/iu;
const SURROUNDING_QUOTES_RE = /^"|"$/g;
const DASHBOARD_OVERVIEW_URL = "https://secure.chase.com/web/auth/dashboard#/dashboard/overview";
const DASHBOARD_ACCOUNT_SELECTOR =
  '[id^="accounts-name-link-button-"][id$="-label"], button[id^="accounts-name-link-button-"], button[data-testid^="accounts-name-link-button-"]';
const ACCOUNT_ACTIVITY_DOM_WAIT_SELECTOR =
  'tr[data-values], [data-testid*="transaction" i], [data-testid*="activity" i], [id*="transaction" i], [id*="activity" i], tr';
const TIME_RANGE_FIELD_BY_STREAM: Record<string, string> = {
  balances: "as_of",
  current_activity: "activity_date",
  statements: "date_delivered",
  transactions: "date",
};

export function chaseTimeRangeField(stream: string): string {
  return TIME_RANGE_FIELD_BY_STREAM[stream] ?? "date";
}

interface CapturedQfxResponse {
  body: Buffer;
  contentType: string;
  method: string;
  status: number;
  suggestedFilename: string | null;
  url: string;
}

interface QfxResponseQueue {
  detach(): void;
  waitForNextResponse(opts?: { timeoutMs?: number }): Promise<CapturedQfxResponse>;
}

interface NoActivityConfirmation {
  bodyPreview: string;
  url: string;
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
    .locator(DASHBOARD_ACCOUNT_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout: DOM_WAIT_MS })
    .catch((): undefined => undefined);

  // Verified patterns:
  // - 2026-04-21: span#accounts-name-link-button-<INTERNAL_ID>-label
  // - 2026-05-14: button#accounts-name-link-button-<INTERNAL_ID>
  //
  // The internal id matches the transactionDetails param and is what the
  // download form's account selector expects. DOM parsing now runs in Node via
  // linkedom (see parsers.ts#parseDashboardAccountsDom) so it can be tested
  // offline against captured fixtures.
  try {
    const html = await page.content();
    return parseDashboardAccountsDom(html);
  } catch {
    return [];
  }
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

function suggestedFilenameFromHeaders(headers: Record<string, string>): string | null {
  const disposition = headers["content-disposition"];
  if (!disposition) {
    return null;
  }
  const utf8 = disposition.match(FILENAME_UTF8_RE);
  if (utf8?.[1]) {
    return decodeURIComponent(utf8[1].replace(SURROUNDING_QUOTES_RE, ""));
  }
  const plain = disposition.match(FILENAME_PLAIN_RE);
  return plain?.[1] ?? null;
}

function isLikelyQfxResponseBody(body: Buffer, headers: Record<string, string>): boolean {
  if (body.length === 0) {
    return false;
  }
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  if (contentType.includes("text/html") || contentType.includes("application/json")) {
    return false;
  }
  const head = body.subarray(0, 1024).toString("utf8").toUpperCase();
  return head.includes("OFXHEADER:") || head.includes("<OFX>");
}

function attachQfxResponseQueue(page: Page): QfxResponseQueue {
  const pending: CapturedQfxResponse[] = [];
  const waiters: ((response: CapturedQfxResponse) => void)[] = [];

  const enqueue = (response: CapturedQfxResponse): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(response);
      return;
    }
    pending.push(response);
  };

  const onResponse = (response: Response): void => {
    const headers = response.headers();
    const contentDisposition = headers["content-disposition"] ?? "";
    const contentType = headers["content-type"] ?? "";
    if (!DOWNLOAD_RESPONSE_HINT_RE.test(`${contentDisposition} ${contentType}`)) {
      return;
    }
    response
      .body()
      .then((body) => {
        if (!isLikelyQfxResponseBody(body, headers)) {
          return;
        }
        enqueue({
          body,
          contentType,
          method: response.request().method(),
          status: response.status(),
          suggestedFilename: suggestedFilenameFromHeaders(headers),
          url: response.url(),
        });
      })
      .catch((): undefined => undefined);
  };

  page.on("response", onResponse);

  return {
    detach(): void {
      page.off("response", onResponse);
    },
    waitForNextResponse({ timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}): Promise<CapturedQfxResponse> {
      const first = pending.shift();
      if (first) {
        return Promise.resolve(first);
      }
      return new Promise<CapturedQfxResponse>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          const idx = waiters.indexOf(resolveOnce);
          if (idx >= 0) {
            waiters.splice(idx, 1);
          }
          reject(new Error(`qfx_response_timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const resolveOnce = (response: CapturedQfxResponse): void => {
          if (settled) {
            pending.unshift(response);
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve(response);
        };
        waiters.push(resolveOnce);
      });
    },
  };
}

async function waitForQfxDownloadArtifact(
  page: Page,
  account: ChaseAccount,
  activity: ActivityKind,
  tmpDir: string,
  downloadQueue: ReturnType<typeof attachDownloadQueue>,
  qfxResponseQueue: QfxResponseQueue,
  capture: CaptureSession | null | undefined
): Promise<DownloadResult> {
  try {
    const playwrightDownloadPromise = downloadQueue
      .waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS })
      .then((download) => ({
        download,
        kind: "playwright_download" as const,
      }));
    const qfxResponsePromise = qfxResponseQueue
      .waitForNextResponse({ timeoutMs: DOWNLOAD_TIMEOUT_MS })
      .then((response) => ({
        kind: "qfx_response" as const,
        response,
      }));
    const result = await Promise.any([
      playwrightDownloadPromise,
      qfxResponsePromise,
      waitForNoActivityConfirmation(page, { timeoutMs: DOWNLOAD_TIMEOUT_MS }).then((confirmation) => ({
        confirmation,
        kind: "no_activity" as const,
      })),
    ]);
    if (result.kind === "no_activity") {
      capture?.captureHttp(
        `download-qfx-${account.internal_id}-${activity}-no-activity-confirmation`,
        { bodyPreview: result.confirmation.bodyPreview },
        {
          method: "DOM",
          path: result.confirmation.url,
          status: 200,
          type: "text/html",
        }
      );
      await capturePageCheckpoint(capture, page, `download-qfx-${account.internal_id}-${activity}-no-activity`);
      return { activity, noActivity: true };
    }
    const qfxPath = join(tmpDir, `chase-${account.internal_id}-${activity}-${Date.now()}.qfx`);
    if (result.kind === "playwright_download") {
      try {
        await savePlaywrightDownload(result.download, qfxPath);
      } catch (downloadErr) {
        const responseResult = await qfxResponsePromise.catch((): null => null);
        if (!responseResult) {
          throw downloadErr;
        }
        await writeFile(qfxPath, responseResult.response.body);
        capture?.captureHttp(
          `download-qfx-${account.internal_id}-${activity}-qfx-response-after-download-save-failed`,
          {
            bytes: responseResult.response.body.length,
            downloadError: truncate(errMessage(downloadErr), ERROR_MESSAGE_SLICE_LONG),
            suggestedFilename: responseResult.response.suggestedFilename,
          },
          {
            method: responseResult.response.method,
            path: responseResult.response.url,
            status: responseResult.response.status,
            type: responseResult.response.contentType,
          }
        );
      }
    } else {
      await writeFile(qfxPath, result.response.body);
      capture?.captureHttp(
        `download-qfx-${account.internal_id}-${activity}-qfx-response`,
        { bytes: result.response.body.length, suggestedFilename: result.response.suggestedFilename },
        {
          method: result.response.method,
          path: result.response.url,
          status: result.response.status,
          type: result.response.contentType,
        }
      );
    }
    return { downloaded: true, qfxPath, activity };
  } catch (err) {
    await capturePageCheckpoint(
      capture,
      page,
      `download-qfx-${account.internal_id}-${activity}-download-event-timeout`
    );
    return {
      downloaded: false,
      error: `download_event_timeout: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }
}

async function waitForNoActivityConfirmation(
  page: Page,
  { timeoutMs = DOWNLOAD_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<NoActivityConfirmation> {
  await page.waitForFunction(
    (messagePattern) => {
      const bodyText = document.body?.innerText ?? "";
      return (
        location.href.includes("confirmDownloadAccountActivity") && new RegExp(messagePattern, "iu").test(bodyText)
      );
    },
    NO_ACTIVITY_CONFIRMATION_RE.source,
    { timeout: timeoutMs }
  );
  return page.evaluate((): NoActivityConfirmation => {
    const WS = /\s+/g;
    return {
      bodyPreview: (document.body?.innerText ?? "").replace(WS, " ").slice(0, 500),
      url: location.href,
    };
  });
}

/** Drive a single QFX download. */
async function downloadQfx(
  page: Page,
  account: ChaseAccount,
  tmpDir: string,
  capture: CaptureSession | null | undefined,
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
  await capturePageCheckpoint(capture, page, `download-qfx-${account.internal_id}-${activity}-form-loaded`);

  // Select activity option FIRST so the Date-Range pickers render before we
  // set file type. Chase's form re-renders when Activity changes; doing file
  // type after Activity keeps the selection stable through the re-render.
  const label = ACTIVITY_LABELS[activity];

  if (activity !== "current") {
    try {
      await selectActivity(page, label);
      await capturePageCheckpoint(capture, page, `download-qfx-${account.internal_id}-${activity}-activity-selected`);
    } catch (err) {
      await capturePageCheckpoint(
        capture,
        page,
        `download-qfx-${account.internal_id}-${activity}-activity-select-failed`
      );
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
        await capturePageCheckpoint(
          capture,
          page,
          `download-qfx-${account.internal_id}-${activity}-date-range-fill-failed`
        );
        return {
          downloaded: false,
          error: `date_range_fill_failed: ${ok.error}`,
        };
      }
      await capturePageCheckpoint(capture, page, `download-qfx-${account.internal_id}-${activity}-date-range-filled`);
    }
  }

  // Now set File Type via click-select (attribute mutation gets clobbered
  // by Activity re-renders).
  try {
    await selectFileType(page, "Quicken Web Connect");
    await capturePageCheckpoint(capture, page, `download-qfx-${account.internal_id}-${activity}-file-type-selected`);
  } catch (err) {
    await capturePageCheckpoint(
      capture,
      page,
      `download-qfx-${account.internal_id}-${activity}-file-type-select-failed`
    );
    return {
      downloaded: false,
      error: `file_type_select_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  // Wait for the Download button to be enabled before clicking.
  await page.locator("mds-button#download").waitFor({ state: "visible", timeout: OPTION_WAIT_MS });

  const downloadQueue = attachDownloadQueue(page);
  const qfxResponseQueue = attachQfxResponseQueue(page);
  try {
    await page.locator("mds-button#download").click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    await capturePageCheckpoint(capture, page, `download-qfx-${account.internal_id}-${activity}-download-click-failed`);
    downloadQueue.detach();
    qfxResponseQueue.detach();
    return {
      downloaded: false,
      error: `download_button_click_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  try {
    return await waitForQfxDownloadArtifact(page, account, activity, tmpDir, downloadQueue, qfxResponseQueue, capture);
  } finally {
    downloadQueue.detach();
    qfxResponseQueue.detach();
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

async function navigateToStatementsPage(page: Page): Promise<void> {
  // Warm overview first — direct-nav to the documents URL can bounce through
  // login if the SPA isn't fully hydrated.
  await page.goto("https://secure.chase.com/web/auth/dashboard#/dashboard/overview", {
    waitUntil: "domcontentloaded",
    timeout: NAV_TIMEOUT_MS,
  });
  // Wait for any account label to render before routing onward.
  await page
    .locator(DASHBOARD_ACCOUNT_SELECTOR)
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
 * DOM order (newest first, per Chase's default ordering). DOM parsing now
 * runs in Node via linkedom (see parsers.ts#parseStatementsListDom).
 */
async function enumerateStatementRows(page: Page): Promise<StatementRow[]> {
  try {
    const html = await page.content();
    return parseStatementsListDom(html);
  } catch {
    return [];
  }
}

/**
 * Click the row's download anchor and capture the PDF via Playwright's
 * download event. Save to disk under ~/.pdpp/chase-statements/<account>/
 * <YYYY-MM>-<sha16>.pdf.
 */
async function downloadStatementPdf(
  page: Page,
  row: StatementRow,
  accountId: string | null,
  capture: CaptureSession | null | undefined
): Promise<StatementDownloadResult> {
  // Chase's anchor ids are safe ASCII (only letters, digits, hyphens) so
  // we can inline them into a CSS selector without CSS.escape (which is
  // browser-only — not available in Node).
  const anchor = page.locator(`#${row.rowAnchorId}`);
  const exists = await anchor.count().catch((): number => 0);
  if (!exists) {
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-anchor-not-found`);
    return { ok: false, error: "anchor_not_found" };
  }

  await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-before-download-click`);
  const downloadQueue = attachDownloadQueue(page);
  try {
    await anchor.click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-click-failed`);
    downloadQueue.detach();
    return {
      ok: false,
      error: `anchor_click_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  let dl: Awaited<ReturnType<typeof downloadQueue.waitForNextDownload>>;
  try {
    dl = await downloadQueue.waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS });
  } catch (err) {
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-event-timeout`);
    return {
      ok: false,
      error: `download_event_timeout: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  } finally {
    downloadQueue.detach();
  }

  const tmpPdfDir = await mkdtemp(join(tmpdir(), "pdpp-chase-statement-"));
  const tmpPdfPath = join(tmpPdfDir, `${row.rowAnchorId}.pdf`);
  let buffer: Buffer;
  try {
    await savePlaywrightDownload(dl, tmpPdfPath);
    buffer = await readFile(tmpPdfPath);
  } catch (err) {
    // Capture DOM/screenshot at the moment of save failure — without this,
    // ENOENT-style races (chase run_1778852923848) leave no evidence of the
    // failure instant, only the pre-click checkpoint.
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-save-failed`);
    return {
      ok: false,
      error: `download_save_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE_LONG)}`,
    };
  } finally {
    await rm(tmpPdfDir, { recursive: true, force: true }).catch((): undefined => undefined);
  }
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

async function capturePageCheckpoint(
  capture: CaptureSession | null | undefined,
  page: Page,
  label: string
): Promise<void> {
  if (!capture) {
    return;
  }
  await capture.captureDom(page, label);
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
  // bare parse). types/ofx-js.d.ts shims the module as `unknown`; we
  // narrow structurally at runtime (see hasParse below) instead of
  // claiming a fixed module shape.
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

// ─── collect() helpers ────────────────────────────────────────────────────
// collect()'s cognitive complexity was 85 in the pre-decomposition layout
// (measured 2026-04-22 via biome lint/complexity/noExcessiveCognitiveComplexity,
// with the connector-scoped override flipped to "warn"). The per-account
// download+parse+emit loop, the statement row loop, and the no-accounts
// diagnostic branch were the three hotspots. We split each into a named
// helper that takes a stable EmitDeps bag (mirrors the amazon pattern
// from commit e62c368) so collect() becomes pure orchestration.

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type ProgressFn = BrowserCollectContext["progress"];
export type CaptureDep = BrowserCollectContext["capture"];
export type RequestedScopes = BrowserCollectContext["requested"];

/** Per-run dependency bag threaded through every emit-path helper. Mirrors
 *  the amazon pattern: one stable bag so collect() becomes pure
 *  orchestration and the helpers are individually testable. */
export interface EmitDeps {
  capture: CaptureDep;
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  emittedAt: string;
  maxSeenByAccount: Record<string, TransactionCursor>;
  progress: ProgressFn;
  requested: RequestedScopes;
  resFilters: Map<string, ReadonlySet<string> | null>;
  tmpDir: string;
  txState: TransactionsStateShape;
  wantsAccounts: boolean;
  wantsBalances: boolean;
  wantsCurrentActivity: boolean;
  wantsStatements: boolean;
  wantsTransactions: boolean;
}

/** STATE message shape the runtime expects for the transactions cursor. */
type StateMessage = Extract<EmittedMessage, { type: "STATE" }>;

/**
 * Pick the res filter that applies to per-account work. Falls back
 * across accounts → transactions → balances so a client asking for just
 * one of those still narrows the account enumeration.
 */
export function filterAccountsByScope(
  accounts: ChaseAccount[],
  resFilters: Map<string, ReadonlySet<string> | null>
): { accountsResFilter: ReadonlySet<string> | null; filteredAccounts: ChaseAccount[] } {
  const accountsResFilter =
    resFilters.get("accounts") ??
    resFilters.get("current_activity") ??
    resFilters.get("transactions") ??
    resFilters.get("balances") ??
    null;
  const filteredAccounts: ChaseAccount[] = accountsResFilter?.size
    ? accounts.filter((a) => accountsResFilter.has(a.internal_id))
    : accounts;
  return { accountsResFilter, filteredAccounts };
}

/**
 * Emit one `accounts` record per filtered account. Balance fields are
 * null here; they're populated later from QFX LEDGERBAL/AVAILBAL as
 * separate `balances` records.
 */
export async function emitAccountsStream(deps: EmitDeps, filteredAccounts: readonly ChaseAccount[]): Promise<void> {
  for (const a of filteredAccounts) {
    await deps.emitRecord("accounts", {
      id: a.internal_id,
      name: a.name,
      type: a.type,
      last_four: a.last_four,
      balance_cents: null,
      available_balance_cents: null,
      credit_limit_cents: null,
      available_credit_cents: null,
      statement_balance_cents: null,
      status: null,
      balance_as_of: null,
      fetched_at: deps.emittedAt,
    });
  }
}

/**
 * Emit one `transactions` record per QFX tx, maintain the per-account
 * max_seen_date cursor, and skip rows with no date.
 *
 * Invariants (tested in integration.test.ts):
 *   - one emit per non-null-dated tx (dedup happens at the runtime's
 *     RECORD key layer, not here; this helper is faithful to the QFX
 *     slice it's given),
 *   - cursor's max_seen_date is the MAX of the input dates (string
 *     compare is safe on ISO yyyy-mm-dd),
 *   - emittedAt propagates into every record's fetched_at.
 */
export async function emitTransactionsForAccount(
  deps: EmitDeps,
  account: ChaseAccount,
  activity: ActivityKind,
  transactions: ReturnType<typeof extractFromQfx>["transactions"]
): Promise<void> {
  const prior = deps.maxSeenByAccount[account.internal_id];
  let maxDate: string | null = prior?.max_seen_date ?? null;
  for (const t of transactions) {
    if (!t.date) {
      continue;
    }
    await deps.emitRecord("transactions", {
      id: `${account.internal_id}|${t.fitid}`,
      account_id: account.internal_id,
      account_name: account.name,
      fitid: t.fitid,
      date: t.date,
      amount: t.amount_cents,
      currency: t.currency,
      type: t.type,
      name: t.name,
      memo: t.memo,
      check_number: t.check_number,
      reference_number: t.reference_number,
      source: `qfx_download_${activity}_${t.date}`,
      fetched_at: deps.emittedAt,
    });
    if (!maxDate || t.date > maxDate) {
      maxDate = t.date;
    }
  }
  if (maxDate) {
    deps.maxSeenByAccount[account.internal_id] = {
      ...(prior ?? {}),
      max_seen_date: maxDate,
      last_activity: activity,
      last_fetched_at: deps.emittedAt,
    };
  }
}

export async function emitCurrentActivityForAccount(
  deps: EmitDeps,
  account: ChaseAccount,
  html: string
): Promise<number> {
  const rows = parseCurrentActivityDom(html, deps.emittedAt.slice(0, 10));
  for (const row of rows) {
    await deps.emitRecord("current_activity", {
      id: currentActivityId(account.internal_id, row),
      account_id: account.internal_id,
      account_name: account.name,
      status: row.status,
      activity_date: row.activity_date,
      posted_date: row.posted_date,
      amount: row.amount_cents,
      currency: "USD",
      description: row.description,
      memo: row.memo,
      ui_transaction_id: row.ui_transaction_id,
      source: "chase_activity_ui",
      fetched_at: deps.emittedAt,
    });
  }
  return rows.length;
}

/**
 * True iff this statement's delivered date falls outside the
 * `statements` stream's time_range. The comparison intentionally
 * slices to yyyy-mm-dd so a user-specified `since=2025-01-01T00:00Z`
 * still includes statements delivered 2025-01-01 (the date_delivered
 * field is date-only).
 */
export function statementRowOutsideTimeRange(deps: EmitDeps, dateIso: string | null): boolean {
  const stmtScope = deps.requested.get("statements");
  if (stmtScope?.time_range?.since && dateIso && dateIso < stmtScope.time_range.since.slice(0, 10)) {
    return true;
  }
  if (stmtScope?.time_range?.until && dateIso && dateIso >= stmtScope.time_range.until.slice(0, 10)) {
    return true;
  }
  return false;
}

/**
 * Emit a `statements` record with no hydrated PDF. Used when the PDF
 * download click fails — the caller still wants a record that the
 * statement exists so the owner can see it in the archive, even if the
 * bytes aren't available this run.
 */
export async function emitStatementIndexOnly(
  deps: EmitDeps,
  id: string,
  row: StatementRow,
  accountId: string | null,
  dateIso: string | null
): Promise<void> {
  await deps.emitRecord("statements", {
    id,
    account_id: accountId,
    title: row.title,
    date_delivered: dateIso,
    account_reference: row.account_reference,
    document_url: null,
    pdf_path: null,
    pdf_sha256: null,
    fetched_at: deps.emittedAt,
  });
}

/**
 * Emit the transactions STATE cursor iff we actually emitted
 * transactions this run. Skipping the emit on empty runs keeps
 * downstream state files from accumulating empty `per_account: {}`
 * entries that erase any prior cursor.
 */
export async function emitTransactionsStateIfAny(deps: EmitDeps): Promise<void> {
  if (!(deps.wantsTransactions && Object.keys(deps.maxSeenByAccount).length > 0)) {
    return;
  }
  const stateMsg: StateMessage = {
    type: "STATE",
    stream: "transactions",
    cursor: { per_account: deps.maxSeenByAccount },
  };
  await deps.emit(stateMsg);
}

export async function emitNoActivityProgress(
  deps: Pick<EmitDeps, "emit">,
  account: ChaseAccount,
  activity: ActivityKind
): Promise<void> {
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `${account.name}: no activity found for QFX download (activity=${activity})`,
  });
}

async function emitNoAccountsDiagnostic(page: Page, emit: EmitFn): Promise<void> {
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
}

async function processAccountDownload(
  deps: EmitDeps,
  page: Page,
  account: ChaseAccount,
  accountProgress?: { index: number; total: number }
): Promise<void> {
  const activityChoice = chooseActivity(
    deps.requested,
    deps.txState,
    deps.wantsTransactions ? "transactions" : "balances",
    account.internal_id
  );
  const progressMsg = {
    type: "PROGRESS",
    stream: "transactions",
    message: `${account.name}: downloading QFX (activity=${activityChoice.activity})`,
    ...(accountProgress ? { count: accountProgress.index, total: accountProgress.total } : {}),
  } as const;
  await deps.emit(progressMsg);

  const downloadOpts: DownloadOptions = activityChoice.dateRange
    ? { activity: activityChoice.activity, dateRange: activityChoice.dateRange }
    : { activity: activityChoice.activity };
  const result = await downloadQfx(page, account, deps.tmpDir, deps.capture, downloadOpts);
  if ("noActivity" in result) {
    await emitNoActivityProgress(deps, account, result.activity);
    return;
  }
  if (!result.downloaded) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "qfx_download_failed",
      message: `${account.name}: ${result.error}`,
    });
    return;
  }

  let parsed: unknown;
  try {
    parsed = await parseQfxFile(result.qfxPath);
  } catch (err) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "qfx_parse_failed",
      message: `${account.name}: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE_LONG)}`,
    });
    return;
  }

  const { transactions, balance } = extractFromQfx(parsed);

  if (deps.wantsTransactions) {
    await emitTransactionsForAccount(deps, account, activityChoice.activity, transactions);
  }

  if (deps.wantsBalances && balance) {
    await deps.emitRecord("balances", {
      id: `${account.internal_id}|${balance.as_of}`,
      account_id: account.internal_id,
      as_of: balance.as_of,
      ledger_balance_cents: balance.ledger_cents,
      available_balance_cents: balance.available_cents,
      fetched_at: deps.emittedAt,
    });
  }

  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `${account.name}: emitted ${transactions.length} transactions`,
  });
}

async function runTransactionsAndBalances(
  deps: EmitDeps,
  page: Page,
  filteredAccounts: readonly ChaseAccount[]
): Promise<void> {
  for (let i = 0; i < filteredAccounts.length; i++) {
    const account = filteredAccounts[i];
    if (!account) {
      continue;
    }
    await processAccountDownload(deps, page, account, { index: i + 1, total: filteredAccounts.length });
  }
}

async function runCurrentActivity(
  deps: EmitDeps,
  page: Page,
  filteredAccounts: readonly ChaseAccount[]
): Promise<void> {
  for (let i = 0; i < filteredAccounts.length; i++) {
    const account = filteredAccounts[i];
    if (!account) {
      continue;
    }
    const progressMsg = {
      type: "PROGRESS",
      stream: "current_activity",
      message: `${account.name}: opening Chase account activity`,
      count: i + 1,
      total: filteredAccounts.length,
    } as const;
    await deps.emit(progressMsg);
    await page.goto(DASHBOARD_OVERVIEW_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    const overviewAccountIds = await page
      .locator(DASHBOARD_ACCOUNT_SELECTOR)
      .evaluateAll((els): string[] =>
        els
          .map((el) => el.id || el.getAttribute("data-testid") || "")
          .map((id) => {
            const prefix = "accounts-name-link-button-";
            if (!id.startsWith(prefix)) {
              return null;
            }
            let digits = "";
            for (const ch of id.slice(prefix.length)) {
              if (ch < "0" || ch > "9") {
                break;
              }
              digits += ch;
            }
            return digits || null;
          })
          .filter((id): id is string => Boolean(id))
      )
      .catch((): string[] => []);
    if (overviewAccountIds.length > 1) {
      await deps.emit({
        type: "SKIP_RESULT",
        stream: "current_activity",
        reason: "ambiguous_multi_account_overview",
        message: `${account.name}: Chase dashboard overview shows multiple accounts; current activity rows cannot yet be safely attributed without a per-account activity surface`,
      });
      continue;
    }
    await page
      .locator(ACCOUNT_ACTIVITY_DOM_WAIT_SELECTOR)
      .first()
      .waitFor({ state: "attached", timeout: DOM_WAIT_MS })
      .catch((): undefined => undefined);
    if (deps.capture) {
      await deps.capture.captureDom(page, `current-activity-${account.internal_id}`);
    }
    const emitted = await emitCurrentActivityForAccount(deps, account, await page.content());
    if (emitted === 0) {
      await deps.emit({
        type: "SKIP_RESULT",
        stream: "current_activity",
        reason: "selectors_pending",
        message: `${account.name}: no parseable current activity rows found in Chase account activity DOM; need saved HTML after expanding a row that visibly contains date, description, amount, and pending/posted status`,
      });
    }
  }
  await deps.emit({
    type: "STATE",
    stream: "current_activity",
    cursor: { fetched_at: deps.emittedAt },
  });
}

async function processStatementRow(
  deps: EmitDeps,
  page: Page,
  row: StatementRow,
  filteredAccounts: readonly ChaseAccount[],
  accounts: readonly ChaseAccount[],
  accountsResFilter: ReadonlySet<string> | null
): Promise<void> {
  try {
    const dateIso = parseDateDelivered(row.date_delivered_raw);
    const accountId = resolveAccountIdForRow(row, filteredAccounts) ?? resolveAccountIdForRow(row, accounts);

    // Apply resources filter: if the accounts res filter excludes this
    // statement's account, skip it. (emitRecord will also skip, but doing
    // it here saves the PDF download.)
    if (accountsResFilter?.size && accountId && !accountsResFilter.has(accountId)) {
      return;
    }
    if (statementRowOutsideTimeRange(deps, dateIso)) {
      return;
    }

    const id = shortHash(`${row.account_reference ?? ""}|${dateIso ?? row.date_delivered_raw}|${row.title}`);
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: `Downloading ${row.title}`,
    });

    const dlResult = await downloadStatementPdf(page, row, accountId, deps.capture);
    if (!dlResult.ok) {
      await deps.emit({
        type: "SKIP_RESULT",
        stream: "statements",
        reason: "pdf_download_failed",
        message: `${row.title}: ${dlResult.error}`,
      });
      // Still emit the index row so the owner has a record the statement
      // exists, just without hydrated bytes.
      await emitStatementIndexOnly(deps, id, row, accountId, dateIso);
      return;
    }

    await deps.emitRecord("statements", {
      id,
      account_id: accountId,
      title: row.title,
      date_delivered: dateIso,
      account_reference: row.account_reference,
      document_url: fileUrl(dlResult.pdfPath),
      pdf_path: dlResult.pdfPath,
      pdf_sha256: dlResult.pdfSha256,
      fetched_at: deps.emittedAt,
    });
  } catch (rowErr) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "row_exception",
      message: `${row.title}: ${truncate(errMessage(rowErr), ERROR_MESSAGE_SLICE_LONG)}`,
    });
  }
}

async function runStatements(
  deps: EmitDeps,
  page: Page,
  filteredAccounts: readonly ChaseAccount[],
  accounts: readonly ChaseAccount[],
  accountsResFilter: ReadonlySet<string> | null
): Promise<void> {
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: "Navigating to Statements & Documents",
    });
    await navigateToStatementsPage(page);
    if (deps.capture) {
      await deps.capture.captureDom(page, "statements-list");
    }
    const rows = await enumerateStatementRows(page);
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: `Found ${rows.length} statement row(s)`,
    });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) {
        continue;
      }
      const progressMsg = {
        type: "PROGRESS",
        stream: "statements",
        message: `Processing statement ${i + 1}/${rows.length}`,
        count: i + 1,
        total: rows.length,
      } as const;
      await deps.emit(progressMsg);
      await processStatementRow(deps, page, row, filteredAccounts, accounts, accountsResFilter);
    }

    const stateMsg: Extract<EmittedMessage, { type: "STATE" }> = {
      type: "STATE",
      stream: "statements",
      cursor: { fetched_at: deps.emittedAt },
    };
    await deps.emit(stateMsg);
  } catch (err) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "statements_scrape_failed",
      message: truncate(errMessage(err), ERROR_MESSAGE_SLICE_MAX),
    });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/chase/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "chase",
    validateRecord,
    // Chase fingerprints the shared daemon profile and bounces it to
    // /#/logon/logon/error regardless of cookie state. See
    // `design-notes/chase-anti-bot.md`. Isolated-per-connector profile works.
    // Headful by default so Chase's login accepts the submission.
    browser: { profileName: "chase", headless: false },
    timeRangeField: chaseTimeRangeField,
    async ensureSession({ context, page, sendInteraction }): Promise<void> {
      await ensureChaseSession({
        context,
        page,
        sendInteraction,
      });
    },
    async collect(ctx: BrowserCollectContext): Promise<void> {
      const { state: startState, requested, page, emit, emitRecord, progress, capture, emittedAt } = ctx;

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

      const deps: EmitDeps = {
        capture,
        emit,
        emitRecord,
        emittedAt,
        maxSeenByAccount,
        progress,
        requested,
        resFilters,
        tmpDir,
        txState,
        wantsAccounts: requested.has("accounts"),
        wantsBalances: requested.has("balances"),
        wantsCurrentActivity: requested.has("current_activity"),
        wantsStatements: requested.has("statements"),
        wantsTransactions: requested.has("transactions"),
      };

      try {
        await progress("Chase session verified; enumerating accounts");

        const accounts = await discoverAccounts(page);
        if (capture) {
          await capture.captureDom(page, "dashboard-accounts");
        }
        if (accounts.length === 0) {
          await emitNoAccountsDiagnostic(page, emit);
          return; // runtime emits DONE succeeded
        }

        await progress(`Found ${accounts.length} account(s)`);

        const { accountsResFilter, filteredAccounts } = filterAccountsByScope(accounts, resFilters);

        // Emit accounts stream. Our record.id is Chase's internal account id
        // directly — stable, no hashing needed. Keeps transactions.account_id
        // aligned with the download URL param.
        if (deps.wantsAccounts) {
          await emitAccountsStream(deps, filteredAccounts);
        }

        // Transactions + balances: download QFX per account, parse, emit.
        if (deps.wantsTransactions || deps.wantsBalances) {
          await runTransactionsAndBalances(deps, page, filteredAccounts);
        }

        if (deps.wantsCurrentActivity) {
          await runCurrentActivity(deps, page, filteredAccounts);
        }

        // Statements: navigate to Statements & Documents, enumerate rows,
        // download each PDF, emit one record per statement with
        // content-addressed path.
        if (deps.wantsStatements) {
          await runStatements(deps, page, filteredAccounts, accounts, accountsResFilter);
        }
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch((): undefined => undefined);
      }

      // Emit STATE for incremental resumption. The per_account cursor drives
      // the next run's chooseActivity() — when max_seen_date is present we'll
      // use "since_last_statement" instead of re-downloading all transactions.
      await emitTransactionsStateIfAny(deps);
    },
  });
}
