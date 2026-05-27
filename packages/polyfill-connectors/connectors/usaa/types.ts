// Parsed shapes and emit records for the USAA connector. Extracted from
// index.ts so parsers.ts and tests can import them without pulling in the
// Playwright-flavored runtime entry.

import type { Locator } from "playwright";
import type { RecordData } from "../../src/connector-runtime.ts";
import type { DownloadQueue } from "../../src/download-queue.ts";

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
  available_balance_cents: number | null;
  balance_cents: number | null;
  fetched_at: string;
  id: string;
  last_four: string | null;
  name: string | null;
  status: "open";
  type: string;
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
  pdf_path: string | null;
  pdf_sha256: string | null;
  title: string | null;
}

export interface CreditCardBillingRecord extends RecordData {
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

export interface DiagnosticInfo {
  diag: PageDiagnostics | null;
  error?: string;
  phase: string;
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

export interface TransactionsStreamCursor {
  [accountKey: string]: { last_date: string | null } | undefined;
}

export interface TransactionsPriorState {
  [accountKey: string]: { last_date: string | null } | undefined;
}

// ─── Export driver ───────────────────────────────────────────────────────

export interface DriveExportOptions {
  accountType?: string;
  downloadQueue: DownloadQueue;
  onDiagnostics?: (info: DiagnosticInfo) => void;
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
  pdfPath: string;
  pdfSha256: string;
  statement: StatementRow;
  suggestedFilename: string;
}
