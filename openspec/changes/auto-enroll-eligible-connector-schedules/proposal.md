## Why

Proven, background-safe first-party connectors (Notion, Oura, Strava, etc.)
require a persisted schedule row before the scheduler loop touches them. The
reference controller already registers their manifests on boot and rejects
schedules for ineligible connectors, but it does not enroll an eligible
connector even when the deployment has the credentials it needs. The result
in Docker today is `scheduler-doctor` reporting `eligible_unscheduled=3` for
Notion/Oura/Strava: registered, listed, proven, env-wired - and silently
unscheduled.

## What Changes

- Declare each connector's required environment variable names in its shipped
  manifest under `capabilities.auth` so the reference can reason about
  deployment readiness without importing connector code.
- On reference-server boot, after manifest reconciliation, auto-enroll any
  first-party manifest whose refresh policy is automatic, background-safe,
  publicly listed with `status: proven`, AND whose declared `auth.required`
  env names are all populated in `process.env`. Enrollment never touches an
  existing schedule row, never inspects secret values, and never enrolls a
  connector whose manifest is manual, paused, background-unsafe, or unproven.
- Add an opt-out (`PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1`) parallel to the
  existing `PDPP_SKIP_MANIFEST_RECONCILE` knob.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Affects reference-server boot: a new idempotent enrollment pass runs after
  manifest reconciliation and before scheduler-manager wiring.
- Affects the shipped first-party manifests of Notion, Oura, and Strava: each
  gains a `capabilities.auth.required` declaration that mirrors the auth
  configuration in the corresponding connector module.
- Does not change the schedule API, the scheduler loop, ineligibility gating,
  manual `run now`, or persisted operator intent (a paused row stays paused).
