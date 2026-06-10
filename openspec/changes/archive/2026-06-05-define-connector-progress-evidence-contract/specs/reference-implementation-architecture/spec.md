## ADDED Requirements

### Requirement: Every connector run SHALL produce a per-stream Collection Report

For each terminal connector run, the reference implementation SHALL produce a
structured **Collection Report**: a per-stream coverage entry for every stream that
was in requested scope or visible in the connector manifest for that run. Each
entry SHALL answer, as structured fields rather than only timeline prose, what was
**considered**, what was **collected**, what was **skipped**, what remains a
**retryable gap**, what is **terminal or unsupported**, what **checkpoint** was
committed for that stream, and what the next run is expected to do.

The Collection Report SHALL be produced as a two-layer construction, because the
evidence needed to answer those questions does not all live in one layer:

- **Runtime collection-fact block (objective, run-local).** The reference runtime
  SHALL attach to the run's terminal evidence (the `run.completed`, `run.failed`,
  or `run.cancelled` spine event payload) a per-stream block carrying only the
  objective, run-local facts it owns at run completion: the stream's **collected**
  count, a **considered** value or `unknown` (never inferred from collected count),
  an optional **covered** count or `unknown` (the in-boundary items the run
  accounted for — emitted plus those it deliberately suppressed as unchanged —
  never inferred from collected count and never including a weighed-but-dropped
  item), the committed **checkpoint** status, the **skip** reason for any
  `SKIP_RESULT`, and the count of pending recoverable **detail gaps**. The runtime SHALL compose
  this block from signals it already receives — `RECORD` counts, `SKIP_RESULT`, the
  reference-only `DETAIL_GAP` and `DETAIL_COVERAGE` signals, and committed `STATE`
  cursors — and SHALL NOT require a new portable wire message from the connector.
  The runtime SHALL NOT stamp a final coverage condition or a forward disposition
  on the terminal event: both require freshness, refresh-policy, attention, and
  cross-stream rollup evidence that the per-connector run subprocess does not hold.
- **Control-plane projection (derived on read).** The control-plane projection
  (the layer that assembles connection-health evidence) SHALL derive the full
  per-stream Collection Report — each entry's **coverage condition** and **forward
  disposition** — from the runtime collection-fact block plus the freshness axis,
  manifest refresh policy, open attention evidence, and cross-stream coverage
  rollup that only that layer holds. Deriving on read keeps the report honest as
  data ages: an entry that was fresh at run completion can become
  `owner_refresh_due` later without rewriting run history.

The Collection Report SHALL be visible only on owner/control-plane surfaces under
the same redaction and bounding policy already applied to `known_gaps` and
`SKIP_RESULT.diagnostics`. Neither the runtime collection-fact block nor the
derived report SHALL be exposed through grant-scoped `/v1` data, search, schema, or
blob APIs.

A stream's entry SHALL reuse the connection-coverage condition vocabulary — the
runtime `CoverageAxis` the connection-health projection already emits
(`complete`, `partial`, `gaps`, `retryable_gap`, `terminal_gap`, `unsupported`,
`unavailable`, `deferred`, `inventory_only`, `unknown`) — so that the
connection-health projection consumes the report without re-deriving coverage from
heterogeneous per-connector heuristics. Freshness (`fresh` / `stale` / `unknown`)
is a separate axis and SHALL NOT be encoded as a coverage condition.

#### Scenario: A successful run produces a report entry per in-scope stream

- **WHEN** a connector run completes for a scope that requested two streams and the manifest declares no further streams
- **THEN** the run's terminal evidence SHALL carry a runtime collection-fact block with one per-stream entry for each of the two requested streams, each entry carrying the stream's collected count and committed checkpoint status
- **AND** the control-plane projection SHALL derive a Collection Report with one entry per stream, each entry carrying a coverage condition drawn from the connection-coverage vocabulary

#### Scenario: The runtime terminal event carries facts only, not derived axes

- **WHEN** the reference runtime emits the `run.completed`, `run.failed`, or `run.cancelled` terminal event for a run
- **THEN** the terminal event's collection-fact block SHALL carry per-stream collected count, considered-or-`unknown`, checkpoint status, skip reason, and pending-detail-gap count
- **AND** the terminal event SHALL NOT carry a per-stream coverage condition or a per-stream forward disposition, because those are derived by the control-plane projection from evidence the runtime does not hold

#### Scenario: A run that skips a stream records it in the report

- **WHEN** a connector emits `SKIP_RESULT` for a requested stream because the implementation cannot collect it in the current mode
- **THEN** the runtime collection-fact block for that stream SHALL carry the skip reason
- **AND** the derived Collection Report entry for that stream SHALL carry a coverage condition of `unsupported`, `unavailable`, `deferred`, or `terminal_gap` consistent with the skip and SHALL NOT report that stream as `complete`

#### Scenario: A run with a recoverable detail gap records it in the report

- **WHEN** a bounded run records a durable recoverable `DETAIL_GAP` for a stream before committing list-level progress
- **THEN** the runtime collection-fact block for that stream SHALL carry the count of pending recoverable gaps
- **AND** the derived Collection Report entry for that stream SHALL carry a `retryable_gap` coverage condition and SHALL reference the reference-only detail-gap backlog rather than restating per-item locators in the report

#### Scenario: The report does not change the public data API

- **WHEN** a grant-scoped client token reads records, search results, schema, or blobs within its grant
- **THEN** the Collection Report SHALL NOT be included in the response
- **AND** the client SHALL NOT receive an identifier that grants access to the report

### Requirement: A Collection Report entry SHALL state a forward disposition

Each Collection Report stream entry SHALL carry a **forward disposition** that
states what work, if any, the next run is expected to do on that stream. The
disposition SHALL be one of `complete` (no outstanding gap and freshness is fresh
or unknown), `resumable` (an outstanding gap that ordinary forward collection or
detail-gap recovery is expected to fill on a later run without owner action),
`awaiting_owner` (an outstanding gap blocked on structured owner attention such as
credentials, OTP, re-consent, or a manual action), `owner_refresh_due` (no
outstanding coverage gap, but the retained data is stale for a connection that
cannot refresh on its own, so an owner-initiated run is due), or `terminal` (an
outstanding gap that no future run is expected to fill without a connector or
source change). The disposition SHALL be derived by the control-plane projection
from the entry's coverage condition, the retryability of any recorded gap, current
attention evidence, and the connection's freshness and refresh-policy evidence —
not from run timeline prose, and not stamped on the runtime terminal event. The
runtime terminal event SHALL NOT carry a forward disposition; the forward
disposition is derived on read by the layer that holds freshness, refresh-policy,
attention, and rollup evidence (the same construction the connection-level
`forward_disposition` already uses).

Coverage completeness and freshness are distinct axes and SHALL NOT be conflated:
a stale stream that collected everything it considered SHALL keep a `complete`
coverage condition and a `stale` freshness axis. Staleness SHALL NOT be encoded as
a coverage gap, and a stale-but-complete stream SHALL NOT be reported with a
coverage condition of `partial`, `gaps`, `retryable_gap`, or `terminal_gap`. The
disposition is where the freshness fact becomes an owner-facing action: a
complete-coverage stream whose connection is manual-refresh-only (its manifest
refresh policy is not background-safe — `recommended_mode` `manual` or `paused`,
or `background_safe` `false`) and whose freshness axis is `stale` SHALL be
`owner_refresh_due`, signalling owner-initiated refresh work rather than degraded
or lost data. A schedulable, background-safe connection that goes stale is the
system's own responsibility to refresh and SHALL NOT be reported as
`owner_refresh_due`.

The forward disposition SHALL be consistent with the gap it describes: an entry
with an outstanding gap blocked on owner attention SHALL be `awaiting_owner`; an
entry whose only outstanding gap is a recoverable detail gap or an ordinary partial
boundary SHALL be `resumable` unless blocked on owner attention; an entry whose gap
is a terminal or unsupported condition SHALL be `terminal`; an entry with no
outstanding gap SHALL be `owner_refresh_due` when it is manual-refresh stale and
`complete` otherwise. `awaiting_owner` SHALL be reserved for an outstanding
coverage gap and SHALL NOT be used for a stale-but-complete stream, so the owner
can tell missing data from merely aged data.

#### Scenario: A retryable gap is resumable

- **WHEN** a stream entry's only outstanding gap is a pending recoverable detail gap with retryable upstream pressure and no owner action is required
- **THEN** the entry's forward disposition SHALL be `resumable`
- **AND** the owner surface SHALL be able to state that the next run is expected to fill the gap without owner action

#### Scenario: A gap blocked on owner attention awaits the owner

- **WHEN** a stream cannot complete because the connection has open structured attention evidence (for example missing credentials, a pending OTP, or required re-consent)
- **THEN** the entry's forward disposition SHALL be `awaiting_owner`
- **AND** the owner surface SHALL point the owner at the same attention target rather than implying an automatic retry will resolve it

#### Scenario: An unsupported stream is terminal

- **WHEN** a stream entry's coverage condition is `unsupported` or `terminal_gap` with no recoverable recovery path
- **THEN** the entry's forward disposition SHALL be `terminal`
- **AND** the owner surface SHALL NOT imply that a future ordinary run will collect that stream

#### Scenario: Complete coverage with fresh freshness is complete and needs no owner action

- **WHEN** a stream entry has no outstanding gap, a committed checkpoint, a known considered value the collected count satisfies, and a freshness axis of `fresh`
- **THEN** the entry's coverage condition SHALL be `complete` and its forward disposition SHALL be `complete`
- **AND** the owner surface SHALL state that no owner action is required for that stream

#### Scenario: Complete coverage that is manual-refresh stale is owner-refresh-due, not degraded data loss

- **WHEN** a stream entry has no outstanding coverage gap and a committed checkpoint, but the connection is manual-refresh-only (its manifest refresh policy is `recommended_mode` `manual` or `paused`, or `background_safe` `false`) and its freshness axis is `stale`
- **THEN** the entry's coverage condition SHALL remain `complete` and its freshness axis SHALL remain `stale`
- **AND** the entry's forward disposition SHALL be `owner_refresh_due`, not `awaiting_owner`, `resumable`, or `complete`
- **AND** the owner surface SHALL frame this as an owner-initiated refresh that is due, not as missing, dropped, or degraded data

#### Scenario: A retryable detail gap stays visible even when the stream is also stale

- **WHEN** a stream entry has a pending recoverable `DETAIL_GAP` with retryable upstream pressure, no owner attention is open, and the connection's freshness axis is also `stale`
- **THEN** the entry's coverage condition SHALL be `retryable_gap` and its pending recoverable-gap count SHALL remain recorded
- **AND** the entry's forward disposition SHALL be `resumable` so the retryable/resumable recovery path stays visible and is not masked by the stale freshness
- **AND** staleness SHALL NOT downgrade, hide, or absorb the recorded retryable gap

#### Scenario: A schedulable stale stream is not owner-refresh-due

- **WHEN** a stream entry has no outstanding gap but the connection is schedulable and background-safe and its freshness axis is `stale`
- **THEN** the entry's forward disposition SHALL NOT be `owner_refresh_due`
- **AND** the owner surface SHALL treat the stale freshness as the system's own scheduled-refresh responsibility rather than owner-initiated refresh work

### Requirement: Absence of a considered denominator SHALL be honest, not assumed complete

A Collection Report stream entry SHALL distinguish a known **considered** axis —
the source range, inventory size, or boundary the run took into account for that
stream — from an unknown one. When a connector declares what it considered for a
stream (for example via `DETAIL_COVERAGE.required_keys`, an explicit considered
count, or an inventory diagnostic), the runtime collection-fact block SHALL record
that considered value, and the control-plane projection MAY use it to distinguish
`partial` from `complete`. When the connector declares no considered value, the
runtime collection-fact block's considered value SHALL be `unknown`, and the
runtime SHALL NOT infer a considered value from collected count alone.

A run that collected records SHALL NOT, by collected count alone, be projected as
having completely covered a stream whose considered denominator is unknown. Neither
the runtime nor the control-plane projection SHALL infer `complete` from collected
count alone. The absence of a considered value SHALL read as absence of evidence,
not as proof of completeness.

A stream that re-enumerates its full source boundary every run and suppresses the
records it determined to be unchanged (for example a full-sync stream gated by a
per-record fingerprint) MAY declare, alongside `considered`, an explicit **covered**
count: the number of in-boundary items the run accounted for, defined as the items
it emitted plus the items it suppressed because they were unchanged. The covered
count SHALL be measured at the enumeration site from objective per-record outcomes
(emitted, or suppressed-because-unchanged) and SHALL NOT be inferred from the
collected count, and SHALL NOT count an item the run weighed but dropped (a
malformed record, a record excluded by a boundary filter, or any item not present
in the source as unchanged). When a connector declares a covered count, the
control-plane projection SHALL compare the considered denominator against the
covered count rather than the collected count: a stream whose covered count
satisfies its considered denominator with no outstanding gap or skip SHALL read
`complete`, and a stream whose covered count falls short of its considered
denominator SHALL read `partial`. When a connector declares no covered count, the
projection SHALL compare the considered denominator against the collected count as
before. The covered count SHALL be optional evidence only; its absence SHALL NOT
change the meaning of `considered` for any stream that does not declare it.

#### Scenario: A steady-state full-sync run suppresses only unchanged records

- **WHEN** a connector enumerates a full-sync stream's entire source boundary, emits no records because every in-boundary item was unchanged since the prior run, and declares a considered count equal to the enumerated inventory and a covered count equal to the same inventory (every item accounted for as suppressed-unchanged)
- **THEN** the Collection Report entry SHALL record the considered value and a `complete` coverage condition
- **AND** the entry SHALL NOT read `partial` solely because its collected count is below its considered denominator

#### Scenario: A full-sync run that drops a weighed item stays partial

- **WHEN** a connector enumerates a full-sync stream's source boundary and accounts for fewer items as covered (emitted or suppressed-unchanged) than it considered, because it weighed but dropped an item (for example a record that failed shape validation)
- **THEN** the Collection Report entry SHALL record the considered value and a `partial` coverage condition
- **AND** the dropped item SHALL NOT be counted as covered, so the covered count SHALL fall short of the considered denominator and the shortfall SHALL remain visible

#### Scenario: A connector declares what it considered

- **WHEN** a connector declares a considered value for a stream (an inventory size, a required-keys set, or an explicit considered count) and collects fewer items than it considered with the remainder recorded as gaps
- **THEN** the Collection Report entry SHALL record the considered value and a `partial` coverage condition
- **AND** the entry SHALL NOT report `complete`

#### Scenario: A connector declares no considered value

- **WHEN** a connector collects records for a stream but declares no considered value, inventory, or required-keys set, and records no gaps
- **THEN** the Collection Report entry's considered axis SHALL be `unknown`
- **AND** the entry SHALL NOT be projected as `complete` solely because it collected records and recorded no gaps
- **AND** the entry's forward disposition SHALL NOT be `complete` on the strength of collected count alone, because `complete` requires the absence of an outstanding gap to be established rather than assumed from an unknown denominator

#### Scenario: Considered evidence is unreadable

- **WHEN** the runtime cannot read a connector-declared considered value because it is malformed or exceeds bounds
- **THEN** the entry's considered axis SHALL fall back to `unknown`
- **AND** the failure SHALL NOT fabricate a `complete` coverage condition for that stream

### Requirement: The Collection Report SHALL reuse reference-only signals without promoting them

The Collection Report SHALL be a reference-implementation projection. It SHALL
compose the reference-only `DETAIL_GAP` and `DETAIL_COVERAGE` signals under their
existing reference-only constraint and the already-public `SKIP_RESULT`, `STATE`,
and terminal-event surfaces. This change SHALL NOT promote `DETAIL_GAP`,
`DETAIL_COVERAGE`, the detail-gap backlog schema, or a new Collection Report
message into the normative portable Collection Profile protocol. Portable
connectors and protocol readers SHALL NOT be required to emit a Collection Report
message or to rely on its shape unless a later OpenSpec change and root protocol
update promote an explicit wire contract.

#### Scenario: A protocol reader asks whether the report is portable protocol

- **WHEN** a reviewer asks whether the Collection Report is a required Collection Profile message or field
- **THEN** the reference documentation SHALL state that it is reference-only projection, not normative portable protocol in this tranche
- **AND** a portable connector that emits only `RECORD`, `STATE`, and `DONE` SHALL still produce a valid Collection Report whose unknown axes read as `unknown`

#### Scenario: Report composition avoids secrets

- **WHEN** the runtime bounds connector-authored skip diagnostics, detail-gap locators, or considered/covered values into the collection-fact block, and the control-plane projection derives the Collection Report from it
- **THEN** both layers SHALL apply the same secret-redaction and bounding policy used for `known_gaps` and `SKIP_RESULT.diagnostics`
- **AND** neither SHALL persist bearer tokens, cookies, secret-bearing URLs, request bodies, or raw private payloads
