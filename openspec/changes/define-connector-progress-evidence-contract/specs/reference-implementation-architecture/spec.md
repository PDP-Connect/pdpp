## ADDED Requirements

### Requirement: Every connector run SHALL produce a per-stream Collection Report

The reference runtime SHALL derive, for each terminal connector run, a structured
**Collection Report**: a per-stream coverage entry for every stream that was in
requested scope or visible in the connector manifest for that run. Each entry
SHALL answer, as structured fields rather than only timeline prose, what was
**considered**, what was **collected**, what was **skipped**, what remains a
**retryable gap**, what is **terminal or unsupported**, and what **checkpoint** was
committed for that stream. The runtime SHALL compose the report from signals it
already receives — `RECORD` counts, `SKIP_RESULT`, the reference-only `DETAIL_GAP`
and `DETAIL_COVERAGE` signals, committed `STATE` cursors, and its own terminal
accounting — and SHALL NOT require a new portable wire message from the connector.

The Collection Report SHALL be attached to the run's terminal evidence (the
`run.completed`, `run.failed`, or `run.cancelled` spine event payload) and SHALL
be visible only on owner/control-plane surfaces under the same redaction and
bounding policy already applied to `known_gaps` and `SKIP_RESULT.diagnostics`. It
SHALL NOT be exposed through grant-scoped `/v1` data, search, schema, or blob APIs.

A stream's entry SHALL reuse the connection-coverage condition vocabulary — the
runtime `CoverageAxis` the connection-health projection already emits
(`complete`, `partial`, `gaps`, `retryable_gap`, `terminal_gap`, `unsupported`,
`unavailable`, `deferred`, `inventory_only`, `unknown`) — so that the
connection-health projection consumes the report without re-deriving coverage from
heterogeneous per-connector heuristics. Freshness (`fresh` / `stale` / `unknown`)
is a separate axis and SHALL NOT be encoded as a coverage condition.

#### Scenario: A successful run produces a report entry per in-scope stream

- **WHEN** a connector run completes for a scope that requested two streams and the manifest declares no further streams
- **THEN** the run's terminal evidence SHALL include a Collection Report with one stream entry for each of the two requested streams
- **AND** each entry SHALL carry the stream's collected count, its committed checkpoint status, and a coverage condition drawn from the connection-coverage vocabulary

#### Scenario: A run that skips a stream records it in the report

- **WHEN** a connector emits `SKIP_RESULT` for a requested stream because the implementation cannot collect it in the current mode
- **THEN** the Collection Report entry for that stream SHALL carry the skip reason and a coverage condition of `unsupported`, `unavailable`, `deferred`, or `terminal_gap` consistent with the skip
- **AND** the entry SHALL NOT report that stream as `complete`

#### Scenario: A run with a recoverable detail gap records it in the report

- **WHEN** a bounded run records a durable recoverable `DETAIL_GAP` for a stream before committing list-level progress
- **THEN** the Collection Report entry for that stream SHALL carry a `retryable_gap` coverage condition and the count of pending recoverable gaps
- **AND** the entry SHALL reference the reference-only detail-gap backlog rather than restating per-item locators in the report

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
source change). The disposition SHALL be derived from the entry's coverage
condition, the retryability of any recorded gap, current attention evidence, and
the connection's freshness and refresh-policy evidence — not from run timeline
prose.

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
count, or an inventory diagnostic), the entry SHALL record that considered value
and MAY use it to distinguish `partial` from `complete`. When the connector
declares no considered value, the entry's considered axis SHALL be `unknown`, and
the runtime SHALL NOT infer `complete` from collected count alone.

A run that collected records SHALL NOT, by collected count alone, be projected as
having completely covered a stream whose considered denominator is unknown. The
absence of a considered value SHALL read as absence of evidence, not as proof of
completeness.

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

- **WHEN** the runtime composes a Collection Report from connector-authored skip diagnostics, detail-gap locators, or considered values
- **THEN** the report SHALL apply the same secret-redaction and bounding policy used for `known_gaps` and `SKIP_RESULT.diagnostics`
- **AND** it SHALL NOT persist bearer tokens, cookies, secret-bearing URLs, request bodies, or raw private payloads
