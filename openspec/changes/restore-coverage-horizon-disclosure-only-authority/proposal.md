## Why

Three artifacts disagreed about whether a coverage horizon may change
completeness.

`add-coverage-horizon-and-actionability-banner` specifies that a horizon
"SHALL participate in NO classification step" and "SHALL NOT by itself mark a
connection unhealthy or a stream's coverage complete"; its design.md rejects
making a horizon a classification input outright. The runtime did the
opposite: `buildCoverageEvidence` computed a `horizonAccountedRetryableGap`
flag and `sourceCoverageCondition` used it to satisfy `SourceCoverageComplete`
for a `retryable_gap` axis. The public connector protocol added
`boundary_claim?: "provider_history_boundary"` with no corresponding
definition in the normative Collection Profile.

The runtime's proof was also too weak for what it decided.
`isProvenPreHorizonGap` required only that the gap carry the typed claim and
that some current, affirmatively-based horizon exist for the stream. Nothing
compared the gap to the horizon's EDGE, and a horizon with
`earliestAvailable: null` (edge unknown) qualified. A retryable gap lying
wholly inside the interval the provider can still serve was therefore
accounted away on a broad typed string plus "some horizon exists": genuinely
owed data read as complete and stopped being owed. Multiple claiming gaps
softened collectively for the same reason.

The path is latent rather than firing today — production holds zero
`connector_coverage_horizons` rows — but the confirm route
(`POST /_ref/connections/:id/coverage-horizon`) is live and mounted, so it
arms the moment any horizon is confirmed.

## What Changes

- Remove `horizonAccountedRetryableGap` from `ConnectionCoverageEvidence`, the
  branch in `sourceCoverageCondition` that honored it, its
  `coverage_complete_horizon_accounted` condition reason, and the
  `computeHorizonAccountedRetryableGap` rollup in `ref-control.ts`.
- Remove `isProvenPreHorizonGap` and `isStreamFullyHorizonAccounted` from
  `connector-gap-classification.ts` rather than demoting them to diagnostics:
  a predicate that still answers "is this gap accounted for by a horizon?" is
  the shape a future caller re-wires into authority, and nothing reads it.
- Keep coverage horizons and `boundary_claim` as disclosure: the store, the
  confirm route, supersession, the snapshot field, and
  `RenderedVerdict.detail.coverage_horizons` are all unchanged, and the
  connector still emits and types its claim.

Deferred, not rejected: binding a specific gap to a specific horizon edge so a
horizon CAN narrow the servable denominator. That requires defining
`boundary_claim` in the normative Collection Profile, an explicit
provenance/authority model, a comparable structured edge carried per gap
(timestamp interval, provider cursor, or ordered key boundary), supersession
and multi-gap semantics, and conformance tests. It is a public-protocol
change, not a runtime one.

## Capabilities

Modified:
- `reference-connection-health`

## Impact

- Strictly narrowing: this path could only ever turn a degrading verdict
  green, so removing it can only make a verdict less green. It cannot
  introduce a false green.
- No connection changes state in production today (zero horizon rows).
- A connection that WOULD have gone green on claim + any-horizon now stays
  `retryable_gap` and degrading, with the horizon still disclosed beside it.
