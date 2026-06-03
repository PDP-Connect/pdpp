# Design — split YNAB account balances into an append-keyed observation stream

This change applies the Family-2 observation-stream construction accepted in
`split-point-in-time-observation-streams` to the `ynab / accounts` stream. The
keying, idempotency, and entity-fingerprint rules are identical; the one new
design fact is the interaction with YNAB's `server_knowledge` delta-sync.

## Scope

| Stream | Sampled metric fields | Entity / identity fields | Construction |
| --- | --- | --- | --- |
| ynab / accounts | `balance`, `cleared_balance`, `uncleared_balance` | `id`, `budget_id`, `name`, `type`, `on_budget`, `closed`, `transfer_payee_id`, `direct_import_linked`, `direct_import_in_error`, `last_reconciled_at`, `note`, `debt_interest_rates`, `debt_minimum_payments`, `debt_escrow_amounts`, `deleted` | fingerprint entity (no prune); append-key stats |

## Observation-stream keying

`account_stats` records use the composite key `{account_id}:{YYYY-MM-DD}` (UTC
date), exactly as `github/user_stats` and `slack/channel_stats`. The record key
is the connector runtime's `data.id`, so the builder sets
`id = "${account_id}:${observedOn}"`. This gives:

1. **Time series preserved** — one record per account per calendar day.
2. **Idempotent within a day** — re-running on the same day with the same
   balances produces the same key and the same content; the runtime
   byte-equivalence check collapses the re-emit to zero new versions.
3. **Real change preserved** — a balance move on the same day overwrites the
   day's record with the new value (a genuine update); a move on a later day
   appends a new record.

`account_stats` carries `account_id` and `budget_id` so the observation series
stays joinable back to the `accounts` entity and `budgets`.

## Entity stream fingerprinting

After the split the `accounts` entity record no longer contains any balance
field. The remaining fields are identity and account settings that change
rarely (a rename, a close, a reconciliation timestamp, a debt-detail edit). A
full per-record fingerprint (no field exclusions) is correct: the entity record
re-emits only when one of those fields actually changes.

`openAccountCursor(state, budgetId)` mirrors the existing
`openPayeeLocationCursor`/`openBudgetCursor` per-budget wrappers: it decodes the
per-budget fingerprint map from `state.accounts[budgetId].fingerprints` and is
seeded so an account skipped this run carries forward into the next STATE write.

## Delta-sync interaction (the one new fact)

This is the structural difference from `github/user` (single full re-fetch) and
`slack/channels` (full archive rebuild), and the reason the v3 closeout lane
flagged `ynab/accounts` as genuine point-in-time churn that is NOT
fetched_at-collapsible.

YNAB `/accounts` is a `server_knowledge` **partial scan**: it returns only
accounts changed since the prior knowledge value. Consequences for the gate:

- **No prune.** `openAccountCursor` MUST NOT call `pruneStale()`. An account
  absent from a delta response was not deleted — it simply did not change. The
  full-scan streams (`budgets`, `payee_locations`) prune because they re-return
  every row; `accounts` (like `transactions`) does not. A deletion arrives
  explicitly as a returned record with `deleted: true`, which the fingerprint
  treats as a normal field change and re-emits.
- **Carry-forward is load-bearing.** Because most runs return only a subset of
  accounts, the prior fingerprint map must survive into the next STATE write for
  every account, including ones not in this delta. The shared
  `openCarryForwardCursor` seed-from-prior behavior provides this.
- **`server_knowledge` cursor unchanged.** The split touches only the RECORD
  emit and adds the entity `fingerprints` field to the `accounts` cursor object
  alongside the existing `{ server_knowledge }`. The knowledge value the
  connector sends on the next run is still `res.data.server_knowledge` from the
  prior response. Delta-sync is not regressed.

Worked trace (single budget, account A):

1. Run 1 (cold): delta returns A. Entity emits (no prior fp). `account_stats`
   emits `A:D1`. Cursor stores fp(A) and knowledge K1.
2. Run 2 same day, balance moved: delta returns A. Entity fingerprint unchanged
   (no identity field moved) → **entity skipped**. `account_stats` emits `A:D1`
   again with the new balance → runtime overwrites the day's stat record.
   Knowledge advances to K2.
3. Run 3 next day, balance moved again: delta returns A. Entity skipped.
   `account_stats` emits `A:D2` → new day, new stat record. K3.
4. Run 4, account A renamed: delta returns A. Entity fingerprint changed →
   **entity re-emits** (one genuine version). `account_stats` emits the day's
   record. K4.
5. Run 5, nothing changed: delta returns zero accounts. Entity loop runs zero
   times; A's fingerprint and knowledge carry forward; no prune drops A.

The net effect: balance ticks accumulate as a daily time series in
`account_stats` and never version the `accounts` entity record; identity edits
still version the entity record exactly once each.

## Backwards compatibility

The `accounts` entity records drop `balance`, `cleared_balance`,
`uncleared_balance`. This is an intentional field-level breaking change,
mirroring the github/user and slack/channels splits, mitigated by:

1. The new `account_stats` stream carrying the same data, keyed for time series.
2. Both `accounts` and `account_stats` declared in the manifest.
3. The balance fields removed from the entity schema (and from its `balances`
   and `full` views and its range_filters) so the break is explicit, not a
   silent `null`. A reader that needs current balance reads the latest
   `account_stats` record for the account.

## Acceptance checks

- `node --test --import tsx packages/polyfill-connectors/connectors/ynab/accounts.test.ts`
- `pnpm --dir packages/polyfill-connectors run typecheck`
- `openspec validate split-ynab-account-balance-observation-stream --strict`
- `git diff --check`

## Out of scope

- `usaa/accounts` (`balance_cents`, `available_balance_cents`) and
  `usaa/credit_card_billing` balances. Structurally the same point-in-time churn,
  but USAA is a browser connector with a wider balance surface and live-credential
  test path; it deserves its own lane. This change records it as the next slice.
- Other YNAB point-in-time metric fields (`categories.balance`/`activity`,
  `month_categories.*`, `months.*`). Out of scope for the account-balance tranche.
- Compaction of historical pre-split entity records (owner-gated separately).
- Production live `--apply` compaction.
