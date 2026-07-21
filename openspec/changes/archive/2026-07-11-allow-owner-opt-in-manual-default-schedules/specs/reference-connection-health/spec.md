## MODIFIED Requirements

### Requirement: Scheduler Policy SHALL Be Separate From Data Health

The reference implementation SHALL model scheduler backoff, paused schedules,
and next due time as policy conditions separate from freshness, coverage, and
last successful ingest.

A connector's **auto-schedulability** SHALL likewise be separate from data
health. When a connector's manifest refresh policy declares it manual, paused,
or background-unsafe (`recommended_mode: "manual"`,
`recommended_mode: "paused"`, or `background_safe: false` — the refresh-policy
values that make it ineligible for background schedule enrollment), the
projection SHALL NOT treat stale freshness as a data-health degradation when the
connection has no explicit owner-created schedule. A connector whose manifest
does not declare it manual, paused, or background-unsafe SHALL be treated as
schedulable, and stale freshness SHALL degrade it as before.

When a connector is recommended manual but also declares
`background_safe: true`, and the owner has explicitly enabled a schedule for the
connection, the projection SHALL treat that connection as scheduled rather than
manual-refresh-only. In that posture, stale freshness SHALL NOT project as
`stale_manual_refresh` or `owner_refresh_due`.

#### Scenario: Newer success clears stale backoff

- **WHEN** a connection has a scheduler backoff fact older than a successful run
  for the same connection generation
- **THEN** the stale backoff SHALL NOT cause the connection projection to be
  blocked or failing.

#### Scenario: Active backoff is visible

- **WHEN** retry policy is currently delaying the next run and no newer success
  supersedes it
- **THEN** the connection projection SHALL expose `cooling_off` or equivalent
  policy state with retry timing.

#### Scenario: Manual connector staleness is not a scheduler-driven failure

- **WHEN** a connection whose manifest refresh policy declares it manual,
  paused, or background-unsafe has aged past its freshness window and has no
  enabled owner-created schedule
- **THEN** the projection SHALL NOT report `degraded` solely because of that
  staleness
- **AND** an otherwise schedulable connector with the identical staleness SHALL
  still degrade.

#### Scenario: Explicitly scheduled manual-default connector is schedulable

- **WHEN** a connection whose manifest refresh policy declares `recommended_mode: "manual"`
  and `background_safe: true` has an enabled owner-created schedule
- **AND** its retained data has aged past the freshness window
- **THEN** the projection SHALL treat the connection as scheduled rather than
  manual-refresh-only
- **AND** the projection SHALL NOT report `owner_refresh_due`
- **AND** the schedule/freshness surface SHALL explain the stale state as the
  scheduler's responsibility rather than an owner-refresh advisory.
