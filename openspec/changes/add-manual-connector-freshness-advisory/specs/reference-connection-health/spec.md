## MODIFIED Requirements

### Requirement: Scheduler Policy SHALL Be Separate From Data Health

The reference implementation SHALL model scheduler backoff, paused schedules, and next due time as policy conditions separate from freshness, coverage, and last successful ingest.

A connector's **auto-schedulability** SHALL likewise be separate from data health. When a connector's manifest refresh policy declares it manual, paused, or background-unsafe (`recommended_mode: "manual"`, `recommended_mode: "paused"`, or `background_safe: false` — the refresh-policy values that make it ineligible for background schedule enrollment), the projection SHALL NOT treat stale freshness as a data-health degradation, because such a connector structurally cannot auto-refresh and only an owner-initiated run advances its data. A connector whose manifest does not declare it manual, paused, or background-unsafe SHALL be treated as schedulable, and stale freshness SHALL degrade it as before.

#### Scenario: Newer success clears stale backoff

- **WHEN** a connection has a scheduler backoff fact older than a successful run for the same connection generation
- **THEN** the stale backoff SHALL NOT cause the connection projection to be blocked or failing.

#### Scenario: Active backoff is visible

- **WHEN** retry policy is currently delaying the next run and no newer success supersedes it
- **THEN** the connection projection SHALL expose `cooling_off` or equivalent policy state with retry timing.

#### Scenario: Manual connector staleness is not a scheduler-driven failure

- **WHEN** a connection whose manifest refresh policy declares it manual, paused, or background-unsafe has aged past its freshness window
- **THEN** the projection SHALL NOT report `degraded` solely because of that staleness
- **AND** an otherwise schedulable connector with the identical staleness SHALL still degrade.

## ADDED Requirements

### Requirement: Manual / paused / background-unsafe connector stale freshness SHALL surface as an owner-action advisory, not a degradation

When a connection is manual-refresh-only — its manifest refresh policy declares `background_safe: false`, `recommended_mode: "manual"`, OR `recommended_mode: "paused"` — and its only non-green signal is that retained data has aged past the freshness window, the connection-health projection SHALL surface that staleness as an owner-action / manual-refresh advisory rather than a `degraded` headline. The advisory SHALL be an `idle` headline with reason code `stale_manual_refresh`, the `stale` freshness axis and badge SHALL remain set, and the `Fresh` condition SHALL be reported `false` at `info` severity (below the degrading threshold) with reason `stale_manual_refresh` and a manual-refresh remediation targeting a connector run.

The advisory SHALL fire only when the connection is otherwise green: the latest collection SHALL be a succeeded run (or an equivalent local-device collection verdict) and source coverage SHALL be complete. The projection SHALL continue to report `degraded` or a higher-precedence state for a manual-refresh-only connection on every real failure — incomplete coverage, terminal or retryable coverage gaps, a stalled outbox, a failed last run, credential rejection, active backoff, or open required attention. A connection that is not manual-refresh-only SHALL degrade on stale freshness exactly as before, and a manual-refresh-only connection that has never produced a succeeded collection SHALL remain the never-run `idle` (with a reason code other than `stale_manual_refresh`), not the advisory.

#### Scenario: Manual connector complete, succeeded, and stale projects an idle advisory

- **WHEN** a manual-refresh-only connection (manifest `recommended_mode: "manual"`, `recommended_mode: "paused"`, or `background_safe: false`) has a succeeded last run, complete coverage, and freshness `stale`
- **THEN** the headline state SHALL be `idle` with reason code `stale_manual_refresh`
- **AND** the `stale` freshness axis and badge SHALL remain set
- **AND** the `Fresh` condition SHALL be `false` at `info` severity with a manual-refresh remediation, so the projection never reports `degraded` for that staleness alone.

#### Scenario: Schedulable connector with the same stale evidence still degrades

- **WHEN** a connection that is not manual-refresh-only has a succeeded last run, complete coverage, and freshness `stale`
- **THEN** the headline state SHALL be `degraded`
- **AND** the `Fresh` condition SHALL be `false` at `warning` severity.

#### Scenario: Manual connector with incomplete coverage still degrades

- **WHEN** a manual-refresh-only connection is stale and also has incomplete or gapped source coverage
- **THEN** the headline state SHALL be `degraded` and the coverage condition SHALL identify the gap, so the manual-stale advisory never masks a coverage failure.

#### Scenario: Manual connector with a failed last run still degrades or blocks

- **WHEN** a manual-refresh-only connection is stale and its latest terminal run failed
- **THEN** the projection SHALL report `degraded` (or `blocked` when the failure is a readiness/credential rejection), never the manual-stale `idle` advisory.

#### Scenario: Never-run manual connector that is stale stays never-run idle

- **WHEN** a manual-refresh-only connection has no succeeded run and no equivalent local-device collection verdict, and freshness is `stale`
- **THEN** the headline state SHALL be `idle` with a reason code other than `stale_manual_refresh`, reflecting the never-run state rather than the manual-stale advisory.
