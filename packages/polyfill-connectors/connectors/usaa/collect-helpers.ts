/**
 * Collect-layer helpers for the USAA connector.
 *
 * Lives in its own file (not index.ts) because index.ts calls
 * `runConnector({...})` at module load — importing it from test code
 * would open stdin and keep the Node event loop alive forever.
 *
 * This file contains only Playwright-free helpers: the per-stream emit
 * paths and the pure filters. Page-bound helpers (driveExport,
 * runStatementsStream, runInboxStream, runCreditCardBillingStream)
 * stay in index.ts since they orchestrate browser I/O and aren't
 * meaningfully testable without a driver.
 *
 * The helpers here are the "emit path" seams:
 *   emitAccountsStream        — per-run: one record per account + STATE.
 *   emitDeferredStreams       — SKIP_RESULT for every requested-but-
 *                               unimplemented stream.
 *   emitExportFailure         — SKIP_RESULT when the backfill ladder
 *                               exhausts with no download.
 *   emitStatementRecords      — per-row: hydrated or index-only fallback.
 *   buildIndexRows            — pure statement-doc row → IndexRow.
 *   hydrationSuccess          — narrow HydrationResult to the ok branch.
 *   shouldParseStatementTitle — pure title-filter for PDF parse pass.
 */

import { type BrowserCollectContext, type EmittedMessage, nowIso } from "../../src/connector-runtime.ts";
import { buildAccountRecord, hashId, isoDate, resolveAccountIdForRef } from "./parsers.ts";
import { fileUrlForPath } from "./statement-pdfs.ts";
import type {
  DashboardAccount,
  DiagnosticInfo,
  DocRow,
  HydrationResult,
  HydrationResultSuccess,
  IndexRow,
  StatementRecord,
} from "./types.ts";

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type RequestedScopes = BrowserCollectContext["requested"];

// Module-scope regexes (Biome useTopLevelRegex).
const CREDIT_CARD_TYPE_RE = /credit-card/;
const STATEMENT_TITLE_RE = /STATEMENT/i;
const NON_STATEMENT_TITLE_RE = /(TERMS\b|AGREEMENT\b|NOTICE\b|DISCLOSURE\b|CONDITION)/i;

/** Per-run dependency bag for the emit-path helpers. */
export interface EmitDeps {
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
    .map((d) => ({
      rowIndex: d.rowIndex,
      id: hashId(`${d.account_reference}|${d.date_delivered}|${d.title}`),
      account_id: resolveAccountIdForRef(d.account_reference, accounts),
      title: d.title,
      date_delivered: isoDate(d.date_delivered),
      account_reference: d.account_reference,
    }));
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
 * start — either the dialog shape shifted or the account has no
 * transactions in any supported window.
 */
export async function emitExportFailure(
  deps: EmitDeps,
  a: DashboardAccount,
  lastDiag: DiagnosticInfo | null
): Promise<void> {
  const isCreditCard = CREDIT_CARD_TYPE_RE.test(a.account_type);
  const baseMessage = lastDiag
    ? `${a.name ?? "?"}: ${lastDiag.phase} at ${lastDiag.diag?.url ?? "unknown url"}`
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
  summary: HydrationSummary
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
    await deps.emitRecord("statements", rec);
  }
  await deps.emit({
    type: "PROGRESS",
    stream: "statements",
    message: `Hydrated ${summary.successes}/${summary.attempts || indexRows.length} PDFs`,
  });
  await deps.emit({
    type: "STATE",
    stream: "statements",
    cursor: { fetched_at: nowIso() },
  });
}
