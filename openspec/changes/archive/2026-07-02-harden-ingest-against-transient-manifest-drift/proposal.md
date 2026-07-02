# Harden ingest against transient manifest drift

## Why

Live GitHub connector runs abort with `ingest_failure phase=http_response
stream=user_stats http_status=404` (`terminal_reason=not_found`) even though the
connector supports `user_stats` and the runtime already validated `user_stats`
against the manifest at run start. Evidence:
`tmp/workstreams/github-user-stats-404-diagnosis.md`.

Root cause has two layers. The trigger — a persisted `connectors.<id>` manifest
row that is intermittently overwritten with a stale variant missing a stream — is
an operational/live-stack concern (owner). This change addresses the **blast
radius only**: the reference runtime treats an ingest `not_found` for a stream it
*already admitted into START scope from the manifest* as a **terminal, run-aborting
failure**, discarding every other in-scope stream. A momentary disagreement
between the runtime's manifest read (at START) and the resource server's manifest
read (at ingest) should degrade to a **retryable per-stream gap**, not vaporize
the whole run.

## What Changes

- The reference runtime, when a record-batch ingest returns HTTP 404 `not_found`
  for a stream that is present in the run's START scope, SHALL classify it as a
  transient per-stream gap (drop that stream's batch, do NOT stage/commit that
  stream's cursor, record a `transient` known gap, emit `run.stream_skipped`) and
  continue the run, rather than failing the run as `not_found`.
- The narrowing gate is load-bearing: the behavior fires ONLY for streams the
  runtime already proved are manifest-declared at START (`buildStartScope` rejects
  scope streams absent from the manifest). An ingest `not_found` for a stream that
  is NOT in START scope is impossible on the record path (undeclared-stream RECORDs
  are rejected earlier) and any other status/code stays terminal — so this does
  NOT hide genuine schema/manifest misconfiguration and does NOT widen any read.

## Capabilities

- Modified: reference-implementation-runtime

## Impact

- `reference-implementation/runtime/index.js` — `flushBatch` gains a narrow
  transient-drift branch; the `STATE` handler skips staging a drift-skipped
  stream's cursor.
- New focused runtime tests covering: drift-skip on 404-for-scope-stream,
  cursor-not-advanced, other streams still committed, run ends succeeded with a
  transient gap, and negative cases (non-404, non-scope) staying terminal.
- No live data mutated, no deploy. Trigger (stale-writer) is tracked separately as
  an owner action in the diagnosis report.

## Residual Risks

- Owner-only stale-writer / D1 trigger validation remains a residual live check.
  The runtime blast-radius fix is merged and covered by deterministic tests; this
  change does not claim to eliminate the separate operational stale-writer cause.
