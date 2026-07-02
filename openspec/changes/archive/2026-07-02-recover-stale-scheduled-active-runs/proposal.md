## Why

Live scheduled runs can leave `controller_active_runs` rows behind after execution stops making progress. The owner console then keeps sources in long-lived `Checking` / `Degraded` states even though no useful collection is happening.

## What Changes

- Add a scheduler progress watchdog for each direct connector attempt.
- Thread a scheduler-owned cancellation signal into `runConnector`.
- Reset the watchdog on valid connector progress so long-running work can continue while it is advancing.
- Persist a terminal failed run record and clear the active-run row when the watchdog expires.
- Wire Slack's `slackdump` subprocess phase to emit bounded archive-growth progress instead of running as a silent black box.

## Capabilities

Modified:
- `reference-implementation-runtime`

## Impact

- A silent stalled scheduled run becomes a bounded terminal failure instead of an indefinite active row.
- A long scheduled run that continues publishing progress is not timed out solely because elapsed time is high.
- Existing successful runs, retries, overlap prevention, state commit rules, and controller-managed run cancellation remain unchanged.
