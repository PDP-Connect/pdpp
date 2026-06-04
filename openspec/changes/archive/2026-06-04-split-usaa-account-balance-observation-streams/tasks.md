# Tasks — split USAA balances into append-keyed observation streams

## 1 — usaa/accounts → account_stats

- [x] 1.1 Add `buildAccountStatsRecord(a, observedOn)` builder in `parsers.ts` (fields: `id` = `{account_id}:{observed_on}`, `account_id`, `observed_on`, `balance_cents`, `available_balance_cents`). Add `AccountStatsRecord` interface to `types.ts`.
- [x] 1.2 Update `buildAccountRecord()` in `parsers.ts` to drop `balance_cents` and `available_balance_cents` (identity/settings fields only). Update `AccountRecord` interface in `types.ts`.
- [x] 1.3 Update `emitAccountsStream()` in `index.ts` to emit `account_stats` for each account when requested, alongside the existing fingerprint-gated entity emit. Write the `account_stats` STATE cursor (`{ observed_on, fetched_at }`). Keep the entity full-scan prune.
- [x] 1.4 Add `accountStatsSchema` in `schemas.ts`; register `account_stats` in `SCHEMAS`. Drop the two balance fields from `accountSchema`.
- [x] 1.5 Add `account_stats` stream to `manifests/usaa.json` (`semantics: "append"`, `cursor_field`/`consent_time_field` = `observed_on`, `incremental: true`, relationship to `accounts`); drop `balance_cents`/`available_balance_cents` from the `accounts` schema and from its `range_filters`.

## 2 — usaa/credit_card_billing → credit_card_billing_stats

- [x] 2.1 Add `buildCreditCardBillingStatsRecord(a, billing, observedOn)` builder in `parsers.ts` (fields: `id` = `{card_id}:{observed_on}`, `card_id`, `account_id`, `observed_on`, `current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`, `billing_status`, `minimum_payment_met`). Add `CreditCardBillingStatsRecord` interface to `types.ts`.
- [x] 2.2 Update `buildCreditCardBillingRecord()` in `parsers.ts` to drop the five volatile fields; retain `id`, `account_id`, `account_nickname`, `credit_limit_cents`, `annual_percent_rate`, `cash_advance_apr`, `card_holders`. Update `CreditCardBillingRecord` interface in `types.ts`.
- [x] 2.3 Update `runCreditCardBillingStream()` in `index.ts` to emit `credit_card_billing_stats` per card alongside the existing fingerprint-gated entity emit. Write the `credit_card_billing_stats` STATE cursor. Keep the entity full-scan prune.
- [x] 2.4 Add `creditCardBillingStatsSchema` in `schemas.ts`; register `credit_card_billing_stats` in `SCHEMAS`. Drop the five volatile fields from `creditCardBillingSchema`.
- [x] 2.5 Add `credit_card_billing_stats` stream to `manifests/usaa.json` (`semantics: "append"`, `cursor_field`/`consent_time_field` = `observed_on`, `incremental: true`, relationships to `accounts` and `credit_card_billing`); drop the five volatile fields from the `credit_card_billing` schema and from its `range_filters`.

## 3 — Tests

- [x] 3.1 New `connectors/usaa/account-stats.test.ts`: `buildAccountStatsRecord` builds the date-scoped key and carries balances; entity record drops balances; later-day key is distinct; same-day key is identical.
- [x] 3.2 `account-stats.test.ts`: a balance-only change does NOT re-emit the entity record (existing fingerprint cursor no-op) but DOES emit a fresh `account_stats` record; an identity/status change re-emits the entity exactly once.
- [x] 3.3 New `connectors/usaa/credit-card-billing-stats.test.ts`: `buildCreditCardBillingStatsRecord` builds the date-scoped key and carries the five volatile fields; entity record drops them and keeps `credit_limit_cents` + APRs; later-day vs same-day keying.
- [x] 3.4 `credit-card-billing-stats.test.ts`: a balance/rewards/status-only change does NOT re-emit the entity; a `credit_limit_cents`/APR/nickname change DOES re-emit the entity exactly once.
- [x] 3.5 Confirm `accounts-fingerprint.test.ts` and `credit-card-billing-fingerprint.test.ts` still pass over the narrowed entity bodies (update the compaction-parity body fixtures to the new shape; a moved settings field must be a distinct fingerprint, a no-op refresh identical).

## 4 — Validation

- [x] 4.1 `node --test --import tsx packages/polyfill-connectors/connectors/usaa/account-stats.test.ts` — passes.
- [x] 4.2 `node --test --import tsx packages/polyfill-connectors/connectors/usaa/credit-card-billing-stats.test.ts` — passes.
- [x] 4.3 `node --test --import tsx packages/polyfill-connectors/connectors/usaa/accounts-fingerprint.test.ts packages/polyfill-connectors/connectors/usaa/credit-card-billing-fingerprint.test.ts` — still pass.
- [x] 4.4 `node --test --import tsx packages/polyfill-connectors/connectors/usaa/parsers.test.ts packages/polyfill-connectors/connectors/usaa/integration.test.ts` — still pass.
- [x] 4.5 `node --test --import tsx packages/polyfill-connectors/bin/reconcile-manifests.test.ts` — manifest/schema/emit aligned for all four USAA streams.
- [x] 4.6 `pnpm --dir packages/polyfill-connectors run typecheck` — zero errors.
- [x] 4.7 `openspec validate split-usaa-account-balance-observation-streams --strict` — valid.
- [x] 4.8 `git diff --check` — no whitespace errors.

## Acceptance checks

1. `account-stats.test.ts` + `credit-card-billing-stats.test.ts` pass, including balance-only-no-entity-churn and same-day-idempotency assertions.
2. `accounts-fingerprint.test.ts` + `credit-card-billing-fingerprint.test.ts` still pass over the narrowed bodies.
3. `reconcile-manifests.test.ts` passes (all four streams declared + registered + emitted).
4. `pnpm --dir packages/polyfill-connectors run typecheck` — zero errors.
5. `openspec validate split-usaa-account-balance-observation-streams --strict` — valid.
6. `git diff --check` — no whitespace errors.
