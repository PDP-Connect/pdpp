## Why

The controller/scheduler admission path must behave like a durable gate, not a
last-writer-wins projection. A second admission for the same
`connector_instance_id` must fail closed and preserve the incumbent row. A
conflict is a neutral coordination outcome, not a run failure.

The lifecycle split is intentional:

- an admission stays reserved only while the logical invocation itself is
  still live, for example while a managed run is waiting for browser-surface
  readiness before `runNow()` resolves
- any `early_return` or returned queued/deferred/failed outcome clears the
  active-run row and nonce; a separate browser-surface queue may persist under
  its own lifecycle
- terminal connector-child execution keeps the reservation until the child is
  terminal
- a durable conflict must not start browser work at all

## What Changes

- Treat `controller_active_runs` as a durable admission gate.
- Reject duplicate live admission for one `connector_instance_id` without
  replacing the incumbent row.
- Apply the same gate to scheduled runs, manual run-now, and
  recovery-continuation admission.
- Preserve run-id-scoped cleanup so an old runner cannot delete a newer row.
- Preserve boot/restart reconciliation for genuinely stale orphaned rows only.
- Tighten the connector-state/scheduler conformance harness so the durable
  store contract fails when a second insert wins.

## Impact

- Reference runtime controller and scheduler only.
- No cadence policy changes.
- No connector-specific logic changes.
- No change to the public PDPP protocol surface.
