## ADDED Requirements

### Requirement: The reference auto-enrolls eligible connectors when deployment credentials are present
The reference implementation SHALL, on server boot, enroll a default enabled
schedule for every first-party connector whose shipped manifest meets all of
the following facts AND whose declared environment variables are populated in
the running process: `recommended_mode=automatic`,
`background_safe=true` (or absent), `public_listing.listed=true`,
`public_listing.status=proven`, and `capabilities.auth.kind=env` with a
non-empty `capabilities.auth.required` list of environment variable names.

#### Scenario: Eligible connector with deployment env is enrolled on boot
- **WHEN** the reference server starts, manifest reconciliation has completed, and a registered first-party manifest satisfies the five-fact eligibility test
- **AND** every entry of `capabilities.auth.required` is satisfied: a string entry SHALL be satisfied when its named `process.env` value is non-empty, and an alias-array entry SHALL be satisfied when **any** of its listed env names is non-empty in `process.env` (matching the runtime first-set-wins resolution in `packages/polyfill-connectors/src/auth.ts`)
- **AND** no persisted schedule row exists for that connector
- **THEN** the reference SHALL insert a new schedule row with `enabled=true`, `interval_seconds=capabilities.refresh_policy.recommended_interval_seconds` (falling back to 3600 when the manifest omits an interval), and `jitter_seconds=0`
- **AND** the reference SHALL NOT inspect, copy, or log the env variable values

#### Scenario: Missing env keeps the connector honestly unscheduled
- **WHEN** a registered first-party manifest is otherwise auto-enroll eligible but at least one entry of `capabilities.auth.required` is unsatisfied (the named `process.env` value is absent or empty for a string entry, or every alias in an alias-array entry is absent or empty in `process.env`)
- **THEN** the reference SHALL NOT create a schedule row for that connector
- **AND** the connector SHALL continue to surface as `NOSCHED` in `scheduler-doctor` and the dashboard SHALL NOT claim the connector is currently runnable

#### Scenario: Auto-enrollment never overrides operator intent
- **WHEN** the reference boots and a persisted schedule row already exists for a connector that would otherwise be auto-enroll eligible
- **THEN** the reference SHALL NOT alter `enabled`, `interval_seconds`, `jitter_seconds`, or any other field of that row
- **AND** the reference SHALL NOT re-enable a row the operator had paused

#### Scenario: Manual, paused, background-unsafe, or unproven connectors are never auto-enrolled
- **WHEN** a registered first-party manifest declares `recommended_mode` of `manual` or `paused`, OR `background_safe: false`, OR `public_listing.status` other than `proven`, OR omits `capabilities.auth.required`
- **THEN** the reference SHALL NOT auto-enroll a schedule for that connector even when every env name happens to be present
- **AND** existing schedule mutation gates (refusing to create or resume an enabled schedule for an ineligible connector) SHALL continue to apply

#### Scenario: Operators can opt out of auto-enrollment
- **WHEN** the reference boots with `PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1` in its environment or with the equivalent constructor option set to `false`
- **THEN** the reference SHALL skip the auto-enrollment pass entirely
- **AND** schedule mutation via the regular schedule API SHALL still work as before

## MODIFIED Requirements

### Requirement: The Collection boundary stays explicit
The reference implementation SHALL keep the Collection boundary explicit across core semantics, Collection Profile semantics, and runtime-only behavior.

#### Scenario: Orchestrator behavior is classified
- **WHEN** behavior concerns scheduling, retry, credential storage, webhook adaptation, batch import, or multi-connector coordination
- **THEN** it SHALL be treated as runtime/orchestrator behavior unless and until a concrete interoperability need justifies a new profile

#### Scenario: Deployment env presence is a runtime gate, not a manifest claim
- **WHEN** the reference auto-enrolls a connector schedule because deployment env variables named by `capabilities.auth.required` are populated
- **THEN** the resulting schedule row SHALL be a runtime/orchestrator artifact and SHALL NOT be promoted into the manifest itself
- **AND** the manifest's `capabilities.auth.required` SHALL remain a static declaration of which env names the connector needs, not a record of which env names are currently set
