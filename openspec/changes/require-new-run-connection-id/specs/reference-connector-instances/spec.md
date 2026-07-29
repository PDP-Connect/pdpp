## ADDED Requirements

### Requirement: New persisted run timeline events SHALL retain connector-instance identity

The reference implementation SHALL persist every newly created `run.*` spine event with the exact immutable `connector_instance_id` of the configured connector instance that owns the run. The shared typed spine write boundary SHALL reject a new run event that omits that identity. It SHALL NOT infer the identity from a connector type, browser profile, schedule, or event timeline.

#### Scenario: A scheduler, manual, browser-surface, local-device, or recovery run writes a lifecycle event

- **WHEN** one of those run paths persists a `run.*` spine event
- **THEN** the event SHALL retain the owning connector instance's exact `connector_instance_id`
- **AND** SQLite and PostgreSQL persistence SHALL retain the same identity.

#### Scenario: A future run writer omits identity

- **WHEN** code attempts to persist a new `run.*` spine event without a non-empty `connector_instance_id`
- **THEN** the write SHALL fail closed with a precise developer/runtime error
- **AND** it SHALL NOT create an unbound event row.

#### Scenario: A historical spine event has no identity

- **WHEN** a pre-existing spine row has a null or missing connector-instance identity
- **THEN** reads SHALL preserve it as unknown
- **AND** the reference SHALL NOT infer, backfill, or rewrite an identity for that row.
