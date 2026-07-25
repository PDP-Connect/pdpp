## Why

Successful local-device collection can drain accepted batches and persist current summary evidence while leaving `stream_latest_facts_json` empty. The terminal-fact fold only consumes attributable terminal spine events, and the local collector previously retained its successful DONE and coverage checkpoint on the device.

## What Changes

- Add a device-authenticated terminal-collection handoff after successful DONE, full drain, and coverage-checkpoint acknowledgement.
- Persist safe, connector-neutral per-stream facts on an attributable terminal spine event so the existing fold maintains `stream_latest_facts_json`.

## Impact

- Local collector client and runner.
- Reference device-exporter route and summary-evidence fold input.
