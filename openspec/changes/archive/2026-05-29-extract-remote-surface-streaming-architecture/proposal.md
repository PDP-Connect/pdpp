## Why

`@pdpp/remote-surface` now owns the pure browser-surface lease substrate, but the full remote-surface streaming architecture is still split across the reference server, dashboard viewer, connector handoff helpers, and dynamic n.eko allocation design.

The next implementation tranche needs an OSS-spinnable internal package boundary before code moves. Without that boundary, dynamic n.eko allocation risks absorbing streaming/session/client concerns that belong in a reusable remote-surface package.

## What Changes

- Define `@pdpp/remote-surface` as the owner of backend-neutral remote-surface protocol shapes, server/session broker interfaces, client viewer/input APIs, backend adapter contracts, telemetry schema, diagnostics, and allocator/session seams.
- Define an explicit package export map for `@pdpp/remote-surface`: core protocol, server broker, client viewer/controllers, backend adapters, diagnostics, leases, and test utilities.
- Keep PDPP reference ownership of run timelines, owner auth, `_ref` routes, connector handoff/registration, persistence adapters, and Docker/Compose/sidecar lifecycle.
- Extract streaming session broker and viewer orchestration in safe tranches rather than moving code blindly.
- Clarify that dynamic n.eko allocation consumes the package lease/session/allocator interfaces while Docker-backed allocator implementation remains reference-owned.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`

## Impact

- Affects `packages/remote-surface`, `reference-implementation/server/streaming`, dashboard stream viewer code, and connector streaming-target registration boundaries.
- Does not move implementation code in this planning tranche.
- Requires validation of this OpenSpec change before implementation starts.
- Blocks claiming OSS spinout readiness until package docs, import-boundary checks, protocol fixtures, and reference parity tests prove the boundary.
