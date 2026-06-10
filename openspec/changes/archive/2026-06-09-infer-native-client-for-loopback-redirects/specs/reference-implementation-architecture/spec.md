## ADDED Requirements

### Requirement: Dynamic client registration SHALL infer native clients from loopback HTTP redirects

When dynamic client registration receives authorization-code public-client metadata without `application_type`, the reference AS SHALL infer `application_type: "native"` if any registered redirect URI uses HTTP on a loopback host. The inferred type SHALL be persisted in registration details and returned in the registration response. If `application_type` is explicitly supplied, the AS SHALL honor and validate the supplied type rather than overriding it.

#### Scenario: Loopback IPv4 redirect infers native

- **WHEN** a public client posts `/oauth/register` with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, no `application_type`, and a redirect URI on `http://127.0.0.1:{port}/...`
- **THEN** the AS SHALL register the client
- **AND** the registration response SHALL include `application_type: "native"`.

#### Scenario: Localhost redirect infers native

- **WHEN** a public client posts `/oauth/register` with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, no `application_type`, and a redirect URI on `http://localhost:{port}/...`
- **THEN** the AS SHALL register the client
- **AND** the registration response SHALL include `application_type: "native"`.

#### Scenario: Loopback IPv6 redirect infers native

- **WHEN** a public client posts `/oauth/register` with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, no `application_type`, and a redirect URI on `http://[::1]:{port}/...`
- **THEN** the AS SHALL register the client
- **AND** the registration response SHALL include `application_type: "native"`.

#### Scenario: Explicit web client remains strict

- **WHEN** a public client posts `/oauth/register` with `application_type: "web"` and a loopback HTTP redirect URI
- **THEN** the AS SHALL reject the registration as invalid web-client redirect metadata.
