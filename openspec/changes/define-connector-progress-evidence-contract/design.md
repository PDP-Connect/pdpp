# Design: Connector Progress Evidence Contract

## Problem framing

The refresh-doc principle is that connector freshness and gap visibility need a
**universal evidence contract**, not connector-by-connector dashboard heuristics.
The dashboard currently reconstructs "is this fresh / what's missing / will it
heal" from whatever each connector happened to emit. That reconstruction is the
fragile surface this change removes.

The SLVP ideal is that every run answers seven questions per stream:

1. What source range / inventory was **considered**?
2. What was **collected**?
3. What was **skipped** (and why)?
4. What remains **retryable**?
5. What is **terminal / unsupported**?
6. What **checkpoint** was committed?
7. Is the **next run expected to fill the gap**?

## What already exists (and is load-bearing)

The reference already has most of the raw material. This change deliberately does
not re-invent it.

- **Terminal event accounting** — `buildRunTerminalData()` in
  `reference-implementation/runtime/index.js` already stamps `records_emitted`,
  `records_flushed`, `buffered_records_dropped`, `checkpoint_commit_status`,
  `state_streams_staged` / `state_streams_committed`, `known_gaps` +
  `known_gaps_summary`, and a reference-only `detail_gaps` block on
  `run.completed` / `run.failed` / `run.cancelled`.
- **Skip evidence** — `SKIP_RESULT` (public) with bounded redacted `diagnostics`
  propagated to `run.stream_skipped` and `known_gap`
  (`reference-implementation-architecture`: "SKIP_RESULT diagnostics SHALL
  propagate…").
- **Detail gaps** — `DETAIL_GAP` / `DETAIL_COVERAGE` / `DETAIL_GAP_RECOVERED`
  (reference-only) with retryability, locators, and a `required_keys` /
  `hydrated_keys` / `gap_keys` coverage signal.
- **Checkpoints** — "Checkpoints are destination-confirmed for retryable work"
  and the bounded-run detail-gap commit ordering.
- **Coverage vocabulary** — the runtime `CoverageAxis`
  (`reference-implementation/runtime/connection-health.ts`) already enumerates
  `complete | partial | gaps | retryable_gap | terminal_gap | unsupported |
  unavailable | deferred | inventory_only | unknown`. Freshness is a separate
  `FreshnessAxis` (`fresh | stale | unknown`), so `stale` is a freshness value,
  not a coverage condition — the report's coverage axis SHALL NOT carry it.

So questions 2–6 are already answerable for connectors that emit the signals. The
genuine gaps are:

- **No contract** binds these into a guaranteed per-stream report. It is emergent,
  so the dashboard cannot assume it.
- **Question 1 (considered)** has no carrier on the terminal event at all. Without
  a considered denominator, `partial` is only distinguishable from `complete`
  through recorded gaps — which silently-dropping or non-gap-emitting connectors
  do not produce.
- **Question 7 (forward disposition)** is implicit. `known_gaps` carry severity
  and retryability, and attention evidence exists separately, but nothing fuses
  them into a single per-stream "will the next run fix this" answer.

## Approach: a derived projection, not a new wire message

The Collection Report is composed by the **runtime** from signals it already
receives. A connector that emits only `RECORD` / `STATE` / `DONE` still yields a
valid report — its considered axis is just `unknown`. This is the critical design
choice: it keeps the reference-only constraint on `DETAIL_GAP` / `DETAIL_COVERAGE`
intact (root protocol untouched) and avoids a flag-day migration across 30
connectors.

The contract therefore lives in `reference-implementation-architecture` (the same
capability that owns coverage, checkpoints, and detail-gap recovery), not in the
root `polyfill-runtime` protocol spec.

### Where `considered` comes from, in priority order

1. `DETAIL_COVERAGE.required_keys.length` when the connector declared list-plus-detail
   coverage for the boundary (already emitted by ChatGPT).
2. An explicit connector-declared considered count — the one small additive input
   this change introduces, accepted on `DETAIL_COVERAGE` and inside
   `SKIP_RESULT.diagnostics` so connectors can declare it without a new message.
3. A coverage/inventory diagnostic count where one exists (local collectors'
   `coverage_diagnostics`).
4. Otherwise `unknown` — never inferred from collected count.

### Forward disposition derivation

Per stream, in order:

- outstanding gap blocked on open attention evidence → `awaiting_owner`
- outstanding recoverable detail gap or ordinary partial boundary, no attention →
  `resumable`
- outstanding `unsupported` / `terminal_gap` with no recovery path → `terminal`
- no outstanding gap with a committed checkpoint → `complete`

This is a pure function of (coverage condition, gap retryability, attention
presence) — all already durable.

## Alternatives considered

- **Promote `DETAIL_GAP` to portable Collection Profile protocol.** Rejected for
  this tranche: it is a flag-day wire change across every connector and protocol
  reader, and the reference-only constraint exists precisely to avoid premature
  promotion. The report can be derived without it.
- **Require every connector to emit a new `COLLECTION_REPORT` message.** Rejected:
  same flag-day cost, and it duplicates accounting the runtime already does more
  reliably than a connector can self-report. Runtime-derived is harder to fake
  (the `records_emitted` mismatch guard already exists).
- **Put the contract in `polyfill-runtime` (root protocol).** Rejected: this is a
  reference projection over reference-only signals; it must not bind portable
  connectors. `reference-implementation-architecture` is the correct home.
- **Compute considered = collected when no gaps recorded.** Explicitly rejected as
  the core dishonesty this change removes: that is exactly how a silent-drop run
  looks complete. Unknown must read as unknown.

## Acceptance checks

- A run with two requested streams produces a two-entry Collection Report on the
  terminal event, each entry carrying collected count, checkpoint status, and a
  coverage condition from the canonical vocabulary.
- A run that emits `SKIP_RESULT` for a stream yields an entry with the skip reason
  and a non-`complete` coverage condition.
- A run that records a `DETAIL_GAP` yields a `retryable_gap` entry with
  `resumable` forward disposition when no attention is open.
- A stream with open attention evidence yields `awaiting_owner`.
- An `unsupported` stream yields `terminal`.
- A connector that declares a considered value larger than collected yields
  `partial`; a connector that declares none yields a `considered: unknown` entry
  that is not projected as `complete`.
- A portable connector emitting only `RECORD` / `STATE` / `DONE` still produces a
  valid report (unknown axes read as `unknown`).
- The report is absent from all grant-scoped `/v1` responses.
- Secret-redaction and size bounds match `known_gaps` / `SKIP_RESULT.diagnostics`.

## Sequencing

1. **This change (spec + smallest safe code):** define the contract; expose a
   derived `considered` axis and `forward_disposition` per stream on the terminal
   event from already-available signals; accept an optional connector-declared
   considered count. Additive only.
2. **Connector honesty lanes (follow-up, one per connector):** have each connector
   declare its considered value where it can, ordered by which dashboard rows are
   least honest today (the connectors that emit neither detail coverage nor a
   considered denominator). These deliver the most green-page value because they
   move rows from `considered: unknown` to a real `complete` / `partial`.
3. **Dashboard consumption (follow-up):** read the per-stream report and forward
   disposition directly instead of per-connector heuristics; deprecate the
   reconstruction paths.
