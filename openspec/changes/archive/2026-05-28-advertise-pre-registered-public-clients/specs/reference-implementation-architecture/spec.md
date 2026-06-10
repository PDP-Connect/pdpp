## ADDED Requirements

### Requirement: Authorization-server metadata SHALL publish pre-registered public clients

When the reference authorization server advertises `pre_registered_public`, it SHALL publish the usable public client identifiers in authorization-server metadata.

#### Scenario: Dynamic registration is disabled

- **WHEN** a public caller fetches `/.well-known/oauth-authorization-server`
- **AND** dynamic registration is disabled
- **THEN** the metadata SHALL omit `registration_endpoint`
- **AND** `pdpp_registration_modes_supported` SHALL include `pre_registered_public`
- **AND** `pdpp_pre_registered_public_clients` SHALL contain at least one usable public client.

#### Scenario: Public clients are advertised

- **WHEN** `pdpp_pre_registered_public_clients` is present
- **THEN** every entry SHALL include `client_id`, `client_name`, and `token_endpoint_auth_method`
- **AND** every entry SHALL describe a configured pre-registered public client
- **AND** the list SHALL NOT include dynamically registered clients, owner-scoped clients, secrets, access tokens, or private registration state.

#### Scenario: Dynamic registration is also available

- **WHEN** dynamic registration is available to the caller
- **THEN** the metadata SHALL advertise both `dynamic` and `pre_registered_public`
- **AND** `pdpp_pre_registered_public_clients` SHALL still list the configured pre-registered public clients.
