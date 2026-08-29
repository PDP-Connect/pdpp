## ADDED Requirements

### Requirement: A coverage horizon and a connector boundary claim SHALL NOT establish coverage completeness

Neither a recorded `ConnectionCoverageHorizon`, nor a connector-declared
`boundary_claim`, nor the two in combination, SHALL cause a stream's coverage
to read complete, narrow the coverage denominator, change a coverage axis, or
change a connection's health state or forward disposition. This SHALL hold for
every horizon `basis`, for a connection-wide (`"*"`) and a stream-scoped
horizon alike, and regardless of whether `earliestAvailable` is present.

The reference implementation SHALL expose no predicate that answers whether a
gap is accounted for by a horizon, and the connection-health coverage evidence
SHALL carry no field by which a caller can unlock completeness from horizon
evidence.

A coverage horizon SHALL remain recorded, superseded, and readable as
disclosure, and a connector's recognized `boundary_claim` SHALL remain
persisted on the durable gap, so removing this authority SHALL NOT reduce what
an owner can see.

A future revision MAY allow a horizon to narrow the servable denominator only
by first defining `boundary_claim` in the normative Collection Profile and
binding an individual gap to a specific horizon edge through a comparable
structured domain that proves the gap lies wholly outside the currently
servable interval.

#### Scenario: a horizon with an unknown edge cannot prove a gap is pre-horizon

- **WHEN** a retryable gap carries the `provider_history_boundary` claim
- **AND** a current, affirmatively-based horizon exists for that stream whose
  `earliestAvailable` is `null`
- **THEN** the stream's coverage SHALL NOT read complete
- **AND** the connection SHALL NOT read healthy on that basis.

#### Scenario: a gap inside the servable interval is not softened by the claim

- **WHEN** a retryable gap carries the `provider_history_boundary` claim
- **AND** the gap falls inside the interval the current horizon reports as
  still servable
- **THEN** the gap SHALL remain degrading exactly as it would with no horizon
  recorded.

#### Scenario: multiple claiming gaps do not collectively account themselves away

- **WHEN** several retryable gaps each carry the `provider_history_boundary`
  claim
- **AND** a current horizon exists for their streams or connection-wide
- **THEN** the connection's coverage SHALL NOT read complete.

#### Scenario: classification is byte-identical with and without a horizon

- **WHEN** the same run is projected twice, differing only by the presence of
  a current, affirmatively-based coverage horizon
- **THEN** the headline state, every axis, the forward disposition, and every
  condition SHALL be identical between the two projections
- **AND** only the disclosure field `coverage_horizons` SHALL differ.
