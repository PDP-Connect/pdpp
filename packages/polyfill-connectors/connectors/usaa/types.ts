// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes and emit records for the USAA connector. Extracted from
// index.ts so parsers.ts and tests can import them without pulling in the
// Playwright-flavored runtime entry.

import type { Locator } from "playwright";
import type { BodyResponseDiagnostics } from "../../src/browser-artifact-response.ts";
import type { BrowserSurfaceDiagnostic, BrowserSurfaceRoute } from "../../src/browser-surface-diagnostic.ts";
import type { RecordData } from "../../src/connector-runtime.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import type { StatementContentFingerprint } from "../../src/statement-content-fingerprint.ts";

// ─── Statements index row ────────────────────────────────────────────────

/** Per-row input to hydrateStatementPdfs. */
export interface StatementRow {
  account_id: string | null;
  account_reference?: string | null;
  date_delivered: string | null;
  id: string;
  rowIndex: number;
  title: string | null;
}

// ─── Dashboard / account extraction ──────────────────────────────────────

export interface DashboardAccount {
  account_id_raw: string | null;
  account_type: string;
  account_url: string;
  balance_cents: number | null;
  last_four: string | null;
  name: string | null;
  raw_text: string;
}

// ─── Emitted records ─────────────────────────────────────────────────────

export interface AccountRecord extends RecordData {
  fetched_at: string;
  id: string;
  last_four: string | null;
  name: string | null;
  status: "open";
  type: string;
}

/**
 * Family-2 observation record: a daily balance snapshot for one account,
 * keyed `{account_id}:{observed_on}` so repeated same-day pulls are
 * idempotent and daily balance history is preserved. The point-in-time
 * balance fields live here, not on `AccountRecord`, so a balance tick no
 * longer versions the entity record.
 */
export interface AccountStatsRecord extends RecordData {
  account_id: string;
  available_balance_cents: number | null;
  balance_cents: number | null;
  id: string;
  observed_on: string;
}

export interface TransactionRecord extends RecordData {
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

export interface InboxMessageRecord extends RecordData {
  date_received: string | null;
  fetched_at: string;
  id: string;
  preview: string;
  status: "unread" | "read";
  subject: string;
}

export interface StatementRecord extends RecordData {
  account_id: string | null;
  account_reference: string | null;
  date_delivered: string | null;
  document_url: string | null;
  fetched_at: string;
  id: string;
  pdf_page_count: number | null;
  pdf_path: string | null;
  pdf_sha256: string | null;
  pdf_text_sha256: string | null;
  title: string | null;
}

export interface CreditCardBillingRecord extends RecordData {
  account_id: string | null;
  account_nickname: string | null;
  annual_percent_rate: string | null;
  card_holders: string | null;
  cash_advance_apr: string | null;
  credit_limit_cents: number | null;
  fetched_at: string;
  id: string;
}

/**
 * Family-2 observation record: the per-cycle volatile financial state for
 * one credit card, keyed `{card_id}:{observed_on}`. Current balance,
 * available credit, accrued rewards, and the cycle billing-status flip live
 * here so they no longer version the `credit_card_billing` entity record.
 * Stable settings (`credit_limit_cents`, APRs, nickname, card holders) stay
 * on the entity — see design.md for the classification rationale.
 */
export interface CreditCardBillingStatsRecord extends RecordData {
  account_id: string | null;
  available_credit_cents: number | null;
  billing_status: string | null;
  card_id: string;
  cash_rewards_cents: number | null;
  current_balance_cents: number | null;
  id: string;
  minimum_payment_met: boolean;
  observed_on: string;
}

// ─── Diagnostics (live-page drift detection) ─────────────────────────────

export interface DiagnosticCandidate {
  cls: string;
  id: string | null;
  tag: string;
  text: string;
}

export interface PageDiagnostics {
  dialog_html_preview?: string | null;
  dialogs_open: number;
  export_candidates: DiagnosticCandidate[];
  has_utility_bar: boolean;
  nav_candidates: DiagnosticCandidate[];
  title: string;
  url: string;
}

/**
 * What `download.saveAs()` + the createReadStream fallback actually
 * produced when the export artifact arrived. Lets `download_empty`-style
 * failures carry forensic detail (URL, suggested filename, byte count,
 * remote-failure reason) into the timeline instead of disappearing into
 * the analytics-noise candidate list.
 */
export interface DownloadDiagnostics {
  bytes?: number | null;
  downloadFailure?: string | null;
  saveAsError?: string | null;
  source?: "dataUrl" | "saveAs" | "createReadStream" | null;
  streamError?: string | null;
  suggestedFilename?: string | null;
  url?: string | null;
}

export interface DiagnosticInfo {
  artifact?: BodyResponseDiagnostics | null;
  browser_surface?: BrowserSurfaceDiagnostic;
  diag: PageDiagnostics | null;
  download?: DownloadDiagnostics | null;
  error?: string;
  no_export_observation?: NoExportAffordanceObservation;
  phase: string;
}

/** Closed facts collected only for the no-export terminal diagnostic. */
export interface NoExportAffordanceObservation {
  account_detail_marker_count: number;
  navigation_marker_count: number;
  route: BrowserSurfaceRoute;
  target_count: number;
  transaction_marker_count: number;
}

// ─── Statements index rows ───────────────────────────────────────────────

export interface DocRow {
  account_reference: string;
  date_delivered: string;
  rowIndex: number;
  title: string;
}

export interface IndexRow extends StatementRow {
  account_id: string | null;
  account_reference: string | null;
  date_delivered: string | null;
  id: string;
  rowIndex: number;
  title: string;
}

// ─── PDF hydration result (discriminated union) ──────────────────────────

export interface HydrationResultSuccess {
  buffer: Buffer;
  content: StatementContentFingerprint;
  pdfPath: string;
  pdfSha256: string;
}

export interface HydrationResultError {
  diag?: Record<string, unknown> | null;
  err: string;
}

export type HydrationResult = HydrationResultSuccess | HydrationResultError;

// ─── Inbox / billing parsed rows ─────────────────────────────────────────

export interface InboxRow {
  date_short: string;
  preview: string;
  status: string;
}

export interface BillingKv {
  [label: string]: string | undefined;
}

// ─── State / cursor ──────────────────────────────────────────────────────

/** Per-account incremental watermark entry in the transactions cursor. */
export interface TransactionsAccountCursor {
  last_date: string | null;
}

/** The transactions STATE cursor is a flat map of `accountKey ->
 *  { last_date }`, plus a reserved `fingerprints` key carrying the
 *  per-transaction fingerprint map (keyed by the record `id`
 *  `hashId(accountId|date|amount|original|#ord)`). `fingerprints` is read
 *  and written through casts at the boundary so the per-account index
 *  signature stays a clean `{ last_date }` for the incremental loop —
 *  mirroring how chase keeps `per_account` separate from `fingerprints`. */
export interface TransactionsStreamCursor {
  [accountKey: string]: TransactionsAccountCursor | undefined;
}

export interface TransactionsPriorState {
  [accountKey: string]: TransactionsAccountCursor | undefined;
}

// ─── Export driver ───────────────────────────────────────────────────────

export interface DriveExportOptions {
  accountType?: string;
  capture?: CaptureSession | null;
  captureLabel?: string;
  onDiagnostics?: (info: DiagnosticInfo) => void;
  /** Test-only override; production uses the verified account-settle delay. */
  settleDelayMs?: number;
  sinceDate: string;
  untilDate: string;
}

export interface LocatedExportPage {
  export: Locator;
  url: string;
}

// ─── Statement-PDF parser shapes ─────────────────────────────────────────

/** Closing context for toIso year-assignment. Bare number = legacy year-only. */
export type ClosingContext = number | { closingMonth: number; closingYear: number } | null | undefined;

/** Closing month + year extracted from a statement PDF's header text. */
export interface StatementClosing {
  closingMonth: number;
  closingYear: number;
}

/** One transaction parsed from a statement PDF, pre-record-shape. */
export interface ParsedStatementTxn {
  amount: number;
  balance: number | null;
  description: string;
  iso: string;
  ord: number;
  tupleKey: string;
}

/** Full transaction record emitted from a statement PDF. */
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

// ─── Statement-PDF download driver ───────────────────────────────────────

export interface DownloadOk {
  buffer: Buffer;
  ok: true;
  suggestedFilename: string;
}

export interface DownloadFail {
  diag?: Record<string, unknown> | null;
  ok: false;
  reason: string;
}

export type DownloadResult = DownloadOk | DownloadFail;

export interface HydratedStatement {
  buffer: Buffer;
  content: StatementContentFingerprint;
  pdfPath: string;
  pdfSha256: string;
  statement: StatementRow;
  suggestedFilename: string;
}
