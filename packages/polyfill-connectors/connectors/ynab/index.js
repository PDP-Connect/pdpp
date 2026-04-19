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
 *   transactions, scheduled_transactions, months
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
 *   }
 *
 * Rate limit: 200 req/hour per token. A typical run is ~7×budgets requests.
 */

import { createInterface } from 'node:readline';
import { resourceSet, requireCredentialsOrAsk } from '../../src/scope-filters.js';

const API_BASE = 'https://api.ynab.com/v1';
const rl = createInterface({ input: process.stdin, terminal: false });

function emit(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function flushAndExit(code) {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
}

function fail(message, retryable = false) {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message, retryable } });
  flushAndExit(1);
}

let _interactionCounter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_interactionCounter}`;
async function sendInteractionAndWait(msg) {
  emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === reqId) {
          rl.off('line', onLine);
          resolve(parsed);
        }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

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

const nowIso = () => new Date().toISOString();

function withinTimeRange(dateStr, timeRange) {
  if (!timeRange) return true;
  if (timeRange.since && dateStr < timeRange.since.slice(0, 10)) return false;
  if (timeRange.until && dateStr >= timeRange.until.slice(0, 10)) return false;
  return true;
}

function priorKnowledge(state, streamName, budgetId) {
  return state?.[streamName]?.[budgetId]?.server_knowledge ?? undefined;
}

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
  });

  if (startMsg.type !== 'START') return fail('Expected START message');

  // Credentials — prompt if missing, don't fail hard.
  let token;
  try {
    const creds = await requireCredentialsOrAsk({
      required: ['YNAB_PERSONAL_ACCESS_TOKEN'],
      connectorName: 'YNAB',
      sendInteractionAndWait,
      nextInteractionId,
    });
    token = creds.YNAB_PERSONAL_ACCESS_TOKEN;
  } catch (e) {
    return fail(e.message, false);
  }

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const state = startMsg.state || {};
  const newState = JSON.parse(JSON.stringify(state));

  // Per-stream resource filters + emitted-id tracking for tombstone emission.
  const resFilters = new Map();
  const emittedIds = new Map();
  for (const [name, req] of requested) {
    resFilters.set(name, resourceSet(req));
    emittedIds.set(name, new Set());
  }

  let totalEmitted = 0;
  const emittedAt = nowIso();
  const emitRecord = (stream, data) => {
    const id = data.id;
    if (id == null) return;
    const canonical = String(id);
    const resSet = resFilters.get(stream);
    if (resSet && !resSet.has(canonical)) return; // out-of-scope — silently skip

    // YNAB returns soft-deleted records with `deleted: true`. Convert to
    // proper PDPP tombstones (op=delete) for mutable_state streams.
    if (data.deleted === true) {
      emit({
        type: 'RECORD',
        stream,
        key: id,
        data: { id },
        emitted_at: emittedAt,
        op: 'delete',
      });
    } else {
      emit({ type: 'RECORD', stream, key: id, data, emitted_at: emittedAt });
    }
    emittedIds.get(stream)?.add(canonical);
    totalEmitted++;
  };

  // 1. Budgets — always fetched; needed to enumerate downstream streams.
  emit({ type: 'PROGRESS', stream: 'budgets', message: 'Fetching budgets' });
  const budgetsRes = await ynab('/budgets', token);
  const budgets = budgetsRes.data.budgets;
  const budgetIds = budgets.map((b) => b.id);

  if (requested.has('budgets')) {
    for (const b of budgets) {
      emitRecord('budgets', {
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
      emit({ type: 'PROGRESS', stream: 'accounts', message: `Fetching accounts for budget ${budgetId}` });
      const knowledge = priorKnowledge(state, 'accounts', budgetId);
      const res = await ynab(`/budgets/${budgetId}/accounts`, token, { knowledge });
      for (const a of res.data.accounts) {
        emitRecord('accounts', {
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
      emit({ type: 'PROGRESS', stream: 'categories', message: `Fetching categories for budget ${budgetId}` });
      const knowledge = priorKnowledge(state, 'categories', budgetId);
      const res = await ynab(`/budgets/${budgetId}/categories`, token, { knowledge });
      for (const group of res.data.category_groups) {
        if (requested.has('category_groups')) {
          emitRecord('category_groups', {
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
            emitRecord('categories', {
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
      emit({ type: 'PROGRESS', stream: 'payees', message: `Fetching payees for budget ${budgetId}` });
      const knowledge = priorKnowledge(state, 'payees', budgetId);
      const res = await ynab(`/budgets/${budgetId}/payees`, token, { knowledge });
      for (const p of res.data.payees) {
        emitRecord('payees', {
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
      emit({ type: 'PROGRESS', stream: 'payee_locations', message: `Fetching payee locations for budget ${budgetId}` });
      const res = await ynab(`/budgets/${budgetId}/payee_locations`, token);
      for (const loc of res.data.payee_locations) {
        emitRecord('payee_locations', {
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
      emit({ type: 'PROGRESS', stream: 'transactions', message: `Fetching transactions for budget ${budgetId}` });
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
        emitRecord('transactions', {
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
      emit({ type: 'PROGRESS', stream: 'scheduled_transactions', message: `Fetching scheduled transactions for budget ${budgetId}` });
      const knowledge = priorKnowledge(state, 'scheduled_transactions', budgetId);
      const res = await ynab(`/budgets/${budgetId}/scheduled_transactions`, token, { knowledge });
      for (const s of res.data.scheduled_transactions) {
        emitRecord('scheduled_transactions', {
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

    // 8. Months
    if (requested.has('months')) {
      emit({ type: 'PROGRESS', stream: 'months', message: `Fetching months for budget ${budgetId}` });
      const knowledge = priorKnowledge(state, 'months', budgetId);
      const res = await ynab(`/budgets/${budgetId}/months`, token, { knowledge });
      for (const m of res.data.months) {
        emitRecord('months', {
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

  emit({ type: 'DONE', status: 'succeeded', records_emitted: totalEmitted });
  process.exit(0);
}

main().catch((e) => {
  const msg = e && e.message ? e.message : String(e);
  const retryable = /rate_limited|ECONN|ETIMEDOUT|fetch failed/i.test(msg);
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable } });
  process.exit(1);
});
