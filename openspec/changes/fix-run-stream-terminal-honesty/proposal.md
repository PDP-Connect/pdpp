## Why

The run-stream companion rendered success copy when a run no longer had a pending browser-assistance request. A failed assisted run can therefore show "is back on it" even though the terminal run event is failed.

## What Changes

- Make the stream page distinguish completed, failed/cancelled/abandoned, and still-running states when no browser assistance is currently active.
- Keep success copy only for completed runs.
- Add a focused test for the terminal-state selector and stream-page wiring.

## Capabilities

Modified:

- `reference-run-assistance`

## Impact

- Prevents false-success copy after failed browser-session reconnect attempts.
- Applies to all assisted browser runs, not only ChatGPT.
