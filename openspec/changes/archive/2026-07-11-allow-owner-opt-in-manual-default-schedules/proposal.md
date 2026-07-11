# Proposal: allow-owner-opt-in-manual-default-schedules

## Why

`recommended_mode: manual` is currently treated as both a conservative default
and a hard scheduling veto. That is too coarse for connectors that are safe to
run in the background when an owner explicitly opts in. The reference needs to
accept an owner-created per-connection schedule for those connectors without
turning them into boot-time auto-enrolled rows.

## What Changes

- Separate boot auto-enrollment from explicit owner schedule capability.
- Keep `recommended_mode: paused` and `background_safe: false` as hard
  prohibitions on background scheduling.
- Allow an explicit owner-created schedule for `recommended_mode: manual` when
  `background_safe: true`.
- Make the connection-health projection treat an explicitly scheduled
  manual-default/background-safe connection as scheduled, not
  `stale_manual_refresh`.
- Update Amazon's manifest to stay manual-by-default, declare
  `background_safe: true` and `assisted_after_owner_auth: true`, and keep it out
  of boot auto-enrollment.

## Capabilities

Modified:
- reference-implementation-architecture
- reference-connector-instances
- reference-connection-health

## Impact

- Owners can explicitly schedule a manual-default connector when the manifest
  says background execution is safe.
- Unscheduled manual-default connectors remain manual and are not auto-enrolled.
- Paused or background-unsafe connectors remain hard blocked from background
  scheduling.
