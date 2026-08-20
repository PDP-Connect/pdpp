#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { isMainModule } from "@pdpp/connector-protocol";
import { redactTransportDetail } from "@pdpp/connector-protocol/http-retry";
import { type ConnectorHttpGovernor, createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import {
  type CollectContext,
  emitDetailCoverage,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { ynabPacingProfile } from "../../src/provider-profile.ts";
import { validateRecord } from "./schemas.ts";

const API_BASE = "https://api.ynab.com/v1";

// Single per-provider send governor + retry layer. `maxAttempts: 1` keeps the
// 429 throw byte-identical to the prior hand-rolled path (cross-run cooldown via
// `retryablePattern`); raising it activates the wired Retry-After honor.
// §3 ProviderProfile: ynab declares its own AUDITED pacing ceiling (20000ms ≈
// 3 req/min, set BELOW the 200-req/hour rolling sustained rate so even a long run
// stays under budget at the ceiling; a typical run is only tens of requests;
// WI-1b). NOT a borrow of ChatGPT's 250ms. See src/provider-profile.ts →
// ynabPacingProfile and docs/research/per-connector-rate-profiles-2026-06-13.md.
const httpGovernor = createConnectorHttpGovernor({
  name: "ynab",
  maxAttempts: 1,
  profile: ynabPacingProfile(),
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
  categories: YnabCategory[];
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireYnabObject<T extends object = Record<string, unknown>>(value: unknown, field: string): T {
  if (!isObjectRecord(value)) {
    throw new Error(`ynab_response_malformed: ${field} must be an object`);
  }
  return value as T;
}

function requireYnabArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`ynab_response_malformed: ${field} must be an array`);
  }
  return value as T[];
}

function parseCategoriesResponse(res: YnabCategoriesResponse): {
  categoryCount: number;
  categoryGroups: YnabCategoryGroup[];
} {
  const envelope = requireYnabObject(res, "wire envelope");
  const data = requireYnabObject(envelope.data, "data");
  const categoryGroups = requireYnabArray<YnabCategoryGroup>(data.category_groups, "data.category_groups");
  for (const [groupIndex, group] of categoryGroups.entries()) {
    if (!isObjectRecord(group)) {
      throw new Error(`ynab_response_malformed: data.category_groups[${String(groupIndex)}] must be an object`);
    }
    requireYnabArray<YnabCategory>(group.categories, `data.category_groups[${String(groupIndex)}].categories`);
  }
  return {
    categoryCount: categoryGroups.reduce((sum, group) => sum + group.categories.length, 0),
    categoryGroups,
  };
}

const BUDGET_ID_PATH_SEGMENT = /\/budgets\/[^/]+/;
const MONTH_PATH_SEGMENT = /\/months\/[^/]+$/;

/**
 * The stable, non-identifying shape of a request path, for terminal-error
 * attribution: `/budgets/{budget_id}/categories` rather than the live path.
 *
 * Which ENDPOINT failed is the diagnostic — one failing endpoint across every
 * budget is a different defect from one failing budget across every endpoint,
 * and the bare "HTTP request failed" message distinguished neither. The budget
 * UUID and the month are owner data, so they are templated out: a terminal
 * `message` is read by operators and must carry no account content (the
 * connectors' `message` vs `diagnostics` split).
 */
function endpointLabel(path: string): string {
  return path.replace(BUDGET_ID_PATH_SEGMENT, "/budgets/{budget_id}").replace(MONTH_PATH_SEGMENT, "/months/{month}");
}

/** Bound for the response-body diagnostic in a terminal message. */
const ERROR_DETAIL_MAX = 200;

/**
 * Reduce a non-2xx response body to a diagnostic safe for a terminal message.
 *
 * The body is attacker- and proxy-influenced text: YNAB's own errors are a small
 * closed envelope, but an intercepting proxy, a gateway error page, or a WAF can
 * return anything, and an echoed request URL or account content in that text
 * would land verbatim in a terminal DB row. Slicing to 200 chars bounded the size
 * and enforced nothing.
 *
 * Two layers, allowlist first:
 *
 *  1. YNAB documents `{ error: { id, name, detail } }`. When the body parses to
 *     that shape we emit only those fields — `id`/`name` are closed machine codes
 *     (`401`/`unauthorized`, `403.1`/`subscription_lapsed`) and are exactly what
 *     an operator needs. `detail` is free prose, so it still goes through the
 *     shared redactor rather than being trusted for being inside a known shape.
 *  2. Anything else — HTML, a proxy dump, malformed JSON — is not a shape we can
 *     reason about, so it is redacted wholesale and bounded.
 *
 * `redactTransportDetail` is reused deliberately: one deterministic sanitizer for
 * every third-party string that can reach terminal text, rather than a second
 * policy that drifts from the first.
 */
export function errorDetail(body: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const envelope =
    parsed && typeof parsed === "object" ? (parsed as { error?: Record<string, unknown> }).error : undefined;
  if (envelope && typeof envelope === "object") {
    const { id, name, detail } = envelope;
    const fields = [
      typeof id === "string" || typeof id === "number" ? `id=${String(id)}` : "",
      typeof name === "string" ? `name=${name}` : "",
      typeof detail === "string" && detail.length > 0 ? `detail=${detail}` : "",
    ].filter((field) => field.length > 0);
    if (fields.length > 0) {
      return redactTransportDetail(fields.join(" ")).slice(0, ERROR_DETAIL_MAX);
    }
  }
  return redactTransportDetail(body).slice(0, ERROR_DETAIL_MAX);
}

interface YnabRawResponse {
  body: string;
  headers?: Record<string, string | undefined>;
  status: number;
}

export type YnabRequest = <T>(
  path: string,
  token: string,
  options?: YnabFetchOptions,
  progress?: ProgressFn,
  extra?: Parameters<ProgressFn>[1]
) => Promise<T>;

export function createYnabRequest(governor: Pick<ConnectorHttpGovernor, "request">): YnabRequest {
  return async function request<T>(
    path: string,
    token: string,
    { knowledge, sinceDate }: YnabFetchOptions = {},
    progress?: ProgressFn,
    extra?: Parameters<ProgressFn>[1]
  ): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    if (knowledge !== undefined) {
      url.searchParams.set("last_knowledge_of_server", String(knowledge));
    }
    if (sinceDate) {
      url.searchParams.set("since_date", sinceDate);
    }
    let result: YnabRawResponse;
    try {
      const r = await governor.request<YnabRawResponse, YnabRawResponse>(
        async () => {
          const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          const retryAfter = res.headers.get("retry-after");
          return {
            body: await res.text().catch((): string => ""),
            ...(retryAfter === null ? {} : { headers: { "retry-after": retryAfter } }),
            status: res.status,
          };
        },
        (raw) => ({
          status: raw.status,
          ...(raw.headers === undefined ? {} : { headers: raw.headers }),
          value: raw,
        })
      );
      result = r.value;
    } catch (error) {
      // Terminal rate-limit: emit the same progress side-effect the hand-rolled
      // path did, then rethrow `ynab_rate_limited` for the cross-run contract.
      // The message is the whole contract here — the runtime pattern-matches it —
      // so it is rethrown untouched.
      if (error instanceof Error && error.message === "ynab_rate_limited") {
        await progress?.("YNAB request rate limited", { ...extra, phase: "rate_limit", rate_limit_pressure: 1 });
        throw error;
      }
      // Every other governor throw (transport fault, exhausted retryable status)
      // reaches the owner as the terminal error. The retry layer folds in the
      // transport cause; only this frame knows WHICH endpoint failed, so it is
      // attached here. `endpointLabel` is the templated path — never the resolved
      // URL, which carries no token today but would silently start leaking one if
      // YNAB ever moved to a query-string credential.
      if (error instanceof Error) {
        throw new Error(`${error.message} [endpoint ${endpointLabel(path)}]`, { cause: error });
      }
      throw error;
    }
    if (result.status === 401) {
      throw new Error("ynab_auth_failed");
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `ynab_http_${String(result.status)} [endpoint ${endpointLabel(path)}]: ${errorDetail(result.body)}`
      );
    }
    return JSON.parse(result.body) as T;
  };
}

export const ynab = createYnabRequest(httpGovernor);

/**
 * The shape of `ynab<T>()`, extracted so `ynabCollect` and every per-budget
 * collector can take it as an injected dependency instead of calling the
 * module-level `ynab` directly. Production always defaults to `ynab` itself
 * (below); tests supply a deterministic fake that returns fixture data
 * synchronously, never touching `httpGovernor` or `fetch` — so a test run
 * incurs none of `ynabPacingProfile()`'s real per-request pacing floor.
 */
const YNAB_RETRYABLE_PATTERN = /rate_limited|ECONN|ETIMEDOUT|fetch failed|retryable status \d+/i;

/**
 * Keep retryable failures from the optional account-type enrichment request
 * visible to the outer run. A transient failure there still consumed a YNAB
 * request and must not be relabeled as a successful transaction collection.
 * Permanent endpoint errors remain non-fatal because the transaction payload
 * itself is still useful without account-type enrichment.
 */
export function isYnabRetryableError(error: unknown): boolean {
  return error instanceof Error && YNAB_RETRYABLE_PATTERN.test(error.message);
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

type EmitFn = CollectContext["emit"];

type TrackedEmitRecord = (stream: string, data: RecordData) => Promise<void>;

interface CoverageFact {
  considered: number;
  covered: number;
  enumeratedFresh: boolean;
}

function coverageForRecords(stream: string, records: readonly RecordData[], enumeratedFresh = false): CoverageFact {
  return {
    considered: records.length,
    covered: records.reduce((count, record) => count + (validateRecord(stream, record).ok ? 1 : 0), 0),
    enumeratedFresh,
  };
}

function aggregateCoverageFacts(facts: readonly CoverageFact[]): CoverageFact | null {
  if (facts.length === 0) {
    return null;
  }
  return facts.reduce(
    (total, fact) => ({
      considered: total.considered + fact.considered,
      covered: total.covered + fact.covered,
      enumeratedFresh: total.enumeratedFresh && fact.enumeratedFresh,
    }),
    { considered: 0, covered: 0, enumeratedFresh: true }
  );
}

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
  request: YnabRequest;
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

/**
 * One budget's contribution to the whole-stream self-coverage proof for
 * `accounts` and/or `account_stats` (both fetched from the same
 * `/budgets/{id}/accounts` call).
 *
 * Unlike `categories`/`payees`/`transactions`/`months`, `collectAccounts`
 * never passes a `server_knowledge` cursor — it always walks the full
 * account list, same as `payee_locations`/`scheduled_transactions` (and
 * matching `collectTransactions`'s own unconditional `/accounts` refetch for
 * its type map). `/accounts` returns no separate total-boundary count
 * alongside a delta payload, so a `knowledge`-scoped call could never measure
 * `considered` at all — only a full walk can. This costs nothing extra:
 * `/accounts` is one request per budget either way (see
 * `collectScheduledTransactions`'s "One request per budget" comment for the
 * same reasoning applied to that endpoint), so always requesting the full
 * list keeps `accounts`/`account_stats` provable on every run, not just a
 * connection's first ever run.
 *
 * `accountsCovered`/`accountStatsCovered` follow the `budgets`/usaa/
 * `scheduled_transactions` precedent: emitted-and-valid plus
 * suppressed-because-unchanged, tallied at the per-record loop from
 * `validateRecord` (the same shape-check the runtime's real emitRecord
 * applies) — never aliased to the emitted count, so a steady-state
 * (all-suppressed) run still reads `covered === considered`, while a row
 * this run attempted and the runtime silently SKIPped for a bad shape is
 * never claimed as covered. A suppressed-unchanged row is counted without
 * re-validating: its fingerprint can only exist because an earlier run's
 * identical content already passed the real emitRecord shape-check.
 *
 * `undefined` on `accountsCovered`/`accountStatsCovered` means that stream
 * was not requested this run — the aggregate must not fabricate a zero for
 * an unrequested stream.
 */
export interface AccountsBudgetFact {
  accountStatsCovered?: number;
  accountsCovered?: number;
  budgetId: string;
  considered: number;
}

interface EmitAccountsAndStatsArgs {
  accounts: readonly YnabAccount[];
  budgetId: string;
  entityCursor: FingerprintCursor;
  observedOn: string;
  trackAndEmit: TrackedEmitRecord;
  wantsEntity: boolean;
  wantsStats: boolean;
}

/**
 * Per-record loop for `collectAccounts`: emits (or suppresses-as-unchanged)
 * the `accounts` entity record and/or the `account_stats` observation record
 * for each returned account, tallying `covered` for each requested stream.
 *
 * Covered tallies are measured here, never aliased to the emitted count (see
 * `AccountsBudgetFact` doc comment). A record the fingerprint cursor
 * suppresses as unchanged is counted without re-validating: its fingerprint
 * can only exist because an earlier run's `shouldEmit` was true for the
 * identical content, which passed through trackAndEmit's real
 * (shape-checking) emitRecord at that time. A record attempted THIS run
 * (shouldEmit true) is gated on `validateRecord` — mirroring
 * `collectScheduledTransactions` — so a row the runtime silently SKIPs for a
 * bad shape is never claimed as covered.
 */
async function emitAccountsAndStats({
  accounts,
  budgetId,
  entityCursor,
  observedOn,
  trackAndEmit,
  wantsEntity,
  wantsStats,
}: EmitAccountsAndStatsArgs): Promise<{ accountStatsCovered: number; accountsCovered: number }> {
  let accountsCovered = 0;
  let accountStatsCovered = 0;
  for (const a of accounts) {
    if (wantsEntity) {
      const entityRec = accountRecord(a, budgetId);
      if (entityCursor.shouldEmit(entityRec)) {
        if (validateRecord("accounts", entityRec).ok) {
          accountsCovered += 1;
        }
        await trackAndEmit("accounts", entityRec);
      } else {
        accountsCovered += 1;
      }
    }
    // Observation stream: append-keyed daily balance snapshot. Emitted
    // unconditionally for returned accounts; the date-scoped key + runtime
    // byte-equivalence make same-day same-balance re-emits idempotent.
    if (wantsStats) {
      const statsRec = accountStatsRecord(a, budgetId, observedOn);
      if (validateRecord("account_stats", statsRec).ok) {
        accountStatsCovered += 1;
      }
      await trackAndEmit("account_stats", statsRec);
    }
  }
  return { accountStatsCovered, accountsCovered };
}

async function collectAccounts(ctx: BudgetCtx): Promise<AccountsBudgetFact> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  await progress("Fetching YNAB accounts window", {
    stream: "accounts",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: false,
  });
  const requestExtra = {
    stream: "accounts",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: false,
  };
  const res = await request<YnabAccountsResponse>(`/budgets/${budgetId}/accounts`, token, {}, progress, requestExtra);
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

  // Entity stream: gate on a per-record fingerprint so an unchanged account
  // is not re-emitted. `/accounts` is now always a full-collection call (see
  // AccountsBudgetFact doc comment), so an id absent this run was genuinely
  // deleted at the source — prune so a future re-creation triggers a fresh
  // emit instead of silently no-opping against a stale fingerprint. A real
  // deletion also arrives as a returned record with `deleted: true`, which
  // the fingerprint treats as a normal field change.
  const entityCursor = openAccountCursor(state, budgetId);
  const wantsEntity = requested.has("accounts");
  const wantsStats = requested.has("account_stats");
  const observedOn = nowIso().slice(0, 10);
  const { accountsCovered, accountStatsCovered } = await emitAccountsAndStats({
    accounts: res.data.accounts,
    budgetId,
    entityCursor,
    observedOn,
    trackAndEmit,
    wantsEntity,
    wantsStats,
  });

  if (wantsEntity) {
    entityCursor.pruneStale();
    const accounts =
      (newState.accounts as
        | Record<string, { server_knowledge: number; fingerprints?: Record<string, string> }>
        | undefined) ?? {};
    accounts[budgetId] = { server_knowledge: res.data.server_knowledge, fingerprints: entityCursor.toState() };
    newState.accounts = accounts;
    await emit({ type: "STATE", stream: "accounts", cursor: newState.accounts });
  } else {
    const accounts = (newState.accounts as Record<string, { server_knowledge: number }> | undefined) ?? {};
    accounts[budgetId] = { ...accounts[budgetId], server_knowledge: res.data.server_knowledge };
    newState.accounts = accounts;
    await emit({ type: "STATE", stream: "accounts", cursor: newState.accounts });
  }

  if (wantsStats) {
    await emit({ type: "STATE", stream: "account_stats", cursor: { observed_on: observedOn, fetched_at: nowIso() } });
  }

  return {
    budgetId,
    considered: res.data.accounts.length,
    ...(wantsEntity ? { accountsCovered } : {}),
    ...(wantsStats ? { accountStatsCovered } : {}),
  };
}

/**
 * Aggregate per-budget `AccountsBudgetFact`s into the whole-stream
 * self-coverage proof for `accounts` and, separately, `account_stats`. Every
 * fact already reflects a full-boundary walk (see `AccountsBudgetFact` doc
 * comment — `collectAccounts` never sends a delta cursor), so no freshness
 * gate is needed; this mirrors `aggregatePayeeLocationsCoverage`. Returns
 * `null` for a stream that had no facts (wasn't requested by any budget, or
 * zero budgets ran).
 */
export function aggregateAccountsCoverage(facts: readonly AccountsBudgetFact[]): {
  accountStats: { considered: number; covered: number } | null;
  accounts: { considered: number; covered: number } | null;
} {
  const accountsFacts = facts.filter((f) => f.accountsCovered !== undefined);
  const accounts =
    accountsFacts.length > 0
      ? {
          considered: accountsFacts.reduce((sum, f) => sum + f.considered, 0),
          covered: accountsFacts.reduce((sum, f) => sum + (f.accountsCovered ?? 0), 0),
        }
      : null;

  const statsFacts = facts.filter((f) => f.accountStatsCovered !== undefined);
  const accountStats =
    statsFacts.length > 0
      ? {
          considered: statsFacts.reduce((sum, f) => sum + f.considered, 0),
          covered: statsFacts.reduce((sum, f) => sum + (f.accountStatsCovered ?? 0), 0),
        }
      : null;

  return { accounts, accountStats };
}

export async function collectCategoriesAndGroups(ctx: BudgetCtx): Promise<{
  categoryGroups: CoverageFact;
  categories: CoverageFact;
}> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
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
  let res = await request<YnabCategoriesResponse>(
    `/budgets/${budgetId}/categories`,
    token,
    knowledge === undefined ? {} : { knowledge },
    progress,
    requestExtra
  );
  let parsed = parseCategoriesResponse(res);
  let enumeratedFresh = knowledge === undefined;
  if (!enumeratedFresh && (parsed.categoryGroups.length === 0 || parsed.categoryCount === 0)) {
    res = await request<YnabCategoriesResponse>(`/budgets/${budgetId}/categories`, token, {}, progress, {
      ...requestExtra,
      cursor_present: false,
    });
    parsed = parseCategoriesResponse(res);
    enumeratedFresh = true;
  }
  const { categoryCount, categoryGroups } = parsed;
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
  const categoryGroupRecords: RecordData[] = [];
  const categoryRecords: RecordData[] = [];
  for (const group of categoryGroups) {
    if (requested.has("category_groups")) {
      const record = categoryGroupRecord(group, budgetId);
      categoryGroupRecords.push(record);
      await trackAndEmit("category_groups", record);
    }
    if (requested.has("categories")) {
      for (const c of group.categories) {
        const record = categoryRecord(c, group, budgetId);
        categoryRecords.push(record);
        await trackAndEmit("categories", record);
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
  // `category_groups` is co-fetched from the same `/categories` response and
  // advances on the identical durable receipt. Stage its own STATE checkpoint
  // so the runtime records a committed checkpoint for the stream.
  if (requested.has("category_groups")) {
    const groups = (newState.category_groups as Record<string, { server_knowledge: number }> | undefined) ?? {};
    groups[budgetId] = { server_knowledge: res.data.server_knowledge };
    newState.category_groups = groups;
    await emit({
      type: "STATE",
      stream: "category_groups",
      cursor: newState.category_groups,
    });
  }
  return {
    categoryGroups: coverageForRecords("category_groups", categoryGroupRecords, enumeratedFresh),
    categories: coverageForRecords("categories", categoryRecords, enumeratedFresh),
  };
}

async function collectPayees(ctx: BudgetCtx): Promise<CoverageFact> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, emit, trackAndEmit, progress } = ctx;
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
  let res = await request<YnabPayeesResponse>(
    `/budgets/${budgetId}/payees`,
    token,
    knowledge === undefined ? {} : { knowledge },
    progress,
    requestExtra
  );
  let enumeratedFresh = knowledge === undefined;
  if (!enumeratedFresh && res.data.payees.length === 0) {
    res = await request<YnabPayeesResponse>(`/budgets/${budgetId}/payees`, token, {}, progress, {
      ...requestExtra,
      cursor_present: false,
    });
    enumeratedFresh = true;
  }
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
  const records = res.data.payees.map((p) => payeeRecord(p, budgetId));
  for (const record of records) {
    await trackAndEmit("payees", record);
  }
  const payees = (newState.payees as Record<string, { server_knowledge: number }> | undefined) ?? {};
  payees[budgetId] = { server_knowledge: res.data.server_knowledge };
  newState.payees = payees;
  await emit({ type: "STATE", stream: "payees", cursor: newState.payees });
  return coverageForRecords("payees", records, enumeratedFresh);
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

/**
 * One budget's contribution to the whole-stream `payee_locations`
 * self-coverage proof. Unlike `accounts`/`scheduled_transactions`,
 * `/payee_locations` carries no `server_knowledge` delta — it is a true
 * full-collection endpoint on every call — so no freshness gating is needed;
 * every call measures the full boundary.
 *
 * `covered` is emitted-and-valid plus suppressed-because-unchanged, tallied
 * at the per-record loop via `validateRecord` (mirroring
 * `scheduled_transactions`) — never aliased to the emitted count, so a
 * steady-state run still reads `covered === considered`, while a
 * newly-attempted row the runtime silently SKIPs for a bad shape is never
 * claimed as covered.
 */
export interface PayeeLocationsBudgetFact {
  budgetId: string;
  considered: number;
  covered: number;
}

async function collectPayeeLocations(ctx: BudgetCtx): Promise<PayeeLocationsBudgetFact> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, emit, trackAndEmit, progress } = ctx;
  await progress("Fetching YNAB payee locations window", {
    stream: "payee_locations",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: false,
  });
  const res = await request<YnabPayeeLocationsResponse>(`/budgets/${budgetId}/payee_locations`, token, {}, progress, {
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
  // covered tallies emitted + suppressed-unchanged, measured at the loop
  // (see PayeeLocationsBudgetFact doc comment).
  let covered = 0;
  for (const loc of res.data.payee_locations) {
    const record = payeeLocationRecord(loc, budgetId);
    if (!cursor.shouldEmit(record)) {
      // Suppressed as unchanged: its fingerprint can only exist because an
      // earlier run's identical content already passed the real emitRecord
      // shape-check.
      covered += 1;
      continue;
    }
    if (validateRecord("payee_locations", record).ok) {
      covered += 1;
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
  return { budgetId, considered: res.data.payee_locations.length, covered };
}

/**
 * Aggregate per-budget `PayeeLocationsBudgetFact`s into the whole-stream
 * `payee_locations` self-coverage proof. No freshness gate is needed (see
 * `PayeeLocationsBudgetFact` doc comment); every budget that ran contributes
 * a measured boundary.
 */
export function aggregatePayeeLocationsCoverage(
  facts: readonly PayeeLocationsBudgetFact[]
): { considered: number; covered: number } | null {
  if (facts.length === 0) {
    return null;
  }
  return {
    considered: facts.reduce((sum, f) => sum + f.considered, 0),
    covered: facts.reduce((sum, f) => sum + f.covered, 0),
  };
}

async function collectTransactions(ctx: BudgetCtx): Promise<CoverageFact> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  const stream = requested.get("transactions");
  const knowledge = priorKnowledge(state, "transactions", budgetId);
  const txnState = state.transactions as Record<string, { server_knowledge?: number; since_date?: string }> | undefined;
  const priorSinceDate = txnState?.[budgetId]?.since_date;
  const scopeSince = stream?.time_range?.since?.slice(0, 10);
  const sinceDate = knowledge === undefined ? scopeSince || priorSinceDate || undefined : undefined;
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
    const aRes = await request<YnabAccountsResponse>(`/budgets/${budgetId}/accounts`, token, {}, progress, {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined || sinceDate !== undefined,
    });
    for (const a of aRes.data.accounts) {
      accountTypeById.set(a.id, a.type);
    }
  } catch (error) {
    if (isYnabRetryableError(error)) {
      throw error;
    }
  }

  let res = await request<YnabTransactionsResponse>(
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
  let enumeratedFresh = knowledge === undefined;
  if (!enumeratedFresh && res.data.transactions.length === 0) {
    res = await request<YnabTransactionsResponse>(`/budgets/${budgetId}/transactions`, token, {}, progress, {
      stream: "transactions",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: false,
    });
    enumeratedFresh = true;
  }
  let emittedTransactions = 0;
  const records: RecordData[] = [];
  for (const t of res.data.transactions) {
    if (!withinTimeRange(t.date, stream?.time_range)) {
      continue;
    }
    const record = transactionRecord(t, budgetId, accountTypeById);
    records.push(record);
    await trackAndEmit("transactions", record);
    emittedTransactions += 1;
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
  txns[budgetId] = {
    server_knowledge: res.data.server_knowledge,
    ...(sinceDate === undefined ? {} : { since_date: sinceDate }),
  };
  newState.transactions = txns;
  await emit({
    type: "STATE",
    stream: "transactions",
    cursor: newState.transactions,
  });
  return coverageForRecords("transactions", records, enumeratedFresh);
}

/**
 * One budget's contribution to the `scheduled_transactions` whole-stream
 * coverage proof. A delta response can prove nonzero coverage, but an empty
 * delta response is reconciled with one uncursored walk before it can prove a
 * source boundary.
 */
export interface ScheduledTransactionsBudgetFact {
  budgetId: string;
  /** Rows this call's response held — the enumerated boundary size. */
  considered: number;
  /**
   * Rows this run objectively accounted for (validated + emitted) — NEVER
   * aliased to `considered`. A row present in the response is "considered"
   * but not automatically "covered": `validateRecord` (the same shape-check
   * the runtime's emitRecord applies) can reject a malformed row, in which
   * case it never emits and must not be claimed as covered — else the proof
   * would overclaim coverage of a row that was in fact dropped.
   */
  covered: number;
  enumeratedFresh: boolean;
}

export async function collectScheduledTransactions(ctx: BudgetCtx): Promise<ScheduledTransactionsBudgetFact> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "scheduled_transactions", budgetId);
  await progress("Fetching YNAB scheduled transactions window", {
    stream: "scheduled_transactions",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  let res = await request<YnabScheduledTransactionsResponse>(
    `/budgets/${budgetId}/scheduled_transactions`,
    token,
    knowledge === undefined ? {} : { knowledge },
    progress,
    {
      stream: "scheduled_transactions",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined,
    }
  );
  let enumeratedFresh = knowledge === undefined;
  if (!enumeratedFresh && res.data.scheduled_transactions.length === 0) {
    res = await request<YnabScheduledTransactionsResponse>(
      `/budgets/${budgetId}/scheduled_transactions`,
      token,
      {},
      progress,
      {
        stream: "scheduled_transactions",
        phase: "fetch",
        offset_ordinal: budgetOrdinal,
        cursor_present: false,
      }
    );
    enumeratedFresh = true;
  }
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
  // `covered` must equal what this run objectively accounted for — never
  // aliased to the raw response length. A row present in
  // `res.data.scheduled_transactions` is "considered" but not automatically
  // "covered": `validateRecord` (the same shape-check the runtime's
  // emitRecord applies) can reject a malformed row, in which case it never
  // emits and must not be claimed as covered either. `id` is a required
  // string on `YnabScheduledTransaction`, so unlike the runtime's generic
  // emitRecord gate, no separate null-id check is needed here.
  let covered = 0;
  for (const s of res.data.scheduled_transactions) {
    const record = scheduledTransactionRecord(s, budgetId);
    if (validateRecord("scheduled_transactions", record).ok) {
      covered += 1;
    }
    await trackAndEmit("scheduled_transactions", record);
  }
  // Emit STATE with server_knowledge as durable receipt (not a future delta cursor).
  const scheduled = (newState.scheduled_transactions as Record<string, { server_knowledge: number }> | undefined) ?? {};
  scheduled[budgetId] = { server_knowledge: res.data.server_knowledge };
  newState.scheduled_transactions = scheduled;
  await emit({
    type: "STATE",
    stream: "scheduled_transactions",
    cursor: newState.scheduled_transactions,
  });
  return {
    budgetId,
    considered: res.data.scheduled_transactions.length,
    covered,
    enumeratedFresh,
  };
}

/**
 * Aggregate per-budget `scheduled_transactions` facts into the whole-stream
 * self-coverage proof. Nonzero delta facts remain usable, while a zero fact is
 * emitted only when every budget performed the uncursored reconciliation.
 *
 * `considered` and `covered` are summed independently, never aliased to one
 * another: a per-budget row that failed `validateRecord` raises that
 * budget's `considered` (the API said it existed) without raising `covered`
 * (it was never emitted), so a run with any rejected row honestly reads
 * `partial` rather than a false `complete`.
 */
export function aggregateScheduledTransactionsCoverage(
  facts: readonly ScheduledTransactionsBudgetFact[]
): { considered: number; covered: number } | null {
  if (facts.length === 0) {
    return null;
  }
  return {
    considered: facts.reduce((sum, f) => sum + f.considered, 0),
    covered: facts.reduce((sum, f) => sum + f.covered, 0),
  };
}

async function fetchMonthsIfNeeded(
  ctx: BudgetCtx,
  shouldFetch: boolean
): Promise<{ enumeratedFresh: boolean; fullScanForDetails: boolean; monthList: YnabMonth[] } | null> {
  if (!shouldFetch) {
    return null;
  }
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, requested, emit, trackAndEmit, progress } = ctx;
  const knowledge = priorKnowledge(state, "months", budgetId);
  const fullScanForDetails = knowledge === undefined;
  await progress("Fetching YNAB months window", {
    stream: "months",
    phase: "fetch",
    offset_ordinal: budgetOrdinal,
    cursor_present: knowledge !== undefined,
  });
  let res = await request<YnabMonthsResponse>(
    `/budgets/${budgetId}/months`,
    token,
    knowledge === undefined ? {} : { knowledge },
    progress,
    {
      stream: "months",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: knowledge !== undefined,
    }
  );
  let enumeratedFresh = knowledge === undefined;
  if (!enumeratedFresh && res.data.months.length === 0) {
    res = await request<YnabMonthsResponse>(`/budgets/${budgetId}/months`, token, {}, progress, {
      stream: "months",
      phase: "fetch",
      offset_ordinal: budgetOrdinal,
      cursor_present: false,
    });
    enumeratedFresh = true;
  }
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
  return { monthList, enumeratedFresh, fullScanForDetails };
}

interface MonthStreamFacts {
  monthCategories?: CoverageFact;
  months?: CoverageFact;
}

async function collectMonthStreams(ctx: BudgetCtx): Promise<MonthStreamFacts> {
  const monthsStream = ctx.requested.get("months");
  const monthCategoriesStream = ctx.requested.get("month_categories");
  const monthFetch = await fetchMonthsIfNeeded(ctx, Boolean(monthsStream || monthCategoriesStream));
  if (!monthFetch) {
    return {};
  }
  const { enumeratedFresh, fullScanForDetails, monthList } = monthFetch;

  const facts: MonthStreamFacts = {};
  if (monthsStream) {
    facts.months = coverageForRecords(
      "months",
      monthList.map((month) => monthRecord(month, ctx.budgetId)),
      enumeratedFresh
    );
  }
  if (monthCategoriesStream) {
    facts.monthCategories = await collectMonthCategories(
      ctx,
      monthList,
      monthCategoriesStream,
      fetchMonthDetail,
      enumeratedFresh,
      fullScanForDetails
    );
  }
  return facts;
}

type MonthDetailFetcher = (budgetId: string, month: string, token: string, request: YnabRequest) => Promise<YnabMonth>;

async function fetchMonthDetail(
  budgetId: string,
  month: string,
  token: string,
  request: YnabRequest
): Promise<YnabMonth> {
  const monthRes = await request<YnabMonthDetailResponse>(`/budgets/${budgetId}/months/${month}`, token);
  const envelope = requireYnabObject(monthRes, "wire envelope");
  const data = requireYnabObject(envelope.data, "data");
  const responseMonth = requireYnabObject<YnabMonth>(data.month, "data.month");
  requireYnabArray<YnabCategory>(responseMonth.categories, "data.month.categories");
  return responseMonth;
}

export async function collectMonthCategories(
  ctx: BudgetCtx,
  monthList: YnabMonth[],
  monthCategoriesStream: { time_range?: TimeRange },
  fetchMonth: MonthDetailFetcher = fetchMonthDetail,
  enumeratedFresh = false,
  fullScanForDetails = enumeratedFresh
): Promise<CoverageFact> {
  const { budgetId, budgetOrdinal = 0, request, token, state, newState, emit, trackAndEmit, progress } = ctx;
  const priorCutoff = state.month_categories as Record<string, { last_fetched_month?: string }> | undefined;
  const lastFetchedMonth = priorCutoff?.[ctx.budgetId]?.last_fetched_month;
  const scopeSince = monthCategoriesStream.time_range?.since?.slice(0, 10);
  // Active months: exclude soft-deleted and apply the requested time range.
  const activeMonths = monthList.filter((m) => {
    if (m.deleted) {
      return false;
    }
    if (!withinTimeRange(m.month, monthCategoriesStream.time_range)) {
      return false;
    }
    return fullScanForDetails || lastFetchedMonth === undefined || m.month >= lastFetchedMonth;
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

  let highestMonth: string | null = fullScanForDetails ? scopeSince || null : lastFetchedMonth || scopeSince || null;
  const records: RecordData[] = [];
  for (let i = 0; i < activeMonths.length; i += 1) {
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
      cursor_present: Boolean((fullScanForDetails ? scopeSince : lastFetchedMonth) || scopeSince),
    });
    const monthDetail = await fetchMonth(budgetId, m.month, token, request);
    const monthObject = requireYnabObject(monthDetail, "data.month");
    const monthCategories = requireYnabArray<YnabCategory>(monthObject.categories, "data.month.categories");
    for (const c of monthCategories) {
      const record = monthCategoryRecord(c, m.month, budgetId);
      records.push(record);
      await trackAndEmit("month_categories", record);
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
  return coverageForRecords("month_categories", records, enumeratedFresh);
}

interface CollectForBudgetFacts {
  accounts?: AccountsBudgetFact;
  categories?: CoverageFact;
  categoryGroups?: CoverageFact;
  monthCategories?: CoverageFact;
  months?: CoverageFact;
  payeeLocations?: PayeeLocationsBudgetFact;
  payees?: CoverageFact;
  scheduledTransactions?: ScheduledTransactionsBudgetFact;
  transactions?: CoverageFact;
}

async function collectForBudget(ctx: BudgetCtx): Promise<CollectForBudgetFacts> {
  const { requested } = ctx;
  let accounts: AccountsBudgetFact | undefined;
  let categories: CoverageFact | undefined;
  let categoryGroups: CoverageFact | undefined;
  let payees: CoverageFact | undefined;
  let transactions: CoverageFact | undefined;
  if (requested.has("accounts") || requested.has("account_stats")) {
    accounts = await collectAccounts(ctx);
  }
  if (requested.has("categories") || requested.has("category_groups")) {
    ({ categories, categoryGroups } = await collectCategoriesAndGroups(ctx));
  }
  if (requested.has("payees")) {
    payees = await collectPayees(ctx);
  }
  let payeeLocations: PayeeLocationsBudgetFact | undefined;
  if (requested.has("payee_locations")) {
    payeeLocations = await collectPayeeLocations(ctx);
  }
  if (requested.has("transactions")) {
    transactions = await collectTransactions(ctx);
  }
  let scheduledTransactions: ScheduledTransactionsBudgetFact | undefined;
  if (requested.has("scheduled_transactions")) {
    scheduledTransactions = await collectScheduledTransactions(ctx);
  }

  const { months, monthCategories } = await collectMonthStreams(ctx);

  return {
    ...(accounts === undefined ? {} : { accounts }),
    ...(categories === undefined ? {} : { categories }),
    ...(categoryGroups === undefined ? {} : { categoryGroups }),
    ...(monthCategories === undefined ? {} : { monthCategories }),
    ...(months === undefined ? {} : { months }),
    ...(payeeLocations === undefined ? {} : { payeeLocations }),
    ...(payees === undefined ? {} : { payees }),
    ...(scheduledTransactions === undefined ? {} : { scheduledTransactions }),
    ...(transactions === undefined ? {} : { transactions }),
  };
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
    if (!validateRecord("budgets", record).ok) {
      continue;
    }
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

/**
 * Emit a whole-stream self-coverage DETAIL_COVERAGE for one aggregated
 * `{ considered, covered }` pair, or do nothing when the stream wasn't
 * requested (`aggregate` passed as `null`) or the aggregator withheld proof
 * (e.g. a stray non-fresh budget, or zero budgets ran — see
 * `aggregateAccountsCoverage`/`aggregatePayeeLocationsCoverage`/
 * `aggregateScheduledTransactionsCoverage`). Centralizes the identical
 * `stream === stateStream`, empty-key-sets shape shared by every
 * required-by-default whole-stream proof in this connector.
 */
async function emitWholeStreamCoverage(
  emit: CollectContext["emit"],
  stream: string,
  aggregate: { considered: number; covered: number; enumeratedFresh?: boolean } | null,
  enumeratedFresh = aggregate?.enumeratedFresh ?? false
): Promise<void> {
  if (!aggregate) {
    return;
  }
  if (aggregate.considered === 0 && !enumeratedFresh) {
    return;
  }
  await emitDetailCoverage(
    { emit },
    {
      stream,
      stateStream: stream,
      requiredKeys: [],
      hydratedKeys: [],
      considered: aggregate.considered,
      covered: aggregate.covered,
    }
  );
}

interface YnabCoverageFacts {
  accounts: AccountsBudgetFact[];
  categories: CoverageFact[];
  categoryGroups: CoverageFact[];
  monthCategories: CoverageFact[];
  months: CoverageFact[];
  payeeLocations: PayeeLocationsBudgetFact[];
  payees: CoverageFact[];
  scheduledTransactions: ScheduledTransactionsBudgetFact[];
  transactions: CoverageFact[];
}

function appendBudgetFacts(collection: YnabCoverageFacts, facts: CollectForBudgetFacts): void {
  if (facts.accounts) {
    collection.accounts.push(facts.accounts);
  }
  if (facts.categories) {
    collection.categories.push(facts.categories);
  }
  if (facts.categoryGroups) {
    collection.categoryGroups.push(facts.categoryGroups);
  }
  if (facts.monthCategories) {
    collection.monthCategories.push(facts.monthCategories);
  }
  if (facts.months) {
    collection.months.push(facts.months);
  }
  if (facts.payeeLocations) {
    collection.payeeLocations.push(facts.payeeLocations);
  }
  if (facts.payees) {
    collection.payees.push(facts.payees);
  }
  if (facts.scheduledTransactions) {
    collection.scheduledTransactions.push(facts.scheduledTransactions);
  }
  if (facts.transactions) {
    collection.transactions.push(facts.transactions);
  }
}

async function emitYnabCoverage(
  emit: CollectContext["emit"],
  requested: ReadonlyMap<string, unknown>,
  facts: YnabCoverageFacts
): Promise<void> {
  if (requested.has("accounts") || requested.has("account_stats")) {
    const { accounts, accountStats } = aggregateAccountsCoverage(facts.accounts);
    await emitWholeStreamCoverage(emit, "accounts", requested.has("accounts") ? accounts : null, true);
    await emitWholeStreamCoverage(emit, "account_stats", requested.has("account_stats") ? accountStats : null, true);
  }

  if (requested.has("payee_locations")) {
    await emitWholeStreamCoverage(emit, "payee_locations", aggregatePayeeLocationsCoverage(facts.payeeLocations), true);
  }
  if (requested.has("category_groups")) {
    await emitWholeStreamCoverage(emit, "category_groups", aggregateCoverageFacts(facts.categoryGroups));
  }
  if (requested.has("categories")) {
    await emitWholeStreamCoverage(emit, "categories", aggregateCoverageFacts(facts.categories));
  }
  if (requested.has("payees")) {
    await emitWholeStreamCoverage(emit, "payees", aggregateCoverageFacts(facts.payees));
  }
  if (requested.has("transactions")) {
    await emitWholeStreamCoverage(emit, "transactions", aggregateCoverageFacts(facts.transactions));
  }
  if (requested.has("months")) {
    await emitWholeStreamCoverage(emit, "months", aggregateCoverageFacts(facts.months));
  }
  if (requested.has("month_categories")) {
    await emitWholeStreamCoverage(emit, "month_categories", aggregateCoverageFacts(facts.monthCategories));
  }
  if (requested.has("scheduled_transactions")) {
    await emitWholeStreamCoverage(
      emit,
      "scheduled_transactions",
      aggregateScheduledTransactionsCoverage(facts.scheduledTransactions),
      facts.scheduledTransactions.length > 0 && facts.scheduledTransactions.every((fact) => fact.enumeratedFresh)
    );
  }
}

/**
 * The production `collect()` callback `runConnector` invokes. Extracted to a
 * named export so integration tests can drive the exact same top-level
 * orchestration (budgets fetch → per-budget loop → whole-stream coverage
 * aggregation) that a real run executes, rather than re-implementing a
 * parallel path that could silently diverge from production.
 *
 * `request` is the sole seam for a deterministic test double: it defaults to
 * the real governed `ynab()` (pacing + retry via the module-level
 * `httpGovernor`), and every downstream fetch — including the ones inside
 * `collectForBudget`/`fetchMonthDetail` — flows through this single injected
 * function via `BudgetCtx.request`. A test override never touches the
 * governor or `fetch`, so a fixture-driven run incurs none of
 * `ynabPacingProfile()`'s real per-request pacing floor. This is a plain
 * function-injection seam — no test-only env flag, no mutable global, no
 * parallel orchestration.
 */
export async function ynabCollect(
  { state, requested, credentials, emit, emitRecord: runtimeEmitRecord, progress }: CollectContext,
  request: YnabRequest = ynab
): Promise<void> {
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
    if (data.id !== null && data.id !== undefined) {
      emittedIds.get(stream)?.add(String(data.id));
    }
    return runtimeEmitRecord(stream, data);
  };
  const progressWithCounters: ProgressFn = progress;

  // 1. Budgets — always fetched; needed to enumerate downstream streams.
  await progressWithCounters("Fetching budgets", { stream: "budgets", phase: "fetch", cursor_present: false });
  const budgetsRes = await request<YnabBudgetsResponse>("/budgets", token, {}, progressWithCounters, {
    stream: "budgets",
    phase: "fetch",
    cursor_present: false,
  });
  const { budgets } = budgetsRes.data;
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

  const coverageFacts: YnabCoverageFacts = {
    accounts: [],
    categories: [],
    categoryGroups: [],
    monthCategories: [],
    months: [],
    payeeLocations: [],
    payees: [],
    scheduledTransactions: [],
    transactions: [],
  };
  for (let budgetOrdinal = 0; budgetOrdinal < budgetIds.length; budgetOrdinal += 1) {
    const budgetId = budgetIds[budgetOrdinal];
    if (!budgetId) {
      continue;
    }
    const facts = await collectForBudget({
      budgetId,
      budgetOrdinal,
      request,
      token,
      state,
      newState,
      requested: requested as Map<string, { time_range?: TimeRange }>,
      emit,
      trackAndEmit,
      progress: progressWithCounters,
    });
    appendBudgetFacts(coverageFacts, facts);
  }
  await emitYnabCoverage(emit, requested, coverageFacts);
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "ynab",
    // Transport vocabulary (`fetch failed`, `ECONN…`, `ETIMEDOUT`) plus YNAB's
    // own `ynab_rate_limited`. `retryable status \d+` covers the retry layer's
    // exhausted-5xx/408/429 wording: those statuses are retryable BY
    // CONSTRUCTION — `retryHttp` only calls them that after `shouldRetry`
    // classified them so — and exhausting a bounded in-run budget against a
    // transient upstream fault does not make the fault permanent. Without it a
    // YNAB 503 terminals the connection as permanently failed and the owner is
    // asked to reconnect a credential that was never the problem.
    retryablePattern: YNAB_RETRYABLE_PATTERN,
    // YNAB marks deleted records with `deleted: true` in-band. Runtime strips
    // to { id } and emits with op: 'delete'.
    isTombstone: (_stream, d) => d.deleted === true,
    auth: { kind: "env", required: [["YNAB_PERSONAL_ACCESS_TOKEN", "YNAB_PAT"]] },
    validateRecord,
    collect: ynabCollect,
  });
}
