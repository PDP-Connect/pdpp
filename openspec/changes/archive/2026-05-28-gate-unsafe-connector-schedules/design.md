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

The scheduler itself also performs an automatic-run readiness check immediately
before invoking a connector. This check is deployment-local, not a manifest
posture judgment: it catches prerequisites that can be absent in Docker or other
runtime environments even when the connector is otherwise automatic and
background-safe. Not-ready automatic runs are recorded as skipped history with a
clear reason, and repeated ticks with the same reason stay quiet to avoid
failure spam. Manual `run now` still bypasses this scheduler gate so the owner
gets the connector's honest, actionable failure or interaction path.

Eligibility is intentionally narrow and easy to audit:

- `recommended_mode: "manual"` or `"paused"` is not eligible for enabled
  schedules.
- `background_safe: false` is not eligible for enabled schedules.
- Missing refresh policy remains allowed for compatibility with existing tests
  and non-first-party manifests.
- `interaction_posture: "credentials"` alone is not blocked because Gmail,
  Slack, and Spotify currently declare automatic, background-safe refresh with
  credential posture.

Readiness is intentionally runtime-local and narrow:

- Missing manifest-declared `external_tools[].detect` commands make automatic
  runs not-ready. Slack's `SLACKDUMP_BIN` deployment override is honored before
  falling back to the manifest `slackdump --help` command so mounted Docker
  binaries are not skipped incorrectly.
- Browser-required connectors are not-ready unless the deployment explicitly
  provides a managed browser surface remote CDP endpoint or opts into unmanaged
  local scheduled browser runs.
- First-party local CLI connectors with filesystem requirements are not-ready
  when their required source paths are absent or unreadable.
- A not-ready reason is a skip, not a failure, because no connector process was
  started.

Disabled schedule rows may still be stored for operator intent, but they must
not be resumed until the manifest posture becomes eligible.

For *enabled* legacy rows whose connector manifest has since shifted to a
manual / paused / background-unsafe policy, the persisted row remains: deleting
operator configuration is more destructive than refusing to run it. The
scheduler manager already filters such rows from the runnable set with a
log warning. To keep operator state honest at the API/dashboard layer too,
the schedule listing API surfaces a non-null `ineligibility_reason` carrying
the same string `getScheduleIneligibilityReason()` produces. The dashboard
renders this as a "not runnable" badge plus the reason text, so an operator
who sees `enabled: true` for Reddit (or any newly-unsafe connector) is told
explicitly that the row is operator intent rather than a running schedule.

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
- Schedule list/get API surfaces a non-null `ineligibility_reason` for those
  same rows, and `null` for rows that are either disabled or whose connector
  policy permits automatic refresh.
- Automatic runs with missing runtime prerequisites are skipped with a not-ready
  reason in scheduler history.
- Manual runs still fail closed through normal connector/runtime errors.
- Automatic/background-safe connectors remain schedulable.
