# Design: manual-connector freshness advisory

## Problem framing

The headline-state precedence runs:

```
unknown > needs_attention > idle(owner-paused) > blocked > cooling_off
       > degraded > unknown(current-without-verdict) > idle(never-run) > healthy
```

`degraded` is claimed by `classifyDegradedEvidence`, which fires when any
condition is `false` with `warning`/`error`/`blocked` severity (minus an
exempt list). The stale `Fresh` condition is `false`/`warning`, so it lands
the projection on `degraded`. There is no signal distinguishing a connector
that *can* be auto-refreshed from one that cannot.

## Decision: manual-refresh-only is the same discriminator the scheduler uses

A connector is **manual-refresh-only** when its manifest refresh policy
declares `background_safe: false`, `recommended_mode: "manual"`, OR
`recommended_mode: "paused"`. These are the refresh-policy values
`auto-enroll-eligible-schedules.ts` reads to deny a background schedule.
Reusing them keeps the health story consistent with the scheduler's own
decision: a connector the scheduler will never auto-run is a connector whose
staleness is not a background-refresh failure.

Absent/malformed policy → treated as schedulable (prior behavior). This is
the safe default: a connector with no declared policy still degrades on
staleness, so we never silently green an unknown connector.

## Decision: softened freshness, not a special-cased headline

Two surgical moves instead of a Reddit special case:

1. `freshCondition` emits the stale `Fresh` condition at **`info`** severity
   (reason `stale_manual_refresh`, manual-refresh remediation) for a
   manual-refresh-only connector. `info` is below the degrading threshold,
   so `hasDegradingCondition` no longer fires on it. Schedulable connectors
   keep the `warning` stale condition and still degrade.

2. A new ordered step `classifyManualStaleAdvisory` claims `idle` (reason
   `stale_manual_refresh`) — but only when the connector is
   manual-refresh-only, the stale `Fresh` carries the `stale_manual_refresh`
   marker, **and** `CollectionSucceeded` and `SourceCoverageComplete` are
   both `true`. It is placed after `classifyDegradedEvidence`, so any real
   degradation has already claimed the verdict before this step runs.

`idle` is the honest headline: like an owner-paused schedule, a
manual-refresh-only connector is *intentionally not making progress* — the
data is real and complete, it has simply aged and awaits a manual run. The
`stale` badge stays on; the advisory rides on the `Fresh` condition's
remediation (`retry_by_runtime`, target `run`) and the `idle` reason code
`stale_manual_refresh`, so the surface can render "stale — run it manually"
without inventing a new pill.

## Why this can never green a broken connector

Reaching `classifyManualStaleAdvisory` already means no degrading condition
fired. The step *additionally* requires positive proof of a succeeded
collection and complete coverage, so:

- incomplete coverage / terminal_gap / retryable_gap / partial → degrades
  earlier (and the guard fails).
- failed last run → `CollectionSucceeded=false` → degrades or blocks earlier.
- stalled outbox → degrades earlier.
- credential rejection → `blocked` earlier.
- open attention / backoff / unreliable projection → higher precedence.
- never-run (no run verdict, no local-device verdict) →
  `CollectionSucceeded=unknown` → guard fails → falls through to the
  existing never-run `idle` (NOT the advisory), so the reason code is not
  `stale_manual_refresh`.

The advisory therefore only reclassifies the exact green-except-manually-
stale case from `degraded` to `idle`.

## Alternatives considered

- **Project `healthy` on manual-stale.** Rejected: stale data genuinely
  isn't current; hiding it as healthy is dishonest and drops the `stale`
  badge's signal value.
- **Synthesize a `next_action` CTA.** Rejected: `next_action` is an
  attention-shaped contract (`source: "structured"`) the console treats as a
  durable owner-prompt. Fabricating one for an `idle` row would muddy that
  contract. The `Fresh` remediation + `idle` reason code already carry the
  advisory; the console's schedule-fallback advisory path covers rows
  without a structured CTA.
- **Gate on `schedule.enabled === false`.** Rejected: a manual connector
  often has no schedule row at all (never auto-enrolled), so
  `ScheduleEligible` is `unknown`, not `false`. The manifest policy is the
  authoritative, always-present signal.

## Acceptance checks

- `node --test --import tsx reference-implementation/test/connection-health.test.js reference-implementation/test/connection-health-acceptance.test.js reference-implementation/test/ref-connectors-local-coverage-green.test.js` — all pass.
- `npx tsc --noEmit` (reference-implementation) — no errors.
- `openspec validate add-manual-connector-freshness-advisory --strict` — passes.

## Residual

- The console already renders a schedule-fallback advisory for rows without a
  structured `next_action`; surfacing the `stale_manual_refresh` reason code
  as bespoke "run it manually" copy is a follow-up console nicety, not a
  blocker (the honest `idle` + `stale` badge are correct without it).
