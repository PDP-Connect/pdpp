## ADDED Requirements

### Requirement: Runtime SHALL fold a validated STREAM_EVIDENCE into its own stream's coverage fact without gating any checkpoint commit

The reference runtime SHALL track `STREAM_EVIDENCE` messages independently
from `DETAIL_COVERAGE` messages, using a separate tracking path
(`trackStreamEvidence`, parallel to but independent from
`trackDetailCoverage`). On accepting a valid `STREAM_EVIDENCE` for a
`state_stream`-declared stream, the runtime SHALL fold its `considered`
value and an `outcomes`-derived `covered` value into that stream's own
`RuntimeCollectionFact` at terminal collection-fact assembly. `covered`
SHALL be derived as `outcomes.emitted + outcomes.unchanged` — the two
outcome terms that account for a considered key without leaving it a
shortfall — deliberately excluding `outcomes.gapped` and
`outcomes.unaccounted`, so that either term being nonzero routes the stream
away from `complete` through the existing, unmodified stream-coherence
contract with no new gating code. The runtime SHALL NOT record
`STREAM_EVIDENCE` evidence into `detailCoverageByStateStream`, and SHALL NOT
allow it to reach `missingDetailCoverageReports` or
`recordDetailCoverageShortfalls`. No checkpoint stream's commit
eligibility — including the `state_stream` child's own parent — SHALL
depend on whether a `STREAM_EVIDENCE` message was received, accepted,
rejected, or omitted for any stream in the run.

Before folding, the runtime SHALL additionally reject a `STREAM_EVIDENCE`
whose `outcomes.emitted` does not equal the exact count of distinct
`(stream, key)` tuples this run's own ingest path proved durably accepted
for that stream — populated only from the hosted ingest response's
validated survivors (the submitted batch minus its index-exact rejection
receipts), computed post-`flushAll()`, scoped to exactly this run with no
cross-run state — and SHALL reject a `STREAM_EVIDENCE` whose
`outcomes.gapped` does not EQUAL this run's own distinct durable
`DETAIL_GAP` count for that stream (deduplicated by `gap_id`: the same gap
is recorded once when first observed pending and again if later recovered,
terminalized, or quarantined, so a raw entry count over-counts a single
logical gap). This is an equality, not a ceiling: a claim of `gapped: 1`
when 2 distinct durable gaps exist for the stream this run is exactly as
invalid as a claim of `gapped: 3` when only 2 exist, because both fail to
match the exact distinct-gap COUNT this run's own durable records prove.
This is an exact count reconciliation, not an identity check: the wire
carries only the integer `outcomes.gapped`, never gap identities, so the
runtime can prove the claimed number equals the number of distinct durable
gaps recorded for the stream, but cannot prove — and this requirement does
not claim to prove — that the connector's own notion of which keys are
gapped is the same SET as the runtime's durable gap records, only that the
two have equal cardinality. Both checks (this one and `outcomes.emitted`'s)
close claims a buggy or dishonest connector cannot otherwise be held to:
the distinct-key equality closes both intra-run duplicate-key inflation
(claiming `emitted: N` for one key emitted N times) and claiming coverage
over records the RS permanently rejected, in one check, because a rejected
or repeated key never adds a
second distinct accepted entry.

A key that is an array (a compound `primary_key`, per `spec-core.md`'s
`RECORD` field table) SHALL be canonicalized to its minified-JSON-array
string form before insertion into the distinct-key set, using the same
`encodeKey` function the resource server uses to canonicalize record keys
for storage (`server/records.ts`) — never `String(key)`, which collapses
distinct compound keys that happen to share a comma-joined representation
(for example `["a","b,c"]` and `["a,b","c"]`) into the same stored string.

`STREAM_EVIDENCE` is a terminal fact per stream per run: the runtime SHALL
reject a `RECORD` or `DETAIL_GAP` message naming a stream for which this
run has already accepted a `STREAM_EVIDENCE`, as a protocol violation. A
connector's own reconciliation of hydrated/gapped/unaccounted keys for a
stream MUST have already settled before it emits `STREAM_EVIDENCE` for
that stream; a later `RECORD` or `DETAIL_GAP` for the same stream would
either silently invalidate the equality/reconciliation checks above (which
were evaluated against the state as of the `STREAM_EVIDENCE` message, not
the run's eventual final state) or indicate the reconciliation was not
actually final when reported.

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
`STREAM_EVIDENCE{considered: n, outcomes: {emitted: e, unchanged: n-e,
gapped: 0, unaccounted: 0}}` with zero pending detail gaps, following a
genuine enumeration boundary
**THEN** the runtime SHALL project that stream's coverage condition as
`complete`
**AND** SHALL NOT require the stream's parent checkpoint to have committed
first for that projection to hold.

#### Scenario: state_stream child with a durable gap projects retryable_gap

**WHEN** a `state_stream`-declared stream's connector reports
`STREAM_EVIDENCE{considered: n, outcomes: {emitted: n-k, unchanged: 0,
gapped: k, unaccounted: 0}}` and `k` matching durable `DETAIL_GAP` records
for that stream in the same run
**THEN** the runtime SHALL project that stream's coverage condition as
`retryable_gap`
**AND** the pending-gap precedence rule SHALL apply before the derived
`considered`/`covered` numerator is consulted, exactly as for any other
stream shape.

#### Scenario: gapped undercounting a stream's real distinct durable gaps is rejected

**WHEN** a `state_stream`-declared stream's connector reports
`STREAM_EVIDENCE{outcomes: {gapped: 1, ...}}` for a stream
**AND** 2 distinct durable `DETAIL_GAP` records exist for that stream in
the same run
**THEN** the runtime SHALL reject the `STREAM_EVIDENCE` as a protocol
violation
**AND** this SHALL hold symmetrically with the already-required rejection
of a `gapped` value that EXCEEDS the stream's distinct durable gap count —
`outcomes.gapped` MUST equal that count exactly, not merely not exceed it.

#### Scenario: state_stream child with an unaccounted key projects partial, never complete

**WHEN** a `state_stream`-declared stream's connector reports
`STREAM_EVIDENCE{considered: n, outcomes: {emitted: n-1, unchanged: 0,
gapped: 0, unaccounted: 1}}` with zero pending detail gaps (one key
enumerated but neither hydrated nor gapped)
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

#### Scenario: a RECORD for a stream after its accepted STREAM_EVIDENCE is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` for a `state_stream`-declared
stream, and the runtime accepts it
**AND** the connector subsequently emits a `RECORD` naming that same
stream, in the same run
**THEN** the runtime SHALL reject the `RECORD` as a protocol violation
**AND** SHALL NOT re-open, adjust, or re-validate the already-accepted
`STREAM_EVIDENCE` fact against it.

#### Scenario: a DETAIL_GAP for a stream after its accepted STREAM_EVIDENCE is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` for a `state_stream`-declared
stream, and the runtime accepts it
**AND** the connector subsequently emits a `DETAIL_GAP` naming that same
stream, in the same run
**THEN** the runtime SHALL reject the `DETAIL_GAP` as a protocol violation.

#### Scenario: a compound (array) key is canonicalized before distinct-key comparison

**WHEN** a `state_stream` child stream's `RECORD` messages carry compound
(array) keys that would collide under naive string concatenation (for
example `["a","b,c"]` and `["a,b","c"]`)
**THEN** the runtime's accepted-key set SHALL store each using the same
canonical minified-JSON-array encoding the resource server uses
(`encodeKey`)
**AND** an honest `STREAM_EVIDENCE` claiming `outcomes.emitted: 2` for both
distinct keys SHALL be accepted, not rejected as a duplicate.

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

**WHEN** a run accepts `STREAM_EVIDENCE{considered: n, outcomes: {emitted: n,
unchanged: 0, gapped: 0, unaccounted: 0}}` for a `state_stream`-declared
stream early in the run
**AND** the same run subsequently fails or is cancelled on a different,
unrelated stream
**AND** a distinct prior run exists and is the run `coverageClassifyingRun`
selects as the classifying run for this connection
**THEN** the owner-facing coverage for the `state_stream`-declared stream
SHALL reflect the selected run's coverage
**AND** SHALL NOT reflect the failed run's `complete` `STREAM_EVIDENCE`-
derived projection in its place.
