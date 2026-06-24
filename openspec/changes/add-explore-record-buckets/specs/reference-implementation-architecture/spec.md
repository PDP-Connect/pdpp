## ADDED Requirements

### Requirement: Explore record buckets expose one exact owner-session aggregate

The reference implementation SHALL expose `GET /_ref/explore/records/buckets` as an owner-session-authenticated reference route that returns exact bucket counts across the same owner-visible record set used by `GET /_ref/explore/records`. The route SHALL NOT be reachable over `/mcp` or with a grant-scoped token.

#### Scenario: Bucket endpoint returns dense exact counts

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records/buckets`
- **THEN** the response SHALL include the populated extent and a dense, zero-filled bucket series
- **AND** each bucket count SHALL equal the number of reachable records in that bucket for the requested scope
- **AND** buckets with no matching records SHALL be represented with count `0`.

#### Scenario: Bucket endpoint respects Explore scope

- **WHEN** an authenticated owner session requests buckets with `connection_id`, `connection`, `stream`, `xconnection`, or `xstream` query parameters
- **THEN** the populated extent and bucket counts SHALL be computed only from records in the resulting Explore scope
- **AND** counts SHALL NOT include unselected or excluded partitions.

#### Scenario: Auto granularity uses populated extent

- **WHEN** an authenticated owner session requests buckets without an explicit granularity
- **THEN** the server SHALL derive granularity from the populated extent, not from a fixed client window
- **AND** the selected granularity SHALL come from a calendar ladder intended to keep the response near 30-60 bars when possible.

#### Scenario: Bucket aggregate stays index-backed

- **WHEN** the reference implementation computes Explore record buckets
- **THEN** the aggregate query SHALL use the indexed semantic-time record set
- **AND** it SHALL NOT read record payload JSON to compute counts.
