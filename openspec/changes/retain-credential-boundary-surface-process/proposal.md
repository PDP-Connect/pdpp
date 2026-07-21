## Why

The archived `harden-chatgpt-session-reuse` change proved that some browser-backed
sources hold their authenticated provider API session in **process-scoped browser
state** that a persistent profile directory and `RestoreOnStartup` do not restore.
It preserved the run page within a live surface, but recorded a residual risk:
ChatGPT API auth is lost whenever the surface's container process is stopped or
restarted.

Steady-state operation now hits that residual risk on ordinary hourly schedules.
The managed n.eko surface layer stops idle surfaces under two paths — idle TTL
(`cleanupIdleSurfaces`) and capacity pressure (`planCapacityPressureReclaim`) —
and then mints a **new random `surface_id`** on the next acquire. The allocator
matches containers by `surface_id`, so the stopped container is never re-matched;
a brand-new container is created, and the ChatGPT connection's process-scoped API
session is gone even though the profile bind mount survives. Both ChatGPT
connections therefore project `session_required` between two otherwise-successful
runs, with no owner action taken in between.

The surface substrate cannot express "this surface is a credential boundary; do
not stop its process under routine idle/capacity." That retention concept is a
distinct boundary from the connection-repair action surface owned by
`complete-connection-repair-action-surfaces`; this change adds it.

## What Changes

- Add a generic `retained` property to a managed browser surface in the
  remote-surface lease layer, exempting it from routine idle-TTL cleanup and
  capacity-pressure reclaim. The lease layer stays connector-neutral: it receives
  a `retainProcess` boolean from its caller and never inspects connector identity
  or manifests.
- Declare page preservation and surface-process retention **once** per connector in
  a single side-effect-free connector-runtime policy module
  (`packages/polyfill-connectors/src/browser-surface-policy.ts`). ChatGPT's
  `runConnector` browser config and the reference lease caller consume the same
  record, so there is no duplicated "set the flags here, register retention there"
  semantic. No manifest schema field, no browser-auth taxonomy, no connector-id
  branching inside remote-surface.
- Reconstruct retention deterministically at boot from the surface's connector
  before the manager can run any idle-cleanup or capacity-reclaim, because
  `retained` is not a persisted column. Retention is a pure function of the
  connector, so boot re-derivation is exact and fail-closed (an unregistered
  connector stays non-retained).
- Keep ordinary (non-retained) surfaces fully reclaimable: capacity pressure and
  idle TTL still stop the oldest idle ordinary surface first; ordinary leases
  still queue and reclaim without deadlock.
- Preserve the surface-wedge fix: a retained surface that a readiness/attach probe
  proves unusable (`invalidateSurface`) is still recycled. Retention exempts only
  a *healthy* surface; it never keeps a poisoned renderer alive.
- Reconstruct retained surfaces across ordinary reference restart without
  intentionally stopping their containers. A genuinely lost container process
  (host reboot, image change forcing recreate) becomes non-green
  continuity-indeterminate evidence, not an immediate owner repair. The
  reference records it through the shared two-phase replacement receipt and its
  exact closed cause set; only a typed verified provider invalidation proof may
  create the existing repair action. Portable authenticated-session continuity
  remains an explicit OPEN / UNSATISFIED handoff.

## Capabilities

- Modified: `polyfill-runtime`

## Impact

- Affects the managed n.eko surface-lease lifecycle in
  `packages/remote-surface/src/leases/surface-lease-manager.ts` (generic
  `retained` behavior) and its callers in
  `reference-implementation/runtime/browser-surface/run-coordinator.ts` plus the
  boot re-derivation in `reference-implementation/server/index.js`.
- Retention/preservation policy is single-sourced in
  `packages/polyfill-connectors/src/browser-surface-policy.ts`, consumed by both the
  ChatGPT connector entry and a thin reference adapter
  (`reference-implementation/runtime/browser-surface/retained-surface-connectors.ts`);
  no new manifest field, no second credential/session-token store, no
  ChatGPT-specific allocator branch.
- Backwards compatible: a surface for a non-retaining connector behaves exactly as
  today.
- `PDPP_NEKO_SURFACE_CAP` stays 3 — the explicit operating invariant (two retained
  ChatGPT surfaces + one fair transient slot). A fair-slot invariant is enforced
  fail-closed at config/boot so retained surfaces can never consume all capacity.
- This revision does not modify the standalone remote-surface repository/package
  or its public API; the RI joins replacement evidence through its own metadata and
  projection adapter.
