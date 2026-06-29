## ADDED Requirements

### Requirement: Authorization-server device authorization SHALL be token-kind honest
The reference authorization server SHALL distinguish owner-agent device authorization from grant-scoped MCP device authorization in public metadata, request validation, stored pending state, token exchange, and approval UI. Owner-agent device requests SHALL redeem only owner tokens. Grant-scoped MCP device requests SHALL redeem only client tokens bound to an approved PDPP grant or grant package.

#### Scenario: Client discovers device authorization metadata
- **WHEN** a client fetches authorization-server or protected-resource metadata
- **THEN** the metadata SHALL NOT imply that owner-agent device authorization is a normal MCP credential path
- **AND** owner-agent onboarding metadata SHALL identify `pdpp_token_kind: "owner"` and `mcp_owner_bearer_rejected: true`
- **AND** grant-scoped MCP device authorization, when advertised, SHALL identify the MCP protected resource and client-token outcome.

#### Scenario: Owner-agent device code is approved
- **WHEN** an owner approves an owner-agent device authorization request
- **THEN** token polling SHALL return a bearer that introspects as `pdpp_token_kind = "owner"`
- **AND** that bearer SHALL NOT satisfy `/mcp` authorization.

#### Scenario: MCP device code is approved
- **WHEN** an owner approves a grant-scoped MCP device authorization request
- **THEN** token polling SHALL return a bearer that introspects as `pdpp_token_kind = "client"` with the approved grant or grant package identifier
- **AND** that bearer SHALL be usable only for the approved MCP protected resource and grant scope.

### Requirement: Grant-scoped MCP device authorization SHALL reuse PDPP grant semantics
The reference authorization server SHALL support a headless MCP setup path in which a public client starts RFC 8628-style device authorization with `client_id`, MCP `resource`, and PDPP `authorization_details`. The AS SHALL validate the client using the same CIMD, pre-registered public-client, or DCR registry used by authorization-code hosted MCP. The AS SHALL validate requested authorization details using the existing pending-consent and grant issuance machinery.

#### Scenario: MCP client starts device authorization
- **WHEN** a registered or CIMD-backed public MCP client posts a device authorization request with `client_id`, MCP `resource`, and PDPP `authorization_details`
- **THEN** the AS SHALL return `device_code`, `user_code`, `verification_uri`, optional `verification_uri_complete`, `expires_in`, and `interval`
- **AND** the stored pending request SHALL record that the eventual token kind is grant-scoped client access, not owner access.

#### Scenario: MCP client omits scope-defining details
- **WHEN** a public MCP client posts a device authorization request without MCP `resource` or without PDPP `authorization_details`
- **THEN** the AS SHALL reject the request with an OAuth-shaped error
- **AND** it SHALL NOT fall back to issuing an owner-agent device code as normal MCP setup.

#### Scenario: Device token polling before approval
- **WHEN** the MCP client polls `/oauth/token` with the device code before owner approval
- **THEN** the AS SHALL return the RFC 8628 `authorization_pending` error and SHALL NOT issue a bearer.

#### Scenario: Device token polling after denial or expiry
- **WHEN** the MCP client polls after owner denial or device-code expiry
- **THEN** the AS SHALL return `access_denied` or `expired_token`
- **AND** it SHALL NOT issue a bearer.

### Requirement: Device authorization approval UI SHALL display client and grant provenance
The reference approval UI for grant-scoped MCP device authorization SHALL show the client identity, client-claim provenance, MCP protected resource, requested sources/streams, expiry, and explicit approve/deny controls. Client-authored name or logo claims SHALL remain visually and semantically distinct from verified client id/origin and PDPP grant scope.

#### Scenario: Owner reviews MCP device approval
- **WHEN** the owner opens the verification URI for a pending MCP device authorization
- **THEN** the approval page SHALL identify the client id/origin, any client-authored display name/logo as claims, the MCP protected resource, and the requested PDPP grant scope
- **AND** the page SHALL show the expiry and approve/deny actions.

#### Scenario: Owner reviews owner-agent device approval
- **WHEN** the owner opens the verification URI for a pending owner-agent device authorization
- **THEN** the approval page SHALL identify the request as trusted owner-agent onboarding
- **AND** it SHALL NOT describe the resulting bearer as a normal MCP credential.
