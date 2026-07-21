## MODIFIED Requirements

### Requirement: Connector manifest stream schema SHALL declare and validate coverage_policy

The connector manifest stream schema SHALL continue to accept `coverage_policy`
as a compatibility shorthand, but stream coverage SHALL be modeled by explicit
stream evidence strategy. A stream SHALL either declare a coverage evidence
strategy in the manifest or emit a runtime collection report entry whose coverage
strategy is accepted by the reference contract.

Accepted coverage evidence strategies SHALL include:

- `full_inventory`
- `checkpoint_window`
- `parent_detail_accounting`
- `snapshot_import_receipt`
- `singleton_presence`

The legacy `coverage_policy` values SHALL remain accepted compatibility
declarations during migration:

- `collect` means the stream is expected to provide a concrete coverage
  strategy and status.
- `deferred` means the stream is intentionally postponed by profile or
  connection scope.
- `inventory_only` means only inventory coverage was owed when supported by the
  stream's declared strategy and runtime facts.
- `unavailable` and `unsupported` mean the provider or connector cannot
  establish coverage for this stream and SHALL carry a reason when available.

Streams that use an accepted-absence policy because the current connector does
not owe the stream's collection SHALL also declare `required: false`. A
manifest SHALL NOT leave an accepted-absence stream load-bearing.

Absence of both a coverage evidence strategy and runtime coverage evidence SHALL
not be treated as successful coverage. It SHALL classify as missing
measurement evidence for existing streams and SHALL fail developer validation
for new or touched streams.

#### Scenario: stream declares full-inventory coverage evidence

**WHEN** a manifest stream declares coverage evidence strategy `full_inventory`
**THEN** reference-contract schema validation SHALL accept the manifest
**AND** the runtime collection report for that stream SHALL be able to carry
considered and collected counts.

#### Scenario: legacy deferred coverage policy remains accepted absence

**WHEN** a manifest stream declares legacy `coverage_policy: "deferred"`
**AND** the stream opts out of requiredness with `required: false`
**THEN** runtime normalization SHALL treat that stream as accepted deferred
coverage
**AND** owner projections SHALL NOT leave that stream in unknown coverage solely
because it did not collect records in the run.

#### Scenario: accepted-absence streams opt out of requiredness

**WHEN** a manifest stream declares `coverage_policy: "inventory_only"`
**OR** `coverage_policy: "deferred"`
**OR** `coverage_policy: "unavailable"`
**OR** `coverage_policy: "unsupported"`
**AND** the stream declares `required: false`
**THEN** developer validation SHALL accept the manifest
**AND** the stream SHALL remain a non-load-bearing accepted-absence stream.

#### Scenario: missing coverage evidence is developer debt

**WHEN** a new or touched stream declares neither a coverage evidence strategy nor
a legacy coverage policy that maps to one
**THEN** developer validation SHALL fail
**AND** the validation message SHALL name the stream and the missing coverage
evidence strategy.

#### Scenario: historical missing coverage evidence remains readable

**WHEN** an existing connection has historical collection reports that predate
stream coverage evidence
**THEN** runtime reads SHALL continue to succeed
**AND** the normalized report SHALL classify the stream's coverage as unknown
with an unmeasured forward disposition rather than complete.

### Requirement: Connectors with a detail lane SHALL emit DETAIL_COVERAGE once per run

A connector that runs a list+detail lane SHALL emit exactly one `DETAIL_COVERAGE`
message per run, after the detail lane completes. The runtime SHALL normalize
that message into `parent_detail_accounting` stream coverage evidence.

`DETAIL_COVERAGE` remains required for list+detail lanes, but it is not the only
coverage evidence mechanism. Connectors without list+detail lanes SHALL provide
coverage evidence through another accepted stream evidence strategy.

When the connector's local accumulator can prove the denominator and numerator
from explicit runtime outcomes, the message SHALL include `considered` and
`covered`. The connector SHALL NOT treat `required_keys` alone as sufficient to
prove completeness when those counts are available. A steady-state run that
enumerated its denominator SHALL emit the message even when the denominator is
zero: `considered: 0` with `covered: 0` is proof of an empty boundary, and
suppressing the message on zero candidates SHALL NOT leave the stream
unmeasured.

#### Scenario: detail coverage normalizes into parent-detail accounting

**WHEN** a list+detail run emits `DETAIL_COVERAGE`
**THEN** collection-report normalization SHALL create a stream coverage evidence
entry with strategy `parent_detail_accounting`
**AND** the entry SHALL preserve non-secret required, hydrated, skipped, and gap
counts needed to classify completeness.

#### Scenario: flat stream uses a non-detail strategy

**WHEN** a connector emits a flat stream with no per-record detail lane
**THEN** the connector SHALL NOT be required to emit `DETAIL_COVERAGE`
**AND** it SHALL still provide coverage evidence through another accepted
strategy such as `full_inventory`, `checkpoint_window`, or
`snapshot_import_receipt`.

#### Scenario: accounted zero-emission run still reports complete coverage

**WHEN** a list+detail run explicitly accounts for a required key with
`hydrated_keys` containing that key and `collected` remaining 0
**AND** the connector reports `considered` and `covered` for that run
**THEN** the collection report SHALL classify the stream as complete
**AND** the projection SHALL NOT fall back to a false partial based on
`collected` alone.

#### Scenario: zero-candidate steady-state run still reports coverage

**WHEN** a list+detail run enumerates its parent boundary and finds zero
detail candidates
**THEN** the connector SHALL still emit `DETAIL_COVERAGE` with
`considered: 0` and `covered: 0`
**AND** the stream SHALL classify as complete rather than resting unmeasured.

## ADDED Requirements

### Requirement: Run scope selection SHALL NOT be conflated with stream coverage policy

The runtime SHALL NOT stamp coverage, skip, or policy facts for declared
streams excluded from the run's scope: a terminal collection-fact block
records only what the run attempted. No layer SHALL classify a stream as
accepted deferred coverage solely because a run's scope excluded it.
Accepted-absence classifications SHALL come only from manifest policy
declarations or explicit connector skip facts for attempted streams.

#### Scenario: scoped run stamps nothing for excluded streams

**WHEN** a run executes with a scope narrower than the manifest's declared
streams
**THEN** the terminal fact block SHALL contain entries only for the attempted
streams
**AND** no excluded stream SHALL gain a skip, policy, or coverage fact from
scope selection alone.

### Requirement: A co-emitted stream SHALL declare its checkpoint parent via state_stream

A co-emitted stream SHALL declare its parent list stream as its `state_stream`
in the manifest and use coverage strategy `checkpoint_window`. A co-emitted
stream is one emitted alongside a parent list stream within the same pass, that
rides the parent's cursor and commits no checkpoint of its own (for example Slack
`reactions` / `message_attachments`, Gmail `message_bodies`). It is not a
list+detail hydration lane and SHALL NOT be required to emit `DETAIL_COVERAGE`.

The runtime SHALL read the declared `state_stream` when building the terminal
collection-fact block so the co-emitted stream's checkpoint reflects the parent
stream's committed cursor. A `DETAIL_COVERAGE` message, when present for the same
stream, SHALL take precedence over the manifest declaration.

The `state_stream` value SHALL name another declared stream, SHALL differ from
the stream declaring it, and SHALL only be declared with coverage strategy
`checkpoint_window`; developer validation SHALL reject a manifest that violates
these constraints.

#### Scenario: co-emitted stream inherits the parent committed checkpoint

**WHEN** a run commits the parent list stream's checkpoint and a co-emitted child
stream declares that parent as its `state_stream`
**THEN** the child stream's collection-fact `checkpoint` SHALL read `committed`
rather than `not_staged`
**AND** with coverage strategy `checkpoint_window` the projection SHALL classify
the child's coverage as `complete`, not `unknown`.

#### Scenario: invalid state_stream fails developer validation

**WHEN** a manifest stream declares a `state_stream` that names no other declared
stream, names itself, or is paired with a non-`checkpoint_window` coverage
strategy
**THEN** developer validation SHALL fail
**AND** the validation message SHALL name the stream and the invalid
`state_stream` declaration.

### Requirement: Stream freshness posture SHALL be declared or emitted per stream

Every declared stream SHALL have a freshness posture separate from coverage. A
stream SHALL either declare a freshness strategy in the manifest or emit a
runtime collection report entry whose freshness strategy is accepted by the
reference contract.

Accepted freshness strategies SHALL include:

- `scheduled_window`
- `manual_as_of`
- `device_heartbeat`
- `source_reported_as_of`
- `not_trackable`

Absence of freshness evidence SHALL classify as not measured for existing
streams and SHALL fail developer validation for new or touched streams.

#### Scenario: scheduled stream declares a staleness window

**WHEN** a stream uses freshness strategy `scheduled_window`
**THEN** its evidence SHALL include the inputs needed to determine whether the
stream is fresh, stale, or unknown due to unavailable evidence
**AND** coverage status SHALL NOT be used as a substitute for freshness.

#### Scenario: local-device stream uses heartbeat freshness

**WHEN** a stream is produced by a local-device exporter
**THEN** it MAY use freshness strategy `device_heartbeat`
**AND** the collection report SHALL distinguish last device check-in from last
successful upload.

#### Scenario: freshness is explicitly not trackable

**WHEN** a stream declares freshness strategy `not_trackable`
**THEN** the declaration or report SHALL carry a reason
**AND** owner projections SHALL NOT label freshness unknown solely because the
stream has no freshness timestamp.

### Requirement: Runtime collection reports SHALL preserve per-stream evidence

The runtime/control plane SHALL preserve a per-stream collection report entry for
each declared stream that participated in a run or whose policy explains why it
did not participate. The entry SHALL include coverage strategy/status, freshness
strategy/status, non-secret supporting facts, and a reason code when evidence is
deferred, unavailable, not trackable, or missing.

The report SHALL NOT include record payloads, credentials, raw provider URLs,
browser selectors, bearer tokens, filesystem paths, or other secret/private
diagnostics.

#### Scenario: complete inventory report carries counts

**WHEN** a stream completes a full inventory pass
**THEN** its collection report entry SHALL carry coverage strategy
`full_inventory`, a complete status, and considered/collected counts
**AND** it SHALL carry freshness strategy/status separately.

#### Scenario: missing measurement evidence is explicit

**WHEN** a stream has no coverage or freshness evidence and no active work can
resolve it
**THEN** collection-report normalization SHALL preserve the missing axis as not
measured
**AND** it SHALL NOT fabricate complete, stale, or checking status.

#### Scenario: report contains no private record payloads

**WHEN** a collection report entry is exposed to an owner surface
**THEN** it SHALL contain only stream names, statuses, strategies, counts,
timestamps, cursors, gap classes, and reason codes
**AND** it SHALL NOT contain record bodies or provider credentials.

### Requirement: Local coverage STATE and failure barriers SHALL be terminally committed

A local collector MAY emit diagnostic `coverage_diagnostics` RECORDs before a
later failure, but SHALL publish its full snapshot-bearing STATE only on a
terminally successful DONE path after predecessor batches and prior
failure gaps drain. Its cursor SHALL contain valid `{ fetched_at, stores }`,
where `stores` is derived from the complete fixed inventory and contains only
safe `{ store, stream, status }` triples. Claude Code and Codex SHALL emit this
proof for their fixed local inventories. RECORD diagnostics, including those
emitted before a later failure, SHALL NOT constitute committed coverage proof;
only the terminal-success STATE is positive local-health authority.

Every child, protocol, nonzero-exit, and terminal-DONE failure, including a
zero-record failure, SHALL create a durable local failure gap/backlog barrier.
Acknowledgement SHALL NOT clear it. Only a later successful full coverage STATE
commit may recover it; scoped non-coverage success and a healthy heartbeat SHALL
NOT.

#### Scenario: failed local collection cannot reuse old proof

**WHEN** local collection has partial diagnostics and then fails with missing
DONE, `DONE.failed`, protocol error, batch/state PUT failure, scan budget
failure, or zero-record child failure
**THEN** it SHALL not publish coverage proof
**AND** projection SHALL remain blocked until later successful coverage STATE.

#### Scenario: terminal DONE closes the collector protocol

**WHEN** a local collector emits its first `DONE`
**THEN** it SHALL be the only terminal DONE for that invocation
**AND** every later protocol message SHALL fail the invocation without creating
or committing a checkpoint.

#### Scenario: acknowledged failure gap remains a barrier

**WHEN** a local failure-gap upload succeeds before a later collection fails
**THEN** the acknowledged gap SHALL remain open and the terminal heartbeat
SHALL remain blocked
**UNTIL** a later successful full `coverage_diagnostics` STATE commit recovers
the gap.
