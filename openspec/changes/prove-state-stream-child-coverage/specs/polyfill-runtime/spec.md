## ADDED Requirements

### Requirement: A `state_stream` child MAY report independently measured coverage via STREAM_EVIDENCE

A connector MAY emit a `STREAM_EVIDENCE` message for a stream declared with
manifest `state_stream` (a checkpoint-dependent child with no cursor of its
own) to report `considered`/`covered` counts measured at that stream's own
hydration site. `STREAM_EVIDENCE` is distinct from `DETAIL_COVERAGE`: it
carries no `state_stream` field, no key sets, and is never consulted for
checkpoint-commit eligibility. A `state_stream`-declared stream SHALL NOT
emit `DETAIL_COVERAGE`; that prohibition is unaffected by this requirement.

A connector SHALL emit at most one `STREAM_EVIDENCE` per stream per run. Each
message SHALL carry:

- `reference_only`: MUST be present and `true`.
- `stream`: the `state_stream`-declared stream this fact describes.
- `considered`: the full count of keys the connector's own hydration lane
  considered for this stream in this run, enumerated at the hydration site
  before outcome-determining work, after the connector's own reconciliation
  of hydrated vs. gapped vs. unaccounted keys settles.
- `covered`: the count of `considered` keys successfully hydrated and
  emitted as `RECORD` in this run. SHALL satisfy `0 <= covered <= considered`.

A connector MUST NOT emit `STREAM_EVIDENCE` for a run that did not establish
a genuine enumeration boundary for that stream. A `state_stream` child with
no independent hydration lane, or that does not measure itself, MAY emit
nothing; the runtime's existing checkpoint-inheritance and `unknown`
projection behavior for that stream is unchanged by this requirement.

`considered` and `covered` SHALL be measured at the declaring stream's own
hydration site, over exactly the keys that stream's own lane attempted. A
connector SHALL NOT derive these counts from a different stream's
enumeration or emitted-record count (a "parent-count alias"), and SHALL NOT
derive `considered` as a function of the run's own successful-emission or
gap counts (an identity with no independent term).

#### Scenario: state_stream child reports final coverage after its own hydration lane settles

**WHEN** a `state_stream`-declared stream's connector-side hydration lane
finishes attempting every key it considered for the run
**THEN** the connector SHALL emit one `STREAM_EVIDENCE` message for that
stream
**AND** `considered` SHALL equal the count of keys the connector's lane
attempted
**AND** `covered` SHALL equal the count of those keys successfully hydrated
and emitted as `RECORD`.

#### Scenario: state_stream child emits nothing on a genuinely quiet run

**WHEN** a run does not establish an enumeration boundary for a
`state_stream`-declared stream (for example, a scheduled run that walks no
window for that stream)
**THEN** the connector SHALL NOT emit `STREAM_EVIDENCE` for that stream
**AND** it SHALL NOT emit `considered: 0, covered: 0` as if a boundary had
been established.

#### Scenario: state_stream child never emits DETAIL_COVERAGE

**WHEN** a stream is declared with manifest `state_stream`
**THEN** its connector SHALL NOT emit any `DETAIL_COVERAGE` message naming
that stream
**AND** it MAY instead emit `STREAM_EVIDENCE` for that stream, following
this requirement.

#### Scenario: a swallowed exception leaves a key considered but not covered

**WHEN** a key is pushed into the connector's `considered` enumeration before
a throw-prone fetch or write step
**AND** that step throws before the key is either hydrated and emitted or
reported as a durable gap
**THEN** the connector's next `STREAM_EVIDENCE` for that stream SHALL count
that key in `considered`
**AND** SHALL NOT count it in `covered`.

### Requirement: Runtime SHALL validate STREAM_EVIDENCE against the manifest and reject it outside a state_stream declaration

A conformant runtime SHALL reject (fail closed, as a protocol violation) a
`STREAM_EVIDENCE` message when any of the following holds:

1. `reference_only` is not `true`.
2. `stream` is not present in the run's `scope.streams`.
3. `stream` is not declared with manifest `state_stream` (i.e. is
   `parent_streams`-declared or self-mapped).
4. `covered` is greater than `considered`, or either value is negative.
5. A `STREAM_EVIDENCE` was already accepted for the same `stream` in the
   same run.

"Same run" in rule 5 SHALL use the identical run identity
(`runId`) the runtime already uses for
`applyStateStreamCheckpointInheritance`'s own single-run scoping
(`parent.runId === child.runId`); this proposal introduces no new run-
identity concept. A resumed or retried logical collection that the runtime
assigns a new `runId` is, by that existing identity, a different run for
rule 5's purposes: a `STREAM_EVIDENCE` accepted under a prior `runId` does
not count as "already accepted" against a subsequent `runId`, and does not
by itself carry forward into the resumed run's own terminal fact. This
proposal does not change how the runtime assigns or resumes `runId`; it
only pins `STREAM_EVIDENCE` duplicate-rejection to that existing identity,
the same way `DETAIL_COVERAGE` duplicate-handling already implicitly does.

A runtime MUST NOT silently drop a rejected `STREAM_EVIDENCE` in a way that
lets the stream fall through to checkpoint inheritance as if nothing had
been reported; a connector emitting an invalid `STREAM_EVIDENCE` is a
protocol-conformance failure for the run.

#### Scenario: STREAM_EVIDENCE naming a parent_streams-declared stream is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` naming a stream declared with
manifest `parent_streams`
**THEN** the runtime SHALL reject the message as a protocol violation
**AND** SHALL fail closed rather than folding it into that stream's coverage
fact.

#### Scenario: STREAM_EVIDENCE naming a self-mapped stream is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` naming a stream that declares
neither `state_stream` nor `parent_streams`
**THEN** the runtime SHALL reject the message as a protocol violation.

#### Scenario: STREAM_EVIDENCE with covered greater than considered is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` with `covered > considered`
**THEN** the runtime SHALL reject the message as a protocol violation.

#### Scenario: a second STREAM_EVIDENCE for the same stream and run is rejected

**WHEN** a connector emits a second `STREAM_EVIDENCE` for a stream it already
reported this run
**THEN** the runtime SHALL reject the second message as a protocol
violation
**AND** SHALL NOT overwrite the first accepted fact with it.
