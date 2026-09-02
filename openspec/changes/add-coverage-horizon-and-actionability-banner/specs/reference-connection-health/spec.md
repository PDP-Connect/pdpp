## ADDED Requirements

### Requirement: A provider coverage horizon SHALL be pure disclosure evidence, never a classification input

The reference implementation SHALL support recording a provider
coverage-horizon disclosure: a structured, reversible record of the boundary
of what a source can EVER provide (for example, a provider's own retention
policy, or history the provider deleted before the connection existed),
scoped to a connection and, optionally, a single manifest stream. A coverage
horizon SHALL require positive evidence (a closed `basis` value) and SHALL
NOT be inferred from a single empty page or one failed attempt. A horizon
record SHALL be append-only: a later confirmation SHALL supersede the prior
current record rather than overwrite it, and superseded records SHALL remain
durably readable as provenance history.

A coverage horizon SHALL carry no `ConnectionHealthState`, no health axis, and
no forward disposition, and SHALL participate in NO classification step. It
SHALL NOT rewrite or delete retained records, and it SHALL NOT by itself mark
a connection unhealthy or a stream's coverage complete. It SHALL be exposed
only through the owner-facing inspection layer (`RenderedVerdict.detail`) and
SHALL NOT be read by tone, channel, pill label, or annotation computation.
Absence of a current horizon record SHALL mean "not read or not confirmed,"
and SHALL NEVER be read as "the provider confirmed there is no more data."

#### Scenario: a provider-retention boundary cannot become a retryable failure

- **WHEN** a stream carries a genuine terminal coverage gap
- **AND** a coverage horizon is recorded explaining the gap as a provider
  retention boundary
- **THEN** the stream's coverage axis, forward disposition, and the
  connection's headline state SHALL be unchanged by the horizon's presence
- **AND** the horizon SHALL NOT soften the gap to retryable or resumable.

#### Scenario: an unproven boundary cannot be accepted as provider reality

- **WHEN** no current coverage-horizon record exists for a connection, or the
  only record on file has been superseded
- **THEN** a stream's coverage gap of unknown origin SHALL classify exactly as
  it would with no coverage-horizon evidence at all
- **AND** the absence of a horizon SHALL NOT be read as a settled, healthy
  explanation for the gap.

#### Scenario: a later provider contradiction supersedes without erasing history

- **WHEN** a new coverage-horizon confirmation is recorded for a connection
  and stream that already has a current record
- **THEN** the prior record SHALL be marked superseded, not deleted or
  overwritten
- **AND** a reader SHALL be able to walk from the new record to the
  superseded one it replaced.

### Requirement: The fleet-wide owner banner SHALL NOT fire for ordinary cadence-relative lateness

The fleet health composer SHALL exclude a connection from its
materially-blocked, banner-warranting evidence when the connection's ONLY
degrading evidence is a headline `degraded` state caused entirely by ordinary
cadence-relative staleness — the same evidence shape the per-connection
verdict already treats as a routine "needs a refresh" advisory rather than a
collection failure. This exclusion SHALL apply only to the banner-warranting
evidence; the broader diagnostic `state` and any other dimension SHALL remain
unchanged, so operator tooling and the strict stream audit keep seeing the
connection's true degraded status.

#### Scenario: an ordinary late source cannot fire the global banner

- **WHEN** a schedulable (`automatic`/`background_safe`) connector's retained
  data has aged past its own cadence-relative staleness window
- **AND** every other health axis (coverage, attention, outbox, remote
  surface, owner state) is clean
- **THEN** the fleet verdict's `banner_warranted` SHALL be `false`
- **AND** the fleet verdict's diagnostic `state` MAY still report the
  connection as contributing to a non-healthy fleet state.

#### Scenario: a real degradation alongside staleness still fires the banner

- **WHEN** a connection's data has aged past its staleness window
- **AND** the connection also carries a real, independent degrading
  condition (a coverage gap, a stalled outbox, a rejected credential, or a
  runtime/remote-surface failure)
- **THEN** the fleet verdict's `banner_warranted` SHALL be `true`
- **AND** the staleness alone SHALL NOT be treated as excusing the other
  condition.

#### Scenario: a successful current collection cannot be overridden by older evidence

- **WHEN** a connection's most recent classified state is a proven, current
  success
- **THEN** the fleet verdict SHALL NOT treat a non-current, superseded false
  condition as live evidence for that connection
- **AND** `banner_warranted` SHALL NOT fire on the basis of evidence that is
  no longer current.
