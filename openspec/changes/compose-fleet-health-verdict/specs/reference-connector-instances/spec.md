## ADDED Requirements

### Requirement: Fleet-health evidence SHALL retain configured connection identity

The reference implementation SHALL retain the configured
`connector_instance_id` / connection identity for every connection that appears
in fleet-health scope or typed evidence dimensions. Fleet-health composition
SHALL NOT collapse independent configured connections by `connector_key`.

#### Scenario: Two connections of one connector type have different evidence

- **WHEN** two configured connections share a connector type and one has a
  fleet-health cause while the other is healthy
- **THEN** the fleet composition SHALL identify the affected configured
  connection independently
- **AND** it SHALL NOT assign the cause to the healthy sibling.
