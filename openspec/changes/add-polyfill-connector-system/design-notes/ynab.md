# YNAB connector — design notes

**Status:** v1 shipped (already running against real data). v2 schema pass captured 2026-04-19 overnight.
**Source:** YNAB full-API-surface audit subagent 2026-04-19, OpenAPI spec 1.83.0.

## Auth
- **Personal Access Token** (PAT). User generates at `app.ynab.com/settings/developer`. 30 seconds of setup.
- Env var: `YNAB_PERSONAL_ACCESS_TOKEN`. Connector reads from `process.env` at runtime.
- Bootstrap secret path: `.env.local` → OS keyring in v2 (deferred).

## Rate limit
- **200 requests/hour per token**, rolling window.
- Per-endpoint equal-weight.
- 429 response body: `{ error: { id: "429", name: "too_many_requests", detail: "..." } }`. Connector treats as `retryable`.
- Our usage budget:
  - Typical run: 1 (plans) + 5 (accounts) + 5 (categories) + 5 (payees) + 5 (transactions) + 5 (scheduled) + 5 (months) = ~31 req for a 5-budget user. Well under budget.
  - Full-history backfill: same call count, just returns more data.

## Streams (v2 complete)

### `budgets` (`mutable_state`, primary_key `["id"]`)
- `id` (UUID)
- `name`
- `last_modified_on` (ISO 8601)
- `first_month`, `last_month` (ISO dates, budget month range)
- `currency_iso_code` (from `currency_format.iso_code`)
- `currency_symbol`
- `currency_symbol_first` (boolean)
- `currency_decimal_digits`
- `currency_decimal_separator`, `currency_group_separator`
- `date_format_string` (from `date_format.format`)
- `deleted` (always false at Budget level; present for consistency)

### `accounts` (`mutable_state`, primary_key `["id"]`)
- `id`, `budget_id`, `name`, `type`
- `on_budget`, `closed`
- `balance`, `cleared_balance`, `uncleared_balance` (all milliunits)
- `transfer_payee_id` (nullable)
- `direct_import_linked` (boolean)
- `direct_import_in_error` (boolean)
- `last_reconciled_at` (nullable ISO 8601)
- `note` (nullable)
- `debt_interest_rates` (object; month → rate), nullable
- `debt_minimum_payments` (object; month → int64), nullable
- `debt_escrow_amounts` (object; month → int64), nullable
- `deleted`

### `categories` (`mutable_state`, primary_key `["id"]`)
- `id`, `budget_id`
- `category_group_id`, `category_group_name`
- `name`
- `hidden`
- `budgeted`, `activity`, `balance` (current month snapshot)
- `note` (nullable)
- Goal fields (all nullable): `goal_type` (TB / TBD / MF / NEED / DEBT), `goal_needs_whole_amount`, `goal_day`, `goal_cadence`, `goal_cadence_frequency`, `goal_creation_month`, `goal_target`, `goal_target_date`, `goal_percentage_complete`, `goal_months_to_budget`, `goal_under_funded`, `goal_overall_funded`, `goal_overall_left`, `goal_snoozed_at`
- `deleted`

### `category_groups` (`mutable_state`, primary_key `["id"]`) — NEW in v2
- `id`, `budget_id`, `name`, `hidden`, `note` (nullable), `deleted`

### `payees` (`mutable_state`, primary_key `["id"]`)
- `id`, `budget_id`, `name`
- `transfer_account_id` (nullable)
- `deleted`

### `payee_locations` (`mutable_state`, primary_key `["id"]`) — NEW in v2
- `id`, `budget_id`, `payee_id`
- `latitude`, `longitude` (strings as API returns)
- `deleted`

Rationale: **valuable for reconciliation** — GPS at which a payee was last used can match a bank-statement merchant to a specific Amazon/Uber location.

### `transactions` (`mutable_state`, primary_key `["id"]`, consent_time_field `"date"`)
Already captured fields plus:
- All v1 fields (id, budget_id, account_id, account_name, date, amount, payee_id, payee_name, category_id, category_name, memo, cleared, approved, flag_color, flag_name, transfer_*, matched_transaction_id, import_id, import_payee_name, import_payee_name_original, debt_transaction_type, deleted, subtransactions)
- `is_split` (derived: `subtransactions.length > 0`) — convenience flag
- `account_type` (joined from accounts; convenience for the reconciliation agent)

### `scheduled_transactions` (`mutable_state`, primary_key `["id"]`, consent_time_field `"date_first"`) — NEW in v2
- `id`, `budget_id`
- `date_first`, `date_next`
- `frequency` (enum: never, daily, weekly, everyOtherWeek, twiceAMonth, every4Weeks, monthly, everyOtherMonth, every3Months, every4Months, twiceAYear, yearly, everyOtherYear)
- `amount`
- `account_id`, `account_name`
- `payee_id`, `payee_name` (nullable)
- `category_id`, `category_name` (nullable)
- `memo` (nullable)
- `transfer_account_id` (nullable)
- `flag_color`, `flag_name` (nullable)
- `subtransactions` (array of scheduled subtransactions)
- `deleted`

### `months` (`mutable_state`, primary_key `["id"]`, consent_time_field `"month"`) — NEW in v2
- `id` (synthetic: `budget_id || '|' || month`)
- `budget_id`
- `month` (ISO date, YYYY-MM-01)
- `income`, `budgeted`, `activity`, `to_be_budgeted` (all milliunits)
- `age_of_money` (nullable int; days)
- `note` (nullable)
- `deleted`

Not `month_categories` nested — the per-category state for that month is already in `categories` (current) and historical month-level breakdown is queryable via `/months/{month}` detail if needed later.

## Relationships (manifest `relationships[]`)
- `accounts.transfer_payee_id` → `payees`
- `transactions.account_id` → `accounts`
- `transactions.payee_id` → `payees`
- `transactions.category_id` → `categories`
- `transactions.transfer_account_id` → `accounts`
- `transactions.transfer_transaction_id` → `transactions` (self)
- `transactions.matched_transaction_id` → `transactions` (self)
- `payee_locations.payee_id` → `payees`
- `categories.category_group_id` → `category_groups`
- `scheduled_transactions.account_id` → `accounts`
- `scheduled_transactions.payee_id` → `payees`
- `scheduled_transactions.category_id` → `categories`
- `months.budget_id` → `budgets`

## Incremental sync
Cursor state (same shape as v1, just more streams):
```
{
  budgets: { fetched_at: ISO },
  accounts:             { [budget_id]: { server_knowledge: N } },
  categories:           { [budget_id]: { server_knowledge: N } },
  category_groups:      (no server_knowledge — re-fetch via /categories response),
  payees:               { [budget_id]: { server_knowledge: N } },
  payee_locations:      (no server_knowledge — paginated list, full refresh),
  transactions:         { [budget_id]: { server_knowledge: N, since_date?: string } },
  scheduled_transactions: { [budget_id]: { server_knowledge: N } },
  months:               { [budget_id]: { server_knowledge: N } },
}
```

Category groups come back in the `/categories` response itself — no separate endpoint. Emit them from the same call.

Payee locations don't support `server_knowledge` delta. Re-fetch full list each run. Cheap: typically <50 per budget.

## Resilience principles applied
- Only required fields: `id` + `budget_id` for most streams; `date` for transactions. Everything else optional/nullable. If YNAB adds a field, we capture it transparently via the catch-all pass-through path. If they remove an optional field, records still validate.
- `cleared` kept as string enum (not boolean). Matches the API.
- `flag_color` kept as string (empty string or nullable).
- Milliunits preserved; no client-side currency math.
- `subtransactions` kept as nested array, NOT a separate stream. (Reversal option: if reconciliation needs to query by sub-level amount/payee, we flip to separate stream. Deferred.)
- Milliunit integers passed through as-is.

## Scheduled run policy
- Interval: **4 hours** with ±30 min jitter.
- First run = full refresh. Subsequent = incremental.
- Full historical backfill on first run (tonight): pull all transactions going back to first_month of each budget.

## Explicit non-goals v1
- Write operations (PATCH/PUT transactions — user manages YNAB via the app).
- `money_movements` stream (internal reallocations, low value for reconciliation).
- `/user` endpoint (static profile data).
- Individual month detail endpoint (re-fetched lazily on demand in v2).

## Things the owner should check on return
- [?] Confirm PayeeLocations has useful data in his budgets (if he's never used mobile YNAB, may be empty)
- [?] Scheduled transactions — does he use this feature? If not, stream will just be empty.
- [?] Whether v2 breaking additions (new required fields) break any prior-run grants. Should not; all new fields are optional.
