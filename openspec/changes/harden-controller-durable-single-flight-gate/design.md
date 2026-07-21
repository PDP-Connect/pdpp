## Context

The live incident showed a durable overlap, not merely a late retry:

- run `run_1784154575706` remained alive and emitted progress
- a second scheduled run `run_1784157985739` started for the same connector
- `controller_active_runs` showed only the newcomer because the admission write
  used `INSERT ... ON CONFLICT ... DO UPDATE`

That means the active-run table is currently modeling a view, not a lock. The
in-memory `activeRuns` map only protects one process; it cannot defend against a
restart or a second admission path that reads the durable row after the map is
empty.

## Decision

Make admission fail closed at the durable layer and keep the reservation alive
only while the logical invocation itself is still live:

- a live row already present for a `connector_instance_id` is a conflict
- the incumbent row remains intact
- scheduled/manual/recovery conflict paths are reported as neutral skip/defer
  outcomes, not as run failures or health regressions
- a managed invocation may keep the reservation while it is still waiting for
  browser-surface readiness before `runNow()` resolves
- any `early_return` or returned queued/deferred/failed outcome clears the
  active-run row and nonce before returning; a separate browser-surface
  queue/projection may continue under its own lifecycle
- once the connector child is launched, the reservation stays held until the
  child becomes terminal
- stale orphaned rows may still be reclaimed during explicit boot/restart
  reconciliation, but only when they are provably stale and not part of a live
  admission race

The controller remains the source of truth for the active-run gate. The
scheduler and manual/recovery continuation paths must route through the same
preflight so they cannot diverge in policy.

## Parent/Child Lifecycle

The gate stays held until the logical connector process is terminal:

- admission writes the active row first
- the logical run remains active while the child is alive
- cleanup runs only after terminalization for the matching run id
- an old runner may clear its own row, but only when the run id still matches

If a child continues after the controller believes the run is terminal, that is
already a separate fencing problem. This change does not invent a new lifecycle;
it preserves the existing one and makes the durable gate impossible to overwrite
during it.

## Alternatives Considered

- Keep overwrite-on-conflict and rely on in-memory guards. Rejected: restart
  loses the only protection.
- Convert conflict into a run failure. Rejected: duplicate admission is a
  coordination outcome, not a connector defect.
- Broaden cleanup to delete by connector instance only. Rejected: that would let
  an old runner erase a newer row.
