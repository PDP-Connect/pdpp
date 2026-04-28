## ADDED Requirements

### Requirement: Dashboard BFF device approval SHALL use the JSON CSRF exemption
The reference implementation SHALL allow same-origin dashboard backend callers to drive the canonical RFC 8628 device flow by POSTing JSON to `/device/approve` and `/device/deny` with a valid owner session cookie. The reference implementation SHALL NOT introduce a private owner-token mint endpoint that bypasses the public device-flow state machine.

#### Scenario: BFF approves a device flow with a valid owner session cookie
- **WHEN** the dashboard BFF POSTs to `/device/approve` with `Content-Type: application/json`, a valid `pdpp_owner_session` cookie, and a staged device `user_code`
- **THEN** the AS SHALL approve the staged device request
- **AND** the subsequent `/oauth/token` device-code exchange SHALL return the bearer issued by the canonical device flow

#### Scenario: JSON approval without a valid owner session is rejected
- **WHEN** the dashboard BFF POSTs to `/device/approve` with `Content-Type: application/json` but without a valid owner session cookie
- **THEN** the AS SHALL return 401 with `owner_session_required`

#### Scenario: Hosted-form CSRF enforcement remains in place
- **WHEN** a caller POSTs a form-encoded body to `/device/approve` without a valid hosted-form CSRF token
- **THEN** the AS SHALL return 403 with `csrf_token_invalid`

#### Scenario: Private owner-token mint endpoint is absent
- **WHEN** a caller requests `POST /_ref/owner/mint-self-export-token`
- **THEN** the AS SHALL NOT mint a bearer through that route
