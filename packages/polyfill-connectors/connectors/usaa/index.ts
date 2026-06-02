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

import { mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { ensureUsaaSession } from "../../src/auto-login/usaa.ts";
import {
  attachBodyResponseQueue,
  type BodyResponseDiagnostics,
  type BodyResponseQueue,
  waitForOptionalBodyResponse,
} from "../../src/browser-artifact-response.ts";
import {
  type BrowserCollectContext,
  type EmittedMessage,
  type InteractionRequest,
  type InteractionResponse,
  nowIso,
  politeDelay,
  runConnector,
  type ValidateRecord,
} from "../../src/connector-runtime.ts";
import { attachDownloadQueue, type DownloadQueue } from "../../src/download-queue.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { readPlaywrightDownloadBufferDetailed } from "../../src/playwright-download.ts";
import {
  buildAccountRecord,
  buildCandidateStarts,
  buildCreditCardBillingRecord,
  buildInboxMessageRecord,
  hashId,
  isoDate,
  mmddyyyy,
  BACKFILL_17MO as PARSERS_BACKFILL_17MO,
  INCREMENTAL_OVERLAP_MS as PARSERS_INCREMENTAL_OVERLAP_MS,
  parseCsv,
  resolveAccountIdForRef,
  rowsToTransactions,
} from "./parsers.ts";
import { validateRecord as validateRecordRaw } from "./schemas.ts";
import { fileUrlForPath, hydrateStatementPdfs, parsePdfStatement } from "./statement-pdfs.ts";
import type {
  BillingKv,
  DashboardAccount,
  DiagnosticCandidate,
  DiagnosticInfo,
  DocRow,
  DownloadDiagnostics,
  DriveExportOptions,
  HydrationResult,
  HydrationResultSuccess,
  InboxRow,
  IndexRow,
  LocatedExportPage,
  PageDiagnostics,
  StatementRecord,
  TransactionsPriorState,
  TransactionsStreamCursor,
} from "./types.ts";

const validateRecord = validateRecordRaw as ValidateRecord;

// ─── Module-scope regexes ────────────────────────────────────────────────

const ACCOUNT_URL_PREFIXES =
  'a[href^="/my/checking"], a[href^="/my/savings"], a[href^="/my/credit-card"], a[href^="/my/external-account"], a[href^="/my/loan"], a[href^="/my/mortgage"], a[href^="/my/investing"], a[href^="/my/retirement"]';
const DASHBOARD_SELECTOR_WAIT = 'a[href^="/my/checking"], a[href^="/my/credit-card"], a[href^="/my/external-account"]';
const LOGON_REDIRECT_RE = /\/my\/logon|\/access-management\/oauth2\/member\/authorize/;
const TRANSACTION_ACCOUNT_TYPE_RE = /checking|savings|credit-card/;
const CREDIT_CARD_TYPE_RE = /credit-card/;
const TEMP_DIR_PREFIX_RE = /\/[^/]+$/;
const UNSAFE_FILENAME_RE = /[\\/]/g;
const EXPORT_BUTTON_TEXT_RE = /^\s*Export\s*$/i;
const CSV_DOWNLOAD_HINT_RE = /filename|attachment|octet-stream|csv|export/iu;
const CSV_HEAD_RE = /date|description|amount|transaction/iu;
const EXPORT_DIALOG_MESSAGE_SELECTOR =
  '[role="dialog"] [class*="errorMessage"]:not(:empty), [role="dialog"] :text-matches("no transactions|nothing to export", "i")';
const EXPORT_NO_DATA_RE = /no transactions|nothing to export/iu;

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
const DOWNLOAD_TIMEOUT_MS = 45_000;
const RESPONSE_FALLBACK_GRACE_MS = 3000;
const KEY_TYPE_DELAY_MS = 30;
const BACKFILL_17MO = PARSERS_BACKFILL_17MO;
const INCREMENTAL_OVERLAP_MS = PARSERS_INCREMENTAL_OVERLAP_MS;
const ID_TEXT_SNIP = 160;
const HTML_PREVIEW_MAX = 600;

// Pure helpers — hashId, currencyToCents, isoDate, mmddyyyy, parseCsv,
// rowsToTransactions — live in ./parsers.ts.

// ─── Emit-path helpers (cross-stream seams) ─────────────────────────────

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type RequestedScopes = BrowserCollectContext["requested"];

// Module-scope regexes (Biome useTopLevelRegex). CREDIT_CARD_TYPE_RE is
// defined above in the existing regex block; reuse it here rather than
// redeclare to avoid a lint collision.
const STATEMENT_TITLE_RE = /STATEMENT/i;
const NON_STATEMENT_TITLE_RE = /(TERMS\b|AGREEMENT\b|NOTICE\b|DISCLOSURE\b|CONDITION)/i;

/** Per-run dependency bag for the emit-path helpers. */
export interface EmitDeps {
  capture?: BrowserCollectContext["capture"];
  emit: EmitFn;
  emitRecord: EmitRecordFn;
}

/** Aggregate shape from the PDF hydration pass. Exposed so the emit-
 *  path caller can thread successes/attempts into the per-run PROGRESS. */
export interface HydrationSummary {
  attempts: number;
  results: Map<number, HydrationResult>;
  successes: number;
}

/** Streams scaffolded in design-notes but without live selectors. Each
 *  requested-but-deferred stream gets a SKIP_RESULT so the client sees
 *  the intent without data. */
export const DEFERRED_STREAMS: readonly string[] = [
  "transfers",
  "bill_payments",
  "scheduled_transactions",
  "external_accounts",
];

/** True iff we should try to extract transactions from this statement
 *  title. USAA's document index mixes statements with agreements /
 *  disclosures — the parser only understands the former. */
export function shouldParseStatementTitle(title: string): boolean {
  return STATEMENT_TITLE_RE.test(title) && !NON_STATEMENT_TITLE_RE.test(title);
}

/** Narrow a HydrationResult to the success branch. Used by the record-
 *  emit path to decide between a hydrated row and an index-only row. */
export function hydrationSuccess(h: HydrationResult | undefined): HydrationResultSuccess | null {
  if (h && "pdfPath" in h) {
    return h;
  }
  return null;
}

/** Build `statements` IndexRows from scraped DocRows. Rows missing a
 *  `date_delivered` are dropped — we can't reliably key them. Account
 *  resolution falls through last-four then name substring. */
export function buildIndexRows(docs: readonly DocRow[], accounts: readonly DashboardAccount[]): IndexRow[] {
  return docs
    .filter((d) => d.date_delivered)
    .map((d) => {
      const accountReference = d.account_reference.trim() || null;
      return {
        rowIndex: d.rowIndex,
        id: hashId(`${accountReference ?? ""}|${d.date_delivered}|${d.title}`),
        account_id: resolveAccountIdForRef(accountReference ?? "", accounts),
        title: d.title,
        date_delivered: isoDate(d.date_delivered),
        account_reference: accountReference,
      };
    });
}

/** Emit one `accounts` record per dashboard account, followed by a
 *  STATE checkpoint. Record `fetched_at` threads the run-level
 *  emittedAt so every record in a run shares one timestamp; STATE
 *  cursor uses `nowIso()` at emit time since it's a heartbeat, not a
 *  record field. */
export async function emitAccountsStream(
  deps: EmitDeps,
  accounts: readonly DashboardAccount[],
  emittedAt: string
): Promise<void> {
  for (const a of accounts) {
    await deps.emitRecord("accounts", buildAccountRecord(a, emittedAt));
  }
  await deps.emit({
    type: "STATE",
    stream: "accounts",
    cursor: { fetched_at: nowIso() },
  });
}

/** Emit a SKIP_RESULT for every requested-but-deferred stream. Keeps
 *  the client informed that we understood the request but can't fulfil
 *  it in this revision — rather than silently dropping the scope. */
export async function emitDeferredStreams(emit: EmitFn, requested: RequestedScopes): Promise<void> {
  for (const s of DEFERRED_STREAMS) {
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
}

/**
 * Emit the "backfill ladder exhausted" SKIP_RESULT for transactions.
 * Called when `tryExportLadder` returns no CSV across every candidate
 * start without an explicit "nothing to export" source response.
 */
export async function emitExportFailure(
  deps: EmitDeps,
  a: DashboardAccount,
  lastDiag: DiagnosticInfo | null
): Promise<void> {
  const isCreditCard = CREDIT_CARD_TYPE_RE.test(a.account_type);
  const baseMessage = lastDiag
    ? `${a.name ?? "?"}: ${formatDiagnosticInfo(lastDiag)}`
    : `${a.name ?? "?"}: export dialog didn't produce a download across all ranges — account may have no transactions or selectors shifted`;
  const ccSuffix = isCreditCard
    ? ' (credit-card export flow not verified live 2026-04-19 — see design-notes/usaa.md "Fallback path: DOM scrape")'
    : "";
  await deps.emit({
    type: "SKIP_RESULT",
    stream: "transactions",
    reason: isCreditCard ? "credit_card_export_unverified" : "export_no_download",
    message: `${baseMessage}${ccSuffix}`,
    diagnostics: lastDiag,
  });
}

function redactDiagnosticUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl.replace(/\d{4,}/g, "[digits]").slice(0, 120);
  }
}

function summarizeArtifactDiagnostics(diag: DiagnosticInfo): string | null {
  const artifact = diag.artifact;
  if (!artifact) {
    return null;
  }
  const matched = artifact.candidates.filter((candidate) => candidate.reason === "matched").length;
  const bodyErrors = artifact.candidates.filter((candidate) => candidate.reason === "body_error").length;
  const inspected = artifact.candidates.length;
  const parts = [
    `artifact cdpReady=${artifact.cdpReady ? "true" : "false"} candidates=${inspected} matched=${matched} bodyErrors=${bodyErrors}`,
  ];
  if (artifact.cdpError) {
    parts.push(`cdpError=${artifact.cdpError.slice(0, ID_TEXT_SNIP)}`);
  }
  const firstCandidate = artifact.candidates[0];
  if (firstCandidate) {
    const firstParts = [
      firstCandidate.source,
      String(firstCandidate.status),
      firstCandidate.reason,
      `${firstCandidate.bodyBytes ?? 0}B`,
      firstCandidate.contentType || "no-content-type",
    ];
    const disposition = firstCandidate.contentDisposition.slice(0, 80);
    if (disposition) {
      firstParts.push(`disposition=${disposition}`);
    }
    const url = redactDiagnosticUrl(firstCandidate.url);
    if (url) {
      firstParts.push(`url=${url}`);
    }
    if (firstCandidate.bodyError) {
      firstParts.push(`bodyError=${firstCandidate.bodyError.slice(0, ID_TEXT_SNIP)}`);
    }
    parts.push(`firstCandidate=${firstParts.join(",")}`);
  }
  return parts.join(" ");
}

function summarizeDownloadDiagnostics(diag: DiagnosticInfo): string | null {
  const dl = diag.download;
  if (!dl) {
    return null;
  }
  const parts: string[] = [];
  const url = redactDiagnosticUrl(dl.url ?? null);
  if (url) {
    parts.push(`url=${url}`);
  }
  if (dl.suggestedFilename) {
    parts.push(`name=${dl.suggestedFilename.slice(0, 80)}`);
  }
  if (typeof dl.bytes === "number") {
    parts.push(`bytes=${dl.bytes}`);
  }
  if (dl.source) {
    parts.push(`source=${dl.source}`);
  }
  if (dl.saveAsError) {
    parts.push(`saveAsError=${dl.saveAsError.slice(0, ID_TEXT_SNIP)}`);
  }
  if (dl.streamError) {
    parts.push(`streamError=${dl.streamError.slice(0, ID_TEXT_SNIP)}`);
  }
  if (dl.downloadFailure) {
    parts.push(`downloadFailure=${dl.downloadFailure.slice(0, ID_TEXT_SNIP)}`);
  }
  return parts.length ? `download ${parts.join(",")}` : null;
}

function formatDiagnosticInfo(diag: DiagnosticInfo): string {
  const parts = [diag.phase];
  const url = redactDiagnosticUrl(diag.diag?.url);
  parts.push(`page=${url ?? "unavailable"}`);
  const artifact = summarizeArtifactDiagnostics(diag);
  if (artifact) {
    parts.push(artifact);
  }
  const download = summarizeDownloadDiagnostics(diag);
  if (download) {
    parts.push(download);
  }
  if (diag.error) {
    parts.push(`error=${diag.error.slice(0, ID_TEXT_SNIP)}`);
  }
  return parts.join("; ");
}

/**
 * Emit one `statements` record per index row. A hydrated row gets a
 * populated `pdf_path` / `pdf_sha256` / `document_url`; a failed
 * hydration falls back to an index-only row (all three are null) so
 * the client never loses the fact that the statement exists. Emits a
 * final PROGRESS + STATE for the stream.
 *
 * Invariants (tested in integration.test.ts):
 *   - same number of records emitted as rows in, regardless of
 *     hydration success (null fallback, not drop),
 *   - hydrated rows set pdf_path + pdf_sha256 + document_url; index-
 *     only rows leave all three null,
 *   - STATE emits exactly once after all records.
 */
export async function emitStatementRecords(
  deps: EmitDeps,
  indexRows: readonly IndexRow[],
  hydrationResults: Map<number, HydrationResult>,
  summary: HydrationSummary,
  fingerprintCursor?: FingerprintCursor
): Promise<void> {
  for (const row of indexRows) {
    const ok = hydrationSuccess(hydrationResults.get(row.rowIndex));
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
    // Gate on a per-statement fingerprint that excludes the run-clock
    // `fetched_at`. A statement's identity fields (id, account_id, title,
    // date_delivered) are immutable, and pdf_path/pdf_sha256/document_url
    // are content-addressed (the path embeds the sha256 prefix), so a
    // re-hydrated identical statement produces a byte-identical body
    // modulo `fetched_at`. Without this gate every run appended a fresh
    // version of every statement (~15 versions/record of pure run-clock
    // churn). When no cursor is supplied (legacy callers/tests) the
    // record always emits.
    if (!fingerprintCursor || fingerprintCursor.shouldEmit(rec)) {
      await deps.emitRecord("statements", rec);
    }
  }
  // Statements is a full scan of the documents index: prune fingerprints
  // for statements no longer listed so a re-appearance re-emits.
  fingerprintCursor?.pruneStale();
  const progressMsg = {
    type: "PROGRESS",
    stream: "statements",
    message: `Hydrated ${summary.successes}/${summary.attempts || indexRows.length} PDFs`,
    count: summary.successes,
    total: summary.attempts || indexRows.length,
  } as const;
  await deps.emit(progressMsg);
  const cursor: Record<string, unknown> = { fetched_at: nowIso() };
  if (fingerprintCursor && fingerprintCursor.size() > 0) {
    cursor.fingerprints = fingerprintCursor.toState();
  }
  await deps.emit({
    type: "STATE",
    stream: "statements",
    cursor,
  });
}

/**
 * Parse the prior `statements` STATE cursor's `fingerprints` map. Keyed
 * by statement `id`. Legacy cursors (only `{ fetched_at }`) decode to an
 * empty map, so the first post-deploy run rebuilds the map and re-emits
 * every statement exactly once.
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
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const WHITESPACE_RE = /\s+/g;
    const SKIP_TEXT_RE = /^(Get started|Add account|View|Manage|Open|Apply|Browse)/i;
    const TYPE_URL_RE = /^\/my\/([^/?]+)/;
    const ACCOUNT_ID_RE = /(?:accountId|acctId)=([^&]+)/;
    const LAST4_RE = /\*(\d{4})/;
    const ENDING_IN_RE = /\bEnding in\b|\bending in\b/i;
    const DOLLAR_RE = /\$([\d,]+\.\d{2})/g;
    const COMMA_RE_LOCAL = /,/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    const out: DashboardAccount[] = [];
    const links = [...document.querySelectorAll<HTMLElement>(linkSelector)];
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
      const balanceCents = firstAmount ? Math.round(Number(firstAmount.replace(COMMA_RE_LOCAL, "")) * 100) : null;
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

  const creditClass = page.locator("button.as_credit__utility-bar-item.as_credit__export");
  if (await creditClass.count().catch((): number => 0)) {
    return creditClass.first();
  }

  const buttonText = page.locator('button, [role="button"]').filter({ hasText: EXPORT_BUTTON_TEXT_RE });
  if (await buttonText.count().catch((): number => 0)) {
    return buttonText.first();
  }

  return null;
}

function capturePageDiagnostics(page: Page): Promise<PageDiagnostics | null> {
  return page
    .evaluate((): PageDiagnostics => {
      // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
      const WS_RE = /\s+/g;
      const EXPORT_OR_DL_RE = /export|download/i;
      // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

      const take = (sel: string, max = 8): DiagnosticCandidate[] => {
        const els = [...document.querySelectorAll<HTMLElement>(sel)];
        return els.slice(0, max).map((el) => ({
          tag: el.tagName,
          text: (el.innerText || "").replace(WS_RE, " ").trim().slice(0, 50),
          cls: (el.className ? String(el.className) : "").slice(0, 80),
          id: el.id || null,
        }));
      };
      return {
        url: location.href,
        title: document.title,
        has_utility_bar: Boolean(document.querySelector('.ent-as-utility-bar, [class*="utility-bar" i]')),
        export_candidates: take('button, [role="button"]').filter((c) => EXPORT_OR_DL_RE.test(c.text)),
        nav_candidates: take('a[href*="/my/credit-card"], a[role="tab"], [role="tab"]'),
        dialogs_open: document.querySelectorAll('[role="dialog"]').length,
      };
    })
    .catch((): PageDiagnostics | null => null);
}

async function locateExportPage(page: Page, accountUrl: string): Promise<LocatedExportPage | null> {
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

const DIALOG_HTML_WS_RE = /\s+/g;

async function emitExportClickFailedDiagnostic(
  page: Page,
  onDiagnostics: DriveExportOptions["onDiagnostics"],
  err: unknown
): Promise<void> {
  if (!onDiagnostics) {
    return;
  }
  const diag = await capturePageDiagnostics(page);
  const msg = err instanceof Error ? err.message : String(err);
  onDiagnostics({
    phase: "export_click_failed",
    diag,
    error: msg.slice(0, ID_TEXT_SNIP),
  });
}

async function emitDialogUnexpectedShapeDiagnostic(
  page: Page,
  onDiagnostics: NonNullable<DriveExportOptions["onDiagnostics"]>
): Promise<void> {
  const base = await capturePageDiagnostics(page);
  const dialogHtml = await page
    .locator('[role="dialog"]')
    .first()
    .innerHTML()
    .catch((): string | null => null);
  const preview = dialogHtml ? dialogHtml.replace(DIALOG_HTML_WS_RE, " ").slice(0, HTML_PREVIEW_MAX) : null;
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

/** Click Export, then confirm the date-range selector rendered. */
async function openExportDialog(
  page: Page,
  located: LocatedExportPage,
  onDiagnostics: DriveExportOptions["onDiagnostics"]
): Promise<boolean> {
  try {
    await located.export.click({ timeout: EXPORT_CLICK_TIMEOUT_MS });
  } catch (err) {
    await emitExportClickFailedDiagnostic(page, onDiagnostics, err);
    return false;
  }
  await politeDelay(EXPORT_DIALOG_DELAY_MS);

  const selectCount = await page
    .locator('[role="dialog"] select[name="selectionType"], select[name="selectionType"]')
    .count()
    .catch((): number => 0);
  if (!selectCount) {
    if (onDiagnostics) {
      await emitDialogUnexpectedShapeDiagnostic(page, onDiagnostics);
    }
    await page.keyboard.press("Escape").catch((): undefined => undefined);
    return false;
  }
  return true;
}

/** Fill the date-range inputs via select → clear → type. */
async function fillExportDateRange(page: Page, sinceDate: string, untilDate: string): Promise<void> {
  await page.selectOption('select[name="selectionType"]', "date-range").catch((): string[] => []);
  await politeDelay(EXPORT_STATE_DELAY_MS);

  const fromIn = page.locator('input[name="fromDate"], input[name="startDate"]').first();
  const endIn = page.locator('input[name="endDate"]').first();
  await fromIn.click().catch((): undefined => undefined);
  await page.keyboard.press("Control+A").catch((): undefined => undefined);
  await page.keyboard.press("Delete").catch((): undefined => undefined);
  await fromIn.pressSequentially(mmddyyyy(sinceDate), { delay: KEY_TYPE_DELAY_MS }).catch((): undefined => undefined);
  await endIn.click().catch((): undefined => undefined);
  await page.keyboard.press("Control+A").catch((): undefined => undefined);
  await page.keyboard.press("Delete").catch((): undefined => undefined);
  await endIn.pressSequentially(mmddyyyy(untilDate), { delay: KEY_TYPE_DELAY_MS }).catch((): undefined => undefined);
  await politeDelay(EXPORT_STATE_DELAY_MS);
  await politeDelay(EXPORT_STATE_DELAY_MS);
}

async function captureExportCheckpoint(page: Page, options: DriveExportOptions, suffix: string): Promise<void> {
  if (!(options.capture && options.captureLabel)) {
    return;
  }
  await options.capture.captureDom(page, `${options.captureLabel}-${suffix}`).catch((): undefined => undefined);
}

type ExportSubmitOutcome =
  | { buffer: Buffer; kind: "artifact"; suggestedFilename: string | null }
  | {
      kind: "artifact_failed";
      artifact: BodyResponseDiagnostics;
      download: DownloadDiagnostics | null;
      error: string;
    }
  | { kind: "dialog_error"; message: string }
  | { kind: "empty"; message: string };

/**
 * Error subclass used by `waitForCsvArtifact` so failure callers can read
 * the download-side evidence (Playwright Download URL, suggestedFilename,
 * remote `failure()`, byte count, fallback source) without re-deriving it.
 */
class CsvArtifactError extends Error {
  readonly download: DownloadDiagnostics | null;
  constructor(message: string, download: DownloadDiagnostics | null) {
    super(message);
    this.name = "CsvArtifactError";
    this.download = download;
  }
}

type DriveExportResult = { kind: "artifact"; path: string } | { kind: "empty" } | { kind: "failed" };

export function isNoDataExportMessage(text: string): boolean {
  return EXPORT_NO_DATA_RE.test(text);
}

/**
 * Skip Adobe Analytics / SiteCatalyst beacon hosts when filtering candidate
 * response bodies. USAA tracks the "export" click as a pageName analytics
 * event, so the keyword `export` ends up in the URL query string of every
 * beacon hit — which was matching `CSV_DOWNLOAD_HINT_RE` and crowding the
 * real CSV endpoint out of the diagnostics candidate list when an export
 * actually failed. Beacons return `image/gif` and never carry the CSV body,
 * so excluding them costs us nothing.
 */
const ANALYTICS_HOST_RE = /^https?:\/\/(da|smetrics|tags|tms)\.usaa\.com\//iu;
const ANALYTICS_CONTENT_TYPE_RE = /image\/gif/iu;

function isAnalyticsBeacon(headers: Record<string, string>, url: string): boolean {
  if (ANALYTICS_HOST_RE.test(url)) {
    return true;
  }
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  return ANALYTICS_CONTENT_TYPE_RE.test(contentType);
}

function attachCsvResponseQueue(page: Page): BodyResponseQueue {
  return attachBodyResponseQueue(page, {
    isExpectedBody(body, headers) {
      if (body.length === 0) {
        return false;
      }
      const contentType = headers["content-type"]?.toLowerCase() ?? "";
      if (contentType.includes("text/html") || contentType.includes("application/json")) {
        return false;
      }
      const head = body.subarray(0, 2048).toString("utf8");
      return CSV_HEAD_RE.test(head) && head.includes(",");
    },
    shouldInspect(headers, url) {
      if (isAnalyticsBeacon(headers, url)) {
        return false;
      }
      const hint = `${headers["content-disposition"] ?? ""} ${headers["content-type"] ?? ""} ${url}`;
      return CSV_DOWNLOAD_HINT_RE.test(hint);
    },
  });
}

async function snapshotDownloadFailure(
  download: Pick<import("playwright").Download, "url" | "suggestedFilename" | "failure">
): Promise<DownloadDiagnostics> {
  const failure = await download.failure().catch((): null => null);
  let url: string | null;
  try {
    url = download.url();
  } catch {
    url = null;
  }
  let suggestedFilename: string | null;
  try {
    suggestedFilename = download.suggestedFilename();
  } catch {
    suggestedFilename = null;
  }
  return { url, suggestedFilename, downloadFailure: failure };
}

async function waitForCsvArtifact(
  downloadQueue: DownloadQueue,
  responseQueue: BodyResponseQueue
): Promise<{ buffer: Buffer; suggestedFilename: string | null }> {
  const responsePromise = responseQueue.waitForNextResponse({ timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const downloadPromise = downloadQueue.waitForNextDownload({ timeoutMs: DOWNLOAD_TIMEOUT_MS });
  const result = await Promise.any([
    responsePromise.then((response) => ({ kind: "response" as const, response })),
    downloadPromise.then((download) => ({ download, kind: "download" as const })),
  ]);
  if (result.kind === "response") {
    return { buffer: result.response.body, suggestedFilename: result.response.suggestedFilename };
  }
  const download = result.download;
  try {
    const { buffer, outcome } = await readPlaywrightDownloadBufferDetailed(download);
    if (buffer.length > 0) {
      return { buffer, suggestedFilename: download.suggestedFilename() };
    }
    // saveAs + createReadStream both produced zero bytes. Capture the
    // download-side evidence (URL, suggested filename, remote failure)
    // before falling through to the response-queue grace window.
    const baseDiag = await snapshotDownloadFailure(download);
    const downloadDiag: DownloadDiagnostics = {
      ...baseDiag,
      bytes: outcome.bytes,
      source: outcome.source,
      saveAsError: outcome.saveAsError ?? null,
      streamError: outcome.streamError ?? null,
    };
    const response = await waitForOptionalBodyResponse(responsePromise, RESPONSE_FALLBACK_GRACE_MS);
    if (response) {
      return { buffer: response.body, suggestedFilename: response.suggestedFilename };
    }
    throw new CsvArtifactError("download_empty", downloadDiag);
  } catch (err) {
    if (err instanceof CsvArtifactError) {
      throw err;
    }
    const baseDiag = await snapshotDownloadFailure(download).catch((): DownloadDiagnostics => ({}));
    const downloadDiag: DownloadDiagnostics = {
      ...baseDiag,
      bytes: 0,
      saveAsError: err instanceof Error ? err.message : String(err),
    };
    const response = await waitForOptionalBodyResponse(responsePromise, RESPONSE_FALLBACK_GRACE_MS);
    if (response) {
      return { buffer: response.body, suggestedFilename: response.suggestedFilename };
    }
    throw new CsvArtifactError(err instanceof Error ? err.message : String(err), downloadDiag);
  }
}

/** Submit the export dialog, race the downloadable artifact against an inline error. */
async function submitExportAndAwait(page: Page): Promise<ExportSubmitOutcome> {
  const downloadQueue = attachDownloadQueue(page);
  const responseQueue = attachCsvResponseQueue(page);
  await responseQueue.ready;

  const submit = page.locator('[role="dialog"] button[type="submit"]').first();
  try {
    await submit.click().catch((): undefined => undefined);

    const dialogMessage = page.locator(EXPORT_DIALOG_MESSAGE_SELECTOR).first();
    const errorPromise = page
      .locator(EXPORT_DIALOG_MESSAGE_SELECTOR)
      .first()
      .waitFor({ state: "visible", timeout: DOWNLOAD_TIMEOUT_MS })
      .then(async (): Promise<ExportSubmitOutcome> => {
        const message = ((await dialogMessage.textContent().catch((): string | null => null)) ?? "").trim();
        return isNoDataExportMessage(message) ? { kind: "empty", message } : { kind: "dialog_error", message };
      })
      .catch((): Promise<never> => new Promise((): void => undefined));

    return await Promise.race<ExportSubmitOutcome>([
      waitForCsvArtifact(downloadQueue, responseQueue).then(
        (artifact): ExportSubmitOutcome => ({
          buffer: artifact.buffer,
          kind: "artifact",
          suggestedFilename: artifact.suggestedFilename,
        })
      ),
      errorPromise,
    ]);
  } catch (err) {
    return {
      artifact: responseQueue.diagnostics(),
      download: err instanceof CsvArtifactError ? err.download : null,
      error: err instanceof Error ? err.message : String(err),
      kind: "artifact_failed",
    };
  } finally {
    downloadQueue.detach();
    responseQueue.detach();
  }
}

async function driveExport(page: Page, accountUrl: string, options: DriveExportOptions): Promise<DriveExportResult> {
  const { sinceDate, untilDate, onDiagnostics } = options;
  const located = await locateExportPage(page, accountUrl);
  if (!located) {
    await captureExportCheckpoint(page, options, "no-export-affordance");
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      onDiagnostics({ phase: "no_export_affordance", diag });
    }
    return { kind: "failed" };
  }

  const dialogOpen = await openExportDialog(page, located, onDiagnostics);
  if (!dialogOpen) {
    await captureExportCheckpoint(page, options, "dialog-not-open");
    return { kind: "failed" };
  }

  await fillExportDateRange(page, sinceDate, untilDate);
  await captureExportCheckpoint(page, options, "before-submit");

  const tempDir = mkdtempSync(join(tmpdir(), "usaa-export-"));
  const outcome = await submitExportAndAwait(page);
  if (outcome.kind === "empty" || outcome.kind === "dialog_error") {
    rmSync(tempDir, { recursive: true, force: true });
    await captureExportCheckpoint(page, options, outcome.kind === "empty" ? "source-empty" : "dialog-error");
    let dialogDiag: PageDiagnostics | null = null;
    if (outcome.kind === "dialog_error" && onDiagnostics) {
      dialogDiag = await capturePageDiagnostics(page);
    }
    await page
      .locator('[role="dialog"] #export-cancel-button')
      .click()
      .catch((): undefined => undefined);
    if (outcome.kind === "dialog_error" && onDiagnostics) {
      onDiagnostics({ diag: dialogDiag, error: outcome.message, phase: "export_dialog_error" });
    }
    return outcome.kind === "empty" ? { kind: "empty" } : { kind: "failed" };
  }
  if (outcome.kind === "artifact_failed") {
    rmSync(tempDir, { recursive: true, force: true });
    await captureExportCheckpoint(page, options, "artifact-failed");
    if (onDiagnostics) {
      const diag = await capturePageDiagnostics(page);
      onDiagnostics({
        artifact: outcome.artifact,
        diag,
        download: outcome.download,
        error: outcome.error,
        phase: "export_artifact_wait_failed",
      });
    }
    return { kind: "failed" };
  }
  const suggested = (outcome.suggestedFilename || "usaa-export.csv").replace(UNSAFE_FILENAME_RE, "_");
  const targetPath = join(tempDir, suggested);
  await writeFile(targetPath, outcome.buffer);
  return { kind: "artifact", path: targetPath };
}

// parseCsv + rowsToTransactions live in ./parsers.ts.

// ─── Stream orchestration helpers ────────────────────────────────────────

interface StatementsSubDeps extends EmitDeps {
  page: Page;
}

interface TransactionsStreamState {
  sessionDeadMidRun: boolean;
}

async function reauthAfterSessionLapse(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  accountName: string | null
): Promise<boolean> {
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `${accountName ?? "?"}: session lapsed — re-authenticating before retry`,
  });
  try {
    await ensureUsaaSession({ context, page, sendInteraction });
    return true;
  } catch (reauthErr) {
    const reauthMsg = reauthErr instanceof Error ? reauthErr.message : String(reauthErr);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "session_dead_reauth_failed",
      message: `USAA session expired mid-run and re-auth failed (${reauthMsg.slice(0, 120)}). Remaining accounts and statements skipped.`,
    });
    return false;
  }
}

interface ExportLadderResult {
  csvPath: string | null;
  exportEmpty: boolean;
  lastDiag: DiagnosticInfo | null;
  usedSince: string | null;
}

/** Try each candidate `sinceDate` in the ladder; stop on success or fatal diagnostic. */
interface LadderAttemptArgs {
  a: DashboardAccount;
  context: BrowserContext;
  deps: EmitDeps;
  onDiagnostics: (info: DiagnosticInfo) => void;
  onSessionDead: () => void;
  page: Page;
  sendInteraction: BrowserCollectContext["sendInteraction"];
  sinceDate: string;
  todayIso: string;
}

type AttemptOutcome =
  | { kind: "empty" }
  | { kind: "retry" }
  | { kind: "session_dead" }
  | { kind: "success"; csvPath: string };

function exportCaptureLabel(a: DashboardAccount, sinceDate: string, untilDate: string): string {
  const account = `${a.name ?? a.account_type}-${a.last_four ?? "unknown"}`;
  return `transaction-export-${account}-${sinceDate}-to-${untilDate}`;
}

/** Run one iteration of the backfill ladder: drive export + translate errors. */
async function runSingleLadderAttempt({
  deps,
  context,
  page,
  sendInteraction,
  a,
  sinceDate,
  todayIso,
  onDiagnostics,
  onSessionDead,
}: LadderAttemptArgs): Promise<AttemptOutcome> {
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `Export ${a.name ?? "?"} (${a.last_four || "n/a"}) from ${sinceDate} to ${todayIso}`,
  });
  try {
    const exportResult = await driveExport(page, `https://www.usaa.com${a.account_url}`, {
      sinceDate,
      untilDate: todayIso,
      accountType: a.account_type,
      capture: deps.capture ?? null,
      captureLabel: exportCaptureLabel(a, sinceDate, todayIso),
      onDiagnostics,
    });
    if (exportResult.kind === "artifact") {
      return { kind: "success", csvPath: exportResult.path };
    }
    return exportResult.kind === "empty" ? { kind: "empty" } : { kind: "retry" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "session_dead_redirect_to_logon") {
      const ok = await reauthAfterSessionLapse(deps, context, page, sendInteraction, a.name);
      if (ok) {
        return { kind: "retry" };
      }
      onSessionDead();
      return { kind: "session_dead" };
    }
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "export_error",
      message: `${a.name ?? "?"}: ${msg.slice(0, ID_TEXT_SNIP)}`,
    });
    return { kind: "retry" };
  }
}

function isFatalDiagPhase(diag: DiagnosticInfo | null): diag is DiagnosticInfo {
  return Boolean(diag && (diag.phase === "no_export_affordance" || diag.phase === "export_dialog_unexpected_shape"));
}

async function tryExportLadder(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  a: DashboardAccount,
  candidateStarts: readonly string[],
  todayIso: string,
  onSessionDead: () => void
): Promise<ExportLadderResult> {
  // Wrap in an object so TS tracks the mutation performed by the onDiagnostics
  // closure; a bare `let lastDiag` would narrow to `null` at read sites.
  const diagBox: { current: DiagnosticInfo | null } = { current: null };
  const onDiagnostics = (info: DiagnosticInfo): void => {
    diagBox.current = info;
  };
  for (const sinceDate of candidateStarts) {
    const outcome = await runSingleLadderAttempt({
      deps,
      context,
      page,
      sendInteraction,
      a,
      sinceDate,
      todayIso,
      onDiagnostics,
      onSessionDead,
    });
    if (outcome.kind === "session_dead") {
      return { csvPath: null, exportEmpty: false, usedSince: null, lastDiag: diagBox.current };
    }
    if (outcome.kind === "success") {
      return { csvPath: outcome.csvPath, exportEmpty: false, usedSince: sinceDate, lastDiag: diagBox.current };
    }
    if (outcome.kind === "empty") {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message: `${a.name ?? "?"}: no transactions to export for ${sinceDate} to ${todayIso}`,
      });
      return { csvPath: null, exportEmpty: true, usedSince: sinceDate, lastDiag: diagBox.current };
    }
    const diagNow = diagBox.current;
    if (diagNow) {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message: `${a.name ?? "?"}: ${formatDiagnosticInfo(diagNow)}`,
      });
    }
    if (isFatalDiagPhase(diagNow)) {
      await deps.emit({
        type: "PROGRESS",
        stream: "transactions",
        message: `${a.name ?? "?"}: ${diagNow.phase} — skipping retries`,
      });
      break;
    }
    await deps.emit({
      type: "PROGRESS",
      stream: "transactions",
      message: `retrying ${a.name ?? "?"} with shorter range`,
    });
  }
  return { csvPath: null, exportEmpty: false, usedSince: null, lastDiag: diagBox.current };
}

/** Parse the downloaded CSV, emit each transaction, return the latest date seen. */
async function emitCsvTransactions(
  deps: EmitDeps,
  csvPath: string,
  a: DashboardAccount,
  priorLastDate: string | null
): Promise<string | null> {
  const text = await readFile(csvPath, "utf8");
  const rows = parseCsv(text);
  const txnAccountId = a.account_id_raw || a.last_four || "unknown";
  const txns = rowsToTransactions(rows, {
    accountId: txnAccountId,
    accountName: a.name,
    fetchedAt: nowIso(),
  });
  let latest: string | null = priorLastDate;
  for (const t of txns) {
    await deps.emitRecord("transactions", t);
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
  return latest;
}

async function processAccountTransactions(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  a: DashboardAccount,
  priorLastDate: string | null,
  sinceDateCfg: string | undefined,
  seventeenMonthsAgo: string,
  streamState: TransactionsStreamState
): Promise<{ last_date: string | null } | null> {
  const desiredSince = priorLastDate
    ? new Date(Date.parse(priorLastDate) - INCREMENTAL_OVERLAP_MS).toISOString().slice(0, 10)
    : (sinceDateCfg ?? seventeenMonthsAgo);
  const todayIso = new Date().toISOString().slice(0, 10);
  const candidateStarts = buildCandidateStarts(desiredSince);

  const { csvPath, exportEmpty, usedSince, lastDiag } = await tryExportLadder(
    deps,
    context,
    page,
    sendInteraction,
    a,
    candidateStarts,
    todayIso,
    () => {
      streamState.sessionDeadMidRun = true;
    }
  );
  if (streamState.sessionDeadMidRun) {
    return null;
  }
  if (!csvPath) {
    if (exportEmpty) {
      return { last_date: priorLastDate || usedSince || null };
    }
    await emitExportFailure(deps, a, lastDiag);
    return null;
  }
  const latest = await emitCsvTransactions(deps, csvPath, a, priorLastDate);
  return { last_date: latest || usedSince || null };
}

async function runTransactionsStream(
  deps: EmitDeps,
  context: BrowserContext,
  page: Page,
  sendInteraction: BrowserCollectContext["sendInteraction"],
  accounts: readonly DashboardAccount[],
  state: Record<string, unknown>,
  requested: BrowserCollectContext["requested"],
  streamState: TransactionsStreamState
): Promise<void> {
  const stream = requested.get("transactions");
  const sinceDateCfg = stream?.time_range?.since?.slice(0, 10);
  const seventeenMonthsAgo = new Date(Date.now() - BACKFILL_17MO).toISOString().slice(0, 10);

  const priorStateForTxns = (state.transactions as TransactionsPriorState | undefined) ?? {};
  const transactionsCursor: TransactionsStreamCursor = { ...priorStateForTxns };

  for (const a of accounts) {
    if (streamState.sessionDeadMidRun) {
      break;
    }
    if (!TRANSACTION_ACCOUNT_TYPE_RE.test(a.account_type)) {
      continue;
    }
    const accountKey = a.account_id_raw || "";
    const perAccState = priorStateForTxns[accountKey];
    const priorLastDate = perAccState?.last_date ?? null;
    const updated = await processAccountTransactions(
      deps,
      context,
      page,
      sendInteraction,
      a,
      priorLastDate,
      sinceDateCfg,
      seventeenMonthsAgo,
      streamState
    );
    if (!updated) {
      continue;
    }
    transactionsCursor[accountKey || a.last_four || "unknown"] = updated;
    await deps.emit({
      type: "STATE",
      stream: "transactions",
      cursor: transactionsCursor,
    });
  }
}

// ─── Statements stream helpers ──────────────────────────────────────────

function scrapeStatementsIndex(page: Page): Promise<DocRow[]> {
  return page.evaluate((): DocRow[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const WS_RE = /\s+/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    interface El {
      innerText?: string;
      querySelectorAll: (s: string) => El[];
    }

    const t = document.querySelector("table") as El | null;
    if (!t) {
      return [];
    }
    return [...t.querySelectorAll("tbody tr")].map((tr: El, rowIndex: number) => {
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
    });
  });
}

async function hydratePdfsForIndex(deps: StatementsSubDeps, indexRows: readonly IndexRow[]): Promise<HydrationSummary> {
  const results = new Map<number, HydrationResult>();
  let attempts = 0;
  let successes = 0;

  try {
    const hydrated = await hydrateStatementPdfs({
      page: deps.page,
      statements: indexRows as IndexRow[],
      onProgress: ({ index, total, title }) => {
        attempts = index + 1;
        // Fire-and-forget: hydrateStatementPdfs signature is sync callback.
        // Swallowing the promise keeps the emit ordering best-effort; a
        // failed write would be caught by the outer try/catch on next await.
        deps
          .emit({
            type: "PROGRESS",
            stream: "statements",
            message: `Downloading PDF ${index + 1}/${total}: ${(title ?? "").slice(0, 60)}`,
          })
          .catch((): undefined => undefined);
      },
      onSkip: ({ statement, reason, diag }) => {
        results.set(statement.rowIndex, { err: reason, diag });
        deps
          .emit({
            type: "SKIP_RESULT",
            stream: "statements",
            reason: `pdf_download_${reason}`,
            message: `${statement.title ?? "?"}: ${reason}`,
            diagnostics: diag,
          })
          .catch((): undefined => undefined);
      },
    });
    for (const h of hydrated) {
      successes++;
      results.set(h.statement.rowIndex, {
        pdfPath: h.pdfPath,
        pdfSha256: h.pdfSha256,
        buffer: h.buffer,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "hydrate_crashed",
      message: msg.slice(0, ID_TEXT_SNIP),
    });
  }
  return { attempts, successes, results };
}

interface PdfParseCounters {
  parsedStatements: number;
  pdfTxnCount: number;
  unknownTemplates: number;
}

async function processPdfStatementRow(
  deps: EmitDeps,
  row: IndexRow,
  ok: HydrationResultSuccess,
  accountById: Map<string, DashboardAccount>,
  counters: PdfParseCounters
): Promise<void> {
  const title = row.title || "";
  if (!shouldParseStatementTitle(title)) {
    return;
  }
  const period = (row.date_delivered || "").slice(0, 7) || null;
  const acct = row.account_id ? accountById.get(row.account_id) : null;
  const accountName = acct?.name ?? row.account_reference ?? null;
  try {
    const { txns, parseMeta } = await parsePdfStatement({
      buffer: ok.buffer,
      accountId: row.account_id || row.account_reference || "unknown",
      accountName,
      period,
    });
    if (!txns.length) {
      counters.unknownTemplates++;
      await deps.emit({
        type: "SKIP_RESULT",
        stream: "transactions",
        reason: "pdf_template_unknown",
        message: `${row.title ?? "?"} (${period ?? "unknown"}): no parser matched (era=${parseMeta.era})`,
        diagnostics: {
          statement_id: row.id,
          year: parseMeta.year,
          raw_text_sample: "rawTextSample" in parseMeta ? parseMeta.rawTextSample : null,
        },
      });
      return;
    }
    for (const t of txns) {
      await deps.emitRecord("transactions", { ...t });
      counters.pdfTxnCount++;
    }
    counters.parsedStatements++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "transactions",
      reason: "pdf_parse_failed",
      message: `${row.title ?? "?"}: ${msg.slice(0, ID_TEXT_SNIP)}`,
    });
  }
}

async function emitPdfStatementTransactions(
  deps: EmitDeps,
  indexRows: readonly IndexRow[],
  hydrationResults: Map<number, HydrationResult>,
  accounts: readonly DashboardAccount[]
): Promise<void> {
  const accountById = new Map<string, DashboardAccount>(
    accounts
      .filter((a): a is DashboardAccount & { account_id_raw: string } => Boolean(a.account_id_raw))
      .map((a) => [a.account_id_raw, a])
  );
  const counters: PdfParseCounters = { pdfTxnCount: 0, parsedStatements: 0, unknownTemplates: 0 };
  for (const row of indexRows) {
    const ok = hydrationSuccess(hydrationResults.get(row.rowIndex));
    if (!ok) {
      continue;
    }
    await processPdfStatementRow(deps, row, ok, accountById, counters);
  }
  await deps.emit({
    type: "PROGRESS",
    stream: "transactions",
    message: `PDF parse: ${counters.pdfTxnCount} txns across ${counters.parsedStatements} statements (${counters.unknownTemplates} unknown templates)`,
  });
}

async function runStatementsStream(
  deps: StatementsSubDeps,
  accounts: readonly DashboardAccount[],
  requested: BrowserCollectContext["requested"],
  statementsFingerprintCursor?: FingerprintCursor
): Promise<void> {
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "statements",
      message: "Fetching statements index",
    });
    await deps.page.goto("https://www.usaa.com/my/documents", {
      waitUntil: "domcontentloaded",
      timeout: DOCUMENTS_NAV_TIMEOUT_MS,
    });
    await politeDelay(DOCUMENTS_SETTLE_DELAY_MS);

    const docs = await scrapeStatementsIndex(deps.page);
    const indexRows = buildIndexRows(docs, accounts);
    const summary = await hydratePdfsForIndex(deps, indexRows);

    if (requested.has("statements")) {
      await emitStatementRecords(deps, indexRows, summary.results, summary, statementsFingerprintCursor);
    }
    if (requested.has("transactions")) {
      await emitPdfStatementTransactions(deps, indexRows, summary.results, accounts);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "statements",
      reason: "scrape_failed",
      message: msg.slice(0, ID_TEXT_SNIP),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: msg.slice(0, ID_TEXT_SNIP),
      },
    });
  }
}

// ─── Inbox stream ───────────────────────────────────────────────────────

function scrapeInboxRows(page: Page): Promise<InboxRow[]> {
  return page.evaluate((): InboxRow[] => {
    // biome-ignore-start lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.
    const WS_RE = /\s+/g;
    // biome-ignore-end lint/performance/useTopLevelRegex: runs in browser context (page.evaluate); module-scoped regexes in Node cannot cross the bridge.

    interface El {
      innerText?: string;
      querySelectorAll: (s: string) => El[];
    }

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
}

async function runInboxStream(deps: EmitDeps, page: Page): Promise<void> {
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "inbox_messages",
      message: "Fetching inbox",
    });
    await page.goto("https://www.usaa.com/my/inbox", {
      waitUntil: "domcontentloaded",
      timeout: INBOX_NAV_TIMEOUT_MS,
    });
    await politeDelay(DOCUMENTS_SETTLE_DELAY_MS);
    const msgs = await scrapeInboxRows(page);
    const year = new Date().getFullYear();
    for (const m of msgs) {
      const record = buildInboxMessageRecord(m, year, nowIso());
      if (!record) {
        continue;
      }
      await deps.emitRecord("inbox_messages", record);
    }
    await deps.emit({
      type: "STATE",
      stream: "inbox_messages",
      cursor: { fetched_at: nowIso() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "inbox_messages",
      reason: "scrape_failed",
      message: msg.slice(0, ID_TEXT_SNIP),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: msg.slice(0, ID_TEXT_SNIP),
      },
    });
  }
}

// ─── Credit-card billing stream ─────────────────────────────────────────

function scrapeCreditCardBilling(page: Page): Promise<BillingKv> {
  return page.evaluate((): BillingKv => {
    interface El {
      innerText?: string;
      nextElementSibling?: El | null;
    }
    const kv: BillingKv = {};
    const labels = [...document.querySelectorAll("dt, .label, .field-label")] as El[];
    for (const el of labels) {
      const label = (el.innerText || "").trim();
      const value = (el.nextElementSibling?.innerText || "").trim();
      if (label && value && !kv[label]) {
        kv[label] = value;
      }
    }
    return kv;
  });
}

async function runCreditCardBillingStream(
  deps: EmitDeps,
  page: Page,
  accounts: readonly DashboardAccount[]
): Promise<void> {
  try {
    await deps.emit({
      type: "PROGRESS",
      stream: "credit_card_billing",
      message: "Fetching credit card billing details",
    });
    const cards = accounts.filter((a) => CREDIT_CARD_TYPE_RE.test(a.account_type));
    for (const a of cards) {
      await page
        .goto(`https://www.usaa.com${a.account_url}`, {
          waitUntil: "domcontentloaded",
          timeout: ACCOUNT_NAV_TIMEOUT_MS,
        })
        .catch((): undefined => undefined);
      await politeDelay(CC_SETTLE_DELAY_MS);
      const billing = await scrapeCreditCardBilling(page);
      await deps.emitRecord("credit_card_billing", buildCreditCardBillingRecord(a, billing, nowIso()));
    }
    await deps.emit({
      type: "STATE",
      stream: "credit_card_billing",
      cursor: { fetched_at: nowIso() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.emit({
      type: "SKIP_RESULT",
      stream: "credit_card_billing",
      reason: "scrape_failed",
      message: msg.slice(0, ID_TEXT_SNIP),
      diagnostics: {
        error_class: err instanceof Error ? err.constructor.name : "unknown",
        message: msg.slice(0, ID_TEXT_SNIP),
      },
    });
  }
}

// ─── Connector entry point ────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/usaa/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "usaa",
    validateRecord,
    // USAA rejects headless Chromium before the login form loads
    // (`net::ERR_HTTP2_PROTOCOL_ERROR`), while headed Chrome loads it.
    // Allow explicit headless probes with PDPP_USAA_HEADLESS=1.
    browser: { profileName: "usaa", headless: process.env.PDPP_USAA_HEADLESS === "1" },
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
      const { state, requested, context, page, emit, emitRecord, progress, capture, sendInteraction, emittedAt } = ctx;
      const deps: EmitDeps = { capture, emit, emitRecord };

      // ACCOUNTS — extract from dashboard; emit optionally based on requested.
      await progress("Extracting accounts from dashboard");
      if (capture) {
        await capture.captureDom(page, "dashboard-accounts");
      }
      const accounts = await extractAccounts(page);
      await progress(`Found ${accounts.length} account(s)`);

      if (requested.has("accounts")) {
        await emitAccountsStream(deps, accounts, emittedAt);
      }

      // Signal raised by the transactions loop when a page redirects to
      // /my/logon mid-run — meaning USAA's session has lapsed.
      const streamState: TransactionsStreamState = { sessionDeadMidRun: false };

      // TRANSACTIONS — drive Export per account where applicable.
      if (requested.has("transactions")) {
        await runTransactionsStream(deps, context, page, sendInteraction, accounts, state, requested, streamState);
      }

      // STATEMENTS — scrape /my/documents + hydrate PDFs + (optionally) parse txns.
      // Per-statement fingerprint cursor (excludes the run-clock `fetched_at`)
      // so unchanged statements stop appending a new version every run. Only
      // opened when `statements` is requested; a transactions-only run does
      // not touch the statements STATE.
      if ((requested.has("statements") || requested.has("transactions")) && !streamState.sessionDeadMidRun) {
        const statementsFingerprintCursor = requested.has("statements")
          ? openFingerprintCursor(state.statements, {
              excludeFromFingerprint: ["fetched_at"],
              priorFingerprints: readPriorStatementFingerprints(state),
            })
          : undefined;
        await runStatementsStream({ ...deps, page }, accounts, requested, statementsFingerprintCursor);
      }

      // INBOX_MESSAGES — scrape /my/inbox.
      if (requested.has("inbox_messages") && !streamState.sessionDeadMidRun) {
        await runInboxStream(deps, page);
      }

      // CREDIT_CARD_BILLING — one record per credit-card account.
      if (requested.has("credit_card_billing") && !streamState.sessionDeadMidRun) {
        await runCreditCardBillingStream(deps, page, accounts);
      }

      await emitDeferredStreams(emit, requested);

      if (streamState.sessionDeadMidRun) {
        throw new Error("usaa session expired mid-run; re-run with fresh auth to complete");
      }
    },
  });
}
