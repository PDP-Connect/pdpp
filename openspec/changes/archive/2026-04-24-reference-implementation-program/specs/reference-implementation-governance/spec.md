## ADDED Requirements

### Requirement: Canonical reference-implementation program tracking lives in OpenSpec
Active multi-tranche execution for the reference implementation SHALL have one canonical OpenSpec program artifact that records the current program goal, completed foundations, current in-progress work, next ordered tranches, and intentionally deferred work.

#### Scenario: A contributor needs the current execution center
- **WHEN** a contributor needs to understand the current reference-implementation program rather than a single local change
- **THEN** they SHALL be able to find one canonical OpenSpec program artifact instead of piecing that state together from inbox memos or ad hoc status notes

#### Scenario: Older execution memos remain in the repo
- **WHEN** older inbox plans, owner-status notes, or synthesis memos remain available for historical context
- **THEN** they SHALL be treated as historical working notes and SHALL point back to the canonical OpenSpec program artifact rather than competing with it as the active steering layer
