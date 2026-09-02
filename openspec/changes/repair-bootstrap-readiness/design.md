## Decision

The reference SHALL resolve a PostgreSQL bootstrap-lock budget from an explicit
positive millisecond override when provided. Without an override, it SHALL use
the database size observed through PostgreSQL: a shorter empty-database budget
and a longer populated-database budget. Unknown size SHALL use the populated
budget. Every attempt SHALL share one monotonic outer deadline, use bounded
backoff, and emit periodic wait progress. A timeout remains a real startup
error; it is no longer reached merely because a fixed 120-attempt loop was
exhausted.

Required schema/bootstrap work remains before listener binding. Optional
manifest reconciliation starts after the AS and RS listeners bind. Retrieval
backfill waits for reconciliation when both are enabled, so corrected manifest
metadata is used without delaying readiness. Maintenance failures are logged
and isolated from the already-listening servers.

The first-boot oracle builds the exact requested revision, creates a disposable
PostgreSQL instance, lets the exact image create its schema, adds synthetic
rows, and starts a fresh immutable-image container with restart disabled. It
records listener, metadata, and readiness timestamps and verifies revision,
zero restarts, and the absence of startup-crash evidence.

## Alternatives considered

- Keeping the fixed retry count: rejected because it couples correctness to an
  arbitrary delay and reproduces the populated-database crash loop.
- Moving all bootstrap behind listeners: rejected because required schema
  bootstrap must still complete before the public surfaces advertise readiness.
- Running reconciliation and backfill concurrently without ordering: rejected
  because retrieval maintenance could observe stale manifest metadata.
- Using a production database for acceptance: rejected; the oracle must be
  disposable and synthetic to keep the evidence safe and repeatable.

## Scope proof

This repair follows the diagnosis: the smallest behavioral change that removes
the fixed lock crash window and pre-listen optional work. It does not change
schema semantics, protocol responses, connector behavior, or deployment
topology.

## Acceptance checks

- Focused unit tests cover data-aware configuration, contention, deadline
  clipping, listener-before-maintenance ordering, and maintenance failure
  isolation.
- A PostgreSQL-gated test exercises the real advisory-lock protocol.
- The exact-image oracle reports the requested revision, listener/metadata/
  readiness timing, and `RestartCount=0` against its own populated database.
