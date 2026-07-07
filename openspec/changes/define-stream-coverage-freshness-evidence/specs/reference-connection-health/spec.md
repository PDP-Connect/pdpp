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

#### Scenario: policy-unavailable stream has a concrete state

**WHEN** a stream's coverage policy is `unavailable` or `unsupported`
**THEN** owner surfaces SHALL render that the stream's coverage is unavailable or
unsupported for a stated reason
**AND** they SHALL NOT render generic coverage unknown or checking copy.

#### Scenario: source detail exposes supporting facts

**WHEN** an owner opens source detail for a stream with incomplete coverage
**THEN** the detail view SHALL show supporting non-secret facts such as strategy,
status, counts, timestamps, pending-gap count, or reason code
**AND** it SHALL NOT require the owner to inspect raw run logs to understand the
stream's next step.
