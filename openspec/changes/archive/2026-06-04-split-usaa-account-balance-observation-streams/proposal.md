# Split USAA account and credit-card balances into append-keyed observation streams

## Why

`usaa/accounts` and `usaa/credit_card_billing` mix point-in-time balance metrics
into entity records that carry stable account identity and settings. Every
balance movement produces a new version of the same account/card record.

The existing USAA fingerprint gates (`extend-usaa-real-field-churn-incidental-gates`)
correctly stop *run-clock* churn — a no-op refresh whose body modulo
`fetched_at` is byte-identical is suppressed. But they were never meant to stop
*point-in-time* churn: a genuine balance move is a real field change, so it
crosses the fingerprint boundary and re-versions the entity record. That is the
correct behavior for a Family-1 gate and the wrong behavior for a stream where
the moving field is a sampled metric, not a semantic event.

This is the same point-in-time churn the Family-2 construction
(`split-point-in-time-observation-streams`) was accepted to resolve for
`github/user_stats` and `slack/channel_stats`, and that
`split-ynab-account-balance-observation-stream` applied to `ynab/accounts`. The
correct construction is to project the sampled balance metrics into dedicated
append-keyed observation streams, keep the entity streams for identity/settings
fields only, and keep the per-record fingerprint gate on the entity streams so a
balance-only tick does not re-version the entity.

USAA differs from YNAB in two ways that this change addresses: it is a browser
connector whose `accounts`/`credit_card_billing` runs are **full dashboard
scans** (so the entity fingerprint cursor continues to `pruneStale()`, unlike
YNAB's `server_knowledge` partial scan), and `credit_card_billing` has a wider
field surface that splits unevenly between volatile metrics and stable settings.
The split line is documented in `design.md`.

## What Changes

- **usaa / `account_stats` stream (new)** — append-keyed observation records for
  `balance_cents` and `available_balance_cents`, keyed by `{account_id}:{YYYY-MM-DD}`
  (UTC). One record per account per calendar day; re-running on the same day with
  the same balances is idempotent. The account key is `buildAccountRecord`'s `id`
  (the USAA account id, or a hash of the raw dashboard text when USAA exposes no id).

- **usaa / `accounts` entity stream (modified)** — drops `balance_cents` and
  `available_balance_cents`; retains `id`, `type`, `name`, `last_four`, `status`.
  Still gated by the existing per-record fingerprint cursor (excludes `fetched_at`)
  so an identity/settings-only change re-emits exactly once and a balance-only tick
  does not.

- **usaa / `credit_card_billing_stats` stream (new)** — append-keyed observation
  records for the volatile per-cycle financial fields `current_balance_cents`,
  `available_credit_cents`, `cash_rewards_cents`, `billing_status`,
  `minimum_payment_met`, keyed by `{card_id}:{YYYY-MM-DD}` (UTC).

- **usaa / `credit_card_billing` entity stream (modified)** — drops the five
  volatile fields above; retains the stable card identity and settings fields
  `id`, `account_id`, `account_nickname`, `credit_limit_cents`,
  `annual_percent_rate`, `cash_advance_apr`, `card_holders`. (Field-classification
  rationale — why `credit_limit_cents` and the APRs stay on the entity — is in
  `design.md`.)

- **Full-scan prune preserved** — both USAA entity streams remain full dashboard
  scans, so their fingerprint cursors continue to `pruneStale()` (unlike YNAB's
  delta-sync partial scan). A re-added account/card re-emits. The observation
  streams append-key and are not pruned.

- **Manifest updated** — `account_stats` and `credit_card_billing_stats` declared
  with `semantics: "append"`, mirroring `github/user_stats` and
  `ynab/account_stats`; the two entity schemas and their `range_filters` drop the
  moved balance fields.

- **Connector tests added** — observation-record builders + entity-split +
  balance-only-no-churn + identity/settings re-emit + same-day idempotency +
  full-scan prune assertions, plus manifest/schema reconcile parity.

No data compaction in this lane. No `--apply`. No change to the retention rule,
backup/apply safety, cursor semantics for other streams, fixture capture, or any
public read path beyond the two new stream declarations and the entity field
removals.

## Capabilities

- Modified: reference-implementation-architecture (USAA account-balance and
  credit-card-billing observation streams; extends the Family-2
  observation-stream class added by `split-point-in-time-observation-streams`,
  applied previously to `ynab/accounts` by
  `split-ynab-account-balance-observation-stream`).

## Impact

- `packages/polyfill-connectors/connectors/usaa/parsers.ts` —
  `buildAccountRecord()` drops balance fields; new `buildAccountStatsRecord()`;
  `buildCreditCardBillingRecord()` drops volatile fields; new
  `buildCreditCardBillingStatsRecord()`.
- `packages/polyfill-connectors/connectors/usaa/index.ts` —
  `emitAccountsStream()` emits `account_stats` alongside the gated entity;
  `runCreditCardBillingStream()` emits `credit_card_billing_stats` alongside the
  gated entity; observation STATE cursors written.
- `packages/polyfill-connectors/connectors/usaa/schemas.ts` —
  `accountStatsSchema`, `creditCardBillingStatsSchema`; `accountSchema` and
  `creditCardBillingSchema` drop the moved fields; `SCHEMAS` gains the two new
  streams.
- `packages/polyfill-connectors/connectors/usaa/types.ts` — record interfaces
  updated/added.
- `packages/polyfill-connectors/manifests/usaa.json` — two `_stats` streams
  added; two entity schemas + range_filters drop the moved fields; profiles
  unchanged (the `reconciliation` profile does not include either entity).
- `packages/polyfill-connectors/connectors/usaa/account-stats.test.ts`,
  `credit-card-billing-stats.test.ts` — new test files.
