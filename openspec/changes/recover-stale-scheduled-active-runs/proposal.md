## Why

Live scheduled runs can leave `controller_active_runs` rows behind after execution stops making progress. The owner console then keeps sources in long-lived `Checking` / `Degraded` states even though no useful collection is happening.

## What Changes

- Add a scheduler wall-clock budget for each connector attempt.
- Thread a scheduler-owned cancellation signal into `runConnector`.
- Persist a terminal failed run record and clear the active-run row when the budget expires.

## Capabilities

Modified:
- `reference-implementation-runtime`

## Impact

- A stalled scheduled run becomes a bounded terminal failure instead of an indefinite active row.
- Existing successful runs, retries, overlap prevention, state commit rules, and controller-managed run cancellation remain unchanged.
