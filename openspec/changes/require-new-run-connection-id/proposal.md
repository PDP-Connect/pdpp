## Why

New run timeline rows can be persisted without a connector-instance identity. That makes a run ambiguous when one connector type has multiple configured connections.

## What Changes

- Require every newly persisted `run.*` spine event to carry the immutable `connector_instance_id` for the configured connection.
- Keep historical unbound spine rows readable as explicitly unknown; do not infer or backfill their identity.
- Cover scheduler, manual, browser-surface, local-device, recovery, and future typed run writers with the shared persistence guard.

## Impact

- Reference runtime and browser-surface event emitters.
- SQLite and PostgreSQL spine persistence tests.
