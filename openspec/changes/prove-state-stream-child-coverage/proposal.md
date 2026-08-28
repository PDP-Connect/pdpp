## Why

A `state_stream` child (for example Gmail's `message_bodies`, riding the
`messages` checkpoint) has no cursor of its own and no `DETAIL_COVERAGE`
message available to it — the profile hard-rejects any `DETAIL_COVERAGE`
naming a `state_stream`-declared stream, by design, because that message
gates its parent's checkpoint commit and a `state_stream` child must never be
able to hold its parent's cursor hostage. Today such a child has exactly two
observable states: it inherits `complete` unconditionally from its parent's
committed checkpoint the instant the parent commits, or (with no runtime
fact at all) it reads `unknown`. Neither state is a measurement of the
child's own coverage. A silently dropped record inside the child's own
hydration lane — a thrown exception between an enumerated key and its write —
is invisible in both states, because nothing about the child's own outcome
ever reaches the coverage projection.

Two prior reviews on this same problem (`bz-gmail-body-proof-design-review-0828.md`,
`bz-gmail-per-key-proof-0828.md`) established, independently and by
execution against the current source, that:

- A per-key denominator computed from the run's own emissions (for example
  `considered = collected + pending_detail_gaps`) is not a measurement — it
  is an identity with no independent term, so it cannot fail and cannot
  catch the swallowed-exception case.
- Routing a `state_stream` child through `parent_streams` is a severe
  regression: it would couple an optional child's coverage report to its
  required parent's cursor commit, exactly the coupling `state_stream` exists
  to prevent.
- No existing "reference-only" channel can carry a per-key denominator across
  the connector/runtime process boundary. `DETAIL_COVERAGE.reference_only`
  is an epistemic flag on the one message kind that is already hard-blocked
  for `state_stream` children; it is not a distinct transport. Every fact
  that crosses the connector/runtime boundary is a wire message, and the
  runtime's only two generic (non-connector-ID) per-key routing tables are
  both manifest-sourced. A new message kind, or a relaxation of the existing
  `state_stream` block, is unavoidable — confirmed by direct code reading of
  the process spawn boundary, the message loop, and both routing tables.

This proposal is the protocol-and-manifest change both reviews concluded is
necessary and named as the only remaining honest path, scoped as narrowly as
those reviews recommended: a state-side coverage fact for a `state_stream`
child, structurally incapable of gating any checkpoint commit.

## What Changes

- Add a new, narrowly-scoped connector-to-runtime message, `STREAM_EVIDENCE`,
  that a `state_stream` child MAY emit at most once per run to report its own
  final `considered`/`covered` counts, measured at the connector's
  enumeration site, after the connector's own key reconciliation (hydrated
  vs. gapped vs. unaccounted) settles.
- `STREAM_EVIDENCE` is deliberately NOT `DETAIL_COVERAGE`: it carries no
  `state_stream` field, is never consulted by
  `missingDetailCoverageReports`/`recordDetailCoverageShortfalls`, and can
  never enter `shortfallStateStreams`. It cannot withhold any checkpoint
  commit, including its own parent's. The existing `state_stream` block on
  `DETAIL_COVERAGE` (`validateDetailCoverageAgainstManifest`) is untouched.
- The runtime folds a validated `STREAM_EVIDENCE` into that stream's own
  `RuntimeCollectionFact.considered`/`covered`, which
  `deriveStreamCoverageCondition` already knows how to evaluate through the
  existing, unmodified `evaluateStreamCoherence` contract — no change to
  `coherence.ts`, `connector-coverage-policy.ts`, or the eligible-checkpoint
  algorithm.
- A `state_stream` child that emits no `STREAM_EVIDENCE` is unaffected: it
  keeps today's behavior exactly (checkpoint inheritance from its parent's
  committed cursor, or `unknown` with no runtime fact).
- No new manifest field. No change to `state_stream`/`parent_streams`
  validation, `coverage_strategy` values, or the `DETAIL_COVERAGE` rejection
  rule. `DETAIL_COVERAGE` remains the transport for `parent_streams` and
  the multi-parent detail-coverage machinery; `STREAM_EVIDENCE` is exclusive
  to `state_stream` children and is rejected for any other stream shape.

## Capabilities

Modified:

- `polyfill-runtime`
- `reference-implementation-runtime`

## Non-Goals

- Does not add `optional_skip_keys` credit to `STREAM_EVIDENCE`. A
  `state_stream` child's unaccounted key stays unaccounted; there is no
  accepted-absence channel for this message.
- Does not let a `state_stream` child emit `DETAIL_COVERAGE`. That
  prohibition, and its enforcement site, are unchanged.
- Does not change how `parent_streams` children report coverage.
- Does not implement production code. This is a design-governed proposal
  only; see `tasks.md`.
