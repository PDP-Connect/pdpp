## ADDED Requirements

### Requirement: OAuth error responses SHALL include request identifiers

The reference implementation SHALL keep authorization-server OAuth errors RFC-shaped while adding a stable request identifier.

#### Scenario: OAuth endpoint rejects a request

- **WHEN** an OAuth authorization-server endpoint returns an error response with `error`
- **THEN** the JSON body SHALL include `request_id`
- **AND** the response SHALL include a `Request-Id` header with the same value
- **AND** the body SHALL retain the OAuth `error` and `error_description` fields when a description is available.

#### Scenario: OAuth errors are compared with PDPP resource errors

- **WHEN** a client receives an OAuth endpoint error
- **THEN** the error SHALL NOT be wrapped in the nested PDPP resource-server error envelope
- **AND** clients SHALL treat `request_id` as the cross-surface correlation key.
