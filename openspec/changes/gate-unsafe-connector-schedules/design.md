## Context

`capabilities.refresh_policy` already classifies first-party connector posture.
Amazon declares `recommended_mode: manual`, `interaction_posture:
otp_likely`, and `background_safe: false`, but the controller persisted
enabled schedules without checking that policy. The dashboard warned about
friction, yet the scheduler manager only filtered by persisted `enabled`.

## Decision

The reference controller is the schedule mutation authority, so it rejects
enabled schedules when a resolved manifest says the connector is not suitable
for automatic background refresh. The scheduler manager also checks the same
policy before constructing runnable scheduled connectors, which protects
operators with stale schedule rows created before this gate.

Eligibility is intentionally narrow and easy to audit:

- `recommended_mode: "manual"` or `"paused"` is not eligible for enabled
  schedules.
- `background_safe: false` is not eligible for enabled schedules.
- Missing refresh policy remains allowed for compatibility with existing tests
  and non-first-party manifests.
- `interaction_posture: "credentials"` alone is not blocked because Gmail,
  Slack, and Spotify currently declare automatic, background-safe refresh with
  credential posture.

Disabled schedule rows may still be stored for operator intent, but they must
not be resumed until the manifest posture becomes eligible.

## Alternatives

- Dashboard-only warning: rejected because the runtime would still auto-run a
  manually unsafe connector through API calls or stale rows.
- Delete unsafe schedules automatically: rejected because deleting operator
  configuration is more destructive than refusing to run it.
- Block every non-`none` interaction posture: rejected because existing
  automatic/background-safe API connectors use `credentials` posture.

## Acceptance Checks

- Amazon and other `background_safe: false` or manual-policy connectors cannot
  create or resume enabled schedules.
- Existing enabled unsafe schedule rows are skipped by scheduler refresh.
- Automatic/background-safe connectors remain schedulable.
