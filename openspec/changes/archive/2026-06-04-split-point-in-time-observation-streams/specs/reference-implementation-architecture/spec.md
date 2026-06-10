# Reference Implementation Architecture — Observation Streams

## ADDED Requirements

### Requirement: observation streams for sampled metrics

The reference implementation SHALL support an observation stream class for sampled metrics that change at polling frequency rather than at semantic event frequency.

#### Scenario: observation-stream record key is deterministic and date-scoped

**WHEN** a connector emits an observation record for entity `E` at time `T`,
**THEN** the record key SHALL be `{entity_id}:{YYYY-MM-DD}` (UTC date derived from `T`),
**AND** emitting again for the same entity on the same UTC calendar day SHALL produce the same key,
**AND** emitting on a different UTC calendar day SHALL produce a distinct key that does not overwrite the prior day's record.

#### Scenario: sampled metrics do not version entity records

**WHEN** sampled metric fields (e.g. `followers`, `num_members`) change between runs,
**THEN** the entity stream record SHALL NOT produce a new version,
**AND** the observation stream SHALL accumulate a new record for each distinct calendar day on which the metric value was observed.

#### Scenario: entity stream is fingerprinted after metric split

**WHEN** a connector separates sampled metrics from an entity stream,
**THEN** the entity stream SHALL use a per-record fingerprint gate,
**AND** the entity record SHALL only re-emit when at least one non-metric identity or structural field changes.

### Requirement: Family-2 observation streams for github/user and slack/channels

The connectors SHALL classify `github/user_stats` and `slack/channel_stats` as Family-2 append-keyed observation streams with date-scoped composite keys.

#### Scenario: github/user_stats accumulates a daily time series

**WHEN** the GitHub connector runs on consecutive days with different `followers` values,
**THEN** `user_stats` SHALL contain one record per day with key `{user_id}:{YYYY-MM-DD}`,
**AND** each record SHALL carry the `followers`, `following`, `public_repos`, and `public_gists` values observed on that day.

#### Scenario: slack/channel_stats accumulates a daily time series

**WHEN** the Slack connector runs on consecutive days with different `num_members` values,
**THEN** `channel_stats` SHALL contain one record per day with key `{channel_id}:{YYYY-MM-DD}`,
**AND** each record SHALL carry the `num_members` value observed on that day.

#### Scenario: same-day re-runs are idempotent for observation streams

**WHEN** the connector runs twice on the same UTC calendar day with identical metric values,
**THEN** both runs SHALL produce the same record key and the same record content,
**AND** no additional record version SHALL be created beyond what the runtime's byte-equivalence check produces.
