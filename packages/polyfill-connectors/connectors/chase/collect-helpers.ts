/**
 * Collect-layer helpers for the Chase connector.
 *
 * Lives in its own file (not index.ts) because index.ts calls
 * `runConnector({...})` at module load — importing it in a test keeps
 * the Node event loop alive waiting for the stdin protocol. This file
 * contains only Playwright-free helpers: the per-stream emit functions
 * and the pure scope/time-range filters. Page-bound helpers
 * (processAccountDownload / processStatementRow) stay in index.ts since
 * they orchestrate browser I/O and aren't meaningfully testable without
 * a driver.
 *
 * The helpers here are the "emit path" seams:
 *   emitAccountsStream           — per-run: one record per filtered account.
 *   emitTransactionsForAccount   — per-account: one record per QFX tx, plus
 *                                  max_seen_date cursor maintenance.
 *   emitStatementIndexOnly       — PDF-download fallback: index row only.
 *   filterAccountsByScope        — res-filter picker (accounts | transactions
 *                                  | balances) + narrowed account list.
 *   statementRowOutsideTimeRange — pure time_range gate for statement rows.
 */

import type { BrowserCollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import type { extractFromQfx } from "./parsers.ts";
import type { ActivityKind, ChaseAccount, StatementRow, TransactionCursor, TransactionsStateShape } from "./types.ts";

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
    resFilters.get("accounts") ?? resFilters.get("transactions") ?? resFilters.get("balances") ?? null;
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
