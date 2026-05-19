## Why

The reference implementation now has many useful operator pieces: dashboard summary projections, connector health research, schedules, web push, remote surfaces, local collectors, detail gaps, and durable outbox work. They are still fragmented enough that the owner cannot yet trust the operator console as the single reliable surface for real collection operations.

This change defines and implements the broader RI/operator-console reliability milestone: every configured source must be bounded, durable, diagnosable, and owner-actionable without false success, silent loss, unbounded host load, or protocol-boundary confusion.

## What Changes

- Define the canonical owner-facing unit as a `connection` and make connection health a projection from durable run, coverage, work, attention, schedule, runtime, and read-model evidence.
- Define green/yellow/red semantics in terms of evidence, coverage, freshness policy, gaps, backlog, and required owner attention rather than last-run status alone.
- Require every long-running executor path to obey bounded-work guarantees: durability, leases or active-run fencing, resource budgets, cancellation, backoff, crash/restart reconstruction, and secret-safe diagnostics.
- Treat human-action needs as structured durable attention states with action targets, expiry, privacy rules, notification policy, and recovery semantics.
- Tie dashboard read models, local collector outbox health, scheduler/backoff state, remote browser surfaces, and connector detail gaps into one operator-console projection model.
- Define the milestone acceptance suite that proves the console remains honest after connector success, partial success, retry/backoff, crash/restart, local backlog, human action, stale projections, and host-load pressure.
- Keep these mechanics reference-implementation/operator behavior unless a separate protocol review promotes a subset into PDPP Core or the Collection Profile.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: Adds the reference operator-console reliability model, connection-health projection requirements, executor resource/durability guarantees, attention-state requirements, and milestone acceptance obligations.

## Impact

- Affects reference runtime/controller behavior, scheduler/backoff projection, local collector runner/outbox adoption, device-exporter diagnostics, remote-surface status, dashboard state rendering, PWA notification policy, connector coverage/gap reporting, and operator CLI/status surfaces.
- Does not change PDPP Core grants, resource-server disclosure enforcement, or public query semantics.
- Does not require every connector to be fully green before the milestone can close; it requires every connector state to be honest, bounded, diagnosable, and recoverable where possible.
