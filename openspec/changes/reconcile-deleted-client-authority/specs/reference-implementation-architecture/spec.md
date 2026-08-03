## ADDED Requirements

### Requirement: Client deletion SHALL reconcile all exact client authority projections idempotently

After an owner-authorized dynamic-client deletion or CIMD deletion, the
reference implementation SHALL reconcile active grants, packages, package
members, tokens, and refresh tokens for that exact `client_id` to revoked
state before completing the deletion. The reconciliation SHALL preserve
authority/history rows and any already-recorded revocation timestamps.

#### Scenario: A revoked package still has an active member

- **GIVEN** a package and its grant are already revoked for a client
- **AND** the package member row still has status `active`
- **WHEN** the client deletion path runs
- **THEN** the member status SHALL become `revoked`
- **AND** the package, grant, and member rows SHALL remain present

#### Scenario: Repeating reconciliation is harmless

- **GIVEN** all authority projections for an exact client are already revoked
- **WHEN** the route or maintenance reconciler runs again
- **THEN** no revoked timestamp SHALL be replaced
- **AND** no authority row SHALL be deleted or reactivated

### Requirement: Historical client-access maintenance SHALL use exact evidence and bounded progress

The reference implementation SHALL maintain historical client-access orphans
only for identities proven by a successful `client.deleted` spine event whose
non-empty `client_id` equals its client object id. It SHALL NOT infer deletion
from a missing registration row, token state, client name, or CIMD metadata.
Each maintenance round SHALL have a finite client and time budget, persist
progress behind a fenced cursor, and run without making startup wait for fleet
convergence.

#### Scenario: A proven deleted identity is eventually repaired

- **GIVEN** a successful exact `client.deleted` event and active authority rows
- **WHEN** bounded maintenance rounds resume from their durable cursor
- **THEN** those rows SHALL converge to revoked across finite rounds
- **AND** a partial round SHALL leave a cursor after the last processed client

#### Scenario: An unproven missing identity is not guessed

- **GIVEN** active authority rows whose client has no exact successful
  `client.deleted` evidence
- **WHEN** historical maintenance runs
- **THEN** those rows SHALL remain unchanged
