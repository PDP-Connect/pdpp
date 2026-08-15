## Context

The Collection Profile currently treats checkpoint commit as all-or-nothing at run level. The reference runtime already flushes each stream before staging its state and persists state one stream at a time, so the storage boundary can preserve completed siblings without changing cursor formats or record ingestion. The protocol must distinguish a certified stream-scoped failure from every other failed run before that behavior is safe.

## Goals / Non-Goals

**Goals:**

- Avoid repeating completed sibling streams after one independent stream fails.
- Preserve failed-run and incomplete-coverage evidence.
- Keep the runtime independent of connector and provider identity.
- Fail closed when the runtime cannot map failure evidence to exact state streams.

**Non-Goals:**

- Treating a partially failed run as successful.
- Committing state after crashes, cancellation, terminal mismatch, or generic failure.
- Inferring completion from record counts or elapsed work.
- Changing a connector's source-specific pagination or retry strategy.

## Decisions

### Require matching terminal and stream evidence

The runtime recognizes the partial-failure exception only when failed `DONE.error.code` and at least one in-scope `SKIP_RESULT.reason` both equal `stream_collection_failed`. The `DONE` code identifies the run-level cause; each skip identifies the affected stream. Either signal alone is insufficient.

Alternative: trust any failed `DONE` after staged state. Rejected because a crash or global failure can invalidate the entire state map.

### Exclude checkpoint parents, not only data-stream names

The runtime maps each failed data stream to the state stream that covers it. Manifest `state_stream` declarations provide the static mapping; run-time detail-coverage evidence can provide a more specific mapping. A parent checkpoint is withheld when any child it covers failed.

Alternative: compare failed stream names directly with state keys. Rejected because co-emitted and detail streams can ride another stream's cursor.

### Preserve terminal failure semantics

Eligible sibling checkpoints are committed before the failed terminal event is projected. The terminal result remains failed, carries the original retryability and known gaps, and reports the actual partial commit counts. No coverage calculation may turn the named failed stream complete.

Alternative: return partial success. Rejected because it would hide the unresolved stream and weaken scheduling and owner-attention semantics.

## Risks / Trade-offs

- [A connector names the wrong failed stream] -> Scope validation rejects unknown streams; parent mapping and counterexample tests prevent committing a checkpoint that covers a named failure. Connector conformance remains responsible for truthful names.
- [The terminal and skip vocabularies drift] -> Conformance tests bind the exact pair and fail closed when either side is absent.
- [A sibling checkpoint commit fails] -> Existing partial-commit error handling reports the committed count and keeps the run failed.
- [Older runtimes repeat completed siblings] -> The change is backward-safe: repetition is inefficient but does not lose data.

## Migration Plan

1. Land protocol text, reference runtime behavior, and discriminating tests together.
2. Deploy without rewriting existing state.
3. Retry affected connections; the first certified partial failure advances only proven siblings, and later retries resume from those checkpoints.
4. Roll back by restoring all-or-nothing failure commits; already persisted sibling checkpoints remain valid because their preceding records were durably flushed.
