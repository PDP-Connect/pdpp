## Why

A presentation viewport can reconfigure a leased n.eko screen, while the
connector remains ready to resume. The current best-effort teardown can let
automation continue before the original geometry is restored, and it leaves a
crash-recovered surface ambiguous.

## What Changes

- Capture the current n.eko screen configuration once, before the first
  presentation-driven screen mutation, and persist the outstanding restore
  obligation.
- Serialize presentation screen apply, rotation, and restoration under one
  lease-scoped epoch; only the controlling stream attachment may request a
  screen resize.
- Retain presentation terminalization identity independently of the expiring
  bearer session and route bearer expiry or supersession through the same
  restore-or-retire barrier.
- Make restoration a terminal interaction barrier. Connector work resumes only
  after restore succeeds; a failed restore recycles a dynamic surface or
  terminals the affected run safely.
- Reconcile captured-but-unrestored screen state during startup before a
  managed surface is reused.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: n.eko streaming geometry and
  interaction-terminal lifecycle gain a presentation-scoped restore barrier.

## Impact

- `reference-implementation/server/streaming/neko-adapter.js`
- `reference-implementation/server/streaming/routes.js`
- `reference-implementation/server/index.js`
- browser-surface persistence/reconciliation and streaming controller tests
