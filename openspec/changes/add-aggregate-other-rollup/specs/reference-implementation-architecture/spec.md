## MODIFIED Requirements

### Requirement: Grouped aggregation results SHALL be bounded and deterministic

Grouped aggregation responses SHALL enforce a maximum bucket limit and
deterministic ordering. Grouped responses SHALL include an `other_count` field
containing the sum of counts for all groups or buckets truncated by `limit`.
`other_count` SHALL be zero when all groups fit within the limit; it SHALL be
positive when truncation occurred. `other_count` SHALL be present on every
grouped response (scalar `group_by` and calendar `group_by_time`) and SHALL be
absent on ungrouped (scalar) aggregation responses.

#### Scenario: Grouped count returns other_count when truncated

- **WHEN** a client requests `group_by=<field>&limit=N`
- **AND** the stream contains more than N distinct values for that field
- **THEN** the response SHALL contain exactly N group buckets ordered by count
  descending, then key ascending
- **AND** the response SHALL include `other_count` equal to the sum of counts
  for all groups beyond the limit
- **AND** `other_count` SHALL be positive

#### Scenario: Grouped count returns other_count=0 when all groups fit

- **WHEN** a client requests `group_by=<field>&limit=N`
- **AND** the stream contains N or fewer distinct values for that field
- **THEN** the response SHALL include all distinct groups
- **AND** the response SHALL include `other_count` equal to zero

#### Scenario: Time-bucket grouping returns other_count when truncated

- **WHEN** a client requests `group_by_time=<date_field>&granularity=day&limit=N`
- **AND** the stream contains records in more than N distinct calendar buckets
- **THEN** the response SHALL return the first N buckets in ascending order
- **AND** the response SHALL include `other_count` equal to the sum of counts
  for all buckets beyond the limit

#### Scenario: Ungrouped aggregation does not emit other_count

- **WHEN** a client requests an aggregation with no grouping dimension (no
  `group_by` or `group_by_time`)
- **THEN** the response SHALL NOT include an `other_count` field
