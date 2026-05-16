## Context

The reference controller already gates schedule mutation on connector refresh
policy via `getScheduleIneligibilityReason()` (see
`openspec/changes/gate-unsafe-connector-schedules/`), and the scheduler-doctor
already cross-references `/_ref/connectors` against `/_ref/schedules` and
emits a `NOSCHED` verdict for "registered, automatic, background-safe, but no
persisted row." Today the only way an eligible connector becomes scheduled in
Docker is a bespoke DB insert or a dashboard click. For proven connectors
whose deployment env declares them ready, that gap is honest but useless: the
operator already opted in via env, and the reference still does nothing.

## Decision

The reference is the schedule mutation authority, so it also owns the safe
default - "if you put the env in, schedule the connector at its
manifest-recommended interval, paused-`enabled=true` from the start, and let
the existing eligibility / readiness / next-due gates do the rest."

Eligibility for *auto-enrollment* is intentionally stricter than the existing
schedule eligibility gate:

- `capabilities.refresh_policy.recommended_mode === "automatic"`.
- `capabilities.refresh_policy.background_safe !== false`.
- `capabilities.public_listing.listed === true`.
- `capabilities.public_listing.status === "proven"`.
- `capabilities.auth.required` is declared, non-empty, and every named env
  variable is present in `process.env` with a non-empty value.

The first four facts already live in shipped manifests. The fifth is new.
Connector modules already declare `auth: { kind: "env", required: [...] }`
at runtime; this change lifts that declaration into the manifest JSON so
the controller can reason about it without importing connector code. The
shape mirrors the runtime config:

```json
"capabilities": {
  "auth": {
    "kind": "env",
    "required": ["NOTION_API_TOKEN"]
  }
}
```

Alias arrays (`[["GITHUB_PERSONAL_ACCESS_TOKEN", "GITHUB_TOKEN"]]`) are
permitted but not used by the proven connectors in this change.

The enrollment pass runs once on boot, after `reconcilePolyfillManifests`
and before the scheduler manager hydrates persisted schedules. It iterates
the registered connectors; for each connector that passes the five criteria
and has NO persisted schedule row, it inserts an enabled row with
`interval_seconds = capabilities.refresh_policy.recommended_interval_seconds`
(or a conservative default of 3600 seconds when the manifest omits it).
Jitter defaults to 0; the scheduler manager applies its own jitter to first
ticks.

Idempotency is the contract: enrollment never overwrites a persisted row,
never re-enables a row the operator paused, never updates the interval, and
never deletes rows. After-boot operator edits via `/_ref/connectors/:id/schedule`
keep being the authority.

Honesty after restart:
- An eligible connector with env present and no prior row is enrolled, runs,
  and surfaces as `FIRE`/`IDLE` in scheduler-doctor.
- An eligible connector with env *absent* is left unenrolled, surfaces as
  `NOSCHED` in scheduler-doctor (existing behavior), and the dashboard does
  not claim it is runnable.
- An ineligible (manual/paused/background-unsafe) connector is never
  enrolled, even if env happens to be present. `MANUAL` remains correct.
- A connector whose operator paused or deleted its row stays in that state,
  even when env is present. Operator intent wins.

Secret hygiene: only `process.env[name] !== undefined && process.env[name].trim() !== ""`
is checked. Secret values are never logged, never compared against fixtures,
and never surfaced in the schedule row or its API projection.

## Alternatives Considered

- **Dashboard one-click enrollment only**: rejected. Docker users without a
  browser session see `eligible_unscheduled=3` forever, and the operator
  intent ("I set the env") is being ignored.
- **Auto-enroll on first manifest registration regardless of env**: rejected.
  Creating an enabled row without credentials means the dashboard says "this
  is runnable" and the scheduler skips it as not-ready every interval. That
  is the exact dishonesty the existing gate-unsafe change avoided.
- **Pull `auth.required` from connector modules at runtime**: rejected. The
  reference server is not the polyfill-connector runner; it would need to
  import connector code or run them as a subprocess, both of which inflate
  the surface area for a one-shot boot decision. Lifting the declaration to
  manifest JSON is honest (manifests already drive other deployment facts
  like `external_tools` and `runtime_requirements.bindings`) and bounded.
- **Schedule with `enabled=false` initially**: rejected. That just moves the
  problem - operators would have to click resume after setting env, which
  defeats the whole "env is opt-in" point. Enabled-from-start is symmetric
  with the operator typing `enabled=true` in the API.

## Acceptance Checks

- A first-party shipped manifest with `recommended_mode=automatic`,
  `background_safe=true`, `public_listing.listed=true`,
  `public_listing.status=proven`, and `auth.required=[X]` is enrolled with
  an enabled schedule row at recommended interval when `process.env.X` is set
  on boot, with no operator action.
- The same manifest does NOT get a schedule row when `process.env.X` is
  unset, blank, or whitespace-only.
- A manifest with `recommended_mode=manual` (or `background_safe=false`, or
  `public_listing.status !== "proven"`) is NEVER auto-enrolled even when
  every declared env is set.
- An existing persisted row (paused, enabled, or with custom interval) is
  preserved verbatim across a boot pass; auto-enrollment is a no-op for it.
- `PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1` short-circuits the entire pass.
- `scheduler-doctor` continues to surface `NOSCHED` for env-missing eligible
  connectors and reports auto-enrolled rows as `FIRE`/`IDLE` after their
  first tick.
- `openspec validate auto-enroll-eligible-connector-schedules --strict` and
  `openspec validate --all --strict` both pass.
