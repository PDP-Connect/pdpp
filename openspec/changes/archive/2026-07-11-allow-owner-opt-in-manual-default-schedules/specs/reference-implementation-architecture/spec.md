## MODIFIED Requirements

### Requirement: Needs-human-auth manifests SHALL NOT auto-schedule

A connector manifest whose `capabilities.public_listing.status` is `"needs_human_auth"` SHALL NOT declare `capabilities.refresh_policy.background_safe: true`
or `capabilities.refresh_policy.recommended_mode: "automatic"` unless the
manifest also declares `capabilities.refresh_policy.assisted_after_owner_auth: true`.
The assisted-after-owner-auth declaration means the connector still needs owner
auth bootstrap or repair, but the reference scheduler may start explicitly
configured runs after that auth state exists. This exception SHALL NOT make the
connector eligible for boot-time auto-enrollment.

#### Scenario: Needs-human-auth manifest with background-safe refresh policy but no assisted auth posture

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **AND** it does not declare
  `capabilities.refresh_policy.assisted_after_owner_auth: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Needs-human-auth manifest with automatic recommended mode but no assisted auth posture

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **AND** it does not declare
  `capabilities.refresh_policy.assisted_after_owner_auth: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Needs-human-auth manifest with assisted-after-owner-auth scheduling

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **AND** that same manifest declares
  `capabilities.refresh_policy.assisted_after_owner_auth: true`
- **THEN** the manifest set's honesty test SHALL pass for this posture
- **AND** explicit owner schedule creation MAY enable a schedule for a
  configured connection, subject to the normal schedule interval and runtime
  readiness gates.

#### Scenario: Manual-default background-safe connectors can be explicitly scheduled

- **WHEN** a registered first-party manifest declares
  `recommended_mode: "manual"` and `background_safe: true`
- **AND** the owner explicitly enables a per-connection schedule
- **THEN** the reference SHALL allow the schedule mutation to succeed
- **AND** the connector SHALL NOT auto-enroll on boot merely because the owner
  later opted in explicitly
- **AND** the scheduled run SHALL use the shared scheduler/run policy rather than
  being treated as a manual-refresh-only advisory.

#### Scenario: Explicitly scheduled manual-default connectors remain owner-opt-in only

- **WHEN** a registered first-party manifest declares `recommended_mode: "manual"`
- **AND** the connection has no enabled owner-created schedule
- **THEN** the reference SHALL NOT auto-enroll a schedule for that connector
- **AND** the connection SHALL remain manual until the owner explicitly enables
  a schedule.

#### Scenario: Paused and background-unsafe connectors remain hard-blocked

- **WHEN** a registered first-party manifest declares
  `recommended_mode: "paused"` OR `background_safe: false`
- **THEN** the reference SHALL reject enabled schedule creation or resume
- **AND** the connector SHALL remain ineligible for background execution.

#### Scenario: Assisted scheduled connector is treated as schedulable for freshness health

- **WHEN** a connector with
  `capabilities.refresh_policy.assisted_after_owner_auth: true` has an enabled
  schedule
- **AND** the connection's retained data is stale under
  `capabilities.refresh_policy.maximum_staleness_seconds`
- **THEN** the reference health projection SHALL treat that stale freshness as
  schedulable stale data rather than as manual-refresh-only advisory staleness
- **AND** any auth-expired or manual-action-needed condition SHALL be surfaced
  through the existing owner-attention gates before a scheduled run starts.

### Requirement: The reference auto-enrolls eligible connectors when deployment credentials are present

The reference implementation SHALL, on server boot, enroll a default enabled
schedule for every first-party connector whose shipped manifest meets all of the
following facts AND whose declared environment variables are populated in the
running process: `recommended_mode=automatic`, `background_safe=true` (or
absent), `public_listing.listed=true`, `public_listing.status=proven`, and
`capabilities.auth.kind=env` with a non-empty `capabilities.auth.required` list
of environment variable names.

#### Scenario: Eligible connector with deployment env is enrolled on boot

- **WHEN** the reference server starts, manifest reconciliation has completed,
  and a registered first-party manifest satisfies the five-fact eligibility
  test
- **AND** every entry of `capabilities.auth.required` is satisfied: a string
  entry SHALL be satisfied when its named `process.env` value is non-empty, and
  an alias-array entry SHALL be satisfied when **any** of its listed env names
  is non-empty in `process.env` (matching the runtime first-set-wins resolution
  in `packages/polyfill-connectors/src/auth.ts`)
- **AND** no persisted schedule row exists for that connector
- **THEN** the reference SHALL insert a new schedule row with `enabled=true`,
  `interval_seconds=capabilities.refresh_policy.recommended_interval_seconds`
  (falling back to 3600 when the manifest omits an interval), and
  `jitter_seconds=0`
- **AND** the reference SHALL NOT inspect, copy, or log the env variable values

#### Scenario: Missing env keeps the connector honestly unscheduled

- **WHEN** a registered first-party manifest is otherwise auto-enroll eligible
  but at least one entry of `capabilities.auth.required` is unsatisfied (the
  named `process.env` value is absent or empty for a string entry, or every alias
  in an alias-array entry is absent or empty in `process.env`)
- **THEN** the reference SHALL NOT create a schedule row for that connector
- **AND** the connector SHALL continue to surface as `NOSCHED` in
  `scheduler-doctor` and the dashboard SHALL NOT claim the connector is
  currently runnable

#### Scenario: Auto-enrollment never overrides operator intent

- **WHEN** the reference boots and a persisted schedule row already exists for a
  connector that would otherwise be auto-enroll eligible
- **THEN** the reference SHALL NOT alter `enabled`, `interval_seconds`,
  `jitter_seconds`, or any other field of that row
- **AND** the reference SHALL NOT re-enable a row the operator had paused

#### Scenario: Manual, paused, background-unsafe, unproven, or owner-auth assisted connectors are never auto-enrolled

- **WHEN** a registered first-party manifest declares `recommended_mode` of
  `manual` or `paused`, OR `background_safe: false`, OR `public_listing.status`
  other than `proven`, OR `capabilities.refresh_policy.assisted_after_owner_auth: true`,
  OR omits `capabilities.auth.required`
- **THEN** the reference SHALL NOT auto-enroll a schedule for that connector
  even when every env name happens to be present
- **AND** existing schedule mutation gates SHALL continue to apply for ineligible
  connectors
- **AND** a `needs_human_auth` connector with `assisted_after_owner_auth: true`
  MAY still be scheduled through an explicit owner schedule mutation after the
  owner configures the connection.

#### Scenario: Operators can opt out of auto-enrollment

- **WHEN** the reference boots with `PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1` in
  its environment or with the equivalent constructor option set to `false`
- **THEN** the reference SHALL skip the auto-enrollment pass entirely
- **AND** schedule mutation via the regular schedule API SHALL still work as
  before
