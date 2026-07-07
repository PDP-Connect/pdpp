## Why

Browser-backed runs can end before connector execution starts when the runtime cannot acquire a secure browser slot. The run is terminal, but it is not a connector failure and should not be presented as one.

## What Changes

- Distinguish browser-surface deferrals from connector failures on run detail and browser-stream surfaces.
- Keep deferrals terminal for polling and cancellation controls.
- Preserve true browser setup failures as failed runs.

## Capabilities

### Modified Capabilities

- `reference-run-assistance`: owner run surfaces distinguish browser-capacity deferrals from connector failures.

## Impact

- Affected code: Sync run detail status mapping and no-assistance browser stream terminal copy.
- No protocol change.
- No connector behavior change.
