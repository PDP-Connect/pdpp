# Tasks — Harden ingest against transient manifest drift

## 1. Runtime behavior

- [x] 1.1 Add `manifest_stream_unresolved` to `TRANSIENT_GAP_REASONS`.
- [x] 1.2 Gate on START-scope membership via `scopeByStream.has(stream)`.
- [x] 1.3 Add a per-run `driftSkippedStreams` set.
- [x] 1.4 In `flushBatch`, on ingest 404 `not_found` (`phase=http_response`) for a
  START-scope stream: record a `transient` known gap, emit `run.stream_skipped`,
  add the stream to `driftSkippedStreams`, clear the batch, return non-fatally.
  Rethrow every other error unchanged. Skip re-POSTing an already-skipped stream.
- [x] 1.5 In the `STATE` handler, skip staging (`newState` set + `run.state_staged`)
  for a stream in `driftSkippedStreams` so its cursor is not committed.

## 2. Tests

- [x] 2.1 Drift-skip: 404/not_found for a scope stream → run succeeds, transient
  gap present, `run.stream_skipped` emitted, that stream's cursor NOT committed,
  other streams' records + cursors committed. (real RS, `runtime-ingest-manifest-drift.test.js`)
- [x] 2.2 Negative: an undeclared-stream RECORD (never in START scope) still fails
  the run terminally as a protocol violation — cannot be masked by the drift branch.
- [x] 2.3 Predicate unit test: reclassification fires ONLY for status 404 +
  `not_found` + `http_response` phase + in-scope stream; 400/401/403/409/5xx,
  other codes, other phases, missing envelope, and out-of-scope streams all stay
  terminal.

## 3. Spec + validation

- [x] 3.1 MODIFIED requirement delta under `reference-implementation-runtime`
  (two new scenarios: transient ingest not_found for a START-scope stream; and the
  negative guard that other rejections stay terminal).
- [x] 3.2 `openspec validate harden-ingest-against-transient-manifest-drift --strict`.

## Acceptance checks

- [x] Focused runtime test file passes (4/4).
- [x] Existing runtime contract suite stays green: `collection-profile.test.js`
  124/124; ingest boundary/operation/atomicity 19/19; connection-health 168/168.
- [x] `tsc --noEmit` clean (0 errors).
- [x] `openspec validate ... --strict` passes.
- [ ] Owner-only trigger (stale-writer / D1) — recorded as residual risk, NOT
  addressed here. No live data mutated; no deploy.
