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

### Requirement: A required stream without a resolved coverage posture SHALL block a Healthy verdict

The connection-level coverage rollup SHALL consume the per-stream collection
report. A connection SHALL render Healthy only when every required stream has
a resolved coverage posture: proven complete, an accepted-absence policy
(`deferred`, `inventory_only`, `unavailable`, `unsupported` on a non-required
stream), a proven local-diagnostic state, or an explicit skip fact. A required
stream resting at unknown coverage with an unmeasured forward disposition
SHALL block the Healthy verdict and SHALL resolve the connection to a
maintainer/system disposition. The rollup SHALL NOT attach an owner call to
action for missing measurement evidence and SHALL NOT render an active
"checking" state without active bounded work. The rollup SHALL preserve
worst-wins: required-stream unknown evidence SHALL never upgrade an
already-degrading coverage axis, and existing gap, attention, and freshness
semantics SHALL be unchanged.

#### Scenario: required unmeasured stream cannot hide beneath a successful run

**WHEN** a connection's latest classified run succeeded with no gaps
**AND** a required stream's collection-report entry rests at unknown coverage
with an unmeasured disposition
**THEN** the connection SHALL NOT render Healthy
**AND** the connection SHALL resolve to a maintainer/system disposition with no
owner call to action
**AND** owner surfaces SHALL render a resting not-measured state, not an active
"checking" state.

#### Scenario: accepted policies and local diagnostics stay healthy

**WHEN** every required stream is proven complete or covered by an accepted
manifest policy, an explicit skip fact, or proven local coverage diagnostics
**AND** only non-required streams carry accepted-absence conditions
**THEN** the connection MAY render Healthy
**AND** the rollup SHALL NOT degrade on the accepted or locally-proven streams.

#### Scenario: worst-wins is preserved over unmeasured evidence

**WHEN** a connection has both a degrading coverage condition (a terminal or
retryable gap) and a required stream at unknown coverage
**THEN** the connection coverage axis SHALL keep the degrading condition
**AND** the unmeasured evidence SHALL NOT upgrade or replace it.

#### Scenario: active bounded work may render checking

**WHEN** a required stream lacks coverage evidence
**AND** an active bounded run is currently expected to produce that evidence
**THEN** owner surfaces MAY render "Checking"
**AND** the state SHALL resolve to a concrete posture when the run reaches a
terminal state.

### Requirement: Per-stream coverage SHALL derive from durable latest-attempt evidence

The reference SHALL maintain durable per-connection, per-stream
latest-attempt evidence in its connector-summary read model: the raw runtime
fact from the newest terminal run that attempted the stream, that run's
terminal time, and its run identity. A terminal run SHALL update only the
streams it attempted; an attempted-but-unresolved fact SHALL replace older
resolved proof; a run that did not attempt a stream SHALL NOT erase that
stream's prior evidence and SHALL NOT create evidence for it. The connection
SHALL be the isolation key: evidence SHALL never cross connections, and a
terminal event that cannot be attributed to exactly one connection SHALL be
refused rather than folded. Coverage and freshness SHALL be derived on read
from the stored raw facts; the read model SHALL NOT store frozen derived
coverage. Folding SHALL be checkpointed by terminal-event sequence so that a
terminal event recorded during an in-progress reconcile is folded on a later
pass rather than lost, and a deterministic rebuild SHALL backfill the
projection from existing terminal events outside the hot owner read path.
Durable pending detail gaps and the classifying run's known gaps SHALL keep
their existing degrading precedence over stored evidence.

Stored evidence SHALL preserve its proof time. The Healthy gate SHALL be
anchored to the oldest required-stream proof time, not the newest run: a
scoped run SHALL NOT make the connection read fresh beyond the age of the
oldest required stream's evidence, and the anchor SHALL feed the freshness
computation itself rather than a post-hoc status comparison. There SHALL be
no run-count limit on evidence correctness.

#### Scenario: scoped run preserves prior proof for omitted streams

**WHEN** a stream was proven complete by a prior run's resolved evidence
**AND** a newer successful run's scope did not attempt that stream
**AND** the carried proof is within the connection's staleness window
**THEN** the stream SHALL keep its proven coverage condition
**AND** the connection MAY render Healthy when all other conditions hold.

#### Scenario: stale carried proof cannot ride a fresh scoped run to Healthy

**WHEN** a required stream's only resolved evidence is older than the
connection's staleness window
**AND** a newer scoped run succeeded without attempting that stream
**THEN** the connection's freshness SHALL be evaluated against the oldest
required-stream proof
**AND** the connection SHALL NOT render Healthy on the newer run's recency
alone.

#### Scenario: never-measured omitted required stream still blocks Healthy

**WHEN** a required stream has no resolved evidence in any recent terminal
fact block
**AND** the latest run succeeded with a scope that did not attempt it
**THEN** the stream SHALL classify as unknown with an unmeasured disposition
**AND** the connection SHALL NOT render Healthy.

#### Scenario: manifest-deferred stream remains accepted

**WHEN** a stream declares an accepted manifest policy such as `deferred`
**AND** recent runs did not attempt it
**THEN** the stream SHALL classify by its accepted policy
**AND** the connection MAY render Healthy.

### Requirement: Retained-record counts SHALL be exact under fresh clean projection evidence

The connector summary SHALL join the manifest's declared streams against the
retained-size stream rows. When the retained-size/summary projection evidence
is fresh and clean, a declared stream absent from the exhaustive row set SHALL
project as exactly zero retained records and owner surfaces SHALL render "0
records". When the projection evidence is stale, dirty, rebuilding, failed, or
unknown, the summary SHALL NOT fabricate a zero for an absent row and owner
surfaces SHALL render the count as unavailable. The summary SHALL expose
enough projection-state evidence for a consumer to make this determination
systemically.

#### Scenario: declared empty stream renders exact zero

**WHEN** the retained-size projection evidence is fresh and clean
**AND** a declared stream has no retained-size row
**THEN** the connector summary SHALL carry a zero-count row for that stream
**AND** owner surfaces SHALL render "0 records" for it.

#### Scenario: stale projection evidence never fabricates zero

**WHEN** the retained-size projection evidence is stale, dirty, or unknown
**AND** a declared stream has no retained-size row
**THEN** the summary SHALL NOT carry a fabricated zero-count row
**AND** owner surfaces SHALL render the retained count as unavailable.

#### Scenario: locally proven streams keep their retained counts

**WHEN** a local-device-backed connection has streams with proven coverage
**AND** the retained-size projection evidence is fresh and clean
**THEN** every declared stream SHALL have a retained-count projection — exact
zero when no records are retained
**AND** proven coverage SHALL NOT coexist with a silently missing retained
count.

### Requirement: A reproducible machine audit SHALL fail on unmeasured required streams beneath Healthy

The reference implementation SHALL provide a reproducible machine audit that
inspects connection verdicts together with their per-stream collection
reports and fails when any required stream rests at unknown/unmeasured
coverage while the connection renders Healthy. The audit SHALL run against
seeded fixtures in developer gates and SHALL support running against a live
owner instance. Generated connector inventory SHALL record every declared
stream's coverage and freshness posture and SHALL fail developer validation
when a stream combines required=true/default-required with an accepted-absence
coverage policy, so newly added debt fails developer validation.

#### Scenario: audit fails on a masked unmeasured stream

**WHEN** the machine audit reads a connection whose rendered verdict is Healthy
**AND** a required stream in its collection report rests at unknown coverage
with an unmeasured disposition and no active run
**THEN** the audit SHALL exit non-zero
**AND** the failure SHALL name the connection and the unmeasured streams.

#### Scenario: audit passes an honest instance

**WHEN** every Healthy connection's required streams carry resolved coverage
postures
**THEN** the audit SHALL exit zero
**AND** accepted-absence and locally-proven streams SHALL NOT be reported as
debt.

#### Scenario: inventory gate fails contradictory required accepted-absence streams

**WHEN** the generated connector inventory reads a manifest stream with
`required: true` or no explicit required flag
**AND** that stream declares an accepted-absence coverage policy such as
`deferred`, `inventory_only`, `unavailable`, or `unsupported`
**THEN** the inventory check SHALL exit non-zero
**AND** the failure SHALL name the connector and stream.
