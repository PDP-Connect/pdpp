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

## Deferred integration

The current `ref-control` LIST synthesizer still reads runtime and bounded run
history directly. Routing GET through this payload before the scoped-runtime
publisher exists would either retain that work or turn missing runtime evidence
into a false-green default. Therefore GET integration is explicitly deferred;
the safe slice here is the durable, invalidating handoff only.
