## Decision

### Model A (disclosure-only) over Model B (denominator-changing)

Two coherent models were available. Model A keeps the horizon as disclosure and
removes its coverage authority. Model B lets a horizon change the servable
denominator, but only behind a full protocol contract: `boundary_claim` defined
in the normative Collection Profile, an explicit provenance/authority model,
per-gap binding to a specific horizon edge, a rule that
`earliestAvailable: null` cannot prove any particular gap is pre-horizon,
supersession and multi-gap semantics, and conformance tests.

Model A was chosen for three reasons.

It restores the only authority that was ever explicitly designed and accepted.
`add-coverage-horizon-and-actionability-banner`'s normative delta requires that
a horizon "participate in NO classification step" and never "by itself mark ...
a stream's coverage complete"; its design.md rejects the horizon as a
classification input in its Alternatives section. The runtime, not the spec, was
the outlier. No accepted artifact ever authorized the denominator rule — two
test files cited a "GOAL-OWNER RULING (recorded verbatim in ... design.md)"
permitting exclusion of the pre-horizon interval, but no such text exists in
that design.md at this revision. Those citations were removed rather than
repeated.

The current evidence does not justify Model B. A broad typed string plus "some
horizon exists for this stream" is not proof that a particular gap lies outside
what the provider can still serve, and Model B's per-gap edge binding is a
public-protocol change spanning the Collection Profile and the connector
protocol package — a materially larger change than this correction, and one
that belongs with the protocol work rather than inside a runtime fix.

Model A is also the strictly safe direction. The removed path could only ever
turn a degrading verdict green, so removing it can only make a verdict less
green. It cannot introduce a false green, which makes it safe to land ahead of
the protocol decision it defers.

### Remove the predicates rather than demote them to diagnostics

`isProvenPreHorizonGap` and `isStreamFullyHorizonAccounted` could have been kept
as non-authoritative diagnostics. They were removed instead. A predicate whose
name and body still answer "is this gap accounted for by a horizon?" is exactly
what a future caller re-wires into authority, and its answer was the unsound
part — not merely its wiring. Nothing read them once the flag was gone, so
keeping them would have preserved the defect's reasoning with no consumer. The
rationale for their absence is recorded in prose where they used to live, so the
next reader learns why the module deliberately has no such predicate.

### Rewrite the pinning tests into their inverses

Three test files pinned the removed behavior. Their assertions were inverted
rather than deleted, because each names a case that still matters: the GroupMe
production shape, the weak-basis distinction, and the health-layer contract. The
weak-basis suite additionally had a `notEqual` against the deleted
`coverage_complete_horizon_accounted` reason; once that string no longer exists
such an assertion passes vacuously, so it was replaced with a positive
`status === "false"` / `reason === "retryable_gap"` pair that still fails if some
other path greens the gap.

## Alternatives

- Keep the flag but require `earliestAvailable` to be non-null: rejected — it
  closes only one of the two false-green shapes. A gap inside the servable
  interval still softens, because a non-null edge without a per-gap comparison
  proves nothing about where a given gap falls.
- Compare the gap's `scope.time_range` to the horizon edge inside the runtime:
  rejected — `scope` is optional and connector-authored, most gaps carry none,
  and inventing an RI-side temporal rule over an undefined protocol field
  recreates the "provider knowledge in the RI" problem the typed
  `boundary_claim` was introduced to remove. The edge binding must be defined in
  the protocol first.
- Edit `add-coverage-horizon-and-actionability-banner` in place: rejected — that
  change's spec is already correct and already says what the runtime now does.
  The drift belongs in its own change with its own scenarios.

## Compatibility and safety

Strictly narrowing. `SourceCoverageComplete` can no longer be satisfied through
horizon evidence, so any connection that would have gone green on
claim + any-horizon now stays `retryable_gap` and degrading, with the horizon
still disclosed beside it. No connection changes state in production today:
`connector_coverage_horizons` holds zero rows, so no live projection reached the
removed branch. Every disclosure surface is untouched, and the connector-side
`boundary_claim` contract still compiles and passes.
