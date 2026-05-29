## Why

The static n.eko tranche proves managed browser-surface leasing for one configured surface, but it cannot run multiple browser-backed connectors with isolated profiles. The reference now needs dynamic n.eko surface allocation so browser-backed connectors can run remotely without sharing profiles, overcommitting host resources, or requiring manual stream switching.

## What Changes

- Add a controller-owned dynamic n.eko surface allocator behind the existing browser-surface lease boundary.
- Allocate one n.eko container per surface id, with a persistent profile volume or directory keyed by the lease profile key.
- Gate lease promotion on n.eko HTTP readiness, CDP readiness, and browser process liveness; stream descriptor authorization stays server-side and adapter stream readiness is verified at interaction time.
- Enforce the configured active-surface cap across static and dynamic surfaces.
- Preserve queued-run priority/FIFO semantics when capacity is full.
- Add idle TTL shutdown that stops unused dynamic containers while preserving profile state.
- Reconcile persisted leases, dynamic containers, and profile volumes after reference restart.
- Keep the first static Compose surface path available as a development/single-surface mode, but stop treating it as the multi-profile solution.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: extend managed n.eko browser-surface leasing from static single-surface semantics to dynamic per-profile surface allocation, readiness gating, idle cleanup, and restart reconciliation.

## Impact

- `reference-implementation/runtime/**` browser-surface manager, controller launch/promotion, persistence, reconciliation, and diagnostics.
- Docker/n.eko orchestration code and configuration for dynamic container creation, naming, networking, and profile volume mounts.
- Reference `_ref` run/timeline/status surfaces for dynamic allocation, starting, health failure, queued, and idle-stopped states.
- Polyfill browser launch env remains lease-scoped; connectors should not gain direct dynamic-container responsibilities.
- Operator documentation for capacity, profile isolation, resource cost, and recovery behavior.
