## Why

Live scheduled connector children can remain active with only `run.started`
recorded when the connector runtime waits forever for a missing `START` line.
In the current container, a connector entrypoint with closed stdin also burns CPU
instead of failing closed, which blocks run cleanup and source health.

## What Changes

- Treat stdin `end`, `close`, and read errors before the first `START` line as a
  terminal connector-runtime failure.
- Emit a bounded failed `DONE` envelope through the existing failure path so the
  parent runtime can terminal the run and clear active-run liveness.
- Add a subprocess regression that proves a connector entrypoint with no `START`
  exits quickly instead of hanging or spinning.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `polyfill-runtime`: Connector runtime startup SHALL fail closed when `START`
  is missing because stdin closes or errors before the first line.

## Impact

- Affected code: `packages/polyfill-connectors/src/connector-runtime.ts`.
- Affected tests: polyfill connector runtime/subprocess tests.
- No protocol wire-format change.
