## ADDED Requirements

### Requirement: Public client self-registration SHALL be publicly discoverable

The reference implementation SHALL support public-client self-registration through the advertised dynamic registration endpoint when DCR is enabled.

#### Scenario: Stranger registers a public client

- **WHEN** a third-party client fetches authorization-server metadata
- **AND** DCR is enabled
- **THEN** the metadata SHALL include `registration_endpoint`
- **AND** `pdpp_registration_modes_supported` SHALL include `dynamic`.

#### Scenario: Public registration succeeds

- **WHEN** a third-party client posts supported public-client metadata to `registration_endpoint` without an initial access token
- **THEN** the reference SHALL create a public client with `token_endpoint_auth_method: "none"`
- **AND** the response SHALL include the assigned `client_id`
- **AND** the request SHALL NOT grant data access or mint bearer tokens
- **AND** the reference SHALL emit an auditable `client.registered` spine event.

#### Scenario: Invalid bearer registration is rejected

- **WHEN** a caller posts public-client metadata with an invalid bearer initial-access token
- **THEN** the reference SHALL NOT create a client
- **AND** the reference SHALL return an OAuth `invalid_client` error
- **AND** the reference SHALL emit an auditable `client.register_rejected` spine event.

#### Scenario: Public registration validates metadata strictly

- **WHEN** a public registration request includes unsupported OAuth metadata, confidential-client claims, unsupported auth methods, or malformed URI metadata
- **THEN** the reference SHALL reject the request
- **AND** the error SHALL include request correlation data.

#### Scenario: Public registration is rate limited

- **WHEN** unauthenticated registration attempts exceed the reference rate limit for a request origin
- **THEN** the reference SHALL return HTTP 429
- **AND** the response SHALL include `Retry-After`.
