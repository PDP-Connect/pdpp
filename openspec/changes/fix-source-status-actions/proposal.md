## Why

The Sources view can mislead an owner during recovery: row-local state can survive source switches, run-start toasts do not link to the run, owner-runnable verdict actions can be hidden from the list, and a recent successful collection with known terminal coverage gaps can read as a total collection failure.

## What Changes

- Preserve the server-owned required-action label on the Sources run control.
- Show owner-runnable verdict cues in the source list, including attention actions.
- Link run-start and already-running toasts to the concrete run detail.
- Reset source-detail local state when the selected source changes.
- Render successful-but-terminal coverage as degraded coverage review instead of a full code-fix failure.

## Capabilities

Modified:
- `reference-connection-health`

## Impact

- Reference rendered-verdict projection.
- Owner-console Sources view and view model.
- Focused unit and structural tests.
- No protocol-core change and no live data mutation in this tranche.
