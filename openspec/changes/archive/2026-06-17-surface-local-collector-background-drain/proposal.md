## Why

The live peregrine Claude Code recovery proved that the local-collector path can
repair the owner-actionable stall, but the post-repair state still leaves too
much inference to the owner. The source moved from attention to calm/checking
while 1,348 queued uploads remained on the device. The data is present in
`local_device_progress`, but the console only exposes it as low-level source
diagnostics.

## What Changes

- Add a reference-console requirement for self-handled local-device drains:
  owner inspection surfaces render a calm, visible background-upload summary
  when a trusted local-device source reports pending outbox work and no
  owner-actionable recovery remains.
- Show the queue scale, host label, last upload/heartbeat, and explicit
  "nothing to do here" copy in the connection diagnostics layer.
- Keep stalled/dead-letter remediation separate. Background drain never renders
  recovery commands and never raises attention by itself.

## Capabilities

Modified:
- `reference-connection-health`

Added:
- None.

Removed:
- None.

## Impact

- No PDPP Core or Collection Profile change.
- No new server contract; this consumes existing `local_device_progress` and
  source-instance diagnostics.
- Console-only presentation change with tests that prevent the self-handled drain
  state from being confused with stalled recovery.
