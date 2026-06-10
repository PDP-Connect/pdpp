## Why

A connector whose manifest refresh policy declares it **manual**, **paused**, or
**background-unsafe** (for example Reddit: `recommended_mode: "manual"`,
`background_safe: false`) cannot auto-refresh — only an owner-initiated run
advances its data. The schedule auto-enroll gate already refuses such a
connector a background schedule for exactly these refresh-policy values.

The connection-health projection, however, treats stale freshness as
degrading for every connector: `freshCondition` emits `Fresh=false` at
`warning` severity, which trips `hasDegradingCondition` and the projection
lands on `degraded`. So a manual connector that has complete coverage and a
successful last run inevitably decays to `degraded` the moment its data ages
past the manifest staleness window — a window it structurally cannot meet on
its own. The "stale" condition recurs forever and the red pill is
misleading: nothing failed; the owner simply has not run it again.

This is a freshness-vs-scheduler-policy leak. "Scheduler Policy SHALL Be
Separate From Data Health" already says backoff/pause state must not
contaminate data health; the symmetric truth is that a connector's
*inability to be auto-scheduled* must not turn unavoidable staleness into a
data-health failure.

## What Changes

- Plumb the manifest refresh policy's `background_safe` / `recommended_mode`
  into the connection-health projection as `ConnectionRefreshEvidence`. A
  connector is **manual-refresh-only** when `background_safe === false`,
  `recommended_mode === "manual"`, OR `recommended_mode === "paused"` — the
  same discriminator the auto-enroll gate uses.
- For a manual-refresh-only connector, surface stale freshness as an
  **owner-action / manual-refresh advisory** (`Fresh=false` at `info`
  severity, reason `stale_manual_refresh`, a manual-refresh remediation),
  which yields an `idle` headline plus the existing `stale` badge — not a
  `degraded` pill — **but only when nothing else is wrong**.
- Preserve degradation for schedulable / background-safe connectors on the
  identical stale evidence, and preserve degradation/blocking for every
  other failure mode (incomplete coverage, terminal/retryable gaps, stalled
  outbox, failed last run, credential rejection, backoff, open attention) on
  manual connectors too. The advisory only fires when coverage is complete
  and the last collection succeeded.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: scheduler-policy decomplection is extended
  to cover a connector's auto-schedulability, and a new requirement defines
  the manual-connector stale-freshness advisory.

### Removed Capabilities

## Impact

- Affected runtime: `reference-implementation/runtime/connection-health.ts`
  (new `ConnectionRefreshEvidence` input, `isManualRefreshOnly`,
  `stale_manual_refresh` reason, manual-aware `freshCondition`, new
  `classifyManualStaleAdvisory` step, `idle` dominant-condition pick).
- Affected server: `reference-implementation/server/ref-control.ts`
  (`buildRefreshEvidence` from the manifest `refresh_policy`, threaded
  through `projectConnectorSummaryConnectionHealth` at both the list and
  detail call sites).
- Affected tests: `reference-implementation/test/connection-health.test.js`,
  `reference-implementation/test/connection-health-acceptance.test.js`.
- No change to the heartbeat wire contract, schedule storage, manifest
  schema, or any data operation. Absent/malformed refresh policy preserves
  the prior behavior (treated as schedulable; staleness degrades).
