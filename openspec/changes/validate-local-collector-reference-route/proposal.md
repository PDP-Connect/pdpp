## Why

Local collectors can be moved to a different host or network while retaining a stale `PDPP_REFERENCE_BASE_URL`. Today the runner can discover that misroute only after it starts draining durable local work, turning a simple route/configuration problem into retry or dead-letter noise.

## What Changes

- Treat the configured reference route as a startup precondition for local collector runs.
- Fail a run before lease recovery, drain, or source scanning when the configured reference route rejects the device heartbeat.
- Extend local `doctor` output with a reference-route check that diagnoses unreachable/wrong reference URLs without reading record payloads or exposing credentials.
- Preserve the existing durable outbox recovery behavior for server failures that happen after startup.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `local-collector-durable-work`: local collector startup and doctor diagnostics gain a reference-route precondition/check.

## Impact

- Affected packages: `packages/polyfill-connectors`, `packages/local-collector`.
- No protocol change, database migration, or new external dependency.
- Operators get a direct route/configuration diagnostic instead of manual outbox spelunking.
