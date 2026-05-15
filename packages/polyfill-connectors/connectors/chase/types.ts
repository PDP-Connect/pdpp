// Parsed shapes for the Chase connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry.

export type ChaseAccountType = "credit_card" | "checking" | "savings" | "unknown";

export interface ChaseAccount {
  internal_id: string;
  last_four: string | null;
  name: string;
  type: ChaseAccountType;
}

export type ActivityKind = "all" | "since_last_statement" | "year_to_date" | "last_year" | "current" | "date_range";

export interface DateRange {
  from?: string | undefined;
  to?: string | undefined;
}

export interface DownloadOptions {
  activity?: ActivityKind;
  dateRange?: DateRange;
}

export interface DownloadSuccess {
  activity: ActivityKind;
  downloaded: true;
  qfxPath: string;
}

export interface DownloadFailure {
  downloaded: false;
  error: string;
}

export interface DownloadNoActivity {
  activity: ActivityKind;
  noActivity: true;
}

export type DownloadResult = DownloadSuccess | DownloadFailure | DownloadNoActivity;

export interface DateFillOk {
  ok: true;
}

export interface DateFillErr {
  error: string;
  ok: false;
}

export type DateFillResult = DateFillOk | DateFillErr;

export interface StatementRow {
  account_reference: string | null;
  date_delivered_raw: string;
  doc_kind: string;
  rowAnchorId: string;
  rowIdx: string | undefined;
  tableIdx: string | undefined;
  title: string;
}

export interface StatementDownloadOk {
  ok: true;
  pdfPath: string;
  pdfSha256: string;
}

export interface StatementDownloadErr {
  error: string;
  ok: false;
}

export type StatementDownloadResult = StatementDownloadOk | StatementDownloadErr;

export interface QfxTransaction {
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

export interface QfxBalance {
  as_of: string;
  available_cents: number | null;
  ledger_cents: number | null;
}

export interface QfxExtracted {
  balance: QfxBalance | null;
  transactions: QfxTransaction[];
}

export type CurrentActivityStatus = "pending" | "posted" | "unknown";

export interface CurrentActivityRow {
  activity_date: string;
  amount_cents: number;
  description: string;
  memo: string | null;
  posted_date: string | null;
  status: CurrentActivityStatus;
  ui_transaction_id: string | null;
}

export interface DashboardDiagnostics {
  body_preview: string;
  title: string;
  url: string;
}

export interface TransactionCursor {
  last_activity?: string;
  last_fetched_at?: string;
  max_seen_date?: string | null;
}

export interface TransactionsStateShape {
  per_account?: Record<string, TransactionCursor | undefined>;
}

export interface ActivityChoice {
  activity: ActivityKind;
  dateRange?: DateRange;
}

// OFX parser output is deeply nested, loosely typed, and varies by ofx-js
// version. We model only what we read as nested `unknown`-backed objects.
export type OfxValue = unknown;
export type OfxRecord = Record<string, OfxValue>;
