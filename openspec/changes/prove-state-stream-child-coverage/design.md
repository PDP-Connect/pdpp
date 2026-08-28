## Decision

Add one new connector-to-runtime message, `STREAM_EVIDENCE`. It is the
smallest portable primitive that lets a `state_stream` child report an
independently measured coverage fact about itself without becoming, or being
confused with, `DETAIL_COVERAGE`.

```json
{
  "type": "STREAM_EVIDENCE",
  "reference_only": true,
  "stream": "message_bodies",
  "considered": 214,
  "covered": 211
}
```

| Field | Type | Description |
|-------|------|--------------|
| `reference_only` | `true` | MUST be present and `true`. Same epistemic marker as `DETAIL_COVERAGE.reference_only`: evidence about a run, not itself durable data. |
| `stream` | string | The `state_stream`-declared stream this fact describes. MUST be present in `scope.streams`. MUST name a stream whose manifest declaration has `state_stream` set (i.e. is itself a `state_stream` child). |
| `considered` | integer, >= 0 | The full count of keys the connector's own hydration lane considered for this stream in this run, after the connector's own reconciliation of hydrated vs. gapped vs. unaccounted keys settles. |
| `covered` | integer, 0 <= covered <= considered | The count of `considered` keys the connector successfully hydrated and emitted as `RECORD` in this run. |

A connector emits at most one `STREAM_EVIDENCE` per `stream` per run. It is
optional: a `state_stream` child that has no independent hydration lane, or
that chooses not to measure itself, emits nothing and keeps today's
inheritance/`unknown` behavior unchanged.

### Why a new message kind, not a `DETAIL_COVERAGE` variant or a new "channel"

Both source reviews independently concluded no existing channel can carry
this without a protocol or manifest change:

- The connector and runtime are separate OS processes communicating only
  through newline-delimited JSON over `stdout`. There is no shared memory,
  return value, or side-channel. Every fact that crosses the boundary is a
  wire message — "reference-only runtime-internal accounting channel" does
  not correspond to any existing distinct mechanism.
- `DETAIL_COVERAGE.reference_only` is an epistemic flag on a message kind
  that is deliberately, hard-blocked for `state_stream` children
  (`validateDetailCoverageAgainstManifest`, profile §3 `DETAIL_COVERAGE`).
  Relaxing that block for a declared exception would either (a) apply
  uniformly and let a `state_stream` child's report enter
  `missingDetailCoverageReports`/`recordDetailCoverageShortfalls`, coupling
  its parent's cursor commit to an optional child's report — the exact
  regression both reviews rule out — or (b) require the runtime to special-
  case `state_stream`-declared streams inside `DETAIL_COVERAGE` handling,
  which reintroduces per-shape branching into a message whose entire
  contract is "this gates a parent." A distinct message kind is structurally
  cleaner than a mode flag on a message whose name already means something
  else.
- `DETAIL_COVERAGE` additionally carries `state_stream`, `hydrated_keys`,
  `gap_keys`, and multi-parent semantics that do not apply here: a
  `state_stream` child has exactly one static parent (the manifest
  declaration itself, not a per-message field), and its own hydration lane
  is single-stream, not fan-in. Reusing the larger message's shape would
  invite the same "flag valid only alongside `state_stream`" overlap the
  first design review rejected in the earlier `detail_gap_accounted`
  proposal.

`STREAM_EVIDENCE` therefore carries only what a `state_stream` child can
honestly report about itself: `considered`, `covered`, its own `stream`
name. No `state_stream` field, no key sets, no parent identity — because it
never needs to select or contest a parent; the manifest already says which
parent it rides, immutably, and this message never touches that.

### Why final counts, not progress metadata

The message carries exactly two integers, both **final** for the run — not
a running `count`/`total` pair, and not raw per-key sets.

- **Progress metadata is explicitly rejected.** `PROGRESS` (profile §3) is
  documented as "Optional progress update for display in runtime UIs" — it
  is presentation, not evidence, and nothing in the coverage projection
  reads it. If `STREAM_EVIDENCE` mirrored `PROGRESS`'s shape (an
  in-flight `count`/`total`), a runtime would have no principled way to
  distinguish "the connector is still counting" from "the connector is
  done counting" without an additional terminal marker — which only
  reinvents the RECORD/DETAIL_GAP-then-terminal-report shape
  `DETAIL_COVERAGE` already uses, badly, on a message not meant to carry
  it. Requiring `considered`/`covered` to already be final numbers, reported
  once after the connector's own reconciliation, keeps the message a
  terminal fact rather than a live counter the runtime would have to
  interpret.
- **Raw key sets are rejected.** `DETAIL_COVERAGE.required_keys`/
  `hydrated_keys`/`gap_keys` exist because the runtime independently
  cross-checks `gap_keys` against durable `DETAIL_GAP` records
  (profile §3 `DETAIL_GAP`: "a `gap_keys` entry ... is not by itself proof
  of a durable retry obligation"). A `state_stream` child has no durable
  gap-recovery lane of its own to cross-check against — `DETAIL_GAP`'s
  `parent_stream` scoping exists for `parent_streams` fan-in, which does not
  apply here. Carrying raw key sets the runtime cannot independently verify
  would only inflate the wire payload and imply a cross-check that does not
  exist. The connector, not the runtime, is the only party positioned to do
  key-level reconciliation for a single-parent, single-lane stream; the
  message reports that reconciliation's finished result.
- **Counts must be measured "after the connector's own key reconciliation,"
  not derived from the run's own emissions.** This is the central defect the
  design review found in the rejected `detail_gap_accounted` proposal:
  `considered = collected + pending_detail_gaps` is an identity over the
  run's own terms, not an independent measurement, and cannot fail. This
  proposal requires the connector to enumerate `considered` at the
  hydration site — before the throw-prone fetch/write work, mirroring the
  `attachments` pattern in the same connector file — and to compute
  `covered` from the outcome of that same enumeration (hydrated vs. gapped
  vs. unaccounted), not from a downstream count. A key enumerated then lost
  to a swallowed exception is `considered` but not `covered`; that shortfall
  is the load-bearing case this message exists to make visible. See
  [Failure semantics](#failure-semantics) below.

### Why `considered`/`covered` and not a parent-count alias

The design explicitly rejects letting a `state_stream` child borrow or
rebadge its parent's `considered`/`covered` (for example, its parent list
stream's `metas.length`/emitted-record count). The parent's denominator
counts records the parent stream enumerated for its own purposes — which,
for Gmail's `messages`→`message_bodies` relationship, includes messages that
never attempted a body fetch. A parent-count alias would silently overstate
the child's own denominator with keys the child never touched, manufacturing
`considered === covered` for keys the child's own lane took no action on.
`STREAM_EVIDENCE.considered`/`covered` MUST be measured at the child
stream's own hydration site, over exactly the keys the child's lane
attempted — never inferred from, copied from, or reconciled against a
different stream's count.

### Runtime handling

`STREAM_EVIDENCE` is validated and tracked by a new function,
`trackStreamEvidence(msg)`, parallel to but independent from
`trackDetailCoverage(msg)`. It is called from the same message-receive loop
as every other connector message, and:

1. Rejects (protocol violation, fail closed) a `STREAM_EVIDENCE` whose
   `stream` is not `state_stream`-declared in the manifest. This message
   kind exists exclusively for `state_stream` children; a
   `parent_streams`-declared or self-mapped stream reporting one is a
   protocol violation, symmetric with `DETAIL_COVERAGE`'s existing rejection
   of `state_stream` children.
2. Rejects a `STREAM_EVIDENCE` with `covered > considered`, `considered < 0`,
   or `covered < 0`.
3. Rejects a second `STREAM_EVIDENCE` for the same `stream` in the same run
   (at most one per stream per run — the message is a terminal fact, not an
   incremental one).
4. On acceptance, records `{considered, covered}` for that stream, folded
   into `RuntimeCollectionFact.considered`/`covered` at the same point
   `buildCollectionFacts` assembles the terminal collection report — never
   into `detailCoverageByStateStream`, never touching
   `missingDetailCoverageReports` or `recordDetailCoverageShortfalls`.

No other runtime coverage machinery changes. `deriveStreamCoverageCondition`
already knows how to turn a `RuntimeCollectionFact` with a real
`considered`/`covered` into a coverage axis via the unmodified
`evaluateStreamCoherence` contract (rule 3: `pending_detail_gaps > 0` →
`retryable_gap`, evaluated *before* the numerator, exactly as it does for
every other stream shape today). `applyStateStreamCheckpointInheritance`
only fires when the child has no runtime fact of its own (or one with
`pending_detail_gaps > 0`); a `state_stream` child with a valid
`STREAM_EVIDENCE`-derived fact and no pending gaps is evaluated on its own
measurement first and does not fall through to inheritance. A child that
emits nothing keeps inheriting exactly as it does today.

### Survival of an accepted fact past a later run-level failure or cancel

An accepted `STREAM_EVIDENCE` is folded into that stream's own
`RuntimeCollectionFact` as soon as it is validated — before the run
terminates. `buildRunTerminalData` (`runtime/index.ts:3340`, calling
`buildCollectionFacts` at `:3378`) is invoked from seven call sites, not only
the succeeded-run path: the generic message-handling failure path, a
done-message failure branch, timeout, owner cancellation, connector-exit
close, and close-failure. An accepted `STREAM_EVIDENCE` fact is therefore
folded into the terminal collection data on every one of those paths, not
only on success — the same way any other stream's already-accepted
`RuntimeCollectionFact` is today. This proposal does not change that: it is
existing, general-purpose terminal-data-assembly behavior, and
`STREAM_EVIDENCE` participates in it exactly as `DETAIL_COVERAGE`-derived
facts already do.

**This is deliberately a distinct guarantee from checkpoint-commit
independence, above.** "No checkpoint commit is gated by `STREAM_EVIDENCE`"
answers whether accepting the message can hold a cursor hostage; it says
nothing about whether the resulting fact is safe to read once a run has, in
the end, not succeeded. The two questions are proved separately because a
run can fail on a stream other than the one that reported
`STREAM_EVIDENCE` — the failure is real, but unrelated to the child's own
coverage.

**The read-model rule:** which run's `RuntimeCollectionFact` values are
surfaced to the owner is decided entirely by existing, pre-existing,
general-purpose run-selection logic —
`coverageClassifyingRun`/`healthClassifyingRun`
(`reference-implementation/server/ref-control.ts:2786-2807`) — not by
anything this proposal adds. That selector already excludes an
intervening failed or owner-cancelled run's facts from being the run whose
coverage is projected to the owner, falling back to `lastSuccessfulRun`
(or `unknown` with none). `STREAM_EVIDENCE` introduces no new selection
path and no new fact source that bypasses `coverageClassifyingRun`: a
`state_stream` child's `coverageCondition` is read only for whichever run
`coverageClassifyingRun` already resolves to, exactly as every other
stream's `coverageCondition` is today. A `STREAM_EVIDENCE` fact accepted
mid-run and then folded into a terminal failure/cancel record is real data
— `buildRunTerminalData` does persist it — but it is not surfaced to the
owner as that stream's current coverage unless `coverageClassifyingRun`
selects that same run, which it does not do for a run whose overall outcome
was failure or owner-cancellation while a distinct prior success exists.

This proposal makes no change to `coverageClassifyingRun`,
`healthClassifyingRun`, or any other run-selection logic, and requires
none: the existing selector already generalizes correctly to a
`STREAM_EVIDENCE`-derived fact because it selects by run outcome, not by
which message types contributed to that run's terminal data. The
implementing change's task list (`tasks.md` §3) MUST include a regression
test proving this directly for `STREAM_EVIDENCE`: a run that accepts
`STREAM_EVIDENCE{considered: n, covered: n}` for a `state_stream` child
and then fails on an unrelated stream MUST NOT have that child's
`complete` projection surfaced to the owner in place of the
`lastSuccessfulRun`'s (or `unknown`, if none) coverage for that stream.

<a id="failure-semantics"></a>
### Failure semantics

- **Quiet run (zero keys considered).** `considered: 0, covered: 0` under
  `checkpoint_window` proves `enumeration_boundary` in the unmodified
  `coherence.ts` — this is correct and is the same zero-result-run proof
  every other `checkpoint_window` stream already relies on. This is why
  emission of `STREAM_EVIDENCE` MUST itself be gated by a boundary predicate
  at the connector: a connector MUST NOT emit `STREAM_EVIDENCE` for a run
  that did not establish a genuine enumeration boundary for that stream (for
  example, a scheduled run that walked no window at all). Withholding the
  message — not emitting `considered: 0, covered: 0` for a run that proved
  nothing — is what keeps a genuinely quiet, fully-covered run distinct from
  a run that walked almost nothing. This mirrors the existing
  `attachmentsCoverageBoundaryEstablished` gate already shipped in the
  Gmail connector for the sibling `attachments` stream, applied here to
  `message_bodies`'s own boundary condition, and is a MUST at the profile
  level, not merely a recommended connector pattern.
- **Swallowed exception (a key enumerated, then lost before hydration or
  gap-reporting).** Because `considered` MUST be measured by pushing each
  key into the connector's own enumeration set before the throw-prone
  fetch/write work — not derived from a downstream success/failure tally —
  an exception that unwinds past the write without reaching either the
  hydrated outcome or a gap record leaves that key `considered` but not
  `covered`. The resulting fact (`covered < considered`, `pending_detail_gaps`
  unaffected) proves `boundary_shortfall` in the unmodified `coherence.ts`,
  which `deriveGapFreeStreamCoverageCondition` maps to `partial` — never
  `complete`. This is the discriminating case the rejected
  `detail_gap_accounted` proposal could not catch, because its `considered`
  was computed *from* the run's own successful emissions plus its own gap
  count, with no independent term. `STREAM_EVIDENCE.considered` being
  enumerated at the hydration site, before outcome is known, is what gives
  it an independent term.
- **Retryable gap.** A key the connector gaps (durable `DETAIL_GAP` with no
  `parent_stream`, matching this single-parent stream) reduces `covered`
  below `considered` and is additionally reflected in
  `pending_detail_gaps`, which — per `deriveStreamCoverageCondition` rule 3
  — routes the stream to `retryable_gap` before the `considered`/`covered`
  numerator is even consulted. This is unchanged existing behavior; a
  `state_stream` child gains no special gap-handling path.
- **Invalid message.** A `STREAM_EVIDENCE` failing runtime validation (wrong
  stream shape, `covered > considered`, negative counts, duplicate for the
  same stream/run) is a protocol violation: the runtime rejects it fail
  closed, exactly as an invalid `DETAIL_COVERAGE` is rejected today. A
  rejected `STREAM_EVIDENCE` MUST NOT be silently dropped in a way that lets
  the stream fall through to inheritance as if nothing were reported; a
  connector emitting an invalid fact is a protocol-conformance failure for
  the run.

### Why this does not weaken the Collection Profile

- **Manifest authority is preserved.** `STREAM_EVIDENCE` requires the
  manifest to already declare the stream as a `state_stream` child; nothing
  about which stream a `STREAM_EVIDENCE` may name is decided at run time.
  The manifest still declares the permitted shape; the message can only
  report within it, exactly the "manifest is authoritative, live evidence
  selects within the declared shape" model the profile's [Precedence between
  manifest and run-time evidence](../../../spec-collection-profile.md#precedence-between-manifest-and-run-time-evidence)
  section already establishes for `DETAIL_COVERAGE`.
- **`DETAIL_COVERAGE` prohibition for `state_stream` children is untouched.**
  `validateDetailCoverageAgainstManifest`'s rejection of any
  `DETAIL_COVERAGE` naming a `state_stream`-declared stream stays exactly as
  written. `STREAM_EVIDENCE` is a different message type; it does not relax,
  alias, or bypass that check, and it gives a `state_stream` child no path
  to becoming `parent_streams`-shaped or to making the `messages` cursor
  commit conditional on an optional child's report — the exact coupling
  `state_stream` exists to prevent (profile §1: "the runtime projects its
  checkpoint status from the parent's commit outcome directly, with no
  run-time override").
- **Checkpoint commit independence is preserved.** `STREAM_EVIDENCE` never
  enters `missingDetailCoverageReports`, `recordDetailCoverageShortfalls`,
  or `shortfallStateStreams`. There is no code path by which accepting,
  rejecting, or omitting a `STREAM_EVIDENCE` message changes whether any
  checkpoint — the child's parent or any other stream — commits. It changes
  only what the `state_stream` child's own `coverageCondition` reads in the
  projection.
- **No inferred completeness.** A `state_stream` child that emits nothing
  keeps its current behavior (parent-inherited `complete` within one run, or
  `unknown`). This proposal adds a strictly more honest additional state —
  self-measured `complete`/`partial`/`retryable_gap`/`unknown` — for
  connectors that choose to measure themselves; it does not change the
  default for connectors that do not.
- **No `optional_skip_keys` expansion.** `STREAM_EVIDENCE` has no accepted-
  absence field. An unaccounted key for a `state_stream` child has no path
  to being credited as intentionally skipped; it can only ever show up as an
  uncovered shortfall.
- **No connector IDs.** Validation and routing are entirely manifest-shape-
  based (`state_stream` declared or not); nothing branches on which
  connector or provider emitted the message.

## Compatibility and versioning

- **`STREAM_EVIDENCE` is a breaking wire addition for an old runtime, not a
  gracefully-degrading one.** `handleMsg`'s dispatch table
  (`reference-implementation/runtime/index.ts:5361-5394`) is an explicit
  allowlist (`ASSISTANCE`, `DETAIL_COVERAGE`, ..., `STATE`); an unrecognized
  `msg.type` is not ignored — it throws (`Connector emitted unknown message
  type: ...`), which fails the entire run, for every stream, the moment the
  message arrives. A runtime that predates this change, paired with a
  connector build that emits `STREAM_EVIDENCE`, therefore does not degrade to
  "inherited-only" coverage for one stream; it crashes every run that
  connector makes.
- **Coordinated rollout is the compatibility posture.** Because there is no
  graceful fallback, the runtime that will receive `STREAM_EVIDENCE` MUST be
  deployed, and MUST have `STREAM_EVIDENCE` present in its `protocolHandlers`
  allowlist, before any connector build that emits `STREAM_EVIDENCE` is
  deployed. This is a breaking, coordinated-rollout change at the profile
  level: runtime-first ordering, not independent connector/runtime
  versioning. It is deliberately not solved with a version-negotiation or
  feature-flag handshake — that would add a new capability-exchange
  mechanism to the protocol to protect a single connector-authored message,
  which is disproportionate to the problem; ordering the rollout (runtime
  before connector) is the smaller change and is already how this class of
  addition is deployed in practice.
- A new runtime receiving a manifest from an old connector that never emits
  `STREAM_EVIDENCE` is unaffected: the stream falls through to the unchanged
  inheritance/`unknown` path. This direction (new runtime, old connector) is
  the only one that degrades gracefully; the reverse (old runtime, new
  connector) is the breaking one addressed above.
- This is a profile-level (not core-protocol) addition, versioned alongside
  the Collection Profile's own `protocol_version`. It does not require a
  bump to the core PDPP protocol version, matching how `DETAIL_COVERAGE` and
  `DETAIL_GAP` were introduced as profile-level additions. It is additive to
  the message vocabulary; it is not additive in deployment ordering, per the
  above.
- No manifest schema change accompanies this message. A stream's eligibility
  to emit `STREAM_EVIDENCE` is derived entirely from its existing
  `state_stream` declaration; there is no new manifest field to version.
- The implementing change's rollout task list MUST include deploying the
  runtime change before enabling `STREAM_EVIDENCE` emission in any connector
  build, and MUST NOT describe the connector-side change as safe to ship
  ahead of or independently from the runtime change.

## Rejected Alternatives

- **`detail_gap_accounted` manifest flag with `considered = collected +
  pending_detail_gaps`.** Rejected per `bz-gmail-body-proof-design-review-0828.md`:
  the identity has no independent denominator and cannot detect a swallowed
  exception; the flag also semantically overlaps `parent_streams`'
  "proves its own coverage" definition without matching its commit
  semantics, so a third connector author could not derive which shape to
  use.
- **Route `message_bodies` (or any `state_stream` child) through
  `parent_streams`.** Rejected: converting a `state_stream` child to
  `parent_streams` would make its parent's checkpoint commit conditional on
  the child's `DETAIL_COVERAGE` report every run — `missingDetailCoverageReports`
  does not consult `required`, so this applies even to an optional child
  against a required parent. Confirmed as the most severe regression risk by
  direct trace of `recordDetailCoverageShortfalls` and its caller.
- **Relax `validateDetailCoverageAgainstManifest` for a declared exception,
  letting a `state_stream` child emit `DETAIL_COVERAGE`.** Considered as
  option 2 in the prior design review. Rejected here as unnecessarily large:
  it would require either applying the relaxed check uniformly (risking the
  `parent_streams`-coupling regression above if any downstream code assumes
  "has `DETAIL_COVERAGE`" implies "is a `parent_streams` shape") or adding a
  new manifest flag to distinguish the two, which reintroduces the
  `detail_gap_accounted`-style overlap problem the first rejected
  alternative already ran into. A distinct message type sidesteps both: it
  is unambiguous by construction which shape a message belongs to.
- **Progress-style `count`/`total` metadata instead of a terminal fact.**
  Rejected: `PROGRESS` is explicitly non-evidentiary and nothing consumes it
  for coverage today; reusing its shape would require the runtime to infer
  "finished" from a stream of updates rather than receiving one settled
  fact, adding interpretation the message does not need to carry.
- **Ship nothing; leave `state_stream` children at `unknown`/inherited-only
  forever.** This remains the correct fallback if `STREAM_EVIDENCE` cannot
  be implemented cleanly, per both source reviews' explicit "ship nothing"
  clause. It is not adopted as the decision here because both reviews
  independently identified a bounded, protocol-honest path (this message)
  that neither found infeasible — only larger than a single-connector fix.

## Acceptance

- A `state_stream` child connector that measures itself and emits
  `STREAM_EVIDENCE{considered: n, covered: n}` with no pending gaps, after a
  genuine enumeration boundary, projects `complete`.
- The same connector, with `k` keys gapped, projects `retryable_gap` (rule 3
  fires on `pending_detail_gaps > 0` before the numerator).
- The same connector, with one key enumerated then lost to an unhandled
  exception before hydration or gap-reporting (no `DETAIL_GAP` emitted),
  projects `partial` — proving the swallowed-exception case is caught, which
  the rejected `detail_gap_accounted` design could not do.
- A quiet run that never establishes an enumeration boundary emits no
  `STREAM_EVIDENCE` at all and projects the unchanged inherited/`unknown`
  result — never a fabricated `considered: 0, covered: 0` complete claim.
- A `STREAM_EVIDENCE` naming a `parent_streams`-declared or self-mapped
  stream is rejected as a protocol violation.
- A `DETAIL_COVERAGE` naming a `state_stream`-declared stream is still
  rejected exactly as today; `STREAM_EVIDENCE` introduces no path around
  that check.
- No checkpoint commit — the child's parent or any other stream — is ever
  gated, delayed, or withheld as a function of `STREAM_EVIDENCE` being
  present, absent, or rejected.
- `coherence.ts`, `connector-coverage-policy.ts`,
  `missingDetailCoverageReports`, `recordDetailCoverageShortfalls`, and the
  eligible-checkpoint algorithm require no code changes; only
  `trackStreamEvidence` and `buildCollectionFacts`'s fact assembly are new
  or touched.
- Mutation checks (see `tasks.md`): deleting the enumeration-site push,
  moving it after the throw-prone work, or inverting the boundary-established
  gate each flips a discriminating test red.

## Residual Risk

This proposal specifies the protocol and runtime contract only. It does not
implement or test a real connector's `considered`/`covered` measurement
(for example Gmail's `message_bodies`); that is separate follow-on work once
this contract is accepted. The boundary-established predicate is specified
here as a MUST but its exact per-connector condition (Gmail's
`messages.backfill.completed_at`) is connector-specific and is not
prescribed by this proposal beyond the general requirement that one must
exist and be genuinely tied to enumeration completeness, not to a fixed
elapsed time or record count.
