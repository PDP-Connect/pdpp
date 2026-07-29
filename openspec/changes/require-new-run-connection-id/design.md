## Decision

`emitSpineEvent` is the shared typed run-timeline write boundary. Before either SQLite or PostgreSQL persistence, it rejects a new `run.*` event whose payload lacks a non-empty `connector_instance_id`. The guard does not derive identity from connector type, a browser profile, event history, or a timeline.

The `spine_events.connector_instance_id` column remains nullable. Existing rows remain readable with `null`, which is the explicit unknown state. No migration updates historical rows and no database `NOT NULL` constraint is added.

The reusable contract is a connection-owned run fact, not a scheduler or browser feature: any source-instance runtime resolves its exact configured binding before creating its first run fact and carries it through every later fact. The direct runtime preserves its optional caller argument by resolving an omitted value to its declared default-account binding before `run.started`; an explicit argument or manifest binding wins. Browser-surface lifecycle events receive the same identity from the active-run record. Local-device terminal collection uses the authorized source binding. Recovery events use the persisted active-run identity. These are reference-implementation acceptance examples, not protocol requirements for scheduler or browser mechanics.

## Alternatives rejected

- Backfill from `connector_id`, browser profile keys, schedules, or timeline proximity: each can be ambiguous and would rewrite history.
- Make the database column `NOT NULL`: this would break readable historical rows and would not protect a direct typed write that failed to provide the right value.
- Enforce only at callers: a future caller could omit the identity without a shared failure.
