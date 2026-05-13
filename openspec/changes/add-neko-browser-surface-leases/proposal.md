## Why

Dedicated n.eko browser surfaces with isolated profiles are the right direction for user-present, stealth-sensitive browser connectors, but each active surface costs real memory/CPU and cannot be allowed to grow unbounded. The reference needs a pre-launch lease and queue model so connector runs that require n.eko wait clearly instead of starting invisibly, overcommitting resources, or falling back to a weaker browser mode.

## What Changes

- Add a reference runtime browser-surface lease manager for n.eko-backed browser runs.
- Enforce a hard cap on active n.eko surfaces.
- Queue runs that require a surface before connector launch when capacity is unavailable.
- Thread controller-owned lease metadata and remote CDP URLs into connector process env.
- Preserve isolated profile keys per connector/account while allowing idle surfaces to be released by policy.
- Surface queued/deferred lease states as reference-only operator status rather than connector failures.
- Define the first-tranche static n.eko policy: one configured surface, one compatible profile key, and honest queue/defer semantics rather than implied multi-surface support.
- Make managed lease env fail-closed so required n.eko runs cannot be satisfied by legacy per-profile remote-CDP overrides.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add reference-only browser-surface lease, queue, and restart-reconciliation requirements for n.eko-backed browser connector runs.

## Impact

- `reference-implementation/runtime/**` controller, scheduler, active-run, and connector-spawn paths.
- `reference-implementation/server/**` reference-only connector run/status surfaces.
- `packages/polyfill-connectors/src/browser-launch.ts` and connector runtime env resolution.
- Docker n.eko overlay configuration for static single-surface managed mode, plus follow-up notes for multi-surface allocation and profile volumes.
- Dashboard/operator copy for queued or deferred browser-surface runs.
