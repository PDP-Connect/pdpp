## ADDED Requirements

### Requirement: Connectors SHALL support an owner-configured detail-lane run cap as an opt-in, default-off bound
A connector with a serial detail lane SHALL be able to bound a single run by an
owner-configured **size** cap (number of detail fetches per run) and/or **time**
cap (wall-clock the detail phase may spend), and this cap SHALL be opt-in via
environment configuration and **default off**: an unset, empty, non-numeric, or
non-positive value SHALL resolve to no cap, and with no cap configured a run SHALL
behave exactly as it would without this feature (no cap branch is consulted). A
configured cap SHALL only ever cause a run to stop *earlier*; it SHALL NOT
increase concurrency, change pacing, raise a retry budget, or cause a run to fetch
more than it otherwise would.

The cap SHALL be **run-scoped and shared** across every pass of a single run — in
particular a detail-gap recovery pass and a forward-walk pass SHALL draw down one
shared budget — so that a recovery backlog plus newly listed records are bounded
together rather than each pass receiving a fresh budget. A wall-clock cap SHALL be
measured from the first time the budget is consulted (the start of the detail
phase), not from connector startup.

When a configured cap is reached, the connector SHALL stop launching new detail
fetches and SHALL defer the current and every remaining record as a resumable
`DETAIL_GAP`, using the same deferral, cursor-commit, and recovery machinery a
source-pressure deferral uses: the hydrated prefix's cursor SHALL commit, the
deferred keys SHALL appear in `DETAIL_COVERAGE.gap_keys`, and a later run SHALL
recover the deferred records (recovery selecting gaps by stream, not by reason)
and walk forward, so a large history fills in over several bounded runs.

#### Scenario: No cap configured leaves a run unbounded and unchanged

- **WHEN** neither the size knob nor the wall-clock knob is set (or both are
  empty / non-numeric / non-positive)
- **THEN** the run SHALL resolve to no cap
- **AND** no cap branch SHALL defer any record
- **AND** a large backlog SHALL run to completion exactly as it would without the
  cap feature

#### Scenario: A configured size cap defers the remaining tail as a resumable gap

- **WHEN** a detail run is configured with a maximum number of detail fetches per
  run
- **AND** the run has hydrated that many record details
- **THEN** the connector SHALL stop launching new detail fetches
- **AND** it SHALL defer the current and every remaining record as a resumable
  `DETAIL_GAP`
- **AND** the hydrated prefix's cursor SHALL commit
- **AND** the deferred keys SHALL appear in `DETAIL_COVERAGE.gap_keys`

#### Scenario: A configured wall-clock cap is bounded by at most one in-flight fetch

- **WHEN** a detail run is configured with a maximum detail-phase wall-clock
- **AND** the elapsed detail-phase wall-clock reaches that maximum
- **THEN** the connector SHALL check the cap between fetches, never interrupting a
  fetch already in flight
- **AND** the run MAY exceed the configured wall-clock by at most one in-flight
  fetch's processing time, itself bounded by the connector's per-fetch timeout

#### Scenario: One shared budget bounds the recovery pass and the forward pass together

- **WHEN** a single run performs a detail-gap recovery pass and then a
  forward-walk pass under a configured cap
- **THEN** both passes SHALL draw down one shared run-scoped budget
- **AND** a recovery backlog larger than the cap SHALL cause the forward pass to
  defer without starting a second budget

### Requirement: An owner-configured run-cap deferral SHALL NOT be treated as source pressure
A run-cap deferral SHALL be marked as a **self-imposed bound**, distinct from a
deferral caused by account/source pressure: a `DETAIL_GAP` deferred because a run
reached its owner-configured size or time cap is not a source-pressure signal. The
run-cap deferral SHALL carry a resumable wire reason
that is **not** in the source-pressure reason set (`upstream_pressure`,
`rate_limited`), so it SHALL NOT arm the cross-run source-pressure cooldown
governor and SHALL NOT be counted in the source-pressure detail-gap backlog
rollup. The deferral SHALL additionally carry a distinct error class identifying
the configured run cap, so an owner surface can render a self-imposed cap
separately from a busy-service deferral. The run-cap deferral SHALL NOT report an
HTTP failure status, because nothing failed — the run simply stopped at its
budget.

#### Scenario: A run-cap deferral does not arm the source-pressure cooldown

- **WHEN** a connector defers records because a run reached its owner-configured
  cap
- **THEN** the deferred `DETAIL_GAP` reason SHALL NOT be in the source-pressure
  reason set
- **AND** the deferral SHALL NOT arm the cross-run source-pressure cooldown
  governor
- **AND** the deferral SHALL NOT be counted in the source-pressure detail-gap
  backlog rollup

#### Scenario: A run-cap deferral is distinguishable from a source-pressure deferral

- **WHEN** a connector defers records because a run reached its owner-configured
  cap
- **THEN** the deferral SHALL carry an error class identifying the configured run
  cap
- **AND** that class SHALL be distinct from the class a source-pressure deferral
  carries
- **AND** the deferral SHALL NOT report an HTTP failure status

### Requirement: Run-cap and generic retry-exhausted deferrals SHALL have distinct, honest end-user copy
The end-user display copy SHALL be distinct for the generic retry-exhausted wire
reason and for the configured run-cap error class, and neither SHALL imply that the
source service was busy. The generic retry-exhausted reason SHALL read as a retry
budget having been used up — applicable to any retry-exhaustion path, not only a
configured cap. The run-cap error class SHALL read as a self-imposed per-run
budget that saved what it collected and will continue on the next run. Copy that
implies source pressure (for example "the service is busy") SHALL be reserved for
the source-pressure reasons.

#### Scenario: Run-cap copy names a self-imposed budget without implying source pressure

- **WHEN** an owner surface renders the copy for a configured run-cap deferral
- **THEN** the copy SHALL describe a per-run budget that saved a batch and will
  continue next run
- **AND** the copy SHALL NOT imply that the source service was busy or pressured

#### Scenario: Generic retry-exhausted copy is not specific to a configured cap

- **WHEN** an owner surface renders the copy for the generic retry-exhausted
  reason
- **THEN** the copy SHALL describe a retry budget that was used up
- **AND** the copy SHALL NOT be byte-identical to the configured run-cap copy
- **AND** the copy SHALL NOT imply that the source service was busy or pressured

### Requirement: A run-cap tail deferral SHALL bound its own foreground materialization

A run-cap trip SHALL bound the **foreground work of materializing the deferral
itself** when the remaining record tail is larger than an owner-configurable
finite chunk: the connector SHALL write at most the configured chunk of
per-record resumable `DETAIL_GAP` rows, then fold every older remaining record
into **one** durable backlog `DETAIL_GAP` carrying a content-derived list cursor
/ watermark (never a positional offset) for the un-materialized remainder. A run
SHALL NOT spend a long foreground stretch writing one gap row per remaining
record after it has already stopped fetching details.

This chunk SHALL be **opt-in and default off**: an unset chunk SHALL leave the
per-record deferral behavior byte-for-byte unchanged. When only a fetch/time cap
is configured (and no explicit chunk), the connector MAY derive a safe finite
chunk so an owner who opts into a run cap also gets a bounded tail. The backlog
gap SHALL reuse the run-cap deferral contract — a resumable reason outside the
source-pressure set and the run-cap error class — so it never arms the
source-pressure cooldown and is excluded from the source-pressure backlog rollup.

The deferral SHALL remain **resumable and convergent**: a later run's recovery
SHALL expand the backlog gap by re-listing the parent list at-or-older than the
stored inclusive watermark and materializing the next bounded chunk of that
window, resolving or rewriting the backlog gap with a new content-derived
watermark when remainder exists, and this expansion SHALL run before forward-walk
work so the deferred tail recovers first. The inclusive bound SHALL be
tie-safe: recovery MAY re-see an already-accounted record sharing the boundary
timestamp, but SHALL NOT strand an un-materialized record with that timestamp. A
history larger than the chunk SHALL drain over several bounded runs with no
record lost and no offset reconstruction; the monotone forward cursor SHALL NOT
advance past an unaccounted record (the backlog gap accounts for the older
remainder).

#### Scenario: A cap trip over a large remaining tail writes a bounded number of gap rows

- **WHEN** a run-cap trips with a configured finite tail-deferral chunk
- **AND** the remaining record tail is larger than that chunk
- **THEN** the connector SHALL write at most the chunk of per-record `DETAIL_GAP`
  rows
- **AND** it SHALL write exactly one durable backlog `DETAIL_GAP` for the older
  remainder, carrying a content-derived watermark and not a positional offset
- **AND** the run SHALL NOT write one gap row per remaining record

#### Scenario: Default-off leaves the tail deferral unchanged

- **WHEN** no tail-deferral chunk is configured and no fetch/time cap derives one
- **THEN** a run-cap tail SHALL be materialized one resumable `DETAIL_GAP` per
  record exactly as it would without this bound (no backlog gap is written)

#### Scenario: A later run expands the backlog gap before forward work and converges

- **WHEN** a later run is served a backlog `DETAIL_GAP`
- **THEN** recovery SHALL re-list the parent list at-or-older than the backlog's
  inclusive watermark and materialize the next bounded chunk of that window
  before any forward-walk work
- **AND** it SHALL resolve the old backlog gap or rewrite it with a new
  content-derived watermark when remainder exists
- **AND** it SHALL NOT strand records that share the backlog watermark timestamp
- **AND** over several bounded runs the older history SHALL fully drain with no
  record lost and no positional-offset reconstruction

#### Scenario: A bounded tail deferral is not source pressure

- **WHEN** a connector folds a run-cap tail into per-record chunk gaps plus a
  backlog gap
- **THEN** every such gap SHALL carry a resumable reason outside the
  source-pressure reason set and the run-cap error class
- **AND** none of them SHALL arm the source-pressure cooldown governor or be
  counted in the source-pressure detail-gap backlog rollup
