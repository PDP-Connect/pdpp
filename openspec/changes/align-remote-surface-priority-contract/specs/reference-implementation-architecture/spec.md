## ADDED Requirements

### Requirement: Browser-surface resource priority SHALL be host-neutral and independent of trigger kind

The reference implementation SHALL represent browser-surface resource priority as either `interactive` or `background`, with `interactive` ordered ahead of `background` for lease arbitration. A manual owner run SHALL default to `interactive`; scheduled and webhook runs SHALL use `background`. The implementation SHALL preserve the run's `triggerKind` (`manual`, `scheduled`, or `webhook`) independently of that priority and SHALL NOT encode trigger semantics in the persisted lease priority value.

#### Scenario: Scheduled run retains its trigger while using background capacity

- **WHEN** the scheduler starts a managed connector run
- **THEN** its browser-surface priority SHALL be `background`
- **AND** its trigger kind SHALL remain `scheduled`.

#### Scenario: Manual run retains its trigger while using interactive capacity

- **WHEN** an owner starts a managed connector run without an explicit priority
- **THEN** its browser-surface priority SHALL default to `interactive`
- **AND** its trigger kind SHALL remain `manual`.

### Requirement: Browser-surface lease persistence SHALL migrate priority vocabulary at startup

The reference implementation SHALL migrate pre-existing browser-surface lease rows from `owner_interactive` to `interactive` and from `scheduled_refresh` to `background` during SQLite and Postgres startup before installing a constraint that admits only the new values. The migration SHALL preserve the lease identity, status, timestamps, fencing token, and relative priority ordering, and SHALL be idempotent after the new constraint is installed.

#### Scenario: A legacy background lease survives restart

- **WHEN** a persisted lease has priority `scheduled_refresh` before startup
- **THEN** startup SHALL retain the lease and rewrite its priority to `background`
- **AND** subsequent writes of `scheduled_refresh` SHALL be rejected by the database constraint.

#### Scenario: A mixed SQLite lease constraint is upgraded without losing dependent objects

- **WHEN** a SQLite lease table has a recognized mixed old/new priority check and explicit indexes, triggers, or inbound/outbound foreign keys
- **THEN** startup SHALL map both legacy values and install the new-only priority check in one transaction
- **AND** it SHALL preserve columns, rows, foreign keys, explicit indexes, and triggers
- **AND** it SHALL run `foreign_key_check` before committing.

#### Scenario: An unsupported SQLite lease shape fails closed

- **WHEN** a SQLite lease table contains an unrecognized direct priority check shape
- **THEN** startup SHALL fail without replacing the table or mapping rows.

#### Scenario: Postgres preserves an unrelated compound priority check

- **WHEN** a Postgres lease table has the known direct legacy priority enum check and another compound check that mentions `priority_class`
- **THEN** startup SHALL replace only the direct legacy enum check and map both legacy values
- **AND** it SHALL retain the compound check unchanged.

#### Scenario: A current Postgres priority check is a repeat-boot no-op

- **WHEN** a Postgres lease table already has the exact new-only direct priority check and no legacy rows
- **THEN** a subsequent startup SHALL not replace that priority constraint.

#### Scenario: Concurrent Postgres legacy starters serialize before discovery

- **WHEN** two Postgres startups encounter the same recognized legacy priority check
- **THEN** they SHALL serialize on a transaction-scoped priority-migration lock before catalog discovery
- **AND** both startups SHALL complete with one current priority check and each legacy row mapped once.
