# Reference Implementation Architecture — USAA pre-split balance migration

## ADDED Requirements

### Requirement: Pre-split real observations are migrated before entity history is canonical-collapse eligible

The reference implementation SHALL migrate real point-in-time observations out of
an entity history into their Family-2 observation stream before that entity
history is treated as eligible for canonical collapse, whenever the observation
stream was split out after the entity stream had already retained those
observations. A canonical compaction policy SHALL NOT collapse such an entity
history until the migration of its real observations has been applied and
verified. The migration SHALL be a distinct operation from canonical compaction:
it relocates surviving data and SHALL NOT delete or mutate the source entity
history.

#### Scenario: pre-split balances exist only in entity history

**WHEN** `usaa/accounts` retained history carries numeric `balance_cents` versions emitted before `account_stats` was split out,
**THEN** those balances SHALL be migrated into `usaa/account_stats` by the backfill migration,
**AND** `usaa/accounts` SHALL remain audit-only (not canonical-collapse eligible) until that migration is applied and verified.

#### Scenario: migration does not mutate the source history

**WHEN** the backfill migration runs in `--apply` mode,
**THEN** it SHALL only insert into the observation stream,
**AND** it SHALL NOT delete, update, or renumber any `usaa/accounts` version in `record_changes`.

### Requirement: USAA pre-split balance backfill reconstructs observation records faithfully

The reference implementation SHALL provide an operator-run, dry-run-by-default,
idempotent maintenance script that backfills the pre-split numeric `balance_cents`
observations from `usaa/accounts` retained history into the `usaa/account_stats`
stream. Each backfilled record SHALL be constructed through the connector's own
`account_stats` record builder so it is indistinguishable from a forward-path
emit: key `{account_id}:{observed_on}`, `account_id` taken from the source
version's entity `id`, `observed_on` derived from the source version's
`emitted_at` UTC date, `balance_cents` taken from the source version, and
`available_balance_cents` set to `null`.

#### Scenario: backfilled key and shape match the forward path

**WHEN** the migration builds an `account_stats` record from a source `usaa/accounts` version,
**THEN** the record key SHALL equal `{account_id}:{observed_on}` where `observed_on` is the source version's `emitted_at` truncated to a UTC date,
**AND** the record SHALL carry the source version's `balance_cents` with `available_balance_cents` set to `null`,
**AND** the record SHALL be byte-equivalent to what the connector's `account_stats` builder produces for the same account and `observed_on`.

#### Scenario: multiple balances on the same UTC day resolve deterministically

**WHEN** one account has more than one distinct `balance_cents` value on the same UTC calendar day in history,
**THEN** the migration SHALL select the balance from the latest source version for that day,
**AND** the dropped source version(s) SHALL be recorded in the per-run source backup table.

### Requirement: USAA balance backfill anchors on current rows and is idempotent

The migration SHALL treat existing `account_stats` rows as authoritative and
SHALL insert only daily observations not already present. It SHALL NOT overwrite,
update, or delete an existing `account_stats` row. A second `--apply` run SHALL
insert nothing.

#### Scenario: forward-path days are skipped, not rewritten

**WHEN** a candidate `{account_id}:{observed_on}` key already exists in `account_stats` from the forward path,
**THEN** the migration SHALL skip that key,
**AND** the existing row SHALL remain byte-identical after `--apply`.

#### Scenario: re-running inserts nothing

**WHEN** the migration is applied a second time after a successful apply,
**THEN** it SHALL compute an empty insert set,
**AND** it SHALL insert zero rows.

### Requirement: USAA balance backfill is auditable, reversible, and copied-database validated

Per run, before writing, the migration SHALL copy the `usaa/accounts` source
history it read into a per-run backup table and SHALL record the exact set of
`account_stats` keys it inserts into a per-run inserted-key table written in the
same transaction as the inserts. A rollback SHALL delete from `records` and
`record_changes` exactly the keys recorded in that run's inserted-key table and
nothing else, leaving forward-path rows untouched. No `--apply` SHALL run against
live retained history until a copied or narrow database has proven candidate
enumeration, additive insert count, current-row preservation, idempotence, and
rollback restoration of the pre-migration row set.

#### Scenario: rollback deletes exactly what the run inserted

**WHEN** an operator runs `--rollback <runId>` for a prior apply,
**THEN** the migration SHALL delete only the `account_stats` keys listed in that run's inserted-key table,
**AND** it SHALL refuse to delete any key not recorded as inserted by that run,
**AND** forward-path `account_stats` rows SHALL remain present and unchanged.

#### Scenario: copied-database validation precedes any live apply

**WHEN** the migration is prepared for a live `--apply`,
**THEN** a copied or narrow database SHALL first prove the candidate count, the net-new insert count, that pre-existing `account_stats` rows are unchanged, that a second apply inserts zero rows, and that rollback restores the pre-migration `account_stats` row set,
**AND** only after that evidence is accepted SHALL a live `--apply` run.
