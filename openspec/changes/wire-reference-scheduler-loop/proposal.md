## Why

The reference exposes schedule CRUD and dashboard schedule state, and it ships an
active scheduler loop with retry, overlap, and needs-human behavior. Docker and
normal server startup only create the runtime controller, so persisted schedules
are currently displayed but not executed automatically.

## What Changes

- Wire the reference server to build and start a scheduler loop from persisted
  enabled schedules after AS and RS loopback URLs are known.
- Keep schedule persistence as the single source of truth for owner-configured
  intervals and enabled/paused state.
- Reuse the existing controller/runtime seams for connector path resolution,
  owner token issuance, active-run protection, connector state, needs-human
  status, and run history.
- Stop the scheduler during graceful shutdown before connector drain completes.
- Cover both in-process server startup and Docker/Compose startup with tests or
  a documented smoke harness.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Clarifies that persisted schedules in
  a long-lived reference server are active runtime instructions, not display-only
  rows, and defines the server/Docker scheduler lifecycle.

## Impact

- Reference server startup and shutdown lifecycle.
- Runtime controller/scheduler integration seams.
- Docker/Compose reference behavior when enabled schedules already exist.
- Tests for persisted schedule execution, paused schedule suppression, and
  shutdown behavior.
