## ADDED Requirements

### Requirement: Reference control-plane mutations require owner session when enabled
The reference implementation SHALL require the placeholder owner session on reference-only `_ref` mutation routes when owner auth is enabled. When owner auth is disabled, the reference implementation SHALL preserve the current open local-dev behavior for those routes.

#### Scenario: Owner auth is enabled and a mutation has no session
- **WHEN** a caller submits a `_ref` mutation request without a valid owner-session cookie while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL reject the request with `401 owner_session_required`
- **AND** the route handler SHALL NOT perform the requested mutation

#### Scenario: Owner auth is enabled and a mutation has a session
- **WHEN** a caller submits a `_ref` mutation request with a valid owner-session cookie while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL process the mutation according to the route's existing behavior

#### Scenario: Owner auth is disabled
- **WHEN** a caller submits a `_ref` mutation request while placeholder owner auth is disabled
- **THEN** the reference SHALL preserve the open local-dev behavior for that mutation route

#### Scenario: Reference read routes remain inspection surfaces
- **WHEN** a caller requests an existing `_ref` read route
- **THEN** this change SHALL NOT require owner-session authentication for that read route
