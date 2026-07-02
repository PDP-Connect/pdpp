# Design — Harden ingest against transient manifest drift

## Problem, precisely

Two independent readers resolve the connector manifest during one run:

1. **Runtime, at START** — `buildStartScope` (runtime/index.js:1089-1107) builds
   the run's stream scope from `manifest.streams` and throws if a scope stream is
   absent from the manifest. So every stream in `startScope.streams` was proven
   manifest-declared at run start.
2. **Resource server, at ingest** — `executeRecordsIngest` calls
   `hasManifestStream(connectorId, stream)` →
   `getConnectorManifest(connectorId)` reads the persisted `connectors` row
   (uncached direct DB read). If absent → HTTP 404 `not_found`.

When the persisted row is momentarily stale (its stream set lags what the running
connector code emits), reader 2 disagrees with reader 1 *within the same run*: the
runtime collected `user_stats`, then the RS 404'd its ingest. Today
`readIngestResponse` builds a `not_found` failure that `classifyRuntimeFailure`
returns verbatim as the terminal reason, aborting the run before its other five
streams run.

## Why this is safe to make non-terminal (the honesty gate)

The failure is only reclassified when **all** hold:

- the ingest response is HTTP **404** with body `error.code === "not_found"`
  (`err.response_status === 404 && err.pdpp_error_code === 'not_found'`);
- the failure is the ingest HTTP-response phase
  (`err.ingest_failure?.phase === 'http_response'`);
- the **stream is in the run's START scope** (`startScopeStreamNames.has(stream)`).

The START-scope gate is the load-bearing correctness condition. A stream reaches
START scope only by surviving `buildStartScope`'s manifest check, so a
`not_found` for it can only mean *the RS manifest read and the runtime manifest
read disagree* — i.e. transient drift — never "the connector emits a stream that
genuinely isn't in the manifest." That genuine-mismatch case cannot even reach
`flushBatch`: a RECORD for an undeclared stream throws at
`handleMsg`/RECORD (runtime/index.js:2927-2929) long before any ingest. So the
new branch cannot mask a real schema error, and it writes nothing new (it
converts a write-rejection into a gap) so it cannot widen a read.

Any other ingest status (400 ambiguous, 401/403 auth, 5xx, invalid-response) and
any `not_found` for a non-scope stream (not reachable, but defensively excluded)
stay exactly as terminal as today.

## Behavior

In `flushBatch(stream)`, wrap the `readIngestResponse` call. On a transient-drift
match:

- record a `transient` known gap via `buildKnownGap({ kind: 'stream_skipped',
  stream, reason: 'manifest_stream_unresolved', recoveryHint: 'retry_by_runtime',
  diagnostics: { http_status: 404, phase: 'http_response' } })` and `appendKnownGap`;
- emit a `run.stream_skipped` spine event (same shape the SKIP_RESULT path emits),
  so the drift is observable in the timeline;
- add the stream to a per-run `driftSkippedStreams` set;
- clear `recordBatch[stream]` and return (non-fatal). `totalFlushed` is NOT
  incremented (nothing was accepted).

In the `STATE` handler, after `flushBatch(msg.stream)`, if
`driftSkippedStreams.has(msg.stream)` then **skip** staging: do not set
`newState[msg.stream]` and do not emit `run.state_staged`. Because the final
commit loop iterates `Object.entries(newState)` (runtime/index.js:3731), an
un-staged stream's cursor is never committed, so the next run re-collects and
re-ingests it once the RS row re-heals. This is the same durability posture the
existing "cancelled run does not commit staged cursor state" rule uses.

`reason: 'manifest_stream_unresolved'` is added to `TRANSIENT_GAP_REASONS` so
`classifyKnownGapSeverity` returns `transient` (it would otherwise fall through to
`actionable`). The recovery hint `retry_by_runtime` also independently yields
`transient`, but naming the reason keeps the timeline legible and self-documenting.

## Alternatives considered

- **Retry the ingest in-process with backoff.** Rejected for this change: the row
  can stay stale for minutes (observed oscillation over hours), so in-run retry
  would burn the run's wall-clock/rate budget without a bounded end. The
  next-scheduled-run retry (via un-committed cursor) is the honest, bounded
  recovery. A future change may add a short bounded in-run retry on top.
- **Fix only the resource server (make ingest tolerant).** Rejected: the RS
  correctly rejects records for a stream its manifest doesn't declare; the defect
  is the runtime treating a *transient* rejection as terminal for the *whole run*.
  The fix belongs where the blast radius is.
- **Swallow all ingest not_found.** Rejected: would hide a genuine connector/RS
  manifest mismatch. The START-scope gate is what makes this safe.

## Acceptance checks

1. A run whose `user_stats` ingest returns 404/not_found but whose other streams
   ingest 200: run ends `succeeded`, carries a `transient` known gap for
   `user_stats` (`reason=manifest_stream_unresolved`), emits `run.stream_skipped`
   for `user_stats`, does NOT commit `user_stats` cursor, and DOES commit the
   other streams' cursors and records.
2. A run whose ingest returns 400 `ambiguous_connector_instance` (or 401/5xx):
   unchanged — run fails terminally as today.
3. A `not_found` for a stream not in START scope (constructed directly): unchanged
   — still terminal (defensive; unreachable via RECORD path).
4. `openspec validate harden-ingest-against-transient-manifest-drift --strict`
   passes.
