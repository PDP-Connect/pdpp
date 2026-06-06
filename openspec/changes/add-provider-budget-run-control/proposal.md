# Proposal: add-provider-budget-run-control

## Why

Collection Profile runtimes call opaque third-party providers whose rate-limit
policies are unknown, partially signaled, or entirely absent. Long-running
connector runs without a correct run-control model produce one or more of the
following failure modes:

- **Provider hammering** — no inter-request pacing causes a burst that exhausts
  the provider's rate budget or triggers account/session suspension.
- **Retry storms** — per-request retry logic, absent a system-wide retry
  budget, amplifies transient throttle events into self-sustaining hammering
  loops.
- **Source-pressure signal corruption** — a planned budget exhaustion (the run
  stopped at its configured cap) is not distinguished from a provider-driven
  rejection; downstream scheduling or cooldown governors misread planned stops
  as provider failures.
- **Non-monotonic or lost checkpoints** — a run that crashes mid-page can
  advance the checkpoint beyond the last durably written page, producing silent
  data loss or duplicate delivery.
- **Wall-clock hang** — a run that cannot call a slow or unresponsive provider
  never terminates unless a separate outer deadline bounds it.

Five prior-art lanes synthesized findings from crawler politeness, data-sync
checkpoint design, retry/circuit-breaker research, rate-control algorithms, and
queue/lease models. All five converge on the same structural conclusions: two
orthogonal control axes (inter-request pacing and run-level volume cap), a
GCRA/token-bucket pacing primitive (with rate-based AIMD adaptation), a
ratio-based retry budget distinct from the per-request attempt count,
commit-gated monotonic checkpoint advancement at slice granularity, and
wall-clock as an outer safety deadline rather than a rate-control or
source-pressure signal. (See synthesis report:
`tmp/workstreams/ri-provider-budget-interim-synthesis-v1-report.md` and final
evidence audit:
`tmp/workstreams/ri-provider-budget-final-evidence-audit-v1-report.md`.

Note: the interim synthesis stated that the rate-control and checkpoint-queues
lanes were "not found." Both completed with full reports. The final evidence
audit confirmed that the structural conclusions hold; the missed lanes raise
confidence on the slice model (22/25 adversarially verified), name GCRA as the
precise pacing primitive, clarify that concurrency-limit AIMD is lower-confidence
than rate-based AIMD, and establish that multi-client shared-credential
coordination is an unsolved open problem in the surveyed literature.)

The reference implementation currently has no normative requirements covering
these behaviors. The bounded-run cap landed in the ChatGPT connector
(`65b98f82`) and was captured by `bound-connector-run-by-owner-cap`, but that
change is narrow (detail-lane cap, no-cap default, decomplect from source
pressure). The broader model — per-provider pacing, retry budget, catch-up mode
separation, and the invariant that wall-clock is not source pressure — is not
specified anywhere.

## What Changes

This change adds a `polyfill-runtime` requirement set covering the minimal
correct run-control model for Collection Profile runtimes calling opaque
third-party providers:

- **Run budget envelope** — every polyfill-runtime run MAY be given explicit
  finite request (or weighted provider-attempt) and wall-clock envelopes, both
  of which trigger a planned defer-and-resume rather than an error on
  exhaustion. These envelopes are owner/system safety bounds, not substitutes
  for adaptive provider pacing.
- **Per-provider pacing** — inter-request rate is controlled by a per-provider
  token bucket distinct from the run-level volume cap.
- **Retry budget** — retry amplification is bounded by a ratio-based token
  bucket (separate from per-request attempt count), so the run defers rather
  than spins when the retry budget is exhausted.
- **Wall-clock role** — wall-clock caps runs to prevent hangs; they are not
  a rate-control primitive and their expiry is not a source-pressure signal.
- **Budget exhaustion as planned defer** — exhaustion of any budget axis
  (request cap, wall-clock, retry budget) produces a resumable gap record with
  a reason distinct from source-pressure reasons; it does not arm the
  source-pressure cooldown governor.
- **Paged detail-gap recovery** — pending detail-gap recovery drains every
  eligible gap in a run until storage is drained or adaptive provider/run safety
  stops. Internal pages are byte-bounded transport batches, not semantic run
  limits.
- **Commit-gated monotonic checkpoint** — the checkpoint advances only after a
  durable write is confirmed; the checkpoint at stop time reflects the last
  durably written page, not the last attempted page.
- **Catch-up vs. steady-state separation** — when a connector distinguishes
  historical backfill from incremental collection, the two modes use separate
  bookmarks and do not corrupt each other's cursor.

## Capabilities

Modified:
- `polyfill-runtime`

Added:
- None

Removed:
- None

## Impact

- Collection Profile runtime authoring policy only. Does not change the public
  `/v1` API, grant semantics, manifest schema, JSONL message wire format (beyond
  requiring the existing `DETAIL_GAP` reason set to remain distinct from
  source-pressure reasons), or the operator dashboard wire contract.
- No new wire messages. Existing `DETAIL_GAP` and `STATE` messages cover
  resumable gaps and checkpoint advancement; this change adds normative
  requirements that already-correct connectors satisfy.
- Composes with `bound-connector-run-by-owner-cap`: that change made the
  detail-lane size/time cap and source-pressure decomplection normative for the
  ChatGPT connector. This change generalizes those invariants to all Collection
  Profile runtimes and adds the pacing and retry-budget axes that the narrower
  change does not cover.
- Composes with `surface-source-pressure-detail-gap-backlog`: the rollup in that
  change is already reason-scoped to source-pressure reasons; budget-exhaustion
  deferrals are excluded by construction. This change makes that exclusion a
  normative requirement of the runtime, not an incidental property.
