## ADDED Requirements

### Requirement: New persisted connection-owned run facts SHALL retain source-instance identity

The reference implementation SHALL bind every newly persisted connection-owned `run.*` fact to the exact immutable `connector_instance_id` of its configured source instance. The shared typed spine write boundary SHALL reject a new run fact that omits that binding. It SHALL NOT infer the binding from a connector type, browser profile, schedule, or event timeline.

#### Scenario: A new connection-owned run fact is persisted

- **WHEN** a source instance persists a `run.*` fact
- **THEN** the fact SHALL retain its owning source instance's exact `connector_instance_id`
- **AND** SQLite and PostgreSQL persistence SHALL retain the same identity.

#### Scenario: Reference runtime acceptance paths

- **WHEN** the reference scheduler, direct runtime, managed browser-surface, local-device, or recovery path persists a `run.*` fact
- **THEN** each path SHALL meet the shared connection-owned run-fact binding requirement.

#### Scenario: A future run writer omits identity

- **WHEN** code attempts to persist a new `run.*` spine event without a non-empty `connector_instance_id`
- **THEN** the write SHALL fail closed with a precise developer/runtime error
- **AND** it SHALL NOT create an unbound event row.

#### Scenario: A historical spine event has no identity

- **WHEN** a pre-existing spine row has a null or missing connector-instance identity
- **THEN** reads SHALL preserve it as unknown
- **AND** the reference SHALL NOT infer, backfill, or rewrite an identity for that row.
