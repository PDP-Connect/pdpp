## ADDED Requirements

### Requirement: Runtime SHALL fold a validated STREAM_EVIDENCE into its own stream's coverage fact without gating any checkpoint commit

The reference runtime SHALL track `STREAM_EVIDENCE` messages independently
from `DETAIL_COVERAGE` messages, using a separate tracking path
(`trackStreamEvidence`, parallel to but independent from
`trackDetailCoverage`). On accepting a valid `STREAM_EVIDENCE` for a
`state_stream`-declared stream, the runtime SHALL fold its `considered` and
`covered` values into that stream's own `RuntimeCollectionFact` at terminal
collection-fact assembly. The runtime SHALL NOT record `STREAM_EVIDENCE`
evidence into `detailCoverageByStateStream`, and SHALL NOT allow it to reach
`missingDetailCoverageReports` or `recordDetailCoverageShortfalls`. No
checkpoint stream's commit eligibility — including the `state_stream`
child's own parent — SHALL depend on whether a `STREAM_EVIDENCE` message was
received, accepted, rejected, or omitted for any stream in the run.

A `state_stream` child stream with an accepted `STREAM_EVIDENCE` fact and no
pending detail gaps SHALL be evaluated on its own `considered`/`covered`
measurement through the existing, unmodified stream-coherence contract
before any checkpoint-inheritance fallback is considered. A `state_stream`
child stream with no accepted `STREAM_EVIDENCE` fact for the run SHALL
continue to use the existing checkpoint-inheritance and `unknown` projection
behavior, unmodified by this requirement.

This requirement introduces no change to `coherence.ts`,
`connector-coverage-policy.ts`, `missingDetailCoverageReports`,
`recordDetailCoverageShortfalls`, or the eligible-checkpoint algorithm.

#### Scenario: state_stream child with clean STREAM_EVIDENCE projects complete

**WHEN** a `state_stream`-declared stream's connector reports
`STREAM_EVIDENCE{considered: n, covered: n}` with zero pending detail gaps,
following a genuine enumeration boundary
**THEN** the runtime SHALL project that stream's coverage condition as
`complete`
**AND** SHALL NOT require the stream's parent checkpoint to have committed
first for that projection to hold.

#### Scenario: state_stream child with a durable gap projects retryable_gap

**WHEN** a `state_stream`-declared stream's connector reports
`STREAM_EVIDENCE{considered: n, covered: n-k}` and `k` matching durable
`DETAIL_GAP` records for that stream in the same run
**THEN** the runtime SHALL project that stream's coverage condition as
`retryable_gap`
**AND** the pending-gap precedence rule SHALL apply before the
`considered`/`covered` numerator is consulted, exactly as for any other
stream shape.

#### Scenario: state_stream child with an unaccounted key projects partial, never complete

**WHEN** a `state_stream`-declared stream's connector reports
`STREAM_EVIDENCE{considered: n, covered: n-1}` with zero pending detail gaps
(one key enumerated but neither hydrated nor gapped)
**THEN** the runtime SHALL project that stream's coverage condition as
`partial`
**AND** SHALL NOT project `complete`.

#### Scenario: state_stream child with no STREAM_EVIDENCE keeps existing inheritance behavior

**WHEN** a `state_stream`-declared stream's connector emits no
`STREAM_EVIDENCE` for the run
**THEN** the runtime SHALL apply the existing checkpoint-inheritance
behavior for that stream, unmodified
**AND** SHALL project `unknown` when inheritance does not apply and no other
runtime fact exists for that stream.

#### Scenario: accepting or rejecting STREAM_EVIDENCE never changes checkpoint commit eligibility

**WHEN** the runtime accepts, rejects, or receives no `STREAM_EVIDENCE` for a
`state_stream`-declared stream in a run
**THEN** the commit eligibility of that stream's parent checkpoint, and of
every other checkpoint stream in the run, SHALL be unaffected
**AND** `missingDetailCoverageReports` and `recordDetailCoverageShortfalls`
SHALL NOT be invoked with any evidence derived from `STREAM_EVIDENCE`.

#### Scenario: DETAIL_COVERAGE naming a state_stream child remains rejected

**WHEN** a connector emits a `DETAIL_COVERAGE` message naming a stream
declared with manifest `state_stream`
**THEN** the runtime SHALL reject it as a protocol violation, exactly as
before this requirement
**AND** the availability of `STREAM_EVIDENCE` for that stream SHALL NOT
change that rejection.

### Requirement: An accepted STREAM_EVIDENCE fact folded into a later-failed run SHALL NOT be surfaced to the owner in place of the run-selection rule's chosen run

Terminal collection-fact assembly (`buildRunTerminalData`,
`buildCollectionFacts`) runs on every run-termination path, including
failure, timeout, owner-cancellation, and connector-exit-close paths, not
only the succeeded-run path. An accepted `STREAM_EVIDENCE` fact SHALL be
folded into that stream's `RuntimeCollectionFact` on all of these paths,
identically to how any other stream's already-accepted runtime fact is
folded today; this requirement introduces no exception for
`STREAM_EVIDENCE`.

Which run's `RuntimeCollectionFact` values are surfaced to the owner as a
stream's current coverage SHALL continue to be governed entirely by the
existing, general-purpose run-selection logic
(`coverageClassifyingRun`/`healthClassifyingRun`), unmodified by this
requirement. A `state_stream` child's `coverageCondition` SHALL be read
only for whichever run that selection logic resolves to. Accepting a
`STREAM_EVIDENCE` message during a run that the overall run-selection logic
does not select as the classifying run SHALL NOT cause that fact to be
surfaced in place of the selected run's coverage for that stream.

#### Scenario: STREAM_EVIDENCE accepted before a later run-level failure is not surfaced over the last successful run

**WHEN** a run accepts `STREAM_EVIDENCE{considered: n, covered: n}` for a
`state_stream`-declared stream early in the run
**AND** the same run subsequently fails or is cancelled on a different,
unrelated stream
**AND** a distinct prior run exists and is the run `coverageClassifyingRun`
selects as the classifying run for this connection
**THEN** the owner-facing coverage for the `state_stream`-declared stream
SHALL reflect the selected run's coverage
**AND** SHALL NOT reflect the failed run's `complete` `STREAM_EVIDENCE`-
derived projection in its place.
