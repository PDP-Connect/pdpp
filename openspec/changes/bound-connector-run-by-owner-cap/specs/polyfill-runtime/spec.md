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
