## Decision

Use the existing per-connection `connector_summary_evidence` row. The added
payload is one named owner LIST projection, not a second table, cache, queue,
or generic selection mechanism. It carries the exact item returned by the
owner LIST surface and an optional, already-classified runtime observation.

A publisher captures the row's opaque canonical-evidence revision in the same
bounded read used to derive the payload. It can mark the payload `current` only
when that exact revision still matches and the row is clean with current
record, terminal-fact, and manifest components. Canonical rebuild, reconcile,
and every existing dirty/failure path advance the revision and make the old
payload stale. The read accessor returns no payload for any non-current state.

## Runtime handoff

The payload's runtime field is a narrow input:

```ts
{ observed_at: string; projection: EphemeralBrowserRuntimeProjection | null }
```

It is supplied by the separately-owned scoped-runtime observation seam. This
change never calls allocator APIs, scans runtime history, or manufactures a
healthy runtime when that seam has not published evidence.

## Maintenance publisher

The existing connector maintenance sweep now owns the follow-on publication.
After a bounded canonical observation unit converges, it passes that exact
connection-id page to the existing `ref-control` LIST synthesizer. The
synthesizer calculates health, verdict, runtime, and all other owner-list
fields once through the existing page-scoped dependency path. The publisher
captures each synthesized row's canonical evidence revision and calls the
existing compare-and-set writer, fenced by the maintenance lease. A lost
canonical or lease race, missing evidence, failed component, or removed
connection publishes nothing and leaves the durable cursor before that page;
no state is marked current optimistically.

The sweep's existing durable keyset cursor and lease provide restart-safe
progress, single-owner page work, and an atomic publication fence. Dirty
acceleration and the cursor walk both use the same callback, so a dirty marker
is only a latency hint and the full walk remains the correctness backstop. The
callback is provider-neutral, bounded to the observed page, and never runs
from an owner GET.

Routing GET through the stored payload remains deferred. The ordinary LIST
path continues to synthesize its read-time freshness and runtime-relative
fields directly, while the durable payload is ready for a later cutover that
can prove parity without duplicating health calculation.

## Read cutover contract

The RI owner owns the cutover. It is a release gate for the durability-stack
integration that contains this change; the staged dual-write is not an
indefinite supported architecture.

Cutover requires all of the following on the assembled schema:

1. A bounded parity oracle compares the complete stored list item with the
   existing synthesizer for current, stale, failed, and unobserved evidence,
   across SQLite and PostgreSQL. It must include runtime-relative fields and
   reject a partial payload rather than filling from the old path.
2. The maintenance sweep backfills every active connection under its durable
   keyset cursor. The cutover gate reports the exact remaining unpublished or
   stale count and requires zero before switching reads.
3. Owner LIST GET reads only current stored payloads. A missing, stale, or
   failed payload remains an explicit unreliable projection; GET does not
   silently invoke the old synthesizer or write a repair.
4. Rollback switches reads back to the synthesizer without deleting stored
   payloads. After one observed scheduler cycle and parity re-verification,
   remove the old synthesizer from the GET path and then remove the rollback.
5. Stopped SQLite and real PostgreSQL backup/restore evidence covers the
   assembled durable schema, including terminal payloads, maintenance cursor,
   invalidation, and post-restore reconciliation.

If the assembled durability release does not meet this gate, remove the
terminal payload columns and publisher before merge rather than preserve an
ownerless second representation.
