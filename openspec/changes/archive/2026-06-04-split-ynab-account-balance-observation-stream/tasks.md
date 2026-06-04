# Tasks — split YNAB account balances into an append-keyed observation stream

## 1 — YNAB connector

- [x] 1.1 Add `accountStatsRecord(a, observedOn)` builder in `index.ts` (fields: `id` = `{account_id}:{observed_on}`, `account_id`, `budget_id`, `observed_on`, `balance`, `cleared_balance`, `uncleared_balance`).
- [x] 1.2 Update `accountRecord()` in `index.ts` to drop `balance`, `cleared_balance`, `uncleared_balance` (identity/settings fields only).
- [x] 1.3 Add `openAccountCursor(state, budgetId)` per-budget fingerprint wrapper in `index.ts` (mirror `openPayeeLocationCursor`; full fingerprint, no exclusions).
- [x] 1.4 Update `collectAccounts()` to gate the `accounts` entity emit on the fingerprint cursor and emit `account_stats` for each account when requested; write `fingerprints` alongside `server_knowledge` in the `accounts` STATE cursor; do NOT prune (delta-sync partial scan).
- [x] 1.5 Add `accountStatsSchema` in `schemas.ts`; register `account_stats` in `SCHEMAS`.
- [x] 1.6 Update `accountsSchema` in `schemas.ts` to drop the three balance fields.
- [x] 1.7 Add `account_stats` stream to `manifests/ynab.json` (and to both profiles after `accounts`, mirroring github/user_stats); drop the balance fields from the `accounts` schema, remove the now-empty `balances` view, strip balance fields from the `full` view, and drop the balance range_filters.

## 2 — Tests

- [x] 2.1 New `connectors/ynab/accounts.test.ts`: `accountStatsRecord` builds the date-scoped key and carries balances.
- [x] 2.2 Entity-split: a balance-only change does NOT re-emit the entity record (fingerprint no-op) but DOES emit a fresh `account_stats` record.
- [x] 2.3 Identity change (rename / close / debt-detail) re-emits the entity record exactly once.
- [x] 2.4 Delta-sync no-prune: a run whose delta omits a known account carries that account's fingerprint forward and does not drop it; an explicit `deleted: true` re-emits.
- [x] 2.5 Same-day idempotency: two emits of `account_stats` on the same UTC day produce the same key; a later day produces a distinct key.

## 3 — Validation

- [x] 3.1 `node --test --import tsx packages/polyfill-connectors/connectors/ynab/accounts.test.ts` — passes (11/11).
- [x] 3.2 `node --test --import tsx packages/polyfill-connectors/connectors/ynab/fingerprint.test.ts` — still passes (14/14; no regression to budgets/payee_locations gates).
- [x] 3.3 `pnpm --dir packages/polyfill-connectors run typecheck` — zero errors.
- [x] 3.4 `openspec validate split-ynab-account-balance-observation-stream --strict` — valid.
- [x] 3.5 `git diff --check` — no whitespace errors.

## Acceptance checks

1. `node --test --import tsx packages/polyfill-connectors/connectors/ynab/accounts.test.ts` passes, including the balance-only-no-entity-churn and delta-sync no-prune assertions.
2. `node --test --import tsx packages/polyfill-connectors/connectors/ynab/fingerprint.test.ts` still passes.
3. `pnpm --dir packages/polyfill-connectors run typecheck` — zero errors.
4. `openspec validate split-ynab-account-balance-observation-stream --strict` — valid.
5. `git diff --check` — no whitespace errors.
