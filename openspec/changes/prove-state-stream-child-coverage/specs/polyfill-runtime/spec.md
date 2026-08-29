## ADDED Requirements

### Requirement: A `state_stream` child MAY report independently measured coverage via STREAM_EVIDENCE

A connector MAY emit a `STREAM_EVIDENCE` message for a stream declared with
manifest `state_stream` (a checkpoint-dependent child with no cursor of its
own) to report `considered` plus a disjoint `outcomes` partition
(`emitted`/`unchanged`/`gapped`/`unaccounted`) measured at that stream's own
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
- `outcomes.emitted`: the count of `considered` keys successfully hydrated
  and emitted as `RECORD` in this run.
- `outcomes.unchanged`: the count of `considered` keys the connector compared
  against its own source and found unchanged, and therefore declined to
  emit.
- `outcomes.gapped`: the count of `considered` keys reported via a durable
  `DETAIL_GAP` for this stream in this run.
- `outcomes.unaccounted`: the count of `considered` keys enumerated but lost
  before reaching either the hydrated or the gapped outcome.

`outcomes.emitted + outcomes.unchanged + outcomes.gapped +
outcomes.unaccounted` SHALL equal `considered` exactly.

`considered` and every `outcomes.*` field SHALL be a non-negative integer no
greater than `9007199254740991` (`Number.MAX_SAFE_INTEGER`), not an
arbitrary-precision non-negative JSON integer: a value above this bound is
not representable exactly in the host runtime's native number type, and the
reference runtime rejects it as a protocol violation exactly as it rejects a
negative or non-integer value (spec-collection-profile.md rule 4).

A connector MUST NOT emit `STREAM_EVIDENCE` for a run that did not establish
a genuine enumeration boundary for that stream. A `state_stream` child with
no independent hydration lane, or that does not measure itself, MAY emit
nothing; the runtime's existing checkpoint-inheritance and `unknown`
projection behavior for that stream is unchanged by this requirement.

`considered` and every `outcomes.*` field SHALL be measured at the declaring
stream's own hydration site, over exactly the keys that stream's own lane
attempted. A connector SHALL NOT derive these counts from a different
stream's enumeration or emitted-record count (a "parent-count alias"), and
SHALL NOT derive `considered` as a function of the run's own
successful-emission or gap counts alone (an identity with no independent
term for `unaccounted`).

#### Scenario: state_stream child reports final coverage after its own hydration lane settles

**WHEN** a `state_stream`-declared stream's connector-side hydration lane
finishes attempting every key it considered for the run
**THEN** the connector SHALL emit one `STREAM_EVIDENCE` message for that
stream
**AND** `considered` SHALL equal the count of keys the connector's lane
attempted
**AND** `outcomes.emitted` SHALL equal the count of those keys successfully
hydrated and emitted as `RECORD`
**AND** the four `outcomes.*` fields SHALL sum to `considered`.

#### Scenario: state_stream child emits nothing on a genuinely quiet run

**WHEN** a run does not establish an enumeration boundary for a
`state_stream`-declared stream (for example, a scheduled run that walks no
window for that stream)
**THEN** the connector SHALL NOT emit `STREAM_EVIDENCE` for that stream
**AND** it SHALL NOT emit an all-zero `considered`/`outcomes` shape as if a
boundary had been established.

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
**AND** SHALL count it in `outcomes.unaccounted`
**AND** SHALL NOT count it in `outcomes.emitted` or `outcomes.gapped`.

### Requirement: Runtime SHALL validate STREAM_EVIDENCE against the manifest and reject it outside a state_stream declaration

A conformant runtime SHALL reject (fail closed, as a protocol violation) a
`STREAM_EVIDENCE` message when any of the following holds:

1. `reference_only` is not `true`.
2. `stream` is not present in the run's `scope.streams`.
3. `stream` is not declared with manifest `state_stream` (i.e. is
   `parent_streams`-declared or self-mapped).
4. Any of `considered`, `outcomes.emitted`, `outcomes.unchanged`,
   `outcomes.gapped`, or `outcomes.unaccounted` is not a non-negative
   integer, or the four `outcomes.*` fields do not sum to `considered`
   exactly.
5. A `STREAM_EVIDENCE` was already accepted for the same `stream` in the
   same run.

"Same run" in rule 5 is the same `run_id` guarantee the root protocol spec
requires (see [STREAM_EVIDENCE](../../../../spec-collection-profile.md#stream_evidence)
rule 5), which a conformant runtime MAY implement by any mechanism proven
one-to-one with a single `run_id`. The reference implementation
(`reference-implementation/runtime/index.ts`) enforces this with TWO
mechanisms, checked together: `streamEvidenceByStream` (one Map per
`runConnector` invocation) catches a duplicate within a single invocation,
and a durable store, `StreamEvidenceRunRegistryStore`
(`server/stores/stream-evidence-run-registry-store.ts`, backing table
`stream_evidence_run_registry`, primary key EXACTLY `(run_id, stream)`),
catches a duplicate across SEPARATE `runConnector` invocations that share
the same caller-supplied `run_id` — the case a retry path can produce
(`runtime/scheduler/run-executor.ts`'s `buildAttemptCall` reuses
`call.runId` verbatim across every attempt when the caller supplies one),
including when that retry sequence spans a process restart.

This document previously described the cross-invocation half as an
in-process mechanism (first a per-invocation Map called
"narrower-but-safe," which independent review correctly rejected as
actually more permissive than the rule allows; then a module-level Map,
first FIFO-capped, then made non-evicting). A further independent review
round found that ANY in-process mechanism — evicting or not — loses the
already-accepted fact on process restart, while rule 5 grants no restart
exception. The registry is therefore durable, not process-scoped: it
survives a restart, and a single atomic claim operation
(`claimStreamEvidenceForRunId`) — not a separate check-then-mark pair —
closes the concurrent-invocation TOCTOU race a check-then-mark split would
otherwise permit. The claim INSERT atomically stores the normalized terminal
payload, its digest, and the deterministic terminal event ID with the
uniqueness key. If a process stops after that INSERT but before terminal
evidence persistence, a later invocation MAY replay only the exact stored
payload; a divergent payload is rejected by digest and an already-persisted
terminal event remains a duplicate. Legacy rows without a recoverable payload
are rejected closed rather than used to invent evidence.

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

#### Scenario: STREAM_EVIDENCE whose outcomes do not sum to considered is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` whose `outcomes.emitted +
outcomes.unchanged + outcomes.gapped + outcomes.unaccounted` does not equal
`considered`
**THEN** the runtime SHALL reject the message as a protocol violation.

#### Scenario: STREAM_EVIDENCE claiming more emitted than the runtime's own distinct accepted-key count is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` with `outcomes.emitted` greater
than the count of distinct keys the runtime's own ingest path durably
accepted for that stream this run (whether from claiming records the RS
permanently rejected, or from claiming the same key emitted more than once
as separate coverage)
**THEN** the runtime SHALL reject the message as a protocol violation.

#### Scenario: STREAM_EVIDENCE claiming a gapped count that does not equal the runtime's own distinct durable DETAIL_GAP count is rejected

**WHEN** a connector emits `STREAM_EVIDENCE` with `outcomes.gapped` not
equal to the count of distinct durable `DETAIL_GAP` records the runtime
holds for that stream this run — whether greater (claiming a gap never
durably reported) or lesser (under-declaring gaps that were durably
reported)
**THEN** the runtime SHALL reject the message as a protocol violation.

#### Scenario: a second STREAM_EVIDENCE for the same stream and run is rejected

**WHEN** a connector emits a second `STREAM_EVIDENCE` for a stream it already
reported this run
**THEN** the runtime SHALL reject the second message as a protocol
violation
**AND** SHALL NOT overwrite the first accepted fact with it.

#### Scenario: a second STREAM_EVIDENCE for the same stream under the same run_id, from a SEPARATE runConnector invocation, is rejected

**WHEN** a `runConnector` invocation accepts `STREAM_EVIDENCE` for a stream
under a given `run_id`
**AND** a SEPARATE, later `runConnector` invocation is called with that
SAME `run_id` and emits `STREAM_EVIDENCE` for the same stream
**THEN** the runtime SHALL reject the second message as a protocol
violation, exactly as it would within a single invocation
**AND** this SHALL hold regardless of whether the two invocations share a
connector instance.

#### Scenario: a claim interrupted before terminal evidence persistence is recoverable

**WHEN** a process persists the durable `(run_id, stream)` claim and then
stops before writing `run.stream_evidence_declared`
**AND** a later invocation uses the SAME `run_id`, stream, and normalized
payload
**THEN** the runtime SHALL persist the terminal evidence with the claim's
stored payload and deterministic event ID
**AND** SHALL NOT derive a new completeness fact from the replay.

#### Scenario: a crash-seam replay with a divergent payload is rejected

**WHEN** a durable claim exists for `(run_id, stream)` and a later invocation
supplies a different normalized payload
**THEN** the runtime SHALL reject the replay as a protocol violation
**AND** SHALL NOT append terminal evidence for the divergent payload.

#### Scenario: a second STREAM_EVIDENCE for the same stream under a DIFFERENT run_id is accepted

**WHEN** a `runConnector` invocation accepts `STREAM_EVIDENCE` for a stream
under one `run_id`
**AND** a later, independent `runConnector` invocation, under a DIFFERENT
`run_id`, emits `STREAM_EVIDENCE` for the same stream
**THEN** the runtime SHALL accept the second message
**AND** SHALL NOT treat it as a duplicate of the first.
