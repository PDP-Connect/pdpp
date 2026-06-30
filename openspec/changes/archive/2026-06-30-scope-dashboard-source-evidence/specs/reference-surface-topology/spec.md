## ADDED Requirements

### Requirement: Dashboard source journeys SHALL be scoped by configured connection identity

Owner dashboard surfaces that present, diagnose, or recover one configured data source SHALL address that source by its configured connection identity (`connection_id` / `connector_instance_id`) rather than by connector type alone. Connector-type identifiers (`connector_id`) MAY be used for catalog, setup, aggregate, or explicitly connector-wide views, but SHALL NOT be used as a silent fallback for a per-source detail, recovery, or action route when multiple active configured connections share that connector type.

Run, trace, coverage, freshness, and recovery evidence SHALL be attributed to a configured source only when the evidence carries exact connection identity or another deterministic binding that resolves to that connection. Connector-wide evidence MAY be shown on a source-adjacent surface only when it is labeled as connector-wide, or when the connector type has exactly one active configured connection and cannot be confused with a sibling source.

#### Scenario: A connector type has multiple configured sources

- **WHEN** an owner has two or more active connections for the same connector type
- **AND** the owner navigates to a dashboard route using only the connector type
- **THEN** the dashboard SHALL NOT silently select the first matching configured connection
- **AND** it SHALL require or route to a concrete connection identity before presenting per-source detail or recovery evidence

#### Scenario: A source card renders a recovery action

- **WHEN** a source card, dashboard hero, runs row, or recovery panel presents an action for one configured source
- **THEN** the action target SHALL carry the exact configured connection identity
- **AND** it SHALL NOT route through a connector-type detail path that could resolve to a sibling connection

#### Scenario: Run evidence lacks exact connection attribution

- **WHEN** a run summary is keyed only by connector type or otherwise lacks proof that it belongs to a configured connection
- **THEN** the dashboard SHALL NOT render that run as the recent run or failure evidence for an individual configured source
- **AND** it MAY render the run on an explicitly connector-wide or global runs surface

#### Scenario: Duplicate fallback names are present

- **WHEN** multiple configured connections for the same connector type lack owner-authored labels
- **THEN** the dashboard SHALL keep each configured connection visible and distinguishable
- **AND** it SHALL avoid implying that they are one source or that destructive cleanup is safe without owner review
