# Design: allow-owner-opt-in-manual-default-schedules

## Context

The current policy model conflates two different facts:

1. the connector's conservative default recommendation; and
2. whether the connector may be run in the background once an owner has
   explicitly opted in.

That works for auto-enrollment, but it is too strict for a connector that should
stay manual-by-default while still accepting a deliberately enabled schedule.
Amazon is the immediate example: it should not auto-enroll on boot, but an owner
who has configured the connection should be able to schedule it explicitly when
the manifest says the connector is background-safe.

## Decision

The change keeps the existing boot auto-enrollment contract intact:

- only automatic, proven, env-wired connectors auto-enroll on boot;
- manual/default connectors do not auto-enroll;
- `paused` and `background_safe: false` remain hard prohibitions.

The new behavior applies only to explicit owner action:

- a manual-default connector with `background_safe: true` may accept an enabled
  per-connection schedule;
- once enabled, the scheduler treats that connection as scheduled rather than
  as a manual-refresh-only advisory;
- the health projection should use the enabled schedule evidence, not just the
  conservative manifest recommendation, when deciding whether stale freshness is
  owner-refresh-due.

## Alternatives Considered

1. Add a new manifest field for "owner opt-in background scheduling."
   Rejected. `background_safe` already expresses the safety boundary; the missing
   seam is the distinction between auto-enrollment and explicit owner intent.
2. Treat every `recommended_mode: manual` connector as schedulable.
   Rejected. That would weaken the boot-time honesty guarantee and blur the
   difference between default recommendation and capability.
3. Leave the policy alone and special-case Amazon.
   Rejected. The invariant is broader than one connector, and the code already
   has a shared policy seam.

## Acceptance Checks

- A manual-default/background-safe connector can be explicitly scheduled.
- The same connector is still not auto-enrolled on boot.
- Paused and background-unsafe connectors still reject background scheduling.
- A scheduled manual-default/background-safe connection projects as scheduled
  rather than `stale_manual_refresh`.
- Amazon remains manual-by-default, does not auto-enroll, and stays
  `needs_human_auth` with `assisted_after_owner_auth: true`.
