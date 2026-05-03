## Why

Browser-bound, device-local, and filesystem-backed connectors should not depend on a host-browser bridge or container GUI plumbing. The reference needs a durable local collector execution lane that reuses the existing connector contracts and device-exporter security boundary without changing PDPP Core.

## What Changes

- Generalize the local device exporter into a local collector runner for connector execution that requires local capabilities.
- Derive runtime placement from existing connector runtime requirements and runtime capability advertisement rather than adding a broad `runtime_modes` taxonomy.
- Keep clean API/token connectors eligible for provider control-plane execution.
- Gate connector spawn on advertised runtime capabilities and fail unsupported placement before launching the connector.
- Remove remaining host-browser bridge strategy remnants; the bridge is dead, not deferred.
- Mark collection lifecycle and ingest choices as optimistic reference implementation behavior pending human-owner Collection Profile alignment.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`

## Impact

- `packages/polyfill-connectors/**` local device/exporter/runtime code.
- `packages/cli/**` pairing or collector commands if needed.
- `reference-implementation/server/**` device exporter, ingest, run diagnostics, and connector orchestration code.
- Docker/compose targets separating provider/control-plane and collector runtime needs.
- Connector/runtime docs and tests that currently imply host-browser bridge behavior.

