## MODIFIED Requirements

### Requirement: CLI and tests are first-class consumers

The CLI and executable tests SHALL consume the real public or reference-designated surfaces of the implementation rather than private database shortcuts or website-only glue.

Owner-bearer REST reads over polyfill connector data SHALL accept the canonical `connection_id` selector wherever the public records read contract advertises it. The reference SHALL resolve that `connection_id` to an active connector instance owned by the owner token subject before constructing the storage binding. The deprecated `connector_instance_id` alias MAY remain accepted during the migration window, but conflicting canonical and alias values SHALL be rejected instead of silently choosing one.

The stream metadata route (`GET /v1/streams/:stream`) SHALL remain metadata-only. Record bodies SHALL be returned from records routes such as `GET /v1/streams/:stream/records`.

#### Scenario: Owner REST caller reads records by discovered connection

- **WHEN** an owner bearer caller discovers a stream with `connection_id` from `GET /v1/streams`
- **AND** the caller requests `GET /v1/streams/:stream/records?connection_id=<that-connection-id>`
- **THEN** the reference SHALL resolve the connection for the owner subject
- **AND** the records response SHALL use the matching connector storage binding without requiring `connector_id`

#### Scenario: Owner REST caller sends conflicting selectors

- **WHEN** an owner bearer caller requests a records read with `connection_id=<A>` and `connector_instance_id=<B>`
- **AND** `<A>` and `<B>` are different non-empty values
- **THEN** the reference SHALL reject the request with a typed request error
- **AND** it SHALL NOT widen the read to connector-level access

#### Scenario: Stream metadata remains distinct from records

- **WHEN** a caller requests `GET /v1/streams/:stream`
- **THEN** the response SHALL describe stream metadata
- **AND** it SHALL NOT return record bodies from that route
