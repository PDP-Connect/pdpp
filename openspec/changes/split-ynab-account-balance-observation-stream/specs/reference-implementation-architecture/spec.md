# Reference Implementation Architecture — YNAB account-balance observation stream

## ADDED Requirements

### Requirement: Family-2 observation stream for ynab/accounts balances

The YNAB connector SHALL classify `ynab/account_stats` as a Family-2
append-keyed observation stream with a date-scoped composite key, projecting the
point-in-time balance metrics out of the `ynab/accounts` entity stream. The
`accounts` entity stream SHALL retain identity and settings fields only and
SHALL be gated by a per-record fingerprint so a balance-only change does not
version the entity record. The split SHALL preserve YNAB `server_knowledge`
delta-sync.

#### Scenario: account balances accumulate a daily time series

**WHEN** the YNAB connector observes an account with balance values on a given UTC calendar day,
**THEN** `account_stats` SHALL contain a record with key `{account_id}:{YYYY-MM-DD}`,
**AND** the record SHALL carry the `balance`, `cleared_balance`, and `uncleared_balance` values observed that day,
**AND** an observation on a later UTC day SHALL append a distinct record rather than overwrite the prior day's record.

#### Scenario: a balance-only change does not version the entity record

**WHEN** an account's balance changes between runs but no identity or settings field changes,
**THEN** the `accounts` entity stream SHALL NOT emit a new record version for that account,
**AND** the `account_stats` stream SHALL record the new balance for the observed calendar day.

#### Scenario: an identity or settings change versions the entity record once

**WHEN** an account's `name`, `closed`, `note`, debt-detail, or other non-balance settings field changes,
**THEN** the `accounts` entity stream SHALL emit exactly one new record version for that account.

#### Scenario: delta-sync omission carries the account forward without pruning

**WHEN** a `server_knowledge` delta response omits a previously observed account because it did not change,
**THEN** the entity fingerprint cursor SHALL carry that account's fingerprint forward into the next STATE write,
**AND** the cursor SHALL NOT prune the omitted account,
**AND** an account returned with `deleted: true` SHALL re-emit the entity record as a normal field change.

#### Scenario: same-day re-runs are idempotent for the observation stream

**WHEN** the connector runs twice on the same UTC calendar day with identical balances for an account,
**THEN** both runs SHALL produce the same `account_stats` record key and content,
**AND** no additional record version SHALL be created beyond what the runtime byte-equivalence check produces.
