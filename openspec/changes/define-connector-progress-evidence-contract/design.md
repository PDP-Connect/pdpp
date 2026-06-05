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

The Collection Report is composed from signals the reference implementation already
receives. A connector that emits only `RECORD` / `STATE` / `DONE` still yields a
valid report — its considered axis is just `unknown`. This is the critical design
choice: it keeps the reference-only constraint on `DETAIL_GAP` / `DETAIL_COVERAGE`
intact (root protocol untouched) and avoids a flag-day migration across 30
connectors.

The contract therefore lives in `reference-implementation-architecture` (the same
capability that owns coverage, checkpoints, and detail-gap recovery), not in the
root `polyfill-runtime` protocol spec.

### Why the report is split across two layers

The evidence the report needs does not all live in one place, so the construction
is split where its inputs already are (this is the accepted layering decision; see
`tmp/workstreams/ri-progress-evidence-terminal-layering-v1-report.md`):

- **Runtime collection-fact block (objective, run-local).** The per-connector run
  is a subprocess that emits a terminal spine event and exits. It objectively owns
  per-stream `collected` counts, the connector-declared `considered` value (or
  `unknown`), committed `STATE`/checkpoint status, `SKIP_RESULT` reasons, and
  pending-`DETAIL_GAP` counts. It attaches these as a per-stream fact block on the
  terminal event. It does **not** see prior-run freshness, the manifest refresh
  policy, or the cross-stream coverage rollup, so it must **not** stamp a final
  coverage condition or a forward disposition.
- **Control-plane projection (derived on read).** `computeConnectionHealth()` (in
  `reference-implementation/runtime/connection-health.ts`, called only from
  `reference-implementation/server/ref-control.ts`) is the only layer that holds
  the freshness axis (`deriveReferenceFreshness()`), the manifest refresh policy
  (`buildRefreshEvidence()`), open attention evidence, and the cross-stream
  coverage rollup (`mapCoverageAxis()`). It derives the per-stream coverage
  condition and the per-stream `forward_disposition` from the runtime fact block
  plus that evidence, reusing the already-unit-tested pure helper
  `deriveForwardDisposition({coverage, gapRetryable, attentionOpen, freshness,
  refresh})`.

Deriving the coverage condition and disposition on read (not freezing them at run
completion) also keeps the report honest as data ages: a stream that was `complete`
+ `fresh` at completion becomes `owner_refresh_due` later, on a manual-refresh-only
connection, without rewriting run history.

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

This runs in the **control-plane projection**, not the runtime — it needs the
freshness axis and refresh policy the runtime subprocess does not hold. Per stream,
in order (first match wins — gaps are evaluated before freshness so a real coverage
gap is never masked by staleness):

- outstanding gap blocked on open attention evidence → `awaiting_owner`
- outstanding recoverable detail gap or ordinary partial boundary, no attention →
  `resumable`
- outstanding `unsupported` / `terminal_gap` with no recovery path → `terminal`
- no outstanding gap, committed checkpoint, but **manual-refresh stale** (the
  connection is manual-refresh-only and its freshness axis is `stale`) →
  `owner_refresh_due`
- no outstanding gap with a committed checkpoint → `complete`

This is a pure function of (coverage condition, gap retryability, attention
presence, freshness axis, refresh policy) — all already durable. The first four
inputs were already used by the prior draft; this lane adds the last two to close
the freshness seam.

### The manual-refresh freshness seam

The prior draft derived disposition from coverage and gaps only, so a
manual-refresh-only connection (Reddit, and any connector whose manifest refresh
policy is `recommended_mode: manual | paused` or `background_safe: false`) that had
collected everything it considered would derive `complete` — even when its retained
data was stale and an owner-initiated run was overdue. That collapses two distinct
facts the refresh doc explicitly keeps separate (full-context-refresh.md: "Do not
conflate revocation, deletion, retention, access validity, data freshness, and
collection state"): coverage completeness and freshness.

The runtime already models this correctly one level up. `connection-health.ts`
emits a separate `FreshnessAxis` (`fresh | stale | unknown`) from its `CoverageAxis`,
and `isManualRefreshOnly()` plus `freshCondition()` already turn a manual-stale
connection into an `idle` headline with a `stale` badge and a "Run the connector
manually" remediation at `info` severity — explicitly *not* a `degraded` pill,
because the connector was never expected to self-refresh. The per-run Collection
Report's disposition was the one place this distinction had not yet propagated.

`owner_refresh_due` is the disposition that carries the freshness fact into the
per-run report without re-encoding it as coverage:

- The **coverage condition stays `complete`** and the **freshness axis stays
  `stale`**. Neither is mutated. A stale-but-complete stream is never reported as
  `partial` / `retryable_gap` / `terminal_gap` — there is no missing data to fill.
- It is **distinct from `awaiting_owner`**, which means an outstanding coverage gap
  is blocked on structured attention (credentials, OTP, re-consent). Refresh-due is
  not blocked and not a gap; conflating the two would tell the owner data is missing
  when it is only aged.
- It is **distinct from `resumable`**, which implies an automatic future run fills a
  gap. A manual connection has no automatic run; the owner must initiate it.
- A **schedulable, background-safe** connection that goes stale is the system's own
  scheduled-refresh responsibility, not owner work, so it is *not*
  `owner_refresh_due` — it stays `complete` at the report level while the
  connection-health projection raises the schedulable-stale `warning` it already
  owns. This keeps the per-run report from second-guessing the scheduler.

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
- **Reuse `awaiting_owner` for manual-refresh-stale streams.** Rejected:
  `awaiting_owner` means an outstanding *coverage gap* is blocked on structured
  attention (credentials, OTP, re-consent). A stale-but-complete stream has no gap;
  labelling it `awaiting_owner` would tell the owner data is missing when it is only
  aged, re-conflating freshness with collection state. `owner_refresh_due` keeps the
  two distinguishable.
- **Encode staleness as a `stale` coverage condition.** Rejected: `stale` is a
  `FreshnessAxis` value, not a `CoverageAxis` value, and the coverage-vocabulary
  requirement already forbids carrying it on the coverage axis. Staleness belongs on
  the freshness axis and surfaces through the disposition, never as a coverage
  condition.
- **Let the per-run report flag schedulable-stale connections too.** Rejected for
  this tranche: a background-safe connection going stale is the scheduler's own
  responsibility and is already surfaced by the connection-health `warning`. Having
  the per-run report also raise owner-action on it would duplicate and second-guess
  the scheduler. `owner_refresh_due` is scoped to manual-refresh-only connections.

## Acceptance checks

- A run with two requested streams attaches a two-entry runtime collection-fact
  block to the terminal event, each entry carrying collected count and checkpoint
  status, and the control-plane projection derives a two-entry Collection Report,
  each entry carrying a coverage condition from the canonical vocabulary.
- The runtime terminal event carries the per-stream fact block (collected,
  considered-or-`unknown`, checkpoint, skip reason, pending-detail-gap count) and
  carries **no** per-stream coverage condition and **no** forward disposition.
- A run that emits `SKIP_RESULT` for a stream yields a fact-block entry with the
  skip reason and a derived entry with a non-`complete` coverage condition.
- A run that records a `DETAIL_GAP` yields a `retryable_gap` entry with
  `resumable` forward disposition when no attention is open.
- A stream with open attention evidence yields `awaiting_owner`.
- An `unsupported` stream yields `terminal`.
- A complete-coverage stream with `fresh` freshness yields a `complete` disposition
  and signals no owner action.
- A complete-coverage stream on a manual-refresh-only connection with `stale`
  freshness yields `owner_refresh_due` (not `complete`, not `awaiting_owner`), while
  its coverage condition stays `complete` and its freshness axis stays `stale`.
- A `retryable_gap` stream that is also `stale` still yields a `resumable`
  disposition with its pending-gap count intact — staleness does not mask the gap.
- A schedulable, background-safe stale stream is *not* `owner_refresh_due`.
- A connector that declares a considered value larger than collected yields
  `partial`; a connector that declares none yields a `considered: unknown` entry
  that is not projected as `complete`.
- A portable connector emitting only `RECORD` / `STATE` / `DONE` still produces a
  valid report (unknown axes read as `unknown`).
- The report is absent from all grant-scoped `/v1` responses.
- Secret-redaction and size bounds match `known_gaps` / `SKIP_RESULT.diagnostics`.

## Sequencing

The code is sequenced to follow the two-layer split — runtime facts first, then the
projection that derives the axes — so each tranche is independently green-able and
strictly additive.

1. **Spec (this change, section 1):** define the contract as the two-layer
   construction. Landed.
2. **Tranche A — runtime input plumbing:** accept an optional connector-declared
   `considered` count on `DETAIL_COVERAGE` and inside `SKIP_RESULT.diagnostics`,
   bounded/redacted on the existing diagnostics path, riding the existing
   `run.detail_coverage_declared` / `run.stream_skipped` spine events. Additive
   only; emits no `collection_report` / coverage condition / `forward_disposition`.
   Landed (task 2.1).
3. **Tranche B — runtime collection-fact block:** track per-stream emitted counts
   in the run loop (today only aggregate `totalEmitted` exists) and attach a
   per-stream fact block (collected, considered-or-`unknown`, checkpoint, skip
   reason, pending-detail-gap count) to `buildRunTerminalData()`. No coverage
   condition, no forward disposition on the terminal event. Next implementation
   lane (task 2.2a).
4. **Tranche C — control-plane projection:** in `ref-control.ts`, key the existing
   coverage-rollup + `deriveForwardDisposition()` logic per stream, reading the
   runtime fact block plus freshness, refresh policy, and attention to derive each
   entry's coverage condition and `forward_disposition` on the owner/control-plane
   surface only (task 2.2b + 2.4–2.7). The connection-level
   `forward_disposition` (tasks 2.3/2.3a/2.3b) already proves this pure helper live
   on the projection; Tranche C extends it from connection scope to stream scope.
5. **Connector honesty lanes (follow-up, one per connector):** have each connector
   declare its considered value where it can, ordered by which dashboard rows are
   least honest today (the connectors that emit neither detail coverage nor a
   considered denominator). These deliver the most green-page value because they
   move rows from `considered: unknown` to a real `complete` / `partial`.
6. **Dashboard consumption (follow-up):** read the per-stream report and forward
   disposition directly instead of per-connector heuristics; deprecate the
   reconstruction paths.
