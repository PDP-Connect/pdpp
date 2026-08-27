## Decision

### Coverage horizon: a third axis, orthogonal to health

Store a coverage horizon as its own append-only table
(`connector_coverage_horizons`), keyed by `(connector_instance_id, stream)`
with `stream = "*"` for a connection-wide disclosure. A new confirmation
supersedes the prior current row (`superseded_at`/`superseded_by_horizon_id`
set on the old row) rather than overwriting it — enforced by a partial unique
index on `(connector_instance_id, stream) WHERE superseded_at IS NULL`, so
there is at most one CURRENT row per (connection, stream) and the full
provenance chain remains walkable.

The horizon is read-only evidence to the health projection: it flows through
`ComputeConnectionHealthInput.coverageHorizons` (optional, defaulting to
empty) straight into `ConnectionHealthSnapshot.coverage_horizons`, following
the exact precedent of `collection_rate`/`detail_gap_backlog`/
`local_device_outbox_counts` — additive, nullable-empty, attached at the
single funnel every classification step returns through so no step can read
or branch on it. It surfaces one layer up in `RenderedVerdict.detail
.coverage_horizons` only; it is never read by tone, channel, label, or
annotation computation.

Absence of a horizon record means "nobody has read/confirmed a boundary
here," never "the provider confirmed there is no more data." The store's
`getCurrentCoverageHorizons` only ever returns non-superseded rows, so a
contradicted or updated confirmation cannot resurface as live evidence.

`ConnectorSummary.coverage_horizons` defaults to an empty array in
`synthesizeConnectorSummary`; no caller is yet wired to read the store on the
batched connector-list path (that page-level evidence batch already reads a
dozen other per-connection evidence types via `Promise.all`, and wiring a
live per-connection horizon read into every list render is unscoped,
unbounded new query volume this change does not need). A future caller that
wants horizons on a connector summary reads the store explicitly and
overrides the field; the type-level contract (a required, non-optional array
on `ConnectorSummary`) is already in place so that caller cannot forget to
handle the empty case.

### Fleet banner: reuse the per-connection predicate, don't invent a second one

`rendered-verdict.ts` already has `staleFreshnessIsSoleDegradation`: an
evidence-based predicate (not a state-list) that answers "is `degraded` here
caused ENTIRELY by ordinary stale freshness, with every other axis clean?" —
used to soften the per-connection pill from "Missing data" to "Needs
refresh". `fleet-health.ts`'s `materiallyBlocked` gate needs the identical
answer, so the predicate is exported and reused verbatim rather than
re-derived. A second, drift-prone copy in `fleet-health.ts` was rejected: the
whole failure mode being fixed is a fleet-level surface disagreeing with the
per-connection verdict it summarizes, and a second predicate could disagree
with the first the same way the raw headline `state` did.

The exclusion applies only to `materiallyBlocked` (the narrow bucket that
feeds `banner_warranted`), not to `degradedOrBroken` (the broader bucket that
feeds the diagnostic `state` field). `degradedOrBroken` intentionally stays
broad per its own existing doc comment — `state` remains a rich diagnostic
signal useful to operator tooling and the strict stream audit, and only
banner-firing changes.

## Alternatives

- Give the coverage horizon its own `ConnectionHealthState` value (e.g.
  `bounded`): rejected — it would make the horizon a classification input,
  which the whole design commits to NEVER doing (a horizon is disclosure, not
  a verdict), and would force every existing consumer of the closed
  `ConnectionHealthState` enum to handle a new member for evidence that
  changes nothing about whether the connection is healthy.
- Re-derive a fleet-local "is this just staleness" check from raw axes
  instead of exporting the rendered-verdict predicate: rejected — this is
  exactly the drift the fix closes; a second implementation of "sole
  degradation" is a second place to get it wrong when a future stale-freshness
  edge case is discovered.
- Blanket-exclude every `degraded` headline state from `materiallyBlocked`:
  rejected — `degraded` is a real degradation for every OTHER cause (coverage
  gaps, a stalled outbox, a failed run), and blanket-listing it would silence
  the banner for genuine collection trouble that happens to also carry the
  `degraded` label.

## Compatibility and safety

Both changes are strictly additive/narrowing:

- `coverage_horizons` is a new field with an empty-array default; no existing
  test asserting on `ConnectionHealthSnapshot`/`VerdictDetail` shape needed
  behavioral changes (existing fixtures were updated to include the new
  required field at its zero value).
- The banner-gate exclusion only ever REMOVES connections from
  `materiallyBlocked` (a `false`-to-`true` `banner_warranted` never becomes
  possible from this change) — a connection that was never in that bucket is
  unaffected, and every existing "still fires the banner" test
  (`needs_owner`, terminal coverage gap, maintainer code-fix, runtime outage,
  stream-health failure) is untouched because none of those shapes satisfy
  `staleFreshnessIsSoleDegradation`.

## Acceptance checks

- A `terminal_gap` stream's coverage axis, forward disposition, and headline
  state are byte-identical with and without an attached coverage horizon
  (provider-retention boundary cannot become a retryable failure).
- No confirmed horizon (or only a superseded one) leaves the coverage axis
  and headline state exactly as they were with no horizon evidence at all
  (an unproven boundary cannot be accepted as provider reality).
- A schedulable connector whose only degradation is ordinary cadence-relative
  staleness does not set `banner_warranted`, while `state` and
  `dimensions.system.degraded_or_broken` still report it.
- A proven current success (`state: "healthy"`) is never overridden by an
  older, non-current false condition.
- `proof-age-cry-wolf-freshness.test.ts` and the full `fleet-health.test.ts`
  suite stay green.
