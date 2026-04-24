#!/usr/bin/env node
/**
 * PDPP YNAB Connector (v0.2.0)
 *
 * Polyfills YNAB's v1 API into the PDPP Collection Profile. Reads
 * YNAB_PERSONAL_ACCESS_TOKEN from the environment. Emits RECORD/STATE/DONE
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

import { nowIso, type RecordData, runConnector } from "../../src/connector-runtime.ts";

const API_BASE = "https://api.ynab.com/v1";

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

async function ynab<T>(path: string, token: string, { knowledge, sinceDate }: YnabFetchOptions = {}): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  if (knowledge != null) {
    url.searchParams.set("last_knowledge_of_server", String(knowledge));
  }
  if (sinceDate) {
    url.searchParams.set("since_date", sinceDate);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    throw new Error("ynab_auth_failed");
  }
  if (res.status === 429) {
    throw new Error("ynab_rate_limited");
  }
  if (!res.ok) {
    const body = await res.text().catch((): string => "");
    throw new Error(`ynab_http_${String(res.status)}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
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
function rewindOneMonth(monthIso: string): string {
  const parts = monthIso.split("-").map(Number);
  const y = parts[0] ?? 0;
  const m = parts[1] ?? 1;
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return `${String(prevY)}-${String(prevM).padStart(2, "0")}-01`;
}

// ─── Record builders ────────────────────────────────────────────────────

function budgetRecord(b: YnabBudget): RecordData {
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

function accountRecord(a: YnabAccount, budgetId: string): RecordData {
  return {
    id: a.id,
    budget_id: budgetId,
    name: a.name,
    type: a.type,
    on_budget: a.on_budget,
    closed: a.closed,
    balance: a.balance,
    cleared_balance: a.cleared_balance,
    uncleared_balance: a.uncleared_balance,
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

function payeeLocationRecord(loc: YnabPayeeLocation, budgetId: string): RecordData {
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

function monthCategoryRecord(c: YnabCategory, month: string, budgetId: string): RecordData {
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

type ProgressFn = (message: string, extra?: { count?: number; stream?: string; total?: number }) => Promise<void>;

interface BudgetCtx {
  budgetId: string;
  emit: EmitFn;
  newState: Record<string, unknown>;
  progress: ProgressFn;
  requested: Map<string, { time_range?: TimeRange }>;
  state: Record<string, unknown>;
  token: string;
  trackAndEmit: TrackedEmitRecord;
}

async function collectAccounts(ctx: BudgetCtx): Promise<void> {
  const { budgetId, token, state, newState, emit, trackAndEmit, progress } = ctx;
  await progress(`Fetching accounts for budget ${budgetId}`, {
    stream: "accounts",
  });
  const knowledge = priorKnowledge(state, "accounts", budgetId);
  const res = await ynab<YnabAccountsResponse>(`/budgets/${budgetId}/accounts`, token, {
    ...(knowledge === undefined ? {} : { knowledge }),
  });
  await progress(`Fetched ${res.data.accounts.length} accounts for budget ${budgetId}`, {
    stream: "accounts",
    count: res.data.accounts.length,
    total: res.data.accounts.length,
  });
  for (const a of res.data.accounts) {
    await trackAndEmit("accounts", accountRecord(a, budgetId));
  }
  const accounts = (newState.accounts as Record<string, { server_knowledge: number }> | undefined) ?? {};
  accounts[budgetId] = { server_knowledge: res.data.server_knowledge };
  newState.accounts = accounts;
  await emit({ type: "STATE", stream: "accounts", cursor: newState.accounts });
}

async function collectCategoriesAndGroups(ctx: BudgetCtx): Promise<void> {
  const { budgetId, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  await progress(`Fetching categories for budget ${budgetId}`, {
    stream: "categories",
  });
  const knowledge = priorKnowledge(state, "categories", budgetId);
  const res = await ynab<YnabCategoriesResponse>(`/budgets/${budgetId}/categories`, token, {
    ...(knowledge === undefined ? {} : { knowledge }),
  });
  const categoryCount = res.data.category_groups.reduce((sum, group) => sum + (group.categories?.length ?? 0), 0);
  await progress(
    `Fetched ${categoryCount} categories in ${res.data.category_groups.length} groups for budget ${budgetId}`,
    {
      stream: "categories",
      count: categoryCount,
      total: categoryCount,
    }
  );
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
  const { budgetId, token, state, newState, emit, trackAndEmit, progress } = ctx;
  await progress(`Fetching payees for budget ${budgetId}`, {
    stream: "payees",
  });
  const knowledge = priorKnowledge(state, "payees", budgetId);
  const res = await ynab<YnabPayeesResponse>(`/budgets/${budgetId}/payees`, token, {
    ...(knowledge === undefined ? {} : { knowledge }),
  });
  await progress(`Fetched ${res.data.payees.length} payees for budget ${budgetId}`, {
    stream: "payees",
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

async function collectPayeeLocations(ctx: BudgetCtx): Promise<void> {
  const { budgetId, token, trackAndEmit, progress } = ctx;
  await progress(`Fetching payee locations for budget ${budgetId}`, {
    stream: "payee_locations",
  });
  const res = await ynab<YnabPayeeLocationsResponse>(`/budgets/${budgetId}/payee_locations`, token);
  await progress(`Fetched ${res.data.payee_locations.length} payee locations for budget ${budgetId}`, {
    stream: "payee_locations",
    count: res.data.payee_locations.length,
    total: res.data.payee_locations.length,
  });
  for (const loc of res.data.payee_locations) {
    await trackAndEmit("payee_locations", payeeLocationRecord(loc, budgetId));
  }
}

async function collectTransactions(ctx: BudgetCtx): Promise<void> {
  const { budgetId, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  await progress(`Fetching transactions for budget ${budgetId}`, {
    stream: "transactions",
  });
  const stream = requested.get("transactions");
  const knowledge = priorKnowledge(state, "transactions", budgetId);
  const txnState = state.transactions as Record<string, { server_knowledge?: number; since_date?: string }> | undefined;
  const priorSinceDate = txnState?.[budgetId]?.since_date;
  const scopeSince = stream?.time_range?.since?.slice(0, 10);
  // Use server-side since_date only on first run (no delta cursor yet).
  const sinceDate = knowledge == null ? scopeSince || priorSinceDate || undefined : undefined;

  // Build account_id → account_type map for convenience enrichment.
  const accountTypeById = new Map<string, string>();
  // Always re-fetch accounts summary for the type map. Small payload, negligible cost.
  try {
    const aRes = await ynab<YnabAccountsResponse>(`/budgets/${budgetId}/accounts`, token);
    for (const a of aRes.data.accounts) {
      accountTypeById.set(a.id, a.type);
    }
  } catch {
    /* non-fatal */
  }

  const res = await ynab<YnabTransactionsResponse>(`/budgets/${budgetId}/transactions`, token, {
    ...(knowledge === undefined ? {} : { knowledge }),
    ...(sinceDate === undefined ? {} : { sinceDate }),
  });
  let emittedTransactions = 0;
  for (const t of res.data.transactions) {
    if (!withinTimeRange(t.date, stream?.time_range)) {
      continue;
    }
    await trackAndEmit("transactions", transactionRecord(t, budgetId, accountTypeById));
    emittedTransactions++;
  }
  await progress(
    `Processed ${res.data.transactions.length} transactions for budget ${budgetId}; emitted ${emittedTransactions}`,
    {
      stream: "transactions",
      count: res.data.transactions.length,
      total: res.data.transactions.length,
    }
  );
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
  const { budgetId, token, state, newState, emit, trackAndEmit, progress } = ctx;
  await progress(`Fetching scheduled transactions for budget ${budgetId}`, {
    stream: "scheduled_transactions",
  });
  const knowledge = priorKnowledge(state, "scheduled_transactions", budgetId);
  const res = await ynab<YnabScheduledTransactionsResponse>(`/budgets/${budgetId}/scheduled_transactions`, token, {
    ...(knowledge === undefined ? {} : { knowledge }),
  });
  await progress(`Fetched ${res.data.scheduled_transactions.length} scheduled transactions for budget ${budgetId}`, {
    stream: "scheduled_transactions",
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
  const { budgetId, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  await progress(`Fetching months for budget ${budgetId}`, {
    stream: "months",
  });
  const knowledge = priorKnowledge(state, "months", budgetId);
  const res = await ynab<YnabMonthsResponse>(`/budgets/${budgetId}/months`, token, {
    ...(knowledge === undefined ? {} : { knowledge }),
  });
  const monthList = res.data.months;
  await progress(`Fetched ${monthList.length} months for budget ${budgetId}`, {
    stream: "months",
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

async function collectMonthCategories(
  ctx: BudgetCtx,
  monthList: YnabMonth[],
  monthCategoriesStream: { time_range?: TimeRange }
): Promise<void> {
  const { budgetId, token, state, newState, emit, trackAndEmit, progress } = ctx;
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
    await progress(`Fetching categories for budget ${budgetId} month ${m.month}`, {
      stream: "month_categories",
      count: i + 1,
      total: activeMonths.length,
    });
    const monthRes = await ynab<YnabMonthDetailResponse>(`/budgets/${budgetId}/months/${m.month}`, token);
    const monthDetail = monthRes.data.month;
    for (const c of monthDetail.categories ?? []) {
      await trackAndEmit("month_categories", monthCategoryRecord(c, m.month, budgetId));
    }
    if (!highestMonth || m.month > highestMonth) {
      highestMonth = m.month;
    }
  }
  await progress(`Fetched month categories for ${activeMonths.length} months in budget ${budgetId}`, {
    stream: "month_categories",
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
  if (requested.has("accounts")) {
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

runConnector({
  name: "ynab",
  retryablePattern: /rate_limited|ECONN|ETIMEDOUT|fetch failed/i,
  // YNAB marks deleted records with `deleted: true` in-band. Runtime strips
  // to { id } and emits with op: 'delete'.
  isTombstone: (_stream, d) => d.deleted === true,
  auth: { kind: "env", required: ["YNAB_PERSONAL_ACCESS_TOKEN"] },
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
    await progressWithCounters("Fetching budgets", { stream: "budgets" });
    const budgetsRes = await ynab<YnabBudgetsResponse>("/budgets", token);
    const budgets = budgetsRes.data.budgets;
    const budgetIds = budgets.map((b) => b.id);
    await progressWithCounters(`Fetched ${budgets.length} budgets`, {
      stream: "budgets",
      count: budgets.length,
      total: budgets.length,
    });

    if (requested.has("budgets")) {
      for (const b of budgets) {
        await trackAndEmit("budgets", budgetRecord(b));
      }
      await emit({
        type: "STATE",
        stream: "budgets",
        cursor: { fetched_at: nowIso() },
      });
      newState.budgets = { fetched_at: nowIso() };
    }

    for (const budgetId of budgetIds) {
      await collectForBudget({
        budgetId,
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
