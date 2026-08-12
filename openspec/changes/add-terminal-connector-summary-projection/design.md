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
