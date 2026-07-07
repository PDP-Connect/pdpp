## MODIFIED Requirements

### Requirement: Stream health projection SHALL consume coverage and freshness evidence strategies

The reference implementation SHALL derive per-stream coverage and freshness
posture from the normalized collection report's stream evidence entries. It
SHALL treat coverage and freshness as separate axes and SHALL NOT infer one from
the other.

The reference implementation SHALL roll degrading per-stream coverage conditions
from the derived collection report into the connection-level coverage axis before
rendering the connection verdict. A connection SHALL NOT render as healthy when
one of its own stream report entries has a degrading coverage condition.

Degrading stream coverage conditions SHALL include `partial`, `retryable_gap`,
`gaps`, and `terminal_gap`. Accepted-policy stream conditions such as
`inventory_only`, `deferred`, `unsupported`, and `unavailable` SHALL NOT newly
degrade the connection solely through this report rollup.

#### Scenario: complete coverage with stale freshness stays decomplected

**WHEN** a stream's coverage evidence is complete
**AND** its freshness evidence is stale
**THEN** the stream projection SHALL report complete coverage and stale freshness
separately
**AND** the owner-facing copy SHALL NOT describe the stream as missing coverage.

#### Scenario: fresh but partially covered stream degrades connection coverage

**WHEN** a stream's freshness evidence is current
**AND** its coverage evidence reports partial coverage or retryable gaps
**THEN** the stream projection SHALL report current freshness and incomplete
coverage separately
**AND** the connection-level verdict SHALL NOT render as healthy
**AND** the owner-facing next step SHALL be based on the coverage condition, not
on staleness.
