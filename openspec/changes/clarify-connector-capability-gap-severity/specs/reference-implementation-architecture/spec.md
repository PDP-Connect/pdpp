## ADDED Requirements

### Requirement: Connector status SHALL distinguish capability, selection, and outcome
The reference implementation SHALL keep connector stream capability, owner/run stream selection, and run outcome distinct when computing connector health. A stream that is not available in the selected connector mode SHALL NOT by itself imply that a run failed or that selected data was lost.

#### Scenario: Unsupported stream is not selected by default
- **WHEN** a connector manifest marks a stream as unsupported in the active collection mode
- **THEN** the reference SHALL NOT request that stream by default for that mode
- **AND** the connector health state SHALL NOT become degraded solely because that unsupported stream exists in the manifest

#### Scenario: Selected stream cannot be collected
- **WHEN** the owner or runtime explicitly requests a stream and the connector cannot collect that selected stream
- **THEN** the reference SHALL record an actionable or explicitly accepted informational gap
- **AND** it SHALL NOT silently report complete coverage for the selected stream

#### Scenario: Successful run has only informational limitations
- **WHEN** a connector run succeeds and its only gaps are informational capability limitations or user-disabled streams
- **THEN** the reference SHALL treat the run as successful as configured for connector health
- **AND** the dashboard MAY surface the limitations in a detail view without rendering the connector as degraded

### Requirement: Known gaps SHALL carry severity semantics
The reference implementation SHALL classify known gaps by severity or reason class before using them for health projection. Gap severity SHALL distinguish informational limitations, transient/retryable pressure, actionable missing selected data, and recoverable detail backlog.

#### Scenario: Informational gap is recorded
- **WHEN** a connector reports an expected unsupported-in-mode stream, user-disabled stream, or out-of-scope stream
- **THEN** the reference SHALL classify the gap as informational
- **AND** informational gaps SHALL NOT by themselves mark connector health as degraded

#### Scenario: Transient gap is recorded
- **WHEN** a connector reports rate limit, upstream pressure, temporary unavailability, or retry exhaustion for selected data
- **THEN** the reference SHALL classify the gap as transient unless a more specific recovery model applies
- **AND** connector health MAY become degraded or cooling-off according to retry/backoff policy

#### Scenario: Actionable gap is recorded
- **WHEN** selected data was not delivered and the owner, operator, or connector author can take action to recover coverage
- **THEN** the reference SHALL classify the gap as actionable
- **AND** connector health SHALL surface degraded or needs-attention status until a later run resolves the condition

#### Scenario: Recoverable detail backlog is recorded
- **WHEN** missing required detail is represented by the reference detail-gap recovery model
- **THEN** the reference SHALL classify that gap as recoverable
- **AND** connector health SHALL follow the detail-gap recovery policy rather than treating the gap as a generic unknown failure

### Requirement: Connector health SHALL use gap severity rather than gap count
The reference connector-health projection SHALL NOT treat every non-empty known-gap list as degraded. It SHALL evaluate run status, gap severity, auth/setup state, retry/backoff state, and freshness state.

#### Scenario: Slack has only expected slackdump-mode limitations
- **WHEN** Slack runs in slackdump archive mode and the only unavailable streams are `stars`, `user_groups`, `reminders`, or `dm_read_states` marked unsupported in that mode
- **THEN** the reference SHALL NOT mark Slack degraded solely because those streams are unavailable
- **AND** the dashboard SHALL keep the limitation visible as connector detail or coverage information

#### Scenario: Actionable selected-stream gap remains degraded
- **WHEN** a successful run includes an actionable gap for data selected by the owner or runtime
- **THEN** the reference SHALL mark connector health as degraded or needs-attention according to the health classifier

#### Scenario: Historical unclassified gap is read
- **WHEN** the reference reads an older known gap without severity metadata
- **THEN** it SHALL treat the gap conservatively as actionable unless a newer classified run supersedes it
