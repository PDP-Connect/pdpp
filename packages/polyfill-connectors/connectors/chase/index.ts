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
 * Selectors verified live in Docker/n.eko on 2026-05-15. This connector
 * still emits diagnostic SKIP_RESULT with DOM/screenshot/locator evidence
 * when affordances drift, so the next repair starts from captured evidence
 * rather than silently failing with zero records.
 *
 * Auth: CHASE_USERNAME + CHASE_PASSWORD in env. 2FA via INTERACTION kind=otp.
 * CHASE_2FA_METHOD=text|voice|email (default text).
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { ensureChaseSession } from "../../src/auto-login/chase.ts";
import {
  attachBodyResponseQueue,
  type BodyResponseQueue,
  isLikelyPdfResponseBody as isLikelyPdfResponseBodyShared,
} from "../../src/browser-artifact-response.ts";
import {
  type BrowserCollectContext,
  buildDetailCoverageMessage,
  type DetailGapMessage,
  type EmittedMessage,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { attachDownloadQueue } from "../../src/download-queue.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import type { CaptureSession, LocatorProbe } from "../../src/fixture-capture.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { savePlaywrightDownload } from "../../src/playwright-download.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import {
  extractStatementContentFingerprint,
  statementFingerprintExcludeKeys,
} from "../../src/statement-content-fingerprint.ts";
import {
  isHydrated,
  openStatementHydrationCursor,
  readPriorStatementHydration,
  type StatementHydration,
  type StatementHydrationCursor,
} from "../../src/statement-hydration-carry-forward.ts";
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
  isUsablePdfBuffer,
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
const CHASE_DOWNLOAD_ROUTE_RE = /downloadAccountTransactions|confirmDownloadAccountActivity/iu;
const NO_ACTIVITY_CONFIRMATION_RE = /we couldn't find any activity that matched the date range you chose/iu;
const CHASE_QFX_FILE_TYPE_COMBOBOX_NAME_RE = /file type/i;
const CHASE_QFX_ACTIVITY_COMBOBOX_NAME_RE = /activity/i;
const DASHBOARD_ACCOUNT_SELECTOR =
  '[id^="accounts-name-link-button-"][id$="-label"], button[id^="accounts-name-link-button-"], button[data-testid^="accounts-name-link-button-"]';
export const CHASE_CURRENT_ACTIVITY_ROW_SELECTOR =
  'tr.mds-activity-table__row[data-values], tr[id*="activity" i][data-values]';
export const CHASE_QFX_ACTIVITY_SELECT_SELECTORS = [
  "#downloadActivityOptionId",
  "#select-downloadActivityOptionId",
] as const;
export const CHASE_QFX_FILE_TYPE_SELECT_SELECTORS = [
  "#downloadFileTypeOption",
  "#select-downloadFileTypeOption",
] as const;
export const CHASE_QFX_FILE_TYPE_SELECT_SELECTOR = CHASE_QFX_FILE_TYPE_SELECT_SELECTORS.join(", ");
export const CHASE_QFX_ACTIVITY_SELECT_SELECTOR = CHASE_QFX_ACTIVITY_SELECT_SELECTORS.join(", ");
const TIME_RANGE_FIELD_BY_STREAM: Record<string, string> = {
  balances: "as_of",
  current_activity: "activity_date",
  statements: "date_delivered",
  transactions: "date",
};

export function chaseTimeRangeField(stream: string): string {
  return TIME_RANGE_FIELD_BY_STREAM[stream] ?? "date";
}

interface NoActivityConfirmation {
  bodyPreview: string;
  url: string;
}

// ─── Dashboard scrape: enumerate accounts ─────────────────────────────────

interface CurrentActivitySnapshotPage {
  content: () => Promise<string>;
  locator: (selector: string) => {
    first: () => {
      waitFor: (options: { state: "attached"; timeout: number }) => Promise<unknown>;
    };
  };
}

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

export async function snapshotDashboardHtmlForCurrentActivity(
  page: CurrentActivitySnapshotPage
): Promise<{ html: string; rowSurfaceReady: boolean }> {
  const rowSurfaceReady = await page
    .locator(CHASE_CURRENT_ACTIVITY_ROW_SELECTOR)
    .first()
    .waitFor({ state: "attached", timeout: DOM_WAIT_MS })
    .then(
      () => true,
      () => false
    );

  const html = await page.content().catch((): string => "");
  return { html, rowSurfaceReady };
}

// ─── QFX download click-path ──────────────────────────────────────────────

// Activity options enumerated live from Chase's mds-select on 2026-04-21:
//   Current display, including filters / Year to date / Last year /
//   Since last statement / 2026 statements / 2025 statements /
//   2024 statements / All transactions / Choose a date range
// We use the visible labels as locators (Playwright's `getByRole('option')`
// pierces shadow DOM).
async function selectActivity(page: Page, optionLabel: string): Promise<void> {
  await clickActivityControl(page);
  const opt = page.getByRole("option", {
    name: new RegExp(`^${optionLabel}$`, "i"),
  });
  await opt.waitFor({ state: "visible", timeout: OPTION_WAIT_MS });
  await opt.click({ timeout: OPTION_WAIT_MS });
}

// Open the Activity mds-select. Chase re-renders and occasionally re-ids the
// download form's controls, so the CSS-id click alone is brittle. Mirror the
// two-tier strategy used for File Type: CSS ids first, then the semantic label.
async function clickActivityControl(page: Page): Promise<void> {
  try {
    await page.locator(CHASE_QFX_ACTIVITY_SELECT_SELECTOR).first().click({ timeout: CLICK_TIMEOUT_MS });
    return;
  } catch (selectorErr) {
    try {
      await page
        .getByRole("combobox", {
          name: CHASE_QFX_ACTIVITY_COMBOBOX_NAME_RE,
        })
        .first()
        .click({ timeout: CLICK_TIMEOUT_MS });
      return;
    } catch (semanticErr) {
      throw new Error(
        `activity_control_unavailable: selector=${CHASE_QFX_ACTIVITY_SELECT_SELECTOR}: ${truncate(
          errMessage(selectorErr),
          ERROR_MESSAGE_SLICE
        )}; combobox=${truncate(errMessage(semanticErr), ERROR_MESSAGE_SLICE)}`
      );
    }
  }
}

/**
 * Select File Type via click-driven dropdown selection. Chase's mds-select
 * ignores direct attribute mutation once any other form interaction has
 * happened — the first run's attribute-set worked only because nothing else
 * touched the form before Download, but re-renders (like selecting Date
 * Range on Activity) revert file type back to CSV. Clicking is durable.
 */
async function selectFileType(page: Page, label: string): Promise<void> {
  await clickFileTypeControl(page);
  const opt = page.getByRole("option", {
    name: new RegExp(`^${label}`, "i"),
  });
  await opt.waitFor({ state: "visible", timeout: OPTION_WAIT_MS });
  await opt.click({ timeout: OPTION_WAIT_MS });
}

async function clickFileTypeControl(page: Page): Promise<void> {
  try {
    await page.locator(CHASE_QFX_FILE_TYPE_SELECT_SELECTOR).first().click({ timeout: CLICK_TIMEOUT_MS });
    return;
  } catch (selectorErr) {
    try {
      await page
        .getByRole("combobox", {
          name: CHASE_QFX_FILE_TYPE_COMBOBOX_NAME_RE,
        })
        .first()
        .click({ timeout: CLICK_TIMEOUT_MS });
      return;
    } catch (semanticErr) {
      throw new Error(
        `file_type_control_unavailable: selector=${CHASE_QFX_FILE_TYPE_SELECT_SELECTOR}: ${truncate(
          errMessage(selectorErr),
          ERROR_MESSAGE_SLICE
        )}; combobox=${truncate(errMessage(semanticErr), ERROR_MESSAGE_SLICE)}`
      );
    }
  }
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

export function isLikelyChaseQfxResponse(headers: Record<string, string>, url = ""): boolean {
  const hint = `${headers["content-disposition"] ?? ""} ${headers["content-type"] ?? ""} ${url}`;
  return DOWNLOAD_RESPONSE_HINT_RE.test(hint) || CHASE_DOWNLOAD_ROUTE_RE.test(url);
}

export const isLikelyPdfResponseBody = isLikelyPdfResponseBodyShared;

function redactChaseEvidenceUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const hash = url.hash.replace(/\d{4,}/g, "[digits]");
    const search = url.search.replace(/\d{4,}/g, "[digits]");
    return `${url.origin}${url.pathname}${search}${hash}`;
  } catch {
    return rawUrl.replace(/\d{4,}/g, "[digits]");
  }
}

function attachQfxResponseQueue(page: Page): BodyResponseQueue {
  return attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyQfxResponseBody,
    redactUrl: redactChaseEvidenceUrl,
    shouldInspect: isLikelyChaseQfxResponse,
    truncateMessageLength: ERROR_MESSAGE_SLICE_LONG,
  });
}

function attachPdfResponseQueue(page: Page): BodyResponseQueue {
  return attachBodyResponseQueue(page, {
    isExpectedBody: isLikelyPdfResponseBody,
    redactUrl: redactChaseEvidenceUrl,
    shouldInspect(headers) {
      const contentDisposition = headers["content-disposition"]?.toLowerCase() ?? "";
      const contentType = headers["content-type"]?.toLowerCase() ?? "";
      return (
        contentType.includes("pdf") || contentDisposition.includes(".pdf") || contentDisposition.includes("attachment")
      );
    },
    truncateMessageLength: ERROR_MESSAGE_SLICE_LONG,
  });
}

function captureBodyResponseDiagnostics(
  capture: CaptureSession | null | undefined,
  page: Page,
  label: string,
  queue: BodyResponseQueue
): void {
  capture?.captureHttp(label, queue.diagnostics(), {
    method: "OBSERVE",
    path: redactChaseEvidenceUrl(page.url()),
  });
}

async function waitForQfxDownloadArtifact(
  page: Page,
  account: ChaseAccount,
  activity: ActivityKind,
  tmpDir: string,
  downloadQueue: ReturnType<typeof attachDownloadQueue>,
  qfxResponseQueue: BodyResponseQueue,
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
          captureBodyResponseDiagnostics(
            capture,
            page,
            `download-qfx-${account.internal_id}-${activity}-response-diagnostics`,
            qfxResponseQueue
          );
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
    captureBodyResponseDiagnostics(
      capture,
      page,
      `download-qfx-${account.internal_id}-${activity}-response-diagnostics`,
      qfxResponseQueue
    );
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
  await page.locator(CHASE_QFX_FILE_TYPE_SELECT_SELECTOR).first().waitFor({ state: "attached", timeout: DOM_WAIT_MS });
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
  await qfxResponseQueue.ready;
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
  const pdfResponseQueue = attachPdfResponseQueue(page);
  await pdfResponseQueue.ready;
  try {
    await anchor.click({ timeout: CLICK_TIMEOUT_MS });
  } catch (err) {
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-click-failed`);
    downloadQueue.detach();
    pdfResponseQueue.detach();
    return {
      ok: false,
      error: `anchor_click_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  const playwrightDownloadPromise = downloadQueue
    .waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS })
    .then((download) => ({
      download,
      kind: "playwright_download" as const,
    }));
  const pdfResponsePromise = pdfResponseQueue
    .waitForNextResponse({ timeoutMs: DOWNLOAD_TIMEOUT_MS })
    .then((response) => ({
      kind: "pdf_response" as const,
      response,
    }));
  let result: Awaited<typeof playwrightDownloadPromise | typeof pdfResponsePromise>;
  try {
    result = await Promise.any([playwrightDownloadPromise, pdfResponsePromise]);
  } catch (err) {
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-event-timeout`);
    captureBodyResponseDiagnostics(
      capture,
      page,
      `statement-${row.rowAnchorId}-pdf-response-diagnostics`,
      pdfResponseQueue
    );
    downloadQueue.detach();
    pdfResponseQueue.detach();
    return {
      ok: false,
      error: `download_event_timeout: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE)}`,
    };
  }

  let buffer: Buffer;
  try {
    if (result.kind === "pdf_response") {
      buffer = result.response.body;
      capture?.captureHttp(
        `statement-${row.rowAnchorId}-pdf-response`,
        { bytes: buffer.length, suggestedFilename: result.response.suggestedFilename },
        {
          method: result.response.method,
          path: result.response.url,
          status: result.response.status,
          type: result.response.contentType,
        }
      );
    } else {
      const tmpPdfDir = await mkdtemp(join(tmpdir(), "pdpp-chase-statement-"));
      const tmpPdfPath = join(tmpPdfDir, `${row.rowAnchorId}.pdf`);
      try {
        await savePlaywrightDownload(result.download, tmpPdfPath);
        buffer = await readFile(tmpPdfPath);
      } catch (downloadErr) {
        const responseResult = await pdfResponsePromise.catch((): null => null);
        if (!responseResult) {
          throw downloadErr;
        }
        buffer = responseResult.response.body;
        capture?.captureHttp(
          `statement-${row.rowAnchorId}-pdf-response-fallback`,
          {
            bytes: buffer.length,
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
      } finally {
        await rm(tmpPdfDir, { recursive: true, force: true }).catch((): undefined => undefined);
      }
    }
  } catch (err) {
    // Capture DOM/screenshot at the moment of save failure — without this,
    // ENOENT-style races (chase run_1778852923848) leave no evidence of the
    // failure instant, only the pre-click checkpoint.
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-save-failed`);
    captureBodyResponseDiagnostics(
      capture,
      page,
      `statement-${row.rowAnchorId}-pdf-response-diagnostics`,
      pdfResponseQueue
    );
    return {
      ok: false,
      error: `download_save_failed: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE_LONG)}`,
    };
  } finally {
    downloadQueue.detach();
    pdfResponseQueue.detach();
  }
  // Reject an empty / non-PDF download instead of recording it as a
  // successful hydration. A 0-byte body otherwise hashes to the empty-string
  // sha256 and is stored as a "captured" statement, which (a) points the
  // owner at a 0-byte file and (b) churns the statement's version every time
  // the real PDF flips back in. Falling through to ok:false routes the row to
  // the same index-only fallback a download failure already uses.
  if (!isUsablePdfBuffer(buffer)) {
    await capturePageCheckpoint(capture, page, `statement-${row.rowAnchorId}-download-empty-pdf`);
    return { ok: false, error: `download_empty_pdf: ${buffer.length}b` };
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

  // Positive content fingerprint over the decrypted text + page count. Chase
  // statement PDFs are RC4-encrypted and re-encrypted per download, so
  // `pdf_sha256` (and the path/url that embed it) churns with no content
  // change; this content fingerprint is what makes excluding those blob fields
  // from the canonical fingerprint lossless. Fail-closed to all-null.
  const content = await extractStatementContentFingerprint(buffer);

  return { ok: true, pdfPath, pdfSha256, content };
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
  const probes = chaseLocatorProbesForLabel(label);
  if (probes.length > 0) {
    await capture.captureLocatorProbe?.(page, label, probes);
  }
}

function chaseLocatorProbesForLabel(label: string): readonly LocatorProbe[] {
  const probes: LocatorProbe[] = [];
  if (label.includes("dashboard")) {
    probes.push({
      description: "Structural account affordance currently used to discover Chase account ids.",
      id: "dashboard-account-selector",
      kind: "css",
      selector: DASHBOARD_ACCOUNT_SELECTOR,
    });
  }
  if (label.includes("download-qfx")) {
    probes.push(
      {
        description: "QFX activity select host.",
        id: "qfx-activity-select-host",
        kind: "css",
        selector: CHASE_QFX_ACTIVITY_SELECT_SELECTORS.join(", "),
      },
      {
        description: "Whether the activity select has a stable accessible combobox name.",
        id: "qfx-activity-combobox-role",
        kind: "role",
        namePattern: "activity",
        role: "combobox",
      },
      {
        description: "QFX file-type select host.",
        id: "qfx-file-type-select-host",
        kind: "css",
        selector: CHASE_QFX_FILE_TYPE_SELECT_SELECTORS.join(", "),
      },
      {
        description: "Whether the file-type select has a stable accessible combobox name.",
        id: "qfx-file-type-combobox-role",
        kind: "role",
        namePattern: "file|type|format",
        role: "combobox",
      },
      {
        description: "Structural download button currently used for the QFX click.",
        id: "qfx-download-button-host",
        kind: "css",
        selector: "mds-button#download",
      },
      {
        description: "Semantic download button candidate.",
        id: "qfx-download-button-role",
        kind: "role",
        namePattern: "download",
        role: "button",
      }
    );
  }
  if (label.includes("statement") || label.includes("statements-list")) {
    probes.push(
      {
        description: "Statements accordion trigger.",
        id: "statement-accordion-button-host",
        kind: "css",
        selector: '[id^="button-documentsAccordion-"]',
      },
      {
        description: "Statement download anchors currently used for PDF hydration.",
        id: "statement-download-anchor-host",
        kind: "css",
        selector: 'a[id$="-download"]',
      },
      {
        description: "Semantic statement download link candidate.",
        id: "statement-download-link-role",
        kind: "role",
        namePattern: "download|save|saves document|statement|pdf",
        role: "link",
      }
    );
  }
  return probes;
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
  /** Per-row fingerprint cursor for `current_activity` (excludes the
   *  run-clock `fetched_at`). One cursor for the whole stream because row
   *  ids (`account_id|ui_transaction_id` or an account-scoped fallback
   *  hash) are globally unique. Optional so legacy callers/tests emit
   *  unconditionally. */
  currentActivityFingerprintCursor?: FingerprintCursor | undefined;
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  emittedAt: string;
  maxSeenByAccount: Record<string, TransactionCursor>;
  progress: ProgressFn;
  requested: RequestedScopes;
  resFilters: Map<string, ReadonlySet<string> | null>;
  /** Pending account-level detail gaps the runtime served this run at START,
   *  keyed by `account_id` → served `gap_id`. When the normal QFX pass reaches
   *  one of these accounts (hydrated or source-limited no-activity), the
   *  connector emits `DETAIL_GAP_RECOVERED` with the served `gap_id` so the
   *  durable gap moves to `recovered` instead of being reset to `pending` by
   *  runtime cleanup. Empty on an ordinary run with no served gaps. */
  servedAccountGaps?: ReadonlyMap<string, string> | undefined;
  tmpDir: string;
  /** Per-transaction fingerprint cursor (excludes the run-clock
   *  `fetched_at`). Shared across all accounts for the whole transactions
   *  stream because record ids (`account_id|fitid`) are globally unique.
   *  Optional so legacy callers/tests emit unconditionally. */
  transactionsFingerprintCursor?: FingerprintCursor | undefined;
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
 *
 * Every field except `fetched_at` is stable across runs (the account
 * identity; all balance fields are hardcoded `null` and live in the
 * `balances` stream). Without a gate, the run-clock `fetched_at` forced
 * a fresh version of every account on every run (~20 versions/record of
 * pure run-clock churn). The fingerprint cursor excludes `fetched_at`,
 * so an account re-emits only when its identity actually changes.
 *
 * Emits a per-stream STATE carrying the fingerprint map so the next run
 * can suppress unchanged accounts. When no cursor is supplied
 * (legacy callers/tests) the records emit unconditionally and no STATE
 * is written.
 */
export async function emitAccountsStream(
  deps: EmitDeps,
  filteredAccounts: readonly ChaseAccount[],
  fingerprintCursor?: FingerprintCursor
): Promise<void> {
  // `covered` is the in-boundary accounts this run accounted for: emitted plus
  // suppressed-because-unchanged. Counted independently at the loop site from
  // objective per-record outcomes, never aliased to the emitted count — every
  // dashboard account reaches the gate (the record literal never drops a row),
  // so a real shortfall could only come from a future pre-gate drop, which
  // would raise `considered` without raising `covered`.
  let covered = 0;
  for (const a of filteredAccounts) {
    const record = {
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
    };
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(record)) {
      await deps.emitRecord("accounts", record);
    }
    if (fingerprintCursor) {
      // Emitted or suppressed-unchanged: either way the account was accounted
      // for. The no-cursor path (legacy callers/tests) declares no coverage.
      covered += 1;
    }
  }
  if (!fingerprintCursor) {
    return;
  }
  // The dashboard scan re-enumerates the full account boundary every run and
  // suppresses unchanged accounts via the per-record fingerprint, so on a
  // steady-state run `collected` is a churn-reduced subset (often 0), not a
  // coverage count. Declare `considered = filteredAccounts.length` (the
  // enumerated boundary) with the objective `covered` count so the Collection
  // Report reads `complete` instead of a false `partial`
  // (define-connector-progress-evidence-contract task 4.4). This self-coverage
  // message (`stream === state_stream === "accounts"`, empty required/hydrated
  // keys) is distinct from the transactions→accounts DETAIL_COVERAGE emitted by
  // `emitTransactionsDetailCoverage` (`stream === "transactions"`), so the two
  // do not collide in the runtime's per-stream considered/covered lookup.
  await deps.emit(
    buildDetailCoverageMessage({
      stream: "accounts",
      stateStream: "accounts",
      requiredKeys: [],
      hydratedKeys: [],
      considered: filteredAccounts.length,
      covered,
    })
  );
  // Accounts enumeration is a full dashboard scan: prune fingerprints for
  // accounts no longer present so a re-added account re-emits.
  fingerprintCursor.pruneStale();
  const cursor: Record<string, unknown> = { fetched_at: deps.emittedAt };
  if (fingerprintCursor.size() > 0) {
    cursor.fingerprints = fingerprintCursor.toState();
  }
  await deps.emit({
    type: "STATE",
    stream: "accounts",
    cursor,
  });
}

/**
 * Parse the prior `accounts` STATE cursor's `fingerprints` map. Keyed by
 * Chase internal account id. Legacy/missing cursors decode to an empty
 * map; the first post-deploy run rebuilds it and re-emits every account
 * exactly once.
 */
export function readPriorAccountFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.accounts ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/**
 * Parse the prior `statements` STATE cursor's `fingerprints` map. Keyed
 * by statement `id` (hash of account_reference|date|title). Legacy
 * cursors (only `{ fetched_at }`) decode to an empty map, so the first
 * post-deploy run rebuilds the map and re-emits every statement exactly
 * once.
 */
export function readPriorStatementFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.statements ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/**
 * Parse the prior `current_activity` STATE cursor's `fingerprints` map.
 * Keyed by the row `id` (`account_id|ui_transaction_id`, or an
 * account-scoped fallback hash). Legacy cursors (only `{ fetched_at }`)
 * decode to an empty map, so the first post-deploy run rebuilds the map
 * and re-emits every still-listed activity row exactly once.
 */
export function readPriorCurrentActivityFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.current_activity ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
}

/**
 * Parse the prior `transactions` STATE cursor's `fingerprints` map. Keyed
 * by transaction `id` (`account_id|fitid`). The cursor shape is
 * `{ per_account, fingerprints }`; `collect()` may also see the bare
 * inner shape (legacy state), so both `state.transactions.fingerprints`
 * and `state.fingerprints` are tolerated. Legacy cursors (only
 * `per_account`) decode to an empty map, so the first post-deploy run
 * rebuilds the map and re-emits every in-window transaction exactly once.
 */
export function readPriorTransactionFingerprints(state: Record<string, unknown>): Map<string, string> {
  const streamState = (state.transactions ?? state ?? {}) as Record<string, unknown>;
  const raw = streamState.fingerprints;
  const out = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" && value.length > 0) {
      out.set(id, value);
    }
  }
  return out;
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
  transactions: ReturnType<typeof extractFromQfx>["transactions"],
  fingerprintCursor?: FingerprintCursor
): Promise<void> {
  const prior = deps.maxSeenByAccount[account.internal_id];
  let maxDate: string | null = prior?.max_seen_date ?? null;
  for (const t of transactions) {
    if (!t.date) {
      continue;
    }
    const record = {
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
    };
    // Gate on a per-transaction fingerprint that excludes run/acquisition
    // metadata (`fetched_at`, `source`). A posted transaction's identity
    // (id = account_id|fitid) and its fields (date, amount, name, memo, …)
    // are immutable, but overlapping windows re-download transactions with
    // a fresh run clock and sometimes a different activity-mode source. With
    // this gate an already-seen transaction whose transaction fields are
    // unchanged is suppressed; a genuinely-new transaction (new id) or a real
    // field move is a fingerprint boundary and still emits.
    //
    // NOTE: transactions is a PARTIAL scan (per-account incremental
    // windows), so this cursor is never `pruneStale()`d — pruning ids the
    // run did not look at would drop their fingerprints and re-churn them
    // on the next overlapping window.
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(record)) {
      await deps.emitRecord("transactions", record);
    }
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
  html: string,
  fingerprintCursor?: FingerprintCursor
): Promise<number> {
  const rows = parseCurrentActivityDom(html, deps.emittedAt.slice(0, 10));
  for (const row of rows) {
    const record = {
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
    };
    // Gate on a per-row fingerprint that excludes the run-clock
    // `fetched_at`. The dashboard overview re-renders the same recent
    // rows every run, so without this gate each still-listed activity row
    // appended a fresh version differing only in `fetched_at`. A row keyed
    // by a stable `ui_transaction_id` that transitions pending → posted
    // (status / posted_date / amount move) IS a fingerprint boundary and
    // re-emits; a fallback-keyed row whose fields change gets a new id and
    // appends as a distinct row. Only a byte-identical re-render modulo
    // `fetched_at` is suppressed.
    //
    // NOTE: current_activity is a PARTIAL scan (only the dashboard's
    // recent rows), so this cursor is never `pruneStale()`d — pruning ids
    // the overview stopped showing would drop their fingerprints and
    // re-churn a row that scrolls back into the recent window.
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(record)) {
      await deps.emitRecord("current_activity", record);
    }
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
 * Emit a `statements` record when the PDF could not be hydrated this run —
 * the caller still wants a record that the statement exists so the owner
 * can see it in the archive, even though this run did not fetch the bytes.
 *
 * Carry-forward: if the statement was previously hydrated, re-emit the
 * prior `document_url`/`pdf_path`/`pdf_sha256` (which point at content-
 * addressed bytes a prior run stored and that never move) instead of null.
 * A statement that was never hydrated stays all-null (honest index-only).
 * Either way the statement detail-coverage report remains the authoritative
 * record of whether PDF bytes were present this run. The carried body asserts
 * the artifact's last known location, not that this run re-verified it. This
 * stops the `value -> null` hydration-availability flap from re-versioning an
 * immutable statement.
 *
 * Gated on the per-statement fingerprint cursor (excludes `fetched_at`) so a
 * re-listed statement that is byte-identical modulo the run clock does not
 * append a fresh version every run; with carry-forward the carried body
 * matches the prior hydrated body, so the cursor suppresses the re-emit.
 */
export async function emitStatementIndexOnly(
  deps: EmitDeps,
  id: string,
  row: StatementRow,
  accountId: string | null,
  dateIso: string | null,
  fingerprintCursor?: FingerprintCursor,
  hydrationCursor?: StatementHydrationCursor
): Promise<StatementHydration> {
  const carried: StatementHydration = hydrationCursor
    ? hydrationCursor.resolveOnFailure(id)
    : { document_url: null, pdf_path: null, pdf_sha256: null, pdf_text_sha256: null, pdf_page_count: null };
  const record = {
    id,
    account_id: accountId,
    title: row.title,
    date_delivered: dateIso,
    account_reference: row.account_reference,
    document_url: carried.document_url,
    pdf_path: carried.pdf_path,
    pdf_sha256: carried.pdf_sha256,
    pdf_text_sha256: carried.pdf_text_sha256 ?? null,
    pdf_page_count: carried.pdf_page_count ?? null,
    fetched_at: deps.emittedAt,
  };
  // Record the resolved pointers (carried or all-null) so the next run's
  // prior map stays complete and the prune step has the right inputs.
  hydrationCursor?.note(id, carried);
  if (!fingerprintCursor || fingerprintCursor.shouldEmit(record)) {
    await deps.emitRecord("statements", record);
  }
  return carried;
}

export type StatementDetailOutcome = { kind: "hydrated"; id: string } | { kind: "index_only"; id: string };

export async function emitStatementDetailCoverage(
  deps: EmitDeps,
  outcomes: readonly StatementDetailOutcome[]
): Promise<void> {
  if (!deps.wantsStatements || outcomes.length === 0) {
    return;
  }
  const requiredKeys = outcomes.map((outcome) => outcome.id);
  const hydratedKeys = outcomes.filter((outcome) => outcome.kind === "hydrated").map((outcome) => outcome.id);
  const optionalSkipKeys = outcomes.filter((outcome) => outcome.kind === "index_only").map((outcome) => outcome.id);
  await deps.emit(
    buildDetailCoverageMessage({
      stream: "statements",
      stateStream: "statements",
      requiredKeys,
      hydratedKeys,
      optionalSkipKeys,
      considered: outcomes.length,
      covered: outcomes.length,
    })
  );
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
  const cursor: Record<string, unknown> = { per_account: deps.maxSeenByAccount };
  // Carry the per-transaction fingerprint map forward so the next run can
  // suppress re-downloaded transactions whose body is unchanged modulo the
  // run clock. NOT pruned: transactions is a partial incremental scan.
  const fp = deps.transactionsFingerprintCursor;
  if (fp && fp.size() > 0) {
    cursor.fingerprints = fp.toState();
  }
  const stateMsg: StateMessage = {
    type: "STATE",
    stream: "transactions",
    cursor,
  };
  await deps.emit(stateMsg);
}

/**
 * Emit the `balances` STATE presence checkpoint iff at least one balance was
 * emitted this run. `balances` is a `singleton_presence` stream — append-only
 * point-in-time ledger snapshots with no incremental cursor to advance — so the
 * checkpoint is a bare `{ fetched_at }` presence marker (mirroring
 * `current_activity`). Without staging it, a succeeded run leaves `balances` at
 * `checkpoint:not_staged`, and the `singleton_presence` strategy cannot prove
 * coverage, so the stream projects unmeasured despite retained records. Gated on
 * an actual emit so an empty balances run does not stamp a hollow presence
 * checkpoint over nothing.
 */
export async function emitBalancesStateIfAny(deps: EmitDeps, balanceEmitted: boolean): Promise<void> {
  if (!(deps.wantsBalances && balanceEmitted)) {
    return;
  }
  await deps.emit({
    type: "STATE",
    stream: "balances",
    cursor: { fetched_at: deps.emittedAt },
  });
}

export async function emitNoActivityProgress(
  deps: Pick<EmitDeps, "emit">,
  _account: ChaseAccount,
  activity: ActivityKind
): Promise<void> {
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `QFX download complete: no activity found (activity=${activity})`,
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

function accountProgressLabel(accountProgress?: { index: number; total: number }): string {
  return accountProgress ? `${accountProgress.index}/${accountProgress.total}` : "?/?";
}

function accountProgressDiagnostic(accountProgress?: { index: number; total: number }): {
  account_index: number | null;
  account_total: number | null;
} {
  return {
    account_index: accountProgress?.index ?? null,
    account_total: accountProgress?.total ?? null,
  };
}

/**
 * Per-account outcome of the QFX (transactions/balances) detail pass. The
 * `accounts` stream is Chase's enumerated inventory — a known denominator —
 * and each account is one key considered for the per-account QFX detail
 * fetch. The runtime turns these outcomes into an honest DETAIL_COVERAGE
 * report (`required_keys` = accounts considered; `hydrated_keys` = accounts
 * the connector successfully reached; `gap_keys` = retryable failures).
 *
 * Three outcomes, deliberately distinct:
 *   - `hydrated`: QFX downloaded and parsed for this account. Includes the
 *     0-transaction parse — the account WAS reached; an empty ledger is
 *     real coverage, not a failure.
 *   - `no_activity`: Chase reported no activity for the requested window.
 *     This is source-limited completeness ("won't backfill"), NOT a gap —
 *     the account was reached and the source had nothing to return. Counts
 *     as hydrated coverage so it is never projected as broken.
 *   - `gap`: the QFX download or parse failed transiently. A retryable
 *     DETAIL_GAP is emitted so the next run retries this account, and the
 *     key lands in `gap_keys` — partial, not complete, and not silently
 *     dropped.
 */
export type AccountDetailOutcome =
  | { kind: "hydrated"; accountId: string; balanceEmitted?: boolean }
  | { kind: "no_activity"; accountId: string; balanceEmitted?: boolean }
  | { kind: "gap"; accountId: string; reason: DetailGapMessage["reason"]; errorClass: string };

async function processAccountDownload(
  deps: EmitDeps,
  page: Page,
  account: ChaseAccount,
  accountProgress?: { index: number; total: number }
): Promise<AccountDetailOutcome> {
  const activityChoice = chooseActivity(
    deps.requested,
    deps.txState,
    deps.wantsTransactions ? "transactions" : "balances",
    account.internal_id
  );
  const progressLabel = accountProgressLabel(accountProgress);
  const progressMsg = {
    type: "PROGRESS",
    stream: "transactions",
    message: `Downloading QFX for account ${progressLabel} (activity=${activityChoice.activity}, timeout=${DOWNLOAD_TIMEOUT_MS / 1000}s)`,
    ...(accountProgress ? { count: accountProgress.index, total: accountProgress.total } : {}),
  } as const;
  await deps.emit(progressMsg);

  const downloadOpts: DownloadOptions = activityChoice.dateRange
    ? { activity: activityChoice.activity, dateRange: activityChoice.dateRange }
    : { activity: activityChoice.activity };
  const result = await downloadQfx(page, account, deps.tmpDir, deps.capture, downloadOpts);
  if ("noActivity" in result) {
    await emitNoActivityProgress(deps, account, result.activity);
    // Source-limited completeness: the account was reached, the source had
    // no activity in the requested window. Coverage, not a gap.
    return { kind: "no_activity", accountId: account.internal_id };
  }
  if (!result.downloaded) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "qfx_download_failed",
      message: `QFX download failed for account ${progressLabel}: ${result.error}`,
      recovery_hint: "retry_by_runtime",
      diagnostics: {
        error: result.error,
        ...accountProgressDiagnostic(accountProgress),
      },
    });
    return {
      kind: "gap",
      accountId: account.internal_id,
      reason: "temporary_unavailable",
      errorClass: "qfx_download_failed",
    };
  }

  let parsed: unknown;
  try {
    parsed = await parseQfxFile(result.qfxPath);
  } catch (err) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "qfx_parse_failed",
      message: `QFX parse failed for account ${progressLabel}: ${truncate(errMessage(err), ERROR_MESSAGE_SLICE_LONG)}`,
      recovery_hint: "retry_by_runtime",
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: truncate(errMessage(err), ERROR_MESSAGE_SLICE_LONG),
        artifact: "qfx",
      },
    });
    return {
      kind: "gap",
      accountId: account.internal_id,
      reason: "temporary_unavailable",
      errorClass: "qfx_parse_failed",
    };
  }

  const { transactions, balance } = extractFromQfx(parsed);

  if (deps.wantsTransactions) {
    await emitTransactionsForAccount(
      deps,
      account,
      activityChoice.activity,
      transactions,
      deps.transactionsFingerprintCursor
    );
  }

  let balanceEmitted = false;
  if (deps.wantsBalances && balance) {
    await deps.emitRecord("balances", {
      id: `${account.internal_id}|${balance.as_of}`,
      account_id: account.internal_id,
      as_of: balance.as_of,
      ledger_balance_cents: balance.ledger_cents,
      available_balance_cents: balance.available_cents,
      fetched_at: deps.emittedAt,
    });
    balanceEmitted = true;
  }

  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `Parsed account ${progressLabel}: emitted ${transactions.length} transaction(s)`,
  });
  // Reached and parsed (even a 0-transaction QFX is real coverage of this
  // account's ledger for the window).
  return { kind: "hydrated", accountId: account.internal_id, balanceEmitted };
}

/**
 * Build the retryable DETAIL_GAP for an account whose QFX download or parse
 * failed transiently. `record_key` is the account id — the next run's detail
 * pass retries exactly this account. Mirrors the chatgpt DETAIL_GAP contract
 * (reference_only, retryable, pending) so the runtime persists one resumable
 * gap per failed key and the per-account coverage stays honest.
 */
export function buildAccountDetailGap(outcome: {
  accountId: string;
  reason: DetailGapMessage["reason"];
  errorClass: string;
}): DetailGapMessage {
  return {
    type: "DETAIL_GAP",
    stream: "transactions",
    parent_stream: "accounts",
    record_key: outcome.accountId,
    status: "pending",
    reason: outcome.reason,
    detail_locator: {
      kind: "chase.account",
      account_id: outcome.accountId,
    },
    retryable: true,
    reference_only: true,
    detail: { class: outcome.errorClass },
    last_error: { class: outcome.errorClass },
  };
}

/**
 * Emit the per-run DETAIL_COVERAGE for the account -> transactions detail
 * fan-out. `accounts` is Chase's enumerated inventory (a known denominator),
 * so this reports honest partial-vs-complete coverage of the QFX detail pass
 * without inferring it from gaps alone:
 *   - `required_keys`: every account considered for the QFX detail fetch.
 *   - `hydrated_keys`: accounts reached, including source-limited no-activity
 *     ones (won't-backfill is coverage, never a broken signal).
 *   - `gap_keys`: accounts whose QFX failed transiently; each also carries a
 *     pending DETAIL_GAP so the runtime's coverage invariant is satisfied and
 *     the next run retries them.
 * Only emitted when the denominator is genuinely known: transactions AND
 * accounts are both in scope (the runtime validates `stream` / `state_stream`
 * against requested scope) and at least one account was considered. When the
 * denominator is unknown the connector emits nothing rather than invent a
 * `complete` projection.
 */
export async function emitTransactionsDetailCoverage(
  deps: EmitDeps,
  outcomes: readonly AccountDetailOutcome[]
): Promise<void> {
  if (!(deps.wantsTransactions && deps.wantsAccounts) || outcomes.length === 0) {
    return;
  }
  const requiredKeys = outcomes.map((o) => o.accountId);
  const hydratedKeys = outcomes
    .filter((o) => o.kind === "hydrated" || o.kind === "no_activity")
    .map((o) => o.accountId);
  const gapKeys = outcomes.filter((o) => o.kind === "gap").map((o) => o.accountId);
  await deps.emit(
    buildDetailCoverageMessage({
      stream: "transactions",
      stateStream: "accounts",
      requiredKeys,
      hydratedKeys,
      gapKeys,
    })
  );
}

/**
 * Build the `account_id → served gap_id` lookup from the pending detail gaps the
 * runtime served this run at START (`ctx.detailGaps`). Filtered to Chase
 * account-level transaction gaps — the exact shape `buildAccountDetailGap`
 * writes: `stream === "transactions"`, `detail_locator.kind === "chase.account"`,
 * and a non-empty `account_id`. Any other served gap (a different connector's
 * locator, a non-transactions stream, a malformed locator) is ignored so the
 * connector can only ever recover a gap it actually understands. Sourcing the
 * `gap_id` from the served gap — never synthesizing one — is what guarantees the
 * connector cannot mark an unrelated or unserved gap recovered.
 */
export function buildServedAccountGapLookup(
  detailGaps: readonly BrowserCollectContext["detailGaps"][number][]
): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const gap of detailGaps) {
    if (gap.stream !== "transactions" || gap.status !== "pending") {
      continue;
    }
    const locator = gap.detail_locator;
    if (!locator || locator.kind !== "chase.account") {
      continue;
    }
    const accountId = locator.account_id;
    if (typeof accountId !== "string" || accountId.length === 0 || typeof gap.gap_id !== "string" || !gap.gap_id) {
      continue;
    }
    // First served gap per account wins; the runtime serves at most one pending
    // gap per (instance, stream, record_key) so a duplicate would be a store
    // anomaly, not an expected state.
    if (!lookup.has(accountId)) {
      lookup.set(accountId, gap.gap_id);
    }
  }
  return lookup;
}

/**
 * Emit `DETAIL_GAP_RECOVERED` for each served account gap whose account this run
 * reached. An account is "reached" when its QFX pass produced a `hydrated`
 * outcome (parsed, including a 0-transaction ledger) or a `no_activity` outcome
 * (source-limited completeness) — both are real coverage of that account's
 * ledger for the window, mirroring how `emitTransactionsDetailCoverage` counts
 * them as `hydrated_keys`. A `gap` outcome is left on the `DETAIL_GAP` re-emit
 * path in `runTransactionsAndBalances` and is never recovered here. A served gap
 * whose account was not reached (still failing, or no longer enumerated) is left
 * untouched so the runtime's existing served-but-unrecovered reset returns it to
 * `pending` — lose-no-data preserved.
 */
export async function recoverServedAccountGaps(
  deps: EmitDeps,
  outcomes: readonly AccountDetailOutcome[]
): Promise<void> {
  const served = deps.servedAccountGaps;
  if (!served || served.size === 0) {
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.kind !== "hydrated" && outcome.kind !== "no_activity") {
      continue;
    }
    const gapId = served.get(outcome.accountId);
    if (!gapId) {
      continue;
    }
    await deps.emit({
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: gapId,
      stream: "transactions",
      record_key: outcome.accountId,
    });
  }
}

async function runTransactionsAndBalances(
  deps: EmitDeps,
  page: Page,
  filteredAccounts: readonly ChaseAccount[]
): Promise<void> {
  const outcomes: AccountDetailOutcome[] = [];
  for (let i = 0; i < filteredAccounts.length; i++) {
    const account = filteredAccounts[i];
    if (!account) {
      continue;
    }
    const outcome = await processAccountDownload(deps, page, account, {
      index: i + 1,
      total: filteredAccounts.length,
    });
    outcomes.push(outcome);
    if (outcome.kind === "gap") {
      await deps.emit(buildAccountDetailGap(outcome));
    }
  }
  // Recover any served pending gaps whose account we reached this run, then
  // declare per-account coverage. Recovery is emitted before coverage so the
  // spine's recovered-gap events precede the run's coverage summary, matching
  // Amazon/ChatGPT ordering (recovery pass → coverage).
  await recoverServedAccountGaps(deps, outcomes);
  await emitTransactionsDetailCoverage(deps, outcomes);
  // Stage the balances presence checkpoint when any balance was emitted so a
  // succeeded run does not leave `balances` at `checkpoint:not_staged`.
  const balanceEmitted = outcomes.some((o) => o.kind !== "gap" && o.balanceEmitted === true);
  await emitBalancesStateIfAny(deps, balanceEmitted);
}

/**
 * Emit current_activity rows scraped from the Chase dashboard overview MDS
 * activity table (`<tr class="mds-activity-table__row" data-values=...>`),
 * which is the surface that visibly contains pending and recent posted
 * rows — verified against the captured run on 2026-05-15 in
 * `fixtures/chase/raw/2026-05-15T13-48-45-588Z/dom/dashboard-accounts.html`
 * (5 MDS rows). The QFX download page does not contain these rows; the
 * pre-fix code re-navigated to the overview hash-route after the download
 * form had already loaded, which is a same-document hash change that does
 * NOT re-render the SPA — so it ended up scraping the download form's DOM
 * and emitting `selectors_pending` against the wrong surface.
 *
 * Attribution policy:
 *   - 1 filtered account: overview rows belong to that account.
 *   - >1 filtered accounts: rows from the overview table mix activity
 *     across all visible accounts and cannot be safely attributed
 *     without a per-account activity surface. Emit a single SKIP_RESULT
 *     `ambiguous_multi_account_overview` instead of guessing.
 *   - 0 parseable rows: emit `selectors_pending` with a message that
 *     references the dashboard overview (the actual surface), not the
 *     account-activity DOM.
 *
 * Takes pre-captured dashboard HTML (Page is no longer required) so this
 * helper is unit-testable and avoids fragile SPA re-routing. The caller
 * is responsible for grabbing `page.content()` while the dashboard
 * overview is still loaded — see collect().
 */
export async function runCurrentActivity(
  deps: EmitDeps,
  dashboardHtml: string,
  filteredAccounts: readonly ChaseAccount[]
): Promise<void> {
  const fingerprintCursor = deps.currentActivityFingerprintCursor;
  // Build the STATE cursor carrying the per-row fingerprints forward.
  // NOT pruned (partial scan — see emitCurrentActivityForAccount), so a
  // run that emits zero rows (no accounts in scope, ambiguous multi-account
  // overview, or a parse miss) still surfaces every prior fingerprint and
  // never re-churns a row the next run re-lists.
  const buildCursor = (): Record<string, unknown> => {
    const cursor: Record<string, unknown> = { fetched_at: deps.emittedAt };
    if (fingerprintCursor && fingerprintCursor.size() > 0) {
      cursor.fingerprints = fingerprintCursor.toState();
    }
    return cursor;
  };

  if (filteredAccounts.length === 0) {
    return;
  }

  if (filteredAccounts.length > 1) {
    await deps.emit({
      type: "PROGRESS",
      stream: "current_activity",
      message: `Skipping current_activity for ${filteredAccounts.length} accounts (overview attribution is ambiguous)`,
    });
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "current_activity",
      reason: "ambiguous_multi_account_overview",
      message:
        "Chase dashboard overview aggregates recent activity across multiple accounts and provides no per-row account attribution; current_activity collection requires a per-account activity surface (not yet wired)",
      diagnostics: { account_count: filteredAccounts.length },
    });
    await deps.emit({
      type: "STATE",
      stream: "current_activity",
      cursor: buildCursor(),
    });
    return;
  }

  const account = filteredAccounts[0];
  if (!account) {
    return;
  }

  const progressMsg = {
    type: "PROGRESS",
    stream: "current_activity",
    message: "Parsing current_activity dashboard overview rows for account 1/1",
    count: 1,
    total: 1,
  } as const;
  await deps.emit(progressMsg);

  const emitted = await emitCurrentActivityForAccount(deps, account, dashboardHtml, fingerprintCursor);
  if (emitted === 0) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "current_activity",
      reason: "selectors_pending",
      message:
        "No parseable current_activity rows found in the Chase dashboard overview DOM; either the dashboard rendered without the recent-activity table or the row markup has drifted — see captured fixture for this run",
      diagnostics: { account_count: 1 },
    });
  } else {
    await deps.emit({
      type: "PROGRESS",
      stream: "current_activity",
      message: `Emitted ${emitted} current_activity row(s) from dashboard overview`,
    });
  }

  await deps.emit({
    type: "STATE",
    stream: "current_activity",
    cursor: buildCursor(),
  });
}

async function processStatementRow(
  deps: EmitDeps,
  page: Page,
  row: StatementRow,
  filteredAccounts: readonly ChaseAccount[],
  accounts: readonly ChaseAccount[],
  accountsResFilter: ReadonlySet<string> | null,
  fingerprintCursor?: FingerprintCursor,
  hydrationCursor?: StatementHydrationCursor
): Promise<StatementDetailOutcome | null> {
  try {
    const dateIso = parseDateDelivered(row.date_delivered_raw);
    const accountId = resolveAccountIdForRow(row, filteredAccounts) ?? resolveAccountIdForRow(row, accounts);

    // Apply resources filter: if the accounts res filter excludes this
    // statement's account, skip it. (emitRecord will also skip, but doing
    // it here saves the PDF download.)
    if (accountsResFilter?.size && accountId && !accountsResFilter.has(accountId)) {
      return null;
    }
    if (statementRowOutsideTimeRange(deps, dateIso)) {
      return null;
    }

    const id = shortHash(`${row.account_reference ?? ""}|${dateIso ?? row.date_delivered_raw}|${row.title}`);
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: "Downloading statement PDF",
    });

    const dlResult = await downloadStatementPdf(page, row, accountId, deps.capture);
    if (!dlResult.ok) {
      await deps.emit({
        type: "PROGRESS",
        stream: "statements",
        message: "Statement PDF not hydrated this run; emitting index-only statement",
      });
      // Still emit a record so the owner has proof the statement exists.
      // If it was previously hydrated, carry the prior pointers forward so a
      // transient download failure does not flap them to null and re-version
      // an immutable statement.
      const carried = await emitStatementIndexOnly(
        deps,
        id,
        row,
        accountId,
        dateIso,
        fingerprintCursor,
        hydrationCursor
      );
      return { kind: isHydrated(carried) ? "hydrated" : "index_only", id };
    }

    const record = {
      id,
      account_id: accountId,
      title: row.title,
      date_delivered: dateIso,
      account_reference: row.account_reference,
      document_url: fileUrl(dlResult.pdfPath),
      pdf_path: dlResult.pdfPath,
      pdf_sha256: dlResult.pdfSha256,
      pdf_text_sha256: dlResult.content.pdf_text_sha256,
      pdf_page_count: dlResult.content.pdf_page_count,
      fetched_at: deps.emittedAt,
    };
    // Record this run's fresh hydration so a later run that fails to
    // re-download can carry these content-addressed pointers AND the positive
    // content fingerprint forward (so a transient failure does not drop the
    // content fields and flip the canonical exclusion back to conservative).
    hydrationCursor?.note(id, {
      document_url: record.document_url,
      pdf_path: record.pdf_path,
      pdf_sha256: record.pdf_sha256,
      pdf_text_sha256: record.pdf_text_sha256,
      pdf_page_count: record.pdf_page_count,
    });
    // Gate on a per-statement fingerprint that excludes the run-clock
    // `fetched_at`. A statement's identity (id = hash(account_reference|
    // date|title)) is immutable and pdf_path/pdf_sha256/document_url are
    // content-addressed (the path embeds the sha256), so a re-downloaded
    // identical statement is byte-identical modulo `fetched_at`. Without
    // this gate every run appended a fresh version of every statement
    // (~10 versions/record of pure run-clock churn).
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(record)) {
      await deps.emitRecord("statements", record);
    }
    return { kind: "hydrated", id };
  } catch (rowErr) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "row_exception",
      message: `Statement row processing failed: ${truncate(errMessage(rowErr), ERROR_MESSAGE_SLICE_LONG)}`,
      diagnostics: {
        error_class: rowErr instanceof Error ? rowErr.constructor.name : "unknown",
        message: truncate(errMessage(rowErr), ERROR_MESSAGE_SLICE_LONG),
      },
    });
    return null;
  }
}

async function runStatements(
  deps: EmitDeps,
  page: Page,
  filteredAccounts: readonly ChaseAccount[],
  accounts: readonly ChaseAccount[],
  accountsResFilter: ReadonlySet<string> | null,
  fingerprintCursor?: FingerprintCursor,
  hydrationCursor?: StatementHydrationCursor
): Promise<void> {
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: "Navigating to Statements & Documents",
    });
    await navigateToStatementsPage(page);
    await capturePageCheckpoint(deps.capture, page, "statements-list");
    const rows = await enumerateStatementRows(page);
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: `Found ${rows.length} statement row(s)`,
    });

    const outcomes: StatementDetailOutcome[] = [];
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
      const outcome = await processStatementRow(
        deps,
        page,
        row,
        filteredAccounts,
        accounts,
        accountsResFilter,
        fingerprintCursor,
        hydrationCursor
      );
      if (outcome) {
        outcomes.push(outcome);
      }
    }
    await emitStatementDetailCoverage(deps, outcomes);

    // Statements is a full scan of the documents index: prune fingerprints
    // (and the carried hydration pointers, in lockstep) for statements no
    // longer listed so a re-appearance re-emits and a delisted statement
    // stops being carried forever.
    fingerprintCursor?.pruneStale();
    hydrationCursor?.pruneStale();
    const cursor: Record<string, unknown> = { fetched_at: deps.emittedAt };
    if (fingerprintCursor && fingerprintCursor.size() > 0) {
      cursor.fingerprints = fingerprintCursor.toState();
    }
    if (hydrationCursor && hydrationCursor.size() > 0) {
      cursor.hydration = hydrationCursor.toState();
    }
    const stateMsg: Extract<EmittedMessage, { type: "STATE" }> = {
      type: "STATE",
      stream: "statements",
      cursor,
    };
    await deps.emit(stateMsg);
  } catch (err) {
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "statements_scrape_failed",
      message: truncate(errMessage(err), ERROR_MESSAGE_SLICE_MAX),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: truncate(errMessage(err), ERROR_MESSAGE_SLICE_MAX),
      },
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

      // Per-transaction fingerprint cursor (excludes the run-clock
      // `fetched_at`). One cursor for the whole transactions stream —
      // record ids (`account_id|fitid`) are globally unique across
      // accounts. Only opened when transactions are requested. NOT pruned:
      // transactions is a partial incremental scan (see
      // emitTransactionsForAccount).
      const transactionsFingerprintCursor = requested.has("transactions")
        ? openFingerprintCursor(startState.transactions, {
            excludeFromFingerprint: ["fetched_at", "source"],
            priorFingerprints: readPriorTransactionFingerprints(startState),
          })
        : undefined;

      // Per-row fingerprint cursor for `current_activity` (excludes the
      // run-clock `fetched_at`). One cursor for the whole stream — row ids
      // (`account_id|ui_transaction_id` or an account-scoped fallback hash)
      // are globally unique. Only opened when current_activity is
      // requested. NOT pruned: the dashboard overview is a partial
      // (recent-rows) scan (see emitCurrentActivityForAccount).
      const currentActivityFingerprintCursor = requested.has("current_activity")
        ? openFingerprintCursor(startState.current_activity, {
            excludeFromFingerprint: ["fetched_at"],
            priorFingerprints: readPriorCurrentActivityFingerprints(startState),
          })
        : undefined;

      const deps: EmitDeps = {
        capture,
        currentActivityFingerprintCursor,
        emit,
        emitRecord,
        emittedAt,
        maxSeenByAccount,
        progress,
        requested,
        resFilters,
        servedAccountGaps: buildServedAccountGapLookup(ctx.detailGaps),
        tmpDir,
        txState,
        transactionsFingerprintCursor,
        wantsAccounts: requested.has("accounts"),
        wantsBalances: requested.has("balances"),
        wantsCurrentActivity: requested.has("current_activity"),
        wantsStatements: requested.has("statements"),
        wantsTransactions: requested.has("transactions"),
      };

      try {
        await progress("Chase session verified; enumerating accounts");

        const accounts = await discoverAccounts(page);
        await capturePageCheckpoint(capture, page, "dashboard-accounts");
        if (accounts.length === 0) {
          await emitNoAccountsDiagnostic(page, emit);
          return; // runtime emits DONE succeeded
        }

        // Snapshot the dashboard overview DOM now while the page is still on
        // it — the MDS recent-activity table (tr.mds-activity-table__row
        // [data-values]) is only present here, NOT on the QFX download form
        // the connector navigates to next. The earlier implementation tried
        // to re-navigate back to the overview hash route after the download
        // page loaded, but `page.goto(<same-path>#<other-fragment>)` is a
        // same-document hash change and does NOT re-render the SPA. Capture
        // the bytes here so current_activity can be parsed even when later
        // phases (downloads, statements) leave the page elsewhere.
        const dashboardHtmlForCurrentActivity = deps.wantsCurrentActivity
          ? await snapshotDashboardHtmlForCurrentActivity(page)
          : { html: "", rowSurfaceReady: false };
        if (deps.wantsCurrentActivity && !dashboardHtmlForCurrentActivity.rowSurfaceReady) {
          await progress("Chase dashboard recent-activity rows did not appear before snapshot");
        }

        await progress(`Found ${accounts.length} account(s)`);

        const { accountsResFilter, filteredAccounts } = filterAccountsByScope(accounts, resFilters);

        // Emit accounts stream. Our record.id is Chase's internal account id
        // directly — stable, no hashing needed. Keeps transactions.account_id
        // aligned with the download URL param.
        if (deps.wantsAccounts) {
          const accountsFingerprintCursor = openFingerprintCursor(startState.accounts, {
            excludeFromFingerprint: ["fetched_at"],
            priorFingerprints: readPriorAccountFingerprints(startState),
          });
          await emitAccountsStream(deps, filteredAccounts, accountsFingerprintCursor);
        }

        // Transactions + balances: download QFX per account, parse, emit.
        if (deps.wantsTransactions || deps.wantsBalances) {
          await runTransactionsAndBalances(deps, page, filteredAccounts);
        }

        if (deps.wantsCurrentActivity) {
          await runCurrentActivity(deps, dashboardHtmlForCurrentActivity.html, filteredAccounts);
        }

        // Statements: navigate to Statements & Documents, enumerate rows,
        // download each PDF, emit one record per statement with
        // content-addressed path. Content-gated per-statement fingerprint
        // cursor: when the record carries a positive content fingerprint
        // (pdf_text_sha256 + pdf_page_count), the blob/acquisition-identity
        // fields are excluded too, so an RC4 re-encryption re-download with
        // unchanged content is a no-op; when absent (legacy/index-only) only
        // `fetched_at` is excluded (conservative fallback).
        if (deps.wantsStatements) {
          const statementsFingerprintCursor = openFingerprintCursor(startState.statements, {
            resolveExcludeFromFingerprint: statementFingerprintExcludeKeys,
            priorFingerprints: readPriorStatementFingerprints(startState),
          });
          // Carry-forward of prior hydrated PDF pointers: seeded from the
          // prior statements STATE so a transient re-download failure re-emits
          // the prior content-addressed pointers instead of null.
          const statementsHydrationCursor = openStatementHydrationCursor(
            readPriorStatementHydration(startState.statements)
          );
          await runStatements(
            deps,
            page,
            filteredAccounts,
            accounts,
            accountsResFilter,
            statementsFingerprintCursor,
            statementsHydrationCursor
          );
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
