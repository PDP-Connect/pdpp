#!/usr/bin/env node

/**
 * PDPP YNAB Connector (v0.2.0)
 *
 * Polyfills YNAB's v1 API into the PDPP Collection Profile. Reads
 * YNAB_PERSONAL_ACCESS_TOKEN or YNAB_PAT from the environment. Emits RECORD/STATE/DONE
 * messages over stdout; reads START from stdin.
 *
 * Streams:
 *   budgets, accounts, category_groups, categories, payees, payee_locations,
 *   transactions, scheduled_transactions, months, month_categories
 *
 * State shape:
 *   {
 *     budgets:                { fetched_at?: string },
 *     accounts:               { [budget_id]: { server_knowledge } },
 *     categories:             { [budget_id]: { server_knowledge } },
 *     payees:                 { [budget_id]: { server_knowledge } },
 *     transactions:           { [budget_id]: { server_knowledge, since_date? } },
 *     scheduled_transactions: { [budget_id]: { server_knowledge } },
 *     months:                 { [budget_id]: { server_knowledge } },
 *     month_categories:       { [budget_id]: { last_fetched_month?: string } },
 *   }
 *
 * Rate limit: 200 req/hour per token. A typical run is ~7×budgets requests,
 * plus one request per month walked when `month_categories` is in scope
 * (historical months are frozen; incremental runs only refetch the current
 * and most-recent month).
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  type CollectContext,
  emitDetailCoverage,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { unauditedConservativePacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API_BASE = "https://api.ynab.com/v1";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical to the prior hand-rolled path (cross-run cooldown via
// `retryablePattern`); raising it activates the wired Retry-After honor.
// §3 ProviderProfile: ynab declares its own pacing ceiling — a conservative,
// UNAUDITED placeholder (NOT a borrow of ChatGPT's 250ms). Replace with ynab's
// real observed flagging threshold once audited (task 1b).
const httpGovernor = createConnectorHttpGovernor({
  name: "ynab",
  maxAttempts: 1,
  profile: unauditedConservativePacingProfile(),
});

interface YnabFetchOptions {
  knowledge?: number;
  sinceDate?: string;
}

interface YnabBudget {
  currency_format?: {
    iso_code?: string | null;
    currency_symbol?: string | null;
    symbol_first?: boolean | null;
    decimal_digits?: number | null;
    decimal_separator?: string | null;
    group_separator?: string | null;
  } | null;
  date_format?: { format?: string | null } | null;
  first_month?: string | null;
  id: string;
  last_modified_on?: string | null;
  last_month?: string | null;
  name: string;
}

interface YnabAccount {
  balance: number;
  cleared_balance: number;
  closed: boolean;
  debt_escrow_amounts?: Record<string, unknown> | null;
  debt_interest_rates?: Record<string, unknown> | null;
  debt_minimum_payments?: Record<string, unknown> | null;
  deleted: boolean;
  direct_import_in_error?: boolean | null;
  direct_import_linked?: boolean | null;
  id: string;
  last_reconciled_at?: string | null;
  name: string;
  note?: string | null;
  on_budget: boolean;
  transfer_payee_id?: string | null;
  type: string;
  uncleared_balance: number;
}

interface YnabCategory {
  activity: number;
  balance: number;
  budgeted: number;
  category_group_id?: string | null;
  category_group_name?: string | null;
  deleted: boolean;
  goal_cadence?: number | null;
  goal_cadence_frequency?: number | null;
  goal_creation_month?: string | null;
  goal_day?: number | null;
  goal_months_to_budget?: number | null;
  goal_needs_whole_amount?: boolean | null;
  goal_overall_funded?: number | null;
  goal_overall_left?: number | null;
  goal_percentage_complete?: number | null;
  goal_snoozed_at?: string | null;
  goal_target?: number | null;
  goal_target_date?: string | null;
  goal_type?: string | null;
  goal_under_funded?: number | null;
  hidden: boolean;
  id: string;
  name: string;
  note?: string | null;
}

interface YnabCategoryGroup {
  categories?: YnabCategory[];
  deleted: boolean;
  hidden: boolean;
  id: string;
  name: string;
  note?: string | null;
}

interface YnabPayee {
  deleted: boolean;
  id: string;
  name: string;
  transfer_account_id?: string | null;
}

interface YnabPayeeLocation {
  deleted: boolean;
  id: string;
  latitude: string;
  longitude: string;
  payee_id: string;
}

interface YnabSubtransaction {
  id: string;
  [field: string]: unknown;
}

interface YnabTransaction {
  account_id: string;
  account_name?: string | null;
  amount: number;
  approved: boolean;
  category_id?: string | null;
  category_name?: string | null;
  cleared: string;
  date: string;
  debt_transaction_type?: string | null;
  deleted: boolean;
  flag_color?: string | null;
  flag_name?: string | null;
  id: string;
  import_id?: string | null;
  import_payee_name?: string | null;
  import_payee_name_original?: string | null;
  matched_transaction_id?: string | null;
  memo?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  subtransactions?: YnabSubtransaction[];
  transfer_account_id?: string | null;
  transfer_transaction_id?: string | null;
}

interface YnabScheduledTransaction {
  account_id: string;
  account_name?: string | null;
  amount: number;
  category_id?: string | null;
  category_name?: string | null;
  date_first: string;
  date_next: string;
  deleted: boolean;
  flag_color?: string | null;
  flag_name?: string | null;
  frequency: string;
  id: string;
  memo?: string | null;
  payee_id?: string | null;
  payee_name?: string | null;
  subtransactions?: YnabSubtransaction[];
  transfer_account_id?: string | null;
}

interface YnabMonth {
  activity: number;
  age_of_money?: number | null;
  budgeted: number;
  categories?: YnabCategory[];
  deleted: boolean;
  income: number;
  month: string;
  note?: string | null;
  to_be_budgeted: number;
}

interface YnabBudgetsResponse {
  data: { budgets: YnabBudget[] };
}

interface YnabAccountsResponse {
  data: { accounts: YnabAccount[]; server_knowledge: number };
}

interface YnabCategoriesResponse {
  data: { category_groups: YnabCategoryGroup[]; server_knowledge: number };
}

interface YnabPayeesResponse {
  data: { payees: YnabPayee[]; server_knowledge: number };
}

interface YnabPayeeLocationsResponse {
  data: { payee_locations: YnabPayeeLocation[] };
}

interface YnabTransactionsResponse {
  data: { transactions: YnabTransaction[]; server_knowledge: number };
}

interface YnabScheduledTransactionsResponse {
  data: {
    scheduled_transactions: YnabScheduledTransaction[];
    server_knowledge: number;
  };
}

interface YnabMonthsResponse {
  data: { months: YnabMonth[]; server_knowledge: number };
}

interface YnabMonthDetailResponse {
  data: { month: YnabMonth };
}

async function ynab<T>(
  path: string,
  token: string,
  { knowledge, sinceDate }: YnabFetchOptions = {},
  progress?: ProgressFn,
  extra?: Parameters<ProgressFn>[1]
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (knowledge != null) {
    url.searchParams.set("last_knowledge_of_server", String(knowledge));
  }
  if (sinceDate) {
    url.searchParams.set("since_date", sinceDate);
  }
  let result: { body: string; status: number };
  try {
    const r = await httpGovernor.request<{ body: string; status: number }, { body: string; status: number }>(
      async () => {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const retryAfter = res.headers.get("retry-after");
        return {
          body: await res.text().catch((): string => ""),
          ...(retryAfter == null ? {} : { headers: { "retry-after": retryAfter } }),
          status: res.status,
        } as { body: string; status: number };
      },
      (raw) => ({ status: raw.status, value: raw })
    );
    result = r.value;
  } catch (error) {
    // Terminal rate-limit: emit the same progress side-effect the hand-rolled
    // path did, then rethrow `ynab_rate_limited` for the cross-run contract.
    if (error instanceof Error && error.message === "ynab_rate_limited") {
      await progress?.("YNAB request rate limited", { ...extra, phase: "rate_limit", rate_limit_pressure: 1 });
    }
    throw error;
  }
  if (result.status === 401) {
    throw new Error("ynab_auth_failed");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`ynab_http_${String(result.status)}: ${result.body.slice(0, 200)}`);
  }
  return JSON.parse(result.body) as T;
}

interface TimeRange {
  since?: string;
  until?: string;
}

function withinTimeRange(dateStr: string, timeRange: TimeRange | undefined): boolean {
  if (!timeRange) {
    return true;
  }
  if (timeRange.since && dateStr < timeRange.since.slice(0, 10)) {
    return false;
  }
  if (timeRange.until && dateStr >= timeRange.until.slice(0, 10)) {
    return false;
  }
  return true;
}

function priorKnowledge(state: Record<string, unknown>, streamName: string, budgetId: string): number | undefined {
  const streamState = state[streamName] as Record<string, { server_knowledge?: number } | undefined> | undefined;
  return streamState?.[budgetId]?.server_knowledge;
}

// Rewind an ISO month (YYYY-MM-DD, day is always 01 from YNAB) by one month.
// Used to keep the cutoff one step behind the highest month we've fetched, so
// the most recent closed month gets one more pass on the next run.
export function rewindOneMonth(monthIso: string): string {
  const parts = monthIso.split("-").map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 1;
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return `${String(prevY)}-${String(prevM).padStart(2, "0")}-01`;
}

// ─── Record builders ────────────────────────────────────────────────────

/**
 * Fields excluded from the `budgets` fingerprint.
 *
 * `last_month` and `last_modified_on` move without a corresponding change to
 * the budget-summary content this stream actually projects:
 *
 *   - `last_month` is the most-recent budget month YNAB has materialized.
 *     YNAB rolls active budgets forward automatically, so this advances on
 *     the 1st of every calendar month even when the owner has touched
 *     nothing. It is a clock, not a user edit to a budget-summary field.
 *   - `last_modified_on` is the budget's last-modified timestamp. It ticks
 *     on *any* edit anywhere in the budget — a single transaction, a
 *     category assignment, a memo — none of which change the fields this
 *     stream emits (name, currency locale, date format, first month).
 *     Those edits surface in their own streams (`transactions`,
 *     `categories`, …); re-emitting the budget summary for them is the
 *     unbounded forward churn this gate removes (~273 versions/budget in the
 *     2026-05-26 churn report).
 *
 * Every remaining field — name, currency locale, date format, and
 * `first_month` — is a real budget-summary source fact, so a genuine edit to
 * any of them still re-emits the budget. This matches the design-note rule
 * "exclude volatile collection-time fields from durable record identity
 * unless those fields are source facts"
 * (design-notes/record-version-churn-and-noop-semantics-2026-05-26.md).
 */
export const BUDGET_FINGERPRINT_EXCLUDE = ["last_month", "last_modified_on"] as const;

export function budgetRecord(b: YnabBudget): RecordData {
  return {
    id: b.id,
    name: b.name,
    last_modified_on: b.last_modified_on ?? null,
    first_month: b.first_month ?? null,
    last_month: b.last_month ?? null,
    currency_iso_code: b.currency_format?.iso_code ?? null,
    currency_symbol: b.currency_format?.currency_symbol ?? null,
    currency_symbol_first: b.currency_format?.symbol_first ?? null,
    currency_decimal_digits: b.currency_format?.decimal_digits ?? null,
    currency_decimal_separator: b.currency_format?.decimal_separator ?? null,
    currency_group_separator: b.currency_format?.group_separator ?? null,
    date_format_string: b.date_format?.format ?? null,
    deleted: false,
  };
}

/**
 * Open the per-record fingerprint cursor for the `budgets` stream.
 *
 * Unlike the per-budget streams, `/budgets` is a single full-collection
 * fetch keyed by budget id, so there is one cursor for the whole stream
 * rather than one per budget. The prior fingerprints live alongside the
 * existing `fetched_at` marker under `state.budgets.fingerprints`; the
 * cursor's tolerant decoder ignores `fetched_at` and any legacy shape.
 *
 * `BUDGET_FINGERPRINT_EXCLUDE` drops the two calendar/clock fields so an
 * unchanged budget no-ops across runs (see the constant's doc comment).
 */
export function openBudgetCursor(state: Record<string, unknown>): FingerprintCursor {
  return openFingerprintCursor(state.budgets, {
    excludeFromFingerprint: BUDGET_FINGERPRINT_EXCLUDE,
  });
}

// Account entity record: identity and settings fields only. The
// point-in-time balance metrics (`balance`, `cleared_balance`,
// `uncleared_balance`) are projected into the `account_stats` observation
// stream so a balance move does not version this entity record. See
// `accountStatsRecord` and the `split-ynab-account-balance-observation-stream`
// OpenSpec change.
export function accountRecord(a: YnabAccount, budgetId: string): RecordData {
  return {
    id: a.id,
    budget_id: budgetId,
    name: a.name,
    type: a.type,
    on_budget: a.on_budget,
    closed: a.closed,
    transfer_payee_id: a.transfer_payee_id ?? null,
    direct_import_linked: a.direct_import_linked ?? null,
    direct_import_in_error: a.direct_import_in_error ?? null,
    last_reconciled_at: a.last_reconciled_at ?? null,
    note: a.note ?? null,
    debt_interest_rates: a.debt_interest_rates ?? null,
    debt_minimum_payments: a.debt_minimum_payments ?? null,
    debt_escrow_amounts: a.debt_escrow_amounts ?? null,
    deleted: a.deleted,
  };
}

// Account balance observation record: point-in-time balances keyed by
// `{account_id}:{observed_on}` (UTC date). One record per account per
// calendar day; re-emitting on the same day with the same balances is
// idempotent under the runtime byte-equivalence check. A later day appends a
// new record, accumulating a daily balance time series.
export function accountStatsRecord(a: YnabAccount, budgetId: string, observedOn: string): RecordData {
  return {
    id: `${a.id}:${observedOn}`,
    account_id: a.id,
    budget_id: budgetId,
    observed_on: observedOn,
    balance: a.balance,
    cleared_balance: a.cleared_balance,
    uncleared_balance: a.uncleared_balance,
  };
}

function categoryGroupRecord(group: YnabCategoryGroup, budgetId: string): RecordData {
  return {
    id: group.id,
    budget_id: budgetId,
    name: group.name,
    hidden: group.hidden,
    note: group.note ?? null,
    deleted: group.deleted,
  };
}

function categoryRecord(c: YnabCategory, group: YnabCategoryGroup, budgetId: string): RecordData {
  return {
    id: c.id,
    budget_id: budgetId,
    category_group_id: group.id,
    category_group_name: group.name,
    name: c.name,
    hidden: c.hidden,
    budgeted: c.budgeted,
    activity: c.activity,
    balance: c.balance,
    note: c.note ?? null,
    goal_type: c.goal_type ?? null,
    goal_needs_whole_amount: c.goal_needs_whole_amount ?? null,
    goal_day: c.goal_day ?? null,
    goal_cadence: c.goal_cadence ?? null,
    goal_cadence_frequency: c.goal_cadence_frequency ?? null,
    goal_creation_month: c.goal_creation_month ?? null,
    goal_target: c.goal_target ?? null,
    goal_target_date: c.goal_target_date ?? null,
    goal_percentage_complete: c.goal_percentage_complete ?? null,
    goal_months_to_budget: c.goal_months_to_budget ?? null,
    goal_under_funded: c.goal_under_funded ?? null,
    goal_overall_funded: c.goal_overall_funded ?? null,
    goal_overall_left: c.goal_overall_left ?? null,
    goal_snoozed_at: c.goal_snoozed_at ?? null,
    deleted: c.deleted,
  };
}

function payeeRecord(p: YnabPayee, budgetId: string): RecordData {
  return {
    id: p.id,
    budget_id: budgetId,
    name: p.name,
    transfer_account_id: p.transfer_account_id ?? null,
    deleted: p.deleted,
  };
}

export function payeeLocationRecord(loc: YnabPayeeLocation, budgetId: string): RecordData {
  return {
    id: loc.id,
    budget_id: budgetId,
    payee_id: loc.payee_id,
    latitude: loc.latitude,
    longitude: loc.longitude,
    deleted: loc.deleted,
  };
}

function transactionRecord(t: YnabTransaction, budgetId: string, accountTypeById: Map<string, string>): RecordData {
  return {
    id: t.id,
    budget_id: budgetId,
    account_id: t.account_id,
    account_name: t.account_name ?? null,
    account_type: accountTypeById.get(t.account_id) ?? null,
    date: t.date,
    amount: t.amount,
    payee_id: t.payee_id ?? null,
    payee_name: t.payee_name ?? null,
    category_id: t.category_id ?? null,
    category_name: t.category_name ?? null,
    memo: t.memo ?? null,
    cleared: t.cleared,
    approved: t.approved,
    flag_color: t.flag_color ?? null,
    flag_name: t.flag_name ?? null,
    transfer_account_id: t.transfer_account_id ?? null,
    transfer_transaction_id: t.transfer_transaction_id ?? null,
    matched_transaction_id: t.matched_transaction_id ?? null,
    import_id: t.import_id ?? null,
    import_payee_name: t.import_payee_name ?? null,
    import_payee_name_original: t.import_payee_name_original ?? null,
    debt_transaction_type: t.debt_transaction_type ?? null,
    is_split: Array.isArray(t.subtransactions) && t.subtransactions.length > 0,
    subtransactions: t.subtransactions ?? [],
    deleted: t.deleted,
  };
}

function scheduledTransactionRecord(s: YnabScheduledTransaction, budgetId: string): RecordData {
  return {
    id: s.id,
    budget_id: budgetId,
    date_first: s.date_first,
    date_next: s.date_next,
    frequency: s.frequency,
    amount: s.amount,
    account_id: s.account_id,
    account_name: s.account_name ?? null,
    payee_id: s.payee_id ?? null,
    payee_name: s.payee_name ?? null,
    category_id: s.category_id ?? null,
    category_name: s.category_name ?? null,
    memo: s.memo ?? null,
    transfer_account_id: s.transfer_account_id ?? null,
    flag_color: s.flag_color ?? null,
    flag_name: s.flag_name ?? null,
    subtransactions: s.subtransactions ?? [],
    deleted: s.deleted,
  };
}

function monthRecord(m: YnabMonth, budgetId: string): RecordData {
  return {
    id: `${budgetId}|${m.month}`,
    budget_id: budgetId,
    month: m.month,
    income: m.income,
    budgeted: m.budgeted,
    activity: m.activity,
    to_be_budgeted: m.to_be_budgeted,
    age_of_money: m.age_of_money ?? null,
    note: m.note ?? null,
    deleted: m.deleted,
  };
}

export function monthCategoryRecord(c: YnabCategory, month: string, budgetId: string): RecordData {
  return {
    id: `${budgetId}:${month}:${c.id}`,
    budget_id: budgetId,
    month,
    category_id: c.id,
    category_name: c.name,
    category_group_id: c.category_group_id ?? null,
    category_group_name: c.category_group_name ?? null,
    budgeted: c.budgeted ?? 0,
    activity: c.activity ?? 0,
    balance: c.balance ?? 0,
    goal_type: c.goal_type ?? null,
    goal_target: c.goal_target ?? null,
    goal_percentage_complete: c.goal_percentage_complete ?? null,
    goal_months_to_budget: c.goal_months_to_budget ?? null,
    goal_creation_month: c.goal_creation_month ?? null,
    goal_under_funded: c.goal_under_funded ?? null,
    goal_overall_funded: c.goal_overall_funded ?? null,
    goal_overall_left: c.goal_overall_left ?? null,
    hidden: c.hidden ?? false,
    note: c.note ?? null,
    deleted: c.deleted ?? false,
  };
}

// ─── Per-budget stream collectors ───────────────────────────────────────

type EmitFn = (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;

type TrackedEmitRecord = (stream: string, data: RecordData) => Promise<void>;

type ProgressFn = (
  message: string,
  extra?: {
    count?: number;
    cursor_present?: boolean;
    item_count?: number;
    offset_ordinal?: number;
    phase?: string;
    rate_limit_pressure?: number;
    stream?: string;
    total?: number;
    total_seen?: number;
  }
) => Promise<void>;

export interface BudgetCtx {
  budgetId: string;
  budgetOrdinal?: number;
  emit: EmitFn;
  newState: Record<string, unknown>;
  progress: ProgressFn;
  requested: Map<string, { time_range?: TimeRange }>;
  state: Record<string, unknown>;
  token: string;
  trackAndEmit: TrackedEmitRecord;
}

/**
 * Per-budget fingerprint cursor for the `accounts` entity stream. After the
 * balance fields move to `account_stats`, the entity record carries only
 * identity and settings fields, so a full fingerprint (no exclusions) is
 * correct: the record re-emits only when one of those fields actually changes.
 *
 * State shape: `state.accounts[budgetId].fingerprints`, opened per budget so a
 * multi-budget owner cannot cross-contaminate fingerprint maps. The per-budget
 * entry also carries the existing `server_knowledge` cursor; this wrapper reads
 * only the `fingerprints` field.
 */
export function openAccountCursor(state: Record<string, unknown>, budgetId: string): FingerprintCursor {
  const streamState = state.accounts;
  let budgetEntry: unknown;
  if (streamState && typeof streamState === "object" && !Array.isArray(streamState)) {
    budgetEntry = (streamState as Record<string, unknown>)[budgetId];
  }
  return openFingerprintCursor(budgetEntry);
}

async function collectAccounts(ctx: BudgetCtx): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "accounts", budgetId);
  await progress("Fetching YNAB accounts window", {
    stream: "accounts",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  const requestExtra = {
    stream: "accounts",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  };
  const res = await ynab<YnabAccountsResponse>(
    `/budgets/${budgetId}/accounts`,
    token,
    {
      ...(knowledge === undefined ? {} : { knowledge }),
    },
    progress,
    requestExtra
  );
  await progress("Fetched YNAB accounts window", {
    stream: "accounts",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: res.data.accounts.length,
    total_seen: res.data.accounts.length,
    cursor_present: true,
    count: res.data.accounts.length,
    total: res.data.accounts.length,
  });

  // Entity stream: gate on a per-record fingerprint so a balance-only delta
  // does not version the account. `/accounts` is a `server_knowledge` PARTIAL
  // scan — it returns only accounts changed since the prior knowledge value —
  // so we must NOT prune: an account absent from this delta was not deleted,
  // it just did not change. A real deletion arrives as a returned record with
  // `deleted: true`, which the fingerprint treats as a normal field change.
  const entityCursor = openAccountCursor(state, budgetId);
  const wantsEntity = requested.has("accounts");
  const wantsStats = requested.has("account_stats");
  const observedOn = nowIso().slice(0, 10);
  for (const a of res.data.accounts) {
    if (wantsEntity) {
      const entityRec = accountRecord(a, budgetId);
      if (entityCursor.shouldEmit(entityRec)) {
        await trackAndEmit("accounts", entityRec);
      }
    }
    // Observation stream: append-keyed daily balance snapshot. Emitted
    // unconditionally for returned accounts; the date-scoped key + runtime
    // byte-equivalence make same-day same-balance re-emits idempotent.
    if (wantsStats) {
      await trackAndEmit("account_stats", accountStatsRecord(a, budgetId, observedOn));
    }
  }

  if (wantsEntity) {
    const accounts =
      (newState.accounts as
        | Record<string, { server_knowledge: number; fingerprints?: Record<string, string> }>
        | undefined) ?? {};
    accounts[budgetId] = { server_knowledge: res.data.server_knowledge, fingerprints: entityCursor.toState() };
    newState.accounts = accounts;
    await emit({ type: "STATE", stream: "accounts", cursor: newState.accounts });
  } else {
    // `account_stats` requested without `accounts`: still advance the
    // server_knowledge delta cursor so the next run continues incrementally.
    const accounts = (newState.accounts as Record<string, { server_knowledge: number }> | undefined) ?? {};
    accounts[budgetId] = { ...accounts[budgetId], server_knowledge: res.data.server_knowledge };
    newState.accounts = accounts;
    await emit({ type: "STATE", stream: "accounts", cursor: newState.accounts });
  }

  if (wantsStats) {
    await emit({ type: "STATE", stream: "account_stats", cursor: { observed_on: observedOn, fetched_at: nowIso() } });
  }
}

async function collectCategoriesAndGroups(ctx: BudgetCtx): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "categories", budgetId);
  await progress("Fetching YNAB categories window", {
    stream: "categories",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  const requestExtra = {
    stream: "categories",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  };
  const res = await ynab<YnabCategoriesResponse>(
    `/budgets/${budgetId}/categories`,
    token,
    {
      ...(knowledge === undefined ? {} : { knowledge }),
    },
    progress,
    requestExtra
  );
  const categoryCount = res.data.category_groups.reduce((sum, group) => sum + (group.categories?.length ?? 0), 0);
  await progress("Fetched YNAB categories window", {
    stream: "categories",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: categoryCount,
    total_seen: categoryCount,
    cursor_present: true,
    count: categoryCount,
    total: categoryCount,
  });
  for (const group of res.data.category_groups) {
    if (requested.has("category_groups")) {
      await trackAndEmit("category_groups", categoryGroupRecord(group, budgetId));
    }
    if (requested.has("categories")) {
      for (const c of group.categories ?? []) {
        await trackAndEmit("categories", categoryRecord(c, group, budgetId));
      }
    }
  }
  const cats = (newState.categories as Record<string, { server_knowledge: number }> | undefined) ?? {};
  cats[budgetId] = { server_knowledge: res.data.server_knowledge };
  newState.categories = cats;
  await emit({
    type: "STATE",
    stream: "categories",
    cursor: newState.categories,
  });
}

async function collectPayees(ctx: BudgetCtx): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "payees", budgetId);
  await progress("Fetching YNAB payees window", {
    stream: "payees",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  const requestExtra = {
    stream: "payees",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  };
  const res = await ynab<YnabPayeesResponse>(
    `/budgets/${budgetId}/payees`,
    token,
    {
      ...(knowledge === undefined ? {} : { knowledge }),
    },
    progress,
    requestExtra
  );
  await progress("Fetched YNAB payees window", {
    stream: "payees",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: res.data.payees.length,
    total_seen: res.data.payees.length,
    cursor_present: true,
    count: res.data.payees.length,
    total: res.data.payees.length,
  });
  for (const p of res.data.payees) {
    await trackAndEmit("payees", payeeRecord(p, budgetId));
  }
  const payees = (newState.payees as Record<string, { server_knowledge: number }> | undefined) ?? {};
  payees[budgetId] = { server_knowledge: res.data.server_knowledge };
  newState.payees = payees;
  await emit({ type: "STATE", stream: "payees", cursor: newState.payees });
}

/**
 * Open a per-record fingerprint cursor for one budget's payee_locations.
 *
 * YNAB exposes `server_knowledge` deltas on payees/transactions/etc., but
 * NOT on `/payee_locations` — the full collection re-returns every run.
 * Without a connector-side gate, every run appends a new version per
 * location (77 keys × 270 versions in the live churn report). The cursor
 * fingerprints the full emitted record; nothing is excluded — lat/long
 * are user-provided in the YNAB UI and never re-geocoded silently, so
 * they are valid change signals, and YNAB does not stamp a run-clock
 * field into the payload.
 *
 * State shape: `state.payee_locations[budgetId].fingerprints` — opened
 * per budget so a multi-budget owner cannot cross-contaminate fingerprint
 * maps.
 */
export function openPayeeLocationCursor(state: Record<string, unknown>, budgetId: string): FingerprintCursor {
  const streamState = state.payee_locations;
  let budgetEntry: unknown;
  if (streamState && typeof streamState === "object" && !Array.isArray(streamState)) {
    budgetEntry = (streamState as Record<string, unknown>)[budgetId];
  }
  return openFingerprintCursor(budgetEntry);
}

async function collectPayeeLocations(ctx: BudgetCtx): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, emit, trackAndEmit, progress } = ctx;
  await progress("Fetching YNAB payee locations window", {
    stream: "payee_locations",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: false,
  });
  const res = await ynab<YnabPayeeLocationsResponse>(`/budgets/${budgetId}/payee_locations`, token, {}, progress, {
    stream: "payee_locations",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: false,
  });
  await progress("Fetched YNAB payee locations window", {
    stream: "payee_locations",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: res.data.payee_locations.length,
    total_seen: res.data.payee_locations.length,
    cursor_present: true,
    count: res.data.payee_locations.length,
    total: res.data.payee_locations.length,
  });
  const cursor = openPayeeLocationCursor(state, budgetId);
  for (const loc of res.data.payee_locations) {
    const record = payeeLocationRecord(loc, budgetId);
    if (!cursor.shouldEmit(record)) {
      continue;
    }
    await trackAndEmit("payee_locations", record);
  }
  // YNAB's `/payee_locations` is a full-collection endpoint, so any prior
  // id absent this run was deleted at the source. Prune so a future
  // re-creation triggers a fresh emit instead of silently no-opping
  // against a stale fingerprint.
  cursor.pruneStale();
  const payeeLocsState =
    (newState.payee_locations as Record<string, { fingerprints?: Record<string, string> }> | undefined) ?? {};
  payeeLocsState[budgetId] = { fingerprints: cursor.toState() };
  newState.payee_locations = payeeLocsState;
  await emit({
    type: "STATE",
    stream: "payee_locations",
    cursor: newState.payee_locations,
  });
}

async function collectTransactions(ctx: BudgetCtx): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  const stream = requested.get("transactions");
  const knowledge = priorKnowledge(state, "transactions", budgetId);
  const txnState = state.transactions as Record<string, { server_knowledge?: number; since_date?: string }> | undefined;
  const priorSinceDate = txnState?.[budgetId]?.since_date;
  const scopeSince = stream?.time_range?.since?.slice(0, 10);
  // Use server-side since_date only on first run (no delta cursor yet).
  const sinceDate = knowledge == null ? scopeSince || priorSinceDate || undefined : undefined;
  await progress("Fetching YNAB transactions window", {
    stream: "transactions",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined || sinceDate !== undefined,
  });

  // Build account_id → account_type map for convenience enrichment.
  const accountTypeById = new Map<string, string>();
  // Always re-fetch accounts summary for the type map. Small payload, negligible cost.
  try {
    const aRes = await ynab<YnabAccountsResponse>(`/budgets/${budgetId}/accounts`, token, {}, progress, {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined || sinceDate !== undefined,
    });
    for (const a of aRes.data.accounts) {
      accountTypeById.set(a.id, a.type);
    }
  } catch {
    /* non-fatal */
  }

  const res = await ynab<YnabTransactionsResponse>(
    `/budgets/${budgetId}/transactions`,
    token,
    {
      ...(knowledge === undefined ? {} : { knowledge }),
      ...(sinceDate === undefined ? {} : { sinceDate }),
    },
    progress,
    {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined || sinceDate !== undefined,
    }
  );
  let emittedTransactions = 0;
  for (const t of res.data.transactions) {
    if (!withinTimeRange(t.date, stream?.time_range)) {
      continue;
    }
    await trackAndEmit("transactions", transactionRecord(t, budgetId, accountTypeById));
    emittedTransactions++;
  }
  await progress("Processed YNAB transactions window", {
    stream: "transactions",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: res.data.transactions.length,
    total_seen: res.data.transactions.length,
    cursor_present: true,
    count: emittedTransactions,
    total: res.data.transactions.length,
  });
  const txns =
    (newState.transactions as Record<string, { server_knowledge: number; since_date?: string }> | undefined) ?? {};
  const storedSince = sinceDate || priorSinceDate || scopeSince;
  txns[budgetId] = {
    server_knowledge: res.data.server_knowledge,
    ...(storedSince === undefined ? {} : { since_date: storedSince }),
  };
  newState.transactions = txns;
  await emit({
    type: "STATE",
    stream: "transactions",
    cursor: newState.transactions,
  });
}

async function collectScheduledTransactions(ctx: BudgetCtx): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "scheduled_transactions", budgetId);
  await progress("Fetching YNAB scheduled transactions window", {
    stream: "scheduled_transactions",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  const res = await ynab<YnabScheduledTransactionsResponse>(
    `/budgets/${budgetId}/scheduled_transactions`,
    token,
    {
      ...(knowledge === undefined ? {} : { knowledge }),
    },
    progress,
    {
      stream: "scheduled_transactions",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined,
    }
  );
  await progress("Fetched YNAB scheduled transactions window", {
    stream: "scheduled_transactions",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: res.data.scheduled_transactions.length,
    total_seen: res.data.scheduled_transactions.length,
    cursor_present: true,
    count: res.data.scheduled_transactions.length,
    total: res.data.scheduled_transactions.length,
  });
  for (const s of res.data.scheduled_transactions) {
    await trackAndEmit("scheduled_transactions", scheduledTransactionRecord(s, budgetId));
  }
  const scheduled = (newState.scheduled_transactions as Record<string, { server_knowledge: number }> | undefined) ?? {};
  scheduled[budgetId] = { server_knowledge: res.data.server_knowledge };
  newState.scheduled_transactions = scheduled;
  await emit({
    type: "STATE",
    stream: "scheduled_transactions",
    cursor: newState.scheduled_transactions,
  });
}

async function fetchMonthsIfNeeded(ctx: BudgetCtx, shouldFetch: boolean): Promise<YnabMonth[] | null> {
  if (!shouldFetch) {
    return null;
  }
  const { budgetId, budgetOrdinal = 0, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "months", budgetId);
  await progress("Fetching YNAB months window", {
    stream: "months",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  const res = await ynab<YnabMonthsResponse>(
    `/budgets/${budgetId}/months`,
    token,
    {
      ...(knowledge === undefined ? {} : { knowledge }),
    },
    progress,
    {
      stream: "months",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined,
    }
  );
  const monthList = res.data.months;
  await progress("Fetched YNAB months window", {
    stream: "months",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: monthList.length,
    total_seen: monthList.length,
    cursor_present: true,
    count: monthList.length,
    total: monthList.length,
  });
  if (requested.has("months")) {
    for (const m of monthList) {
      await trackAndEmit("months", monthRecord(m, budgetId));
    }
    const months = (newState.months as Record<string, { server_knowledge: number }> | undefined) ?? {};
    months[budgetId] = { server_knowledge: res.data.server_knowledge };
    newState.months = months;
    await emit({ type: "STATE", stream: "months", cursor: newState.months });
  }
  return monthList;
}

type MonthDetailFetcher = (budgetId: string, month: string, token: string) => Promise<YnabMonth>;

async function fetchMonthDetail(budgetId: string, month: string, token: string): Promise<YnabMonth> {
  const monthRes = await ynab<YnabMonthDetailResponse>(`/budgets/${budgetId}/months/${month}`, token);
  return monthRes.data.month;
}

export async function collectMonthCategories(
  ctx: BudgetCtx,
  monthList: YnabMonth[],
  monthCategoriesStream: { time_range?: TimeRange },
  fetchMonth: MonthDetailFetcher = fetchMonthDetail
): Promise<void> {
  const { budgetId, budgetOrdinal = 0, token, state, newState, emit, trackAndEmit, progress } = ctx;
  const mcState = state.month_categories as Record<string, { last_fetched_month?: string }> | undefined;
  const priorCutoff = mcState?.[budgetId]?.last_fetched_month;
  const scopeSince = monthCategoriesStream.time_range?.since?.slice(0, 10);
  // Active months: exclude soft-deleted, apply time_range and prior cutoff.
  const activeMonths = monthList.filter((m) => {
    if (m.deleted) {
      return false;
    }
    if (!withinTimeRange(m.month, monthCategoriesStream.time_range)) {
      return false;
    }
    if (priorCutoff && m.month < priorCutoff) {
      return false;
    }
    return true;
  });
  // Oldest → newest so the cursor advances monotonically on partial failure.
  activeMonths.sort((a, b) => {
    if (a.month < b.month) {
      return -1;
    }
    if (a.month > b.month) {
      return 1;
    }
    return 0;
  });

  let highestMonth: string | null = priorCutoff || scopeSince || null;
  for (let i = 0; i < activeMonths.length; i++) {
    const m = activeMonths[i];
    if (!m) {
      continue;
    }
    await progress("Fetching YNAB month categories window", {
      stream: "month_categories",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      count: i + 1,
      total: activeMonths.length,
      total_seen: i,
      cursor_present: Boolean(priorCutoff || scopeSince),
    });
    const monthDetail = await fetchMonth(budgetId, m.month, token);
    for (const c of monthDetail.categories ?? []) {
      await trackAndEmit("month_categories", monthCategoryRecord(c, m.month, budgetId));
    }
    if (!highestMonth || m.month > highestMonth) {
      highestMonth = m.month;
    }
  }
  await progress("Fetched YNAB month categories windows", {
    stream: "month_categories",
    phase: "page",
    offset_ordinal: budgetOrdinal,
    item_count: activeMonths.length,
    total_seen: activeMonths.length,
    cursor_present: Boolean(highestMonth),
    count: activeMonths.length,
    total: activeMonths.length,
  });
  const mcNew = (newState.month_categories as Record<string, { last_fetched_month?: string }> | undefined) ?? {};
  // Rewind cutoff by one month so the most recently closed month gets
  // one more pass next run (guards against late-arriving edits).
  const cutoffToStore = highestMonth ? rewindOneMonth(highestMonth) : undefined;
  mcNew[budgetId] = {
    ...(cutoffToStore === undefined ? {} : { last_fetched_month: cutoffToStore }),
  };
  newState.month_categories = mcNew;
  await emit({
    type: "STATE",
    stream: "month_categories",
    cursor: newState.month_categories,
  });
}

async function collectForBudget(ctx: BudgetCtx): Promise<void> {
  const { requested } = ctx;
  if (requested.has("accounts") || requested.has("account_stats")) {
    await collectAccounts(ctx);
  }
  if (requested.has("categories") || requested.has("category_groups")) {
    await collectCategoriesAndGroups(ctx);
  }
  if (requested.has("payees")) {
    await collectPayees(ctx);
  }
  if (requested.has("payee_locations")) {
    await collectPayeeLocations(ctx);
  }
  if (requested.has("transactions")) {
    await collectTransactions(ctx);
  }
  if (requested.has("scheduled_transactions")) {
    await collectScheduledTransactions(ctx);
  }

  const monthsStream = requested.get("months");
  const monthCategoriesStream = requested.get("month_categories");
  const shouldFetchMonths = Boolean(monthsStream || monthCategoriesStream);
  const monthList = await fetchMonthsIfNeeded(ctx, shouldFetchMonths);

  if (monthCategoriesStream && monthList) {
    await collectMonthCategories(ctx, monthList, monthCategoriesStream);
  }
}

/** Inputs for the `budgets` full-sync stream, extracted from `collect()` so the
 *  considered/covered declaration is unit-testable without the live API. */
export interface BudgetsStreamDeps {
  budgets: readonly YnabBudget[];
  emit: CollectContext["emit"];
  newState: Record<string, unknown>;
  state: Record<string, unknown>;
  trackAndEmit: TrackedEmitRecord;
}

/**
 * Emit the `budgets` entity stream. `/budgets` is a full-collection endpoint
 * with no `server_knowledge` delta, so the run re-enumerates the whole budget
 * inventory every time and gates each row through a per-record fingerprint
 * (excluding the two calendar/clock fields, see `BUDGET_FINGERPRINT_EXCLUDE`) so
 * an unchanged budget is not re-emitted — without this gate each run appended a
 * new version per budget (~273/budget in the 2026-05-26 churn report).
 *
 * Because the run suppresses unchanged rows, on a steady-state run `collected`
 * is a churn-reduced subset (often 0), not a coverage count. The stream declares
 * `considered = budgets.length` (the enumerated boundary) alongside an objective
 * `covered` count — emitted plus suppressed-because-unchanged, tallied at the
 * loop site from per-record outcomes — so the Collection Report reads `complete`
 * instead of a false `partial` (define-connector-progress-evidence-contract
 * task 4.4). `covered` is counted independently from `budgets.length`: a future
 * malformed-row drop before the gate would raise `considered` without raising
 * `covered`, leaving an honest `partial`. Empty required/hydrated key sets — a
 * list stream with no detail-hydration phase, so considered-vs-covered is the
 * only coverage axis.
 */
export async function emitBudgetsStream(deps: BudgetsStreamDeps): Promise<void> {
  const { budgets, state, newState, emit, trackAndEmit } = deps;
  const cursor = openBudgetCursor(state);
  let covered = 0;
  for (const b of budgets) {
    const record = budgetRecord(b);
    if (!cursor.shouldEmit(record)) {
      // Suppressed because unchanged since the prior run. The budget is still
      // accounted for as covered — `/budgets` re-enumerated it and the run
      // deliberately chose not to re-emit it.
      covered += 1;
      continue;
    }
    await trackAndEmit("budgets", record);
    covered += 1;
  }
  await emitDetailCoverage(
    { emit },
    {
      stream: "budgets",
      stateStream: "budgets",
      requiredKeys: [],
      hydratedKeys: [],
      considered: budgets.length,
      covered,
    }
  );
  // `/budgets` is a full-collection endpoint, so any id known to the prior
  // cursor but absent this run was deleted at the source. Prune so a future
  // re-creation triggers a fresh emit instead of silently no-opping against a
  // stale fingerprint.
  cursor.pruneStale();
  const budgetsCursor = {
    fetched_at: nowIso(),
    fingerprints: cursor.toState(),
  };
  await emit({ type: "STATE", stream: "budgets", cursor: budgetsCursor });
  newState.budgets = budgetsCursor;
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "ynab",
    retryablePattern: /rate_limited|ECONN|ETIMEDOUT|fetch failed/i,
    // YNAB marks deleted records with `deleted: true` in-band. Runtime strips
    // to { id } and emits with op: 'delete'.
    isTombstone: (_stream, d) => d.deleted === true,
    auth: { kind: "env", required: [["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"]] },
    validateRecord,
    async collect({ state, requested, credentials, emit, emitRecord: runtimeEmitRecord, progress }) {
      const token = credentials.YNAB_PERSONAL_ACCESS_TOKEN;
      if (!token) {
        throw new Error("ynab_auth_failed");
      }

      const newState: Record<string, unknown> = JSON.parse(JSON.stringify(state));

      // Track which IDs we emitted this run, per stream. Used later for
      // end-of-stream tombstones: IDs present in prior state but not in this
      // run are treated as deletions the server never told us about
      // (YNAB occasionally hard-deletes without soft-delete marker).
      const emittedIds = new Map<string, Set<string>>();
      for (const [streamName] of requested) {
        emittedIds.set(streamName, new Set<string>());
      }

      // Trap to record ids so end-of-stream reconciliation can compare.
      // Delegates to the runtime's emitRecord; only observes ids flowing through.
      const trackAndEmit: TrackedEmitRecord = (stream, data) => {
        if (data.id != null) {
          emittedIds.get(stream)?.add(String(data.id));
        }
        return runtimeEmitRecord(stream, data);
      };
      const progressWithCounters: ProgressFn = progress;

      // 1. Budgets — always fetched; needed to enumerate downstream streams.
      await progressWithCounters("Fetching budgets", { stream: "budgets", phase: "fetch", cursor_present: false });
      const budgetsRes = await ynab<YnabBudgetsResponse>("/budgets", token, {}, progressWithCounters, {
        stream: "budgets",
        phase: "fetch",
        cursor_present: false,
      });
      const budgets = budgetsRes.data.budgets;
      const budgetIds = budgets.map((b) => b.id);
      await progressWithCounters("Fetched budgets", {
        stream: "budgets",
        phase: "page",
        item_count: budgets.length,
        total_seen: budgets.length,
        cursor_present: true,
        count: budgets.length,
        total: budgets.length,
      });

      if (requested.has("budgets")) {
        await emitBudgetsStream({ budgets, state, newState, emit, trackAndEmit });
      }

      for (let budgetOrdinal = 0; budgetOrdinal < budgetIds.length; budgetOrdinal++) {
        const budgetId = budgetIds[budgetOrdinal];
        if (!budgetId) {
          continue;
        }
        await collectForBudget({
          budgetId,
          budgetOrdinal,
          token,
          state,
          newState,
          requested: requested as Map<string, { time_range?: TimeRange }>,
          emit,
          trackAndEmit,
          progress: progressWithCounters,
        });
      }
    },
  });
}
