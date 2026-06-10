## ADDED Requirements

### Requirement: The authorization endpoint SHALL accept URL-shaped client identifiers via CIMD

The reference AS SHALL accept an `https://`-URL `client_id` at the authorization endpoint without prior Dynamic Client Registration or pre-registration. When `client_id` begins with `https://`, the AS SHALL treat it as a Client ID Metadata Document (CIMD) identifier and fetch the document to establish client identity.

#### Scenario: CIMD client_id is detected at the authorize endpoint
- **WHEN** the authorization endpoint receives a request with a `client_id` that begins with `https://`
- **THEN** the AS SHALL classify it as a CIMD client_id
- **AND** it SHALL NOT route it through the DCR or pre-registered-public lookup path
- **AND** it SHALL proceed to validate the URL before fetching

#### Scenario: Non-URL client_id is presented
- **WHEN** the authorization endpoint receives a `client_id` that does not begin with `https://`
- **THEN** the AS SHALL apply existing DCR and pre-registered-public resolution unchanged
- **AND** it SHALL NOT attempt a CIMD fetch

### Requirement: The AS SHALL validate the CIMD client_id URL before any outbound fetch

Before issuing any outbound HTTP request, the AS SHALL reject `client_id` values that fail the following pre-fetch validation:

1. Scheme is exactly `https`.
2. Userinfo component is absent.
3. Path is non-empty and contains no dot-segment (`/.` or `/..`) and no fragment.
4. Resolved host is not a loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), or multicast address.
5. Port, if present, is subject to the same DNS/IP validation and fetch-time guardrails.

#### Scenario: Validation rejects a loopback client_id
- **WHEN** `client_id` resolves to a loopback address
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

#### Scenario: Validation rejects a private-network client_id
- **WHEN** `client_id` resolves to a private RFC 1918 or ULA address
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

#### Scenario: Validation rejects userinfo in the client_id URL
- **WHEN** `client_id` contains a userinfo component (e.g. `https://user@example.com/...`)
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

#### Scenario: Validation rejects dot-segment paths
- **WHEN** `client_id` path contains `/.` or `/..`
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

### Requirement: The AS SHALL fetch and cache CIMD documents with size and timeout safeguards

When an external `client_id` URL passes pre-fetch validation, the AS SHALL fetch the CIMD document with all of the following constraints:

- Timeout: abort after 5 seconds.
- Size cap: abort and reject if the response body exceeds 5 KB.
- Redirects: do not automatically follow HTTP redirects.
- Cache: store a successfully fetched document for between 60 seconds and 24 hours, keyed on the exact `client_id` URL.

#### Scenario: Fetch succeeds within limits
- **WHEN** the CIMD document is fetched and the body is ≤5 KB within 5 seconds
- **THEN** the AS SHALL parse, validate, and cache the document
- **AND** it SHALL use the document to populate the consent surface

#### Scenario: Fetch exceeds size cap
- **WHEN** the response body exceeds 5 KB
- **THEN** the AS SHALL abort the fetch and return a recoverable authorization error
- **AND** it SHALL log the failure at WARN
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Fetch exceeds timeout
- **WHEN** the fetch does not complete within 5 seconds
- **THEN** the AS SHALL abort the connection and return a recoverable authorization error
- **AND** it SHALL log the failure at WARN
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Fetch returns a non-200 status
- **WHEN** the CIMD endpoint returns a non-200 HTTP status
- **THEN** the AS SHALL return a recoverable authorization error
- **AND** it SHALL log the failure at WARN
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Fetch returns a redirect
- **WHEN** the CIMD endpoint returns a redirect status
- **THEN** the AS SHALL return a recoverable authorization error without following the redirect
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Document is malformed or missing client_id
- **WHEN** the fetched document is malformed JSON, lacks `client_id`, or has a `client_id` value that is not an exact string match for the URL used to fetch it
- **THEN** the AS SHALL reject the authorization request
- **AND** it SHALL NOT cache the document

#### Scenario: Document requests unsupported client authentication
- **WHEN** the fetched document contains a shared-secret client authentication method, `client_secret`, or a client authentication method the reference token endpoint does not implement
- **THEN** the AS SHALL reject the authorization request
- **AND** it SHALL NOT cache the document

#### Scenario: Cache hit avoids re-fetch
- **WHEN** a valid cached CIMD document exists for the `client_id` and is within its TTL
- **THEN** the AS SHALL serve the cached document without issuing an outbound fetch

### Requirement: The AS SHALL enforce redirect_uri trust using same-origin constraint with a localhost exception

The AS SHALL require that every `redirect_uri` in a CIMD authorize request appears in the fetched document's `redirect_uris` field and satisfies at least one of:

- It shares the same origin (scheme + host + port) as the `client_id` URL, or
- It matches `http://localhost:*/*`, `http://127.0.0.1:*/*`, or `http://[::1]:*/*` (localhost development exception).

#### Scenario: redirect_uri matches document and shares origin
- **WHEN** the `redirect_uri` in the authorize request is listed in the CIMD document and shares the `client_id` origin
- **THEN** the AS SHALL proceed with the authorization request

#### Scenario: redirect_uri is a localhost development URI
- **WHEN** the `redirect_uri` is loopback HTTP on `localhost`, `127.0.0.1`, or `[::1]` and is listed in the CIMD document
- **THEN** the AS SHALL permit it as the localhost development exception

#### Scenario: redirect_uri is cross-origin and not localhost
- **WHEN** the `redirect_uri` does not share the `client_id` origin and is not a localhost URI
- **THEN** the AS SHALL reject the authorization request

#### Scenario: redirect_uri is absent from the document
- **WHEN** the `redirect_uri` is not listed in the CIMD document
- **THEN** the AS SHALL reject the authorization request

### Requirement: The AS SHALL revoke tokens and invalidate cache on security-relevant metadata changes

When a re-fetched CIMD document changes security-relevant metadata (`redirect_uris`, `token_endpoint_auth_method`, `jwks`, or `jwks_uri`) compared with the previously cached version, the AS SHALL:

1. Revoke all tokens issued to that `client_id`.
2. Invalidate the cached document entry.
3. Emit a security audit log record.

#### Scenario: Re-fetched document has changed security-relevant metadata
- **WHEN** a CIMD document is re-fetched and its `redirect_uris`, `token_endpoint_auth_method`, `jwks`, or `jwks_uri` differs from the cached version
- **THEN** the AS SHALL revoke all tokens issued to that `client_id`
- **AND** it SHALL invalidate the cache entry and log a security audit event
- **AND** the client SHALL be required to re-authorize

#### Scenario: Re-fetched document has unchanged security-relevant metadata
- **WHEN** a CIMD document is re-fetched and its security-relevant metadata is unchanged
- **THEN** the AS SHALL update the cache TTL
- **AND** existing tokens SHALL remain valid

#### Scenario: Re-fetched document changes display-only metadata
- **WHEN** a CIMD document is re-fetched and only `client_name` or `logo_uri` changes
- **THEN** the AS MAY update the displayed metadata without revoking existing tokens

### Requirement: The AS SHALL advertise CIMD support in authorization-server discovery

The AS SHALL include `"client_id_metadata_document"` in the `pdpp_registration_modes_supported` array of the `/.well-known/oauth-authorization-server` metadata response when CIMD behavior is implemented. The AS SHALL also set the current standard metadata field `client_id_metadata_document_supported: true` while the field remains current in the CIMD draft.

#### Scenario: Discovery metadata is fetched
- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** `pdpp_registration_modes_supported` SHALL include `"client_id_metadata_document"`
- **AND** the existing values `"dynamic"` and `"pre_registered_public"` SHALL remain present
- **AND** `client_id_metadata_document_supported` SHALL be `true` while that field name remains current in the CIMD draft

### Requirement: The reference SHALL serve operator-created CIMD documents at a stable route

The reference AS SHALL expose a `GET /oauth/client-metadata/:id` route that serves operator-created CIMD documents. The route SHALL:

- Return `Content-Type: application/json` with `Cache-Control: max-age=3600`.
- Return HTTP 404 for unknown identifiers.
- Include `client_id` exactly equal to the document URL.
- Include `redirect_uris`.
- Include `token_endpoint_auth_method: "none"` for public local MCP clients.
- Exclude `client_secret` and every shared-secret authentication method.

#### Scenario: Known client metadata document is requested
- **WHEN** `GET /oauth/client-metadata/<uuid>` is requested for an operator-created identity
- **THEN** the response SHALL be `application/json` with the CIMD document and `Cache-Control: max-age=3600`

#### Scenario: Unknown client metadata document is requested
- **WHEN** `GET /oauth/client-metadata/<uuid>` is requested for an id not in operator storage
- **THEN** the response SHALL be HTTP 404

#### Scenario: End-to-end CIMD flow using the hosted document
- **WHEN** an MCP client presents `https://<pdpp-host>/oauth/client-metadata/<uuid>` as its `client_id`
- **THEN** the AS SHALL resolve the document from local operator storage rather than issuing an outbound self-fetch
- **AND** it SHALL complete the authorize flow and issue a grant-scoped token usable at `/mcp`

#### Scenario: Hosted client metadata document is deleted
- **WHEN** the operator deletes a client metadata document
- **THEN** the document URL SHALL return HTTP 404
- **AND** all grants and tokens issued to that exact `client_id` SHALL be revoked

### Requirement: The reference SHALL reject owner and control-plane bearer tokens at /mcp

The `/mcp` endpoint SHALL reject requests bearing owner bearer tokens or control-plane bearer tokens. This posture is unchanged by the CIMD addition.

#### Scenario: Owner bearer token is presented to /mcp
- **WHEN** a request to `/mcp` carries an owner bearer token
- **THEN** the server SHALL return an authentication error
- **AND** the request SHALL NOT be processed as a normal MCP operation

#### Scenario: Normal MCP setup does not involve the owner token
- **WHEN** an MCP client follows the CIMD-based OAuth authorize flow
- **THEN** it SHALL receive a grant-scoped client token
- **AND** the owner token SHALL NOT be required or requested at any step of the flow
