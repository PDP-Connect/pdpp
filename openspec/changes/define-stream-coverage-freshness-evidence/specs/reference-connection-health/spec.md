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
streams it attempted; a run that did not attempt a stream SHALL NOT erase
that stream's prior evidence and SHALL NOT create evidence for it.

Folding a newer attempt's fact over an older one SHALL be monotonic per
stream, independent of which terminal event type carried the newer attempt
or whether the run overall succeeded, failed, or was cancelled: once a
stream's stored fact durably proves coverage, a newer attempt whose own fact
does not also prove durable coverage SHALL NOT replace it — the stronger,
already-proven fact SHALL be kept. A newer attempt whose own fact DOES also
prove durable coverage (including a legitimate skip or accepted-absence fact
whose own checkpoint proves the boundary) SHALL still replace the stored
fact normally, so forward progress is unaffected. A stream with no prior
durably-proven fact has no floor: every attempt — resolved or not — SHALL
still replace it, so a stream that has never been proven keeps surfacing its
newest attempt rather than silently freezing on the first thing recorded for
it. Run failure or cancellation itself SHALL be represented by the
connection's separate run-health/run-summary authority, never fabricated or
suppressed by this per-stream fact store.

The connection SHALL be the isolation key: evidence SHALL never cross
connections, and a terminal event that cannot be attributed to exactly one
connection SHALL be refused rather than folded. Coverage and freshness SHALL
be derived on read from the stored raw facts; the read model SHALL NOT store
frozen derived coverage. Folding SHALL be checkpointed by terminal-event
sequence so that a terminal event recorded during an in-progress reconcile
is folded on a later pass rather than lost, and a deterministic rebuild
SHALL backfill the projection from existing terminal events outside the hot
owner read path. A change to the fold's merge semantics SHALL be able to
invalidate previously-folded rows so they re-derive from their full
attributable terminal history on the next ordinary reconcile pass, rather
than permanently freezing output computed under superseded semantics.
Durable pending detail gaps and the classifying run's known gaps SHALL keep
their existing degrading precedence over stored evidence.

A fold pass SHALL be resumable but NEVER falsely trusted mid-replay: when a
pass's own bounded work budget is exhausted before its drain genuinely
reaches the pass's full high-water mark, the row's terminal facts SHALL be
persisted as real, resumable partial progress — never discarded and never
restarted from scratch on the next pass — but SHALL be marked with a
distinct unreliable/incomplete terminal-facts state and a precise, stable
reason, surfaced through the SAME existing evidence-unreliability boundary
every other terminal-facts failure uses. Only a pass whose drain genuinely
converges to the pass's full high-water mark SHALL mark a row's terminal
facts trustworthy. This gate applies uniformly to every bounded fold pass,
not only a fold-logic-version upgrade replay. The fold-logic version a
row's terminal facts were computed under SHALL be recorded on every write a
pass makes, converged or not — never withheld pending convergence — because
withholding it would make an incomplete row look version-behind again on
its next pass and restart its replay from empty instead of resuming from
its own genuine partial progress; trustworthiness SHALL be carried
entirely by the terminal-facts reliability state, never by the recorded
fold-logic version. Every fold write SHALL replace the stored per-stream
fact map EXACTLY — including replacing it with empty — never retaining a
prior value under a silently coalesced write, so an early or empty replay
can never be misread as carrying forward stale evidence under a newer
claimed version.

A row whose recorded fold-logic version is AHEAD of the observing
instance's own version — already folded by a newer, not-yet-understood
fold contract — SHALL NEVER be folded, replayed, or durably mutated by an
older instance, not even to mark it unreliable: an older instance SHALL
fail such a row closed only in its OWN read-time observation, leaving the
durable row completely untouched, so a still-running older instance (a
rolling deploy, or a rollback) can never durably regress or poison state a
newer instance already produced, and a newer-compatible reader continues to
observe the row exactly as the newer instance left it.

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

#### Scenario: a later cancelled or failed attempt does not regress an already-durably-proven stream

**WHEN** a stream's stored fact already durably proves coverage
**AND** a later terminal event — regardless of its event type (`run.completed`,
`run.failed`, or `run.cancelled`) — attempts that same stream but its own
fact does not durably prove coverage
**THEN** the stream SHALL keep its already-proven fact and provenance
**AND** the connection SHALL NOT be classified with unmeasured evidence for
that stream on the basis of the later, unresolved attempt.

#### Scenario: a fold-semantics fix self-heals previously-folded rows without a manual data repair

**WHEN** a row's stored per-stream facts were folded under a superseded
merge semantics that has since been corrected
**THEN** the next ordinary reconcile pass SHALL re-derive that row's facts
from its full attributable terminal history under the corrected semantics
**AND** this SHALL require no connector-specific code path and no manual
data mutation.

#### Scenario: a bounded pass that exhausts its budget before converging is never readable as trustworthy

**WHEN** a fold pass's own work budget is exhausted before its drain
genuinely reaches the pass's full high-water mark
**THEN** the row's terminal facts SHALL be persisted as real, resumable
partial progress
**AND** the row's terminal-facts state SHALL be marked unreliable with a
precise, stable reason, never trustworthy, even though real progress was
made.

#### Scenario: bounded rounds resume and accumulate; only genuine convergence marks a row trustworthy

**WHEN** a connection's terminal history is folded across multiple bounded
passes, each of which exhausts its own budget before the last one
**THEN** each intermediate pass SHALL resume from the prior pass's own
partial progress and accumulate onto it, never restarting from empty
**AND** every intermediate pass's row SHALL remain marked unreliable
**AND** only the pass whose drain genuinely reaches the connection's full
attributable terminal history SHALL mark the row's terminal facts
trustworthy.

#### Scenario: an incomplete pass's recorded fold-logic version never regresses to version-behind

**WHEN** a fold pass writes a row's terminal facts before its drain
converges
**THEN** the row's recorded fold-logic version SHALL still reflect the
CURRENT fold-logic version, not be withheld pending convergence
**AND** the row's next fold pass SHALL resume from this exact partial
progress rather than being treated as version-behind and replayed again
from an empty fact map.

#### Scenario: an empty or early replay clears stale evidence exactly, never silently retaining it

**WHEN** a fold pass's genuine output for a row is an empty per-stream fact
map — whether because no attributable terminal history exists, or because
an early bounded replay round has not yet re-derived any stream
**THEN** the row's stored per-stream fact map SHALL be replaced exactly by
that empty output
**AND** a prior stored fact map SHALL NOT be silently retained under the
newly recorded fold-logic version.

#### Scenario: a fold-logic-version-ahead row is never folded, replayed, or durably mutated by an older instance

**WHEN** a row's recorded fold-logic version is ahead of the observing
instance's own fold-logic version
**THEN** the observing instance SHALL NOT fold, replay, or durably write to
that row for any reason, including to mark it unreliable
**AND** the observing instance SHALL present that row's terminal facts as
unreliable only within its OWN read-time observation, leaving the durable
row completely unchanged
**AND** a subsequent read by an instance whose fold-logic version is
compatible SHALL observe the row exactly as it was durably stored,
unaffected by the incompatible instance's own observation.

### Requirement: Canonical record counts SHALL be exact under current record-snapshot evidence

The connector summary SHALL join the manifest's declared streams against the
stable canonical `records WHERE deleted = false` snapshot. When record-snapshot
evidence is current at its exact source checkpoint, a declared stream absent
from the exhaustive canonical row set SHALL project as exactly zero records and
owner surfaces SHALL render "0 records". When record-snapshot evidence is
unobserved, stale, failed, or unknown, the summary SHALL NOT fabricate a zero
for an absent row and owner surfaces SHALL render the count as unavailable or
explicitly stale. Retained-size rows SHALL own retained byte, history, and blob
measures only; their availability SHALL NOT determine a canonical record count.
The summary SHALL expose enough projection-state evidence for a consumer to
make this determination systemically.

#### Scenario: declared empty stream renders exact zero

**WHEN** canonical record-snapshot evidence is current at a stable checkpoint
**AND** a declared stream has no live canonical record row
**THEN** the connector summary SHALL carry an exact zero-count row for that stream
**AND** owner surfaces SHALL render "0 records" for it.

#### Scenario: stale projection evidence never fabricates zero

**WHEN** record-snapshot evidence is stale, failed, unobserved, or unknown
**AND** no trustworthy current count exists for a declared stream
**THEN** the summary SHALL NOT carry a fabricated zero-count row
**AND** owner surfaces SHALL render the record count as unavailable or stale.

#### Scenario: locally proven streams keep their canonical counts

**WHEN** a local-device-backed connection has streams with proven coverage
**AND** canonical record-snapshot evidence is current
**THEN** every declared stream SHALL have a canonical count projection — exact
zero when no live records exist
**AND** proven coverage SHALL NOT coexist with a silently missing canonical
count.

### Requirement: A reproducible machine audit SHALL distinguish settled failures from active or unreliable evidence

The reference implementation SHALL provide a reproducible machine audit that
inspects every settled connection together with its per-stream collection
report. A connection is settled when it is neither revoked nor in a
`draft`/`setup_in_progress` lifecycle state: a draft connection has not
completed its first enrollment/credential-capture step, so it is intentionally
owner-discoverable (per the pending-connection-discovery contract) before it
carries any coverage evidence, and the audit SHALL NOT judge it against the
settled-failure bar. On a settled connection, the audit SHALL fail when any
required stream rests at unknown/unmeasured coverage or carries an
accepted-absence condition. When active bounded work is currently expected to
resolve the missing evidence, the audit SHALL be explicitly inconclusive
rather than passing. When declared stream counts are unavailable because
record-snapshot evidence is unobserved, stale, failed, or otherwise unreliable,
the audit SHALL be inconclusive rather than fabricating zero; when the canonical
record snapshot is current, an absent declared stream count SHALL fail.
The audit SHALL report at most one finding per distinct (connection, stream,
evidence class) combination — internal checks that independently detect the
same masked or unsettled evidence for a stream SHALL collapse into a single
reported finding, but distinct evidence classes for the same or different
streams SHALL both surface; the audit SHALL NOT let deduplication hide a real,
distinct failure. The audit SHALL run against seeded fixtures in developer
gates and SHALL support running against a live owner instance. Generated
connector inventory SHALL record every declared stream's coverage and
freshness posture so newly added debt fails developer validation.

#### Scenario: audit fails on a settled masked unmeasured stream

**WHEN** the machine audit reads a settled connection whose collection report
contains a required stream at unknown coverage with an unmeasured disposition
**THEN** the audit SHALL exit non-zero
**AND** the failure SHALL name the connection and the unmeasured streams.

#### Scenario: audit does not judge a draft connection as a settled failure

**WHEN** the machine audit reads a connection whose lifecycle status is
`draft` (or whose projected owner state resolver is `setup_in_progress`)
**AND** that connection has required streams resting at unknown/unmeasured
coverage
**THEN** the audit SHALL NOT report the connection as failing or inconclusive
on account of that draft's stream evidence
**AND** an otherwise-honest instance consisting only of such draft connections
SHALL exit zero.

#### Scenario: audit is inconclusive while active bounded work is expected

**WHEN** the machine audit reads a connection with active bounded work evidence
**AND** the connection is settled
**THEN** the audit SHALL exit non-zero
**AND** the result SHALL be explicitly inconclusive rather than a pass.

#### Scenario: audit is inconclusive when canonical counts are unavailable

**WHEN** the machine audit reads a settled connection whose declared stream is
absent from the canonical-count projection
**AND** the record-snapshot evidence is non-current
**THEN** the audit SHALL exit non-zero
**AND** the result SHALL be explicitly inconclusive rather than fabricating
zero.

#### Scenario: a stream masked by more than one internal check reports once

**WHEN** the machine audit reads a settled connection whose collection report
contains a required stream that both rests at unknown/unmeasured coverage and
has no trustworthy canonical count
**THEN** the audit SHALL report exactly one failure finding for that stream
**AND** SHALL NOT report the same connection/stream/evidence-class combination
twice.

#### Scenario: deduplication does not hide a distinct failure on another stream

**WHEN** the machine audit reads a settled connection with two different
required streams that each carry a different masked evidence class
**THEN** the audit SHALL report a distinct failure finding for each stream
**AND** neither finding SHALL be dropped on account of the other.

#### Scenario: audit passes an honest instance

**WHEN** every settled connection's required streams carry resolved
coverage postures
**AND** every declared stream count is either present or cleanly synthesized
as zero
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

### Requirement: Local-device health authority SHALL be source-kind scoped and fail closed

The control plane SHALL select Collection Report and health authority from
persisted connection `source_kind` before run precedence. For `local_device`,
scheduler/controller run facts, schedules, and latest-attempt hydration are
quarantined audit history and SHALL NOT participate in coverage, freshness, or
verdict projection. Non-local connections retain existing run behavior.

`local_device` coverage SHALL be proven only by connection-scoped committed
`coverage_diagnostics` STATE with valid `{ fetched_at, stores }`, non-null server
`updated_at`, and an exact complete sanitized known-store/store-to-stream snapshot.
Health SHALL source its rows only from that STATE, never retained diagnostics
RECORDs; fetched-at-only legacy STATE is historical data but insufficient proof.
Malformed, dropped, extra, duplicate, conflicting, or `unaccounted` entries
shall fail closed. Same-stream stores SHALL fold worst-wins. The STATE server `updated_at` is each local stream's
`evidence_as_of`; heartbeat and record emission time cannot refresh proof.

The control plane SHALL also require a fresh healthy idle/drained heartbeat,
reliable state read, no pending/leased/retrying/stale-lease/dead-letter/
open-backlog outbox work, and no local collector, pending-detail, or
terminal-detail gap. Missing, legacy, malformed, unreadable, unreliable, or
contradictory evidence SHALL fail closed to unmeasured or gaps.

#### Scenario: newer scheduler facts cannot suppress local proof

**WHEN** a `local_device` connection has valid committed local coverage STATE
and a newer scheduler run fact
**THEN** its Collection Report SHALL project from local evidence
**AND** the same non-local fixture SHALL project from its scheduler fact.

#### Scenario: incomplete local proof cannot green

**WHEN** local coverage STATE is absent, malformed, unreadable, lacks server
`updated_at`, has invalid cursor, empty/duplicate/dropped/unaccounted rows,
unresolved gap, unhealthy/stale/starting heartbeat, or open outbox work
**THEN** the connection SHALL NOT render Healthy.

#### Scenario: fixed inventory and future proof are rejected

**WHEN** a local coverage proof omits or adds a store outside the connector's
shared fixed inventory, or its cursor or server `updated_at` is more than the
allowed bounded future skew ahead of trusted server time
**THEN** its local coverage evidence SHALL be unmeasured
**AND** it SHALL NOT seed complete Collection Report rows or pass machine audit.

### Requirement: Local-device control admission SHALL be rejected

Run-now and every schedule create, update, pause, resume, and delete mutation
SHALL reject a persisted `local_device` connection regardless of heartbeat
presence with a typed unsupported-local-device response. Console modality SHALL
derive from `source_kind`, not heartbeat presence, and SHALL not render remote
Sync or schedule controls for a local-device connection.

#### Scenario: no-heartbeat local control rejection

**WHEN** a persisted `local_device` connection has no heartbeat
**AND** run-now or a schedule mutation is requested
**THEN** it SHALL receive the typed local-device rejection.
