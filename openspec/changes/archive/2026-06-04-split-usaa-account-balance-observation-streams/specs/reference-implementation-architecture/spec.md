# Reference Implementation Architecture — USAA balance observation streams

## ADDED Requirements

### Requirement: Family-2 observation streams for usaa/accounts and usaa/credit_card_billing balances

The USAA connector SHALL classify `usaa/account_stats` and
`usaa/credit_card_billing_stats` as Family-2 append-keyed observation streams
with date-scoped composite keys, projecting the point-in-time balance metrics out
of the `usaa/accounts` and `usaa/credit_card_billing` entity streams. The entity
streams SHALL retain identity and settings fields only and SHALL each remain
gated by a per-record fingerprint so a balance-only change does not version the
entity record. Because both entity streams are full dashboard scans, their
fingerprint cursors SHALL continue to prune entities absent from the current
scan.

#### Scenario: account balances accumulate a daily time series

**WHEN** the USAA connector observes an account with balance values on a given UTC calendar day,
**THEN** `account_stats` SHALL contain a record with key `{account_id}:{YYYY-MM-DD}`,
**AND** the record SHALL carry the `balance_cents` and `available_balance_cents` values observed that day,
**AND** an observation on a later UTC day SHALL append a distinct record rather than overwrite the prior day's record.

#### Scenario: credit-card balances accumulate a daily time series

**WHEN** the USAA connector observes a credit card with billing values on a given UTC calendar day,
**THEN** `credit_card_billing_stats` SHALL contain a record with key `{card_id}:{YYYY-MM-DD}`,
**AND** the record SHALL carry the `current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`, `billing_status`, and `minimum_payment_met` values observed that day.

#### Scenario: a balance-only change does not version the entity record

**WHEN** an account's or card's balance changes between runs but no identity or settings field changes,
**THEN** the corresponding entity stream SHALL NOT emit a new record version for that account or card,
**AND** the corresponding `_stats` stream SHALL record the new value for the observed calendar day.

#### Scenario: an identity or settings change versions the entity record once

**WHEN** an account's `name`/`status` or a card's `credit_limit_cents`, `annual_percent_rate`, `cash_advance_apr`, `account_nickname`, or `card_holders` changes,
**THEN** the corresponding entity stream SHALL emit exactly one new record version for that account or card.

#### Scenario: a disappeared entity is pruned on the full scan

**WHEN** a previously observed account or card is absent from the current dashboard scan,
**THEN** the entity fingerprint cursor SHALL prune that entity so a later re-appearance re-emits the entity record,
**AND** the entity's prior `_stats` records SHALL be retained as history and SHALL NOT be pruned.

#### Scenario: same-day re-runs are idempotent for the observation streams

**WHEN** the connector runs twice on the same UTC calendar day with identical balances for an account or card,
**THEN** both runs SHALL produce the same `_stats` record key and content,
**AND** no additional record version SHALL be created beyond what the runtime byte-equivalence check produces.
