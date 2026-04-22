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

import { requireCredentialsOrAsk } from '../../src/scope-filters.js';
import { runConnector, nowIso } from '../../src/connector-runtime.js';

const API_BASE = 'https://api.ynab.com/v1';

async function ynab(path, token, { knowledge, sinceDate } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  if (knowledge != null) url.searchParams.set('last_knowledge_of_server', String(knowledge));
  if (sinceDate) url.searchParams.set('since_date', sinceDate);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('ynab_auth_failed');
  if (res.status === 429) throw new Error('ynab_rate_limited');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ynab_http_${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function withinTimeRange(dateStr, timeRange) {
  if (!timeRange) return true;
  if (timeRange.since && dateStr < timeRange.since.slice(0, 10)) return false;
  if (timeRange.until && dateStr >= timeRange.until.slice(0, 10)) return false;
  return true;
}

function priorKnowledge(state, streamName, budgetId) {
  return state?.[streamName]?.[budgetId]?.server_knowledge ?? undefined;
}

// Rewind an ISO month (YYYY-MM-DD, day is always 01 from YNAB) by one month.
// Used to keep the cutoff one step behind the highest month we've fetched, so
// the most recent closed month gets one more pass on the next run.
function rewindOneMonth(monthIso) {
  const [y, m] = monthIso.split('-').map(Number);
  const prevM = m === 1 ? 12 : m - 1;
  const prevY = m === 1 ? y - 1 : y;
  return `${prevY}-${String(prevM).padStart(2, '0')}-01`;
}

runConnector({
  name: 'ynab',
  retryablePattern: /rate_limited|ECONN|ETIMEDOUT|fetch failed/i,
  // YNAB marks deleted records with `deleted: true` in-band. Runtime strips
  // to { id } and emits with op: 'delete'.
  isTombstone: (_stream, d) => d.deleted === true,
  async collect({ state, requested, emit, emitRecord: runtimeEmitRecord, progress, sendInteraction }) {
    // Credentials — prompt if missing, don't fail hard.
    const creds = await requireCredentialsOrAsk({
      required: ['YNAB_PERSONAL_ACCESS_TOKEN'],
      connectorName: 'YNAB',
      sendInteraction,
    });
    const token = creds.YNAB_PERSONAL_ACCESS_TOKEN;

    const newState = JSON.parse(JSON.stringify(state));

    // Track which IDs we emitted this run, per stream. Used later for
    // end-of-stream tombstones: IDs present in prior state but not in this
    // run are treated as deletions the server never told us about
    // (YNAB occasionally hard-deletes without soft-delete marker).
    const emittedIds = new Map();
    for (const [streamName] of requested) emittedIds.set(streamName, new Set());

    // Trap to record ids so end-of-stream reconciliation can compare.
    // Delegates to the runtime's emitRecord; only observes ids flowing through.
    const trackAndEmit = (stream, data) => {
      if (data?.id != null) emittedIds.get(stream)?.add(String(data.id));
      return runtimeEmitRecord(stream, data);
    };

    // 1. Budgets — always fetched; needed to enumerate downstream streams.
    progress('Fetching budgets', { stream: 'budgets' });
    const budgetsRes = await ynab('/budgets', token);
    const budgets = budgetsRes.data.budgets;
    const budgetIds = budgets.map((b) => b.id);

    if (requested.has('budgets')) {
      for (const b of budgets) {
        trackAndEmit('budgets', {
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
        });
      }
      emit({ type: 'STATE', stream: 'budgets', cursor: { fetched_at: nowIso() } });
      newState.budgets = { fetched_at: nowIso() };
    }

    for (const budgetId of budgetIds) {
      // 2. Accounts (per budget)
      if (requested.has('accounts')) {
        progress(`Fetching accounts for budget ${budgetId}`, { stream: 'accounts' });
        const knowledge = priorKnowledge(state, 'accounts', budgetId);
        const res = await ynab(`/budgets/${budgetId}/accounts`, token, { knowledge });
        for (const a of res.data.accounts) {
          trackAndEmit('accounts', {
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
          });
        }
        newState.accounts = newState.accounts || {};
        newState.accounts[budgetId] = { server_knowledge: res.data.server_knowledge };
        emit({ type: 'STATE', stream: 'accounts', cursor: newState.accounts });
      }

      // 3. Categories + Category Groups (same response)
      if (requested.has('categories') || requested.has('category_groups')) {
        progress(`Fetching categories for budget ${budgetId}`, { stream: 'categories' });
        const knowledge = priorKnowledge(state, 'categories', budgetId);
        const res = await ynab(`/budgets/${budgetId}/categories`, token, { knowledge });
        for (const group of res.data.category_groups) {
          if (requested.has('category_groups')) {
            trackAndEmit('category_groups', {
              id: group.id,
              budget_id: budgetId,
              name: group.name,
              hidden: group.hidden,
              note: group.note ?? null,
              deleted: group.deleted,
            });
          }
          if (requested.has('categories')) {
            for (const c of group.categories ?? []) {
              trackAndEmit('categories', {
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
              });
            }
          }
        }
        newState.categories = newState.categories || {};
        newState.categories[budgetId] = { server_knowledge: res.data.server_knowledge };
        emit({ type: 'STATE', stream: 'categories', cursor: newState.categories });
      }

      // 4. Payees
      if (requested.has('payees')) {
        progress(`Fetching payees for budget ${budgetId}`, { stream: 'payees' });
        const knowledge = priorKnowledge(state, 'payees', budgetId);
        const res = await ynab(`/budgets/${budgetId}/payees`, token, { knowledge });
        for (const p of res.data.payees) {
          trackAndEmit('payees', {
            id: p.id,
            budget_id: budgetId,
            name: p.name,
            transfer_account_id: p.transfer_account_id ?? null,
            deleted: p.deleted,
          });
        }
        newState.payees = newState.payees || {};
        newState.payees[budgetId] = { server_knowledge: res.data.server_knowledge };
        emit({ type: 'STATE', stream: 'payees', cursor: newState.payees });
      }

      // 5. Payee Locations (no server_knowledge delta; full refresh cheap)
      if (requested.has('payee_locations')) {
        progress(`Fetching payee locations for budget ${budgetId}`, { stream: 'payee_locations' });
        const res = await ynab(`/budgets/${budgetId}/payee_locations`, token);
        for (const loc of res.data.payee_locations) {
          trackAndEmit('payee_locations', {
            id: loc.id,
            budget_id: budgetId,
            payee_id: loc.payee_id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            deleted: loc.deleted,
          });
        }
      }

      // 6. Transactions
      if (requested.has('transactions')) {
        progress(`Fetching transactions for budget ${budgetId}`, { stream: 'transactions' });
        const stream = requested.get('transactions');
        const knowledge = priorKnowledge(state, 'transactions', budgetId);
        const priorSinceDate = state.transactions?.[budgetId]?.since_date;
        const scopeSince = stream.time_range?.since?.slice(0, 10);
        // Use server-side since_date only on first run (no delta cursor yet).
        const sinceDate = knowledge != null ? undefined : (scopeSince || priorSinceDate || undefined);

        // Build account_id → account_type map for convenience enrichment.
        const accountTypeById = new Map();
        if (newState.accounts?.[budgetId]) {
          // Accounts were fetched this run; we cached them only by emission, not structure.
          // Safe fallback: re-query accounts once for the type map if transactions are requested.
        }
        // Always re-fetch accounts summary for the type map. Small payload, negligible cost.
        try {
          const aRes = await ynab(`/budgets/${budgetId}/accounts`, token);
          for (const a of aRes.data.accounts) accountTypeById.set(a.id, a.type);
        } catch { /* non-fatal */ }

        const res = await ynab(`/budgets/${budgetId}/transactions`, token, { knowledge, sinceDate });
        for (const t of res.data.transactions) {
          if (!withinTimeRange(t.date, stream.time_range)) continue;
          trackAndEmit('transactions', {
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
          });
        }
        newState.transactions = newState.transactions || {};
        newState.transactions[budgetId] = {
          server_knowledge: res.data.server_knowledge,
          since_date: sinceDate || priorSinceDate || scopeSince || undefined,
        };
        emit({ type: 'STATE', stream: 'transactions', cursor: newState.transactions });
      }

      // 7. Scheduled Transactions
      if (requested.has('scheduled_transactions')) {
        progress(`Fetching scheduled transactions for budget ${budgetId}`, { stream: 'scheduled_transactions' });
        const knowledge = priorKnowledge(state, 'scheduled_transactions', budgetId);
        const res = await ynab(`/budgets/${budgetId}/scheduled_transactions`, token, { knowledge });
        for (const s of res.data.scheduled_transactions) {
          trackAndEmit('scheduled_transactions', {
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
          });
        }
        newState.scheduled_transactions = newState.scheduled_transactions || {};
        newState.scheduled_transactions[budgetId] = { server_knowledge: res.data.server_knowledge };
        emit({ type: 'STATE', stream: 'scheduled_transactions', cursor: newState.scheduled_transactions });
      }

      // 8. Months (+ month_categories, which piggy-backs on the months list)
      const monthsStream = requested.get('months');
      const monthCategoriesStream = requested.get('month_categories');
      let monthList = null; // populated when either stream is in scope
      if (monthsStream || monthCategoriesStream) {
        progress(`Fetching months for budget ${budgetId}`, { stream: 'months' });
        const knowledge = priorKnowledge(state, 'months', budgetId);
        const res = await ynab(`/budgets/${budgetId}/months`, token, { knowledge });
        monthList = res.data.months;
        if (monthsStream) {
          for (const m of monthList) {
            trackAndEmit('months', {
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
            });
          }
          newState.months = newState.months || {};
          newState.months[budgetId] = { server_knowledge: res.data.server_knowledge };
          emit({ type: 'STATE', stream: 'months', cursor: newState.months });
        }
      }

      // 9. Month Categories — per-month snapshot of every category's budgeted/
      //    activity/balance/goal state. One API call per month (endpoint does
      //    NOT expose server_knowledge), so we use a month cutoff from prior
      //    state: only refetch months >= last_fetched_month, since older
      //    months are frozen in YNAB. The current (and just-closed) month
      //    always refetches because its cutoff matches `last_fetched_month`.
      if (monthCategoriesStream && monthList) {
        const priorCutoff = state.month_categories?.[budgetId]?.last_fetched_month;
        const scopeSince = monthCategoriesStream.time_range?.since?.slice(0, 10);
        // Active months: exclude soft-deleted, apply time_range and prior cutoff.
        const activeMonths = monthList.filter((m) => {
          if (m.deleted) return false;
          if (!withinTimeRange(m.month, monthCategoriesStream.time_range)) return false;
          if (priorCutoff && m.month < priorCutoff) return false;
          return true;
        });
        // Oldest → newest so the cursor advances monotonically on partial failure.
        activeMonths.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

        let highestMonth = priorCutoff || scopeSince || null;
        for (const m of activeMonths) {
          progress(`Fetching categories for budget ${budgetId} month ${m.month}`, { stream: 'month_categories' });
          const monthRes = await ynab(`/budgets/${budgetId}/months/${m.month}`, token);
          const monthDetail = monthRes.data.month;
          for (const c of monthDetail.categories ?? []) {
            trackAndEmit('month_categories', {
              id: `${budgetId}:${m.month}:${c.id}`,
              budget_id: budgetId,
              month: m.month,
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
            });
          }
          if (!highestMonth || m.month > highestMonth) highestMonth = m.month;
        }
        newState.month_categories = newState.month_categories || {};
        // Rewind cutoff by one month so the most recently closed month gets
        // one more pass next run (guards against late-arriving edits).
        const cutoffToStore = highestMonth ? rewindOneMonth(highestMonth) : undefined;
        newState.month_categories[budgetId] = { last_fetched_month: cutoffToStore };
        emit({ type: 'STATE', stream: 'month_categories', cursor: newState.month_categories });
      }
    }
  },
});
