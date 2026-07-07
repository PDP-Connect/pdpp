## ADDED Requirements

### Requirement: Stream health projection SHALL consume coverage and freshness evidence strategies

The reference implementation SHALL derive per-stream coverage and freshness
posture from the normalized collection report's stream evidence entries. It
SHALL treat coverage and freshness as separate axes and SHALL NOT infer one from
the other.

#### Scenario: complete coverage with stale freshness stays decomplected

**WHEN** a stream's coverage evidence is complete
**AND** its freshness evidence is stale
**THEN** the stream projection SHALL report complete coverage and stale freshness
separately
**AND** the owner-facing copy SHALL NOT describe the stream as missing coverage.

#### Scenario: fresh but partially covered stream stays decomplected

**WHEN** a stream's freshness evidence is current
**AND** its coverage evidence reports retryable or terminal gaps
**THEN** the stream projection SHALL report current freshness and incomplete
coverage separately
**AND** the owner-facing next step SHALL be based on the coverage condition, not
on staleness.

### Requirement: Missing stream measurement SHALL not project as active checking

The reference implementation SHALL NOT project missing stream measurement
evidence as active checking when no active bounded work can resolve that missing
evidence.
When a stream lacks coverage or freshness evidence and there is no active
bounded work that can resolve that absence, the reference implementation SHALL
project the missing axis as not measured, unavailable, or deferred according to
the normalized stream evidence. It SHALL NOT label the resting state as
"checking".

#### Scenario: resting missing evidence is unmeasured

**WHEN** a stream has no coverage evidence
**AND** there is no active connector run, health probe, coverage probe, or
projection rebuild expected to produce that evidence
**THEN** the stream projection SHALL classify the coverage axis as unknown with
an unmeasured forward disposition, or as unavailable/deferred when a policy says
so
**AND** owner surfaces SHALL NOT say the stream is checking.

#### Scenario: active bounded work may show checking

**WHEN** a stream lacks current evidence
**AND** an active bounded run, probe, or projection rebuild is currently expected
to produce that evidence
**THEN** owner surfaces MAY show a checking state for that stream
**AND** the checking state SHALL expire or resolve when the active work ends or
its evidence deadline passes.

### Requirement: Owner stream rows SHALL render concrete stream evidence states

Owner surfaces that show stream rows SHALL render a concrete state derived from
stream evidence. The summary copy SHALL avoid exposing raw evidence-strategy
names as primary user language. The detail view MAY expose the strategy, counts,
and reason codes as supporting inspection details.

For local-device-backed connections, stream-row coverage SHALL consume the same
durable `coverage_diagnostics` evidence that can establish connection-level
coverage. The implementation SHALL NOT project a local-device connection as
coverage-complete while every stream row remains unmeasured when stream-scoped
coverage diagnostics are present.

When a local-device stream declares `state_stream`, stream-row coverage SHALL
inherit the parent stream's local `coverage_diagnostics` state unless a runtime
fact or pending detail gap exists for the child stream.

When a scheduler-run collection fact exists for a child stream that declares
`state_stream`, and the child fact has no skip, pending detail gap, or committed
checkpoint of its own, stream-row coverage SHALL use the parent stream's
committed checkpoint when the parent fact is present in the same collection fact
block. This read-side inheritance SHALL preserve historical run reports that
predate runtime-side state-stream checkpoint stamping, and SHALL NOT fabricate
coverage when the parent fact is missing or uncommitted.

#### Scenario: policy-unavailable stream has a concrete state

**WHEN** a stream's coverage policy is `unavailable` or `unsupported`
**THEN** owner surfaces SHALL render that the stream's coverage is unavailable or
unsupported for a stated reason
**AND** they SHALL NOT render generic coverage unknown or checking copy.

#### Scenario: local coverage diagnostics establish stream coverage

**WHEN** a local-device-backed connection has durable `coverage_diagnostics`
records that map stores to streams and safe statuses
**THEN** stream rows SHALL derive concrete coverage states from those diagnostics
**AND** owner surfaces SHALL NOT leave those rows in generic coverage unknown
solely because the local collector has no scheduler run facts.

#### Scenario: local co-emitted streams inherit parent coverage

**WHEN** a local-device-backed connection has durable `coverage_diagnostics` for
a parent stream
**AND** a child stream declares that parent as `state_stream`
**THEN** the child stream row SHALL derive its concrete coverage state from the
parent's diagnostics
**AND** owner surfaces SHALL NOT leave the child stream unmeasured solely because
the collector emitted no separate child-stream diagnostic row.

#### Scenario: historical run facts inherit parent checkpoint for co-emitted streams

**WHEN** a scheduler-run collection fact block includes a committed parent stream
**AND** a co-emitted child stream declares that parent as `state_stream`
**AND** the child fact has an uncommitted checkpoint with no skip or pending gap
**THEN** stream-row coverage SHALL use the parent committed checkpoint for the
child stream
**AND** owner surfaces SHALL NOT leave the child stream unmeasured solely because
the historical child fact predates runtime-side checkpoint inheritance.

#### Scenario: source detail exposes supporting facts

**WHEN** an owner opens source detail for a stream with incomplete coverage
**THEN** the detail view SHALL show supporting non-secret facts such as strategy,
status, counts, timestamps, pending-gap count, or reason code
**AND** it SHALL NOT require the owner to inspect raw run logs to understand the
stream's next step.
