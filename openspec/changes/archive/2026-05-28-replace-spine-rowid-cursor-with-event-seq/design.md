## Context

The disclosure spine is a durable audit surface. Existing pagination orders by event time with SQLite `rowid` as a tiebreaker. That leaks a backend-specific identity into the cursor contract, even if the token is opaque to clients.

Future storage portability needs a stable logical sequence. The reference should introduce it now before any spine-store extraction.

## Decision

Spine events SHALL have a stable monotonic `event_seq` assigned at append time. Timeline pagination SHALL use an opaque cursor over `(occurred_at, event_seq)` or an equivalent stable logical ordering. Public event payloads do not need to expose `event_seq` unless existing diagnostics require it; the requirement is about the internal cursor contract.

Existing spine data may be handled by additive migration or by deriving `event_seq` during schema initialization. The migration must be non-destructive.

## Stop Conditions

Stop for owner review if the implementation:

- requires destructive migration of existing spine events;
- exposes SQLite `rowid` in any cursor helper, operation boundary, or public response;
- changes public run/grant/trace timeline event payloads except for additive diagnostic metadata approved in OpenSpec;
- extracts a production `DisclosureSpineStore` in this change.

## Acceptance Checks

- `rg -n "rowid" reference-implementation/lib/spine.ts reference-implementation/server/queries` shows no live spine cursor dependency on SQLite `rowid`.
- Disclosure-spine conformance proves pagination remains stable when multiple events share the same timestamp.
- Existing `_ref` run, grant, and trace timeline pagination tests remain green.
