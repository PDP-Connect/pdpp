## MODIFIED Requirements

### Requirement: Canonical record counts SHALL be exact under current record-snapshot evidence

The connector summary SHALL derive current per-stream record counts from a
stable canonical `records WHERE deleted = false` snapshot stamped with the
connection's exact reset-safe record checkpoint. When `record_snapshot` evidence
is current, a manifest-declared stream absent from the exhaustive canonical row
set SHALL project as exactly zero records and owner surfaces SHALL render "0
records". When record evidence is unobserved, stale, failed, or unknown, the
summary SHALL NOT fabricate zero and owner surfaces SHALL render the count as
unavailable or explicitly stale.

Retained-size rows SHALL own retained byte, history, and blob measures only.
Dirty/unavailable retained-size evidence SHALL make those measures unavailable
without invalidating a stable canonical record count. Record count SHALL remain
independent from provider collection coverage: known zero SHALL NOT prove that a
provider boundary was observed or completely collected.

#### Scenario: Declared empty stream renders exact zero

- **WHEN** canonical record snapshot evidence is current at a stable checkpoint
- **AND** a declared stream has no live canonical record row
- **THEN** the connector summary SHALL carry `count_state: known_zero` and `record_count: 0`
- **AND** owner surfaces SHALL render "0 records" for it.

#### Scenario: Stale or failed record snapshot never fabricates zero

- **WHEN** record snapshot evidence is stale, failed, unobserved, or unknown
- **AND** no trustworthy current count exists for a declared stream
- **THEN** the summary SHALL carry a nullable unavailable/stale count state
- **AND** owner surfaces SHALL NOT render a fabricated zero.

#### Scenario: Dirty retained bytes do not hide an exact count

- **WHEN** canonical record snapshot evidence is current
- **AND** retained-size byte evidence is dirty, stale, or failed
- **THEN** every declared stream SHALL retain its exact current record count
- **AND** retained byte/history/blob measures SHALL render unavailable independently.

#### Scenario: Locally proven coverage remains independent from canonical count

- **WHEN** a local-device-backed stream has proven collection coverage
- **AND** its canonical record snapshot is current
- **THEN** its record count SHALL be exact, including zero
- **AND** coverage SHALL remain a separate fact rather than being inferred from that count.

## ADDED Requirements

### Requirement: Connection health SHALL fail closed on unavailable required summary projection evidence

Connector source freshness, collection coverage, connector-summary projection
reliability, and retained byte availability SHALL remain separate evidence
axes. A non-current `record_snapshot`, non-current `terminal_facts`, non-current
`manifest_declaration`, or explicit current-generation unexpected stream SHALL add a closed
connector-neutral source code to the existing `ProjectionReliable` condition.
For terminal facts, non-current includes `unobserved`, `stale`, and `failed`.
That false condition SHALL take precedence over otherwise successful, complete,
or fresh source evidence and force headline `unknown`.

A successfully checkpointed empty terminal history is current evidence, not a
projection failure. A retained-byte-only failure SHALL make byte measures
unavailable but SHALL NOT by itself set `ProjectionReliable=false`, because
connection health does not depend on retained bytes. A successful repair MAY
restore the condition automatically without owner action.

#### Scenario: Missing or failed required summary evidence cannot render Healthy

- **GIVEN** a connection has fresh source evidence and complete required-stream coverage
- **AND** its record snapshot, terminal facts, or manifest declaration evidence is unobserved, stale, or failed
- **WHEN** health is synthesized
- **THEN** `ProjectionReliable` SHALL be false with a closed sanitized source code
- **AND** the headline SHALL be `unknown`
- **AND** no successful run, heartbeat, or coverage fact SHALL upgrade it to Healthy.

#### Scenario: Never-observed terminal facts fail closed while checkpointed-empty is current

- **WHEN** terminal facts have never been successfully observed or checkpointed
- **THEN** `terminal_facts` SHALL be non-current and `ProjectionReliable` SHALL be false
- **BUT WHEN** an empty terminal history has been successfully checkpointed
- **THEN** `terminal_facts` SHALL be current and SHALL NOT fail projection reliability by itself.

#### Scenario: Dirty evidence self-heals without sticky health state

- **GIVEN** changed ingest left summary evidence dirty or checkpoint-lagging
- **WHEN** the central observation barrier repairs it successfully
- **THEN** health SHALL use the repaired current evidence
- **AND** it SHALL require no owner refresh, connector-specific patch, or sticky UI dismissal.

#### Scenario: Dormant history does not degrade projection reliability

- **GIVEN** a valid current manifest omits a canonical or retained stream grain
- **WHEN** connection health is synthesized
- **THEN** the grain SHALL be dormant diagnostic/retention data and SHALL NOT prevent a Healthy verdict by itself
- **AND** it SHALL be excluded from active totals, discovery, coverage, and serving
- **AND** stale grants SHALL NOT read it.

#### Scenario: Retained-byte-only failure does not change source health

- **GIVEN** record snapshot, terminal facts, manifest declaration, coverage, and freshness evidence are all current
- **AND** only retained byte/history/blob evidence is unavailable
- **WHEN** health is synthesized
- **THEN** byte measures SHALL be unavailable
- **AND** the retained-byte failure alone SHALL NOT make `ProjectionReliable` false or change the source-health verdict.

#### Scenario: Closed projection reasons never leak raw errors

- **WHEN** summary reconciliation or terminal folding fails
- **THEN** health SHALL name only a closed connector-neutral projection reason code
- **AND** SHALL NOT expose raw database messages, SQL, record identity/content, paths, credentials, or connector-specific error copy.
