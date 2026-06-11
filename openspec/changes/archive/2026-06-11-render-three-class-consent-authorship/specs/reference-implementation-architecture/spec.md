# reference-implementation-architecture (delta)

## MODIFIED Requirements

### Requirement: Hosted consent UI SHALL disclose effective access risk

The reference Authorization Server's hosted consent UI SHALL render authorization requests in terms of the effective access the owner is approving, not only in terms of request shorthand. A stream wildcard SHALL NOT be rendered as a bare `*`; the UI SHALL disclose that all streams for the requested source are in scope and SHALL show the resolved stream count and names when the source manifest is available. Long-lived `continuous` access SHALL receive a distinct risk affordance, especially when no expiry or retention bound is present.

Requests for `purpose_category: "ai_training"` SHALL require explicit affirmative consent. When that consent is missing, the AS SHALL reject the request with a typed PDPP error envelope rather than an untyped internal server error.

The hosted consent UI SHALL keep three authorship classes visually and semantically distinct, so a consumer can point at any rendered element and name its provenance:

- **protocol** — facts the owner's server enforces or verifies: the grant access mode, retention bound, the source binding, and (for clients resolved through a Client ID Metadata Document) the URL-origin client identity.
- **manifest** — the owner-trusted human descriptions of the requested streams (stream names and descriptions resolved from the manifest).
- **client** — claims the client itself authored: its self-described display name, its `purpose_description` / `purpose_code`, and any per-stream `client_claims` (request-scoped purpose and commitments).

Each rendered block SHALL carry a machine-readable `data-authorship` attribute whose value is `protocol`, `manifest`, or `client`. Client-authored content SHALL be presented as claims, never as protocol facts: it SHALL NOT be rendered in the same undifferentiated facts list as protocol facts, and the client-claims block SHALL carry an explicit disclaimer that the claims are not enforced by the server. Per-stream `client_claims` SHALL be rendered (not dropped) when present, inside the client authorship class.

#### Scenario: Hosted consent receives a wildcard stream request
- **WHEN** the AS renders `GET /consent?request_uri=...` for a pending request whose authorization details include a stream selection of `*`
- **THEN** the HTML SHALL NOT render a bare `*` as the stream name
- **AND** the HTML SHALL indicate that all streams for the requested source are in scope
- **AND** when the source manifest is known, the HTML SHALL include the resolved stream count and resolved stream names

#### Scenario: Hosted consent receives a continuous grant request
- **WHEN** the AS renders hosted consent for a request whose effective `access_mode` is `continuous`
- **THEN** the HTML SHALL include a distinct long-lived-access warning
- **AND** when no expiry or retention bound is present, the warning SHALL state that the requested access has no explicit expiry

#### Scenario: AI-training request lacks affirmative consent
- **WHEN** a caller submits an authorization request for `purpose_category: "ai_training"` without the reference's explicit affirmative consent marker
- **THEN** the AS SHALL reject the request with a typed PDPP error envelope
- **AND** the response SHALL NOT be a generic `500` internal server error

#### Scenario: Hosted consent distinguishes the three authorship classes
- **WHEN** the AS renders `GET /consent?request_uri=...` for a pending request whose authorization details carry a `purpose_description` and a stream with `client_claims` (a purpose and commitments)
- **THEN** the HTML SHALL render a protocol-authored block, a manifest-authored block, and a client-authored block, each marked with the corresponding `data-authorship` attribute value
- **AND** the per-stream `client_claims` purpose and commitments SHALL be rendered inside the client authorship class
- **AND** the client-authored values (the stated purpose and the `client_claims` content) SHALL NOT appear inside the protocol-authored block
- **AND** the client-claims block SHALL carry a disclaimer stating the claims are not enforced by the owner's server
