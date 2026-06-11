## ADDED Requirements

### Requirement: Google Data Portability authorizations SHALL create distinct provider-auth connector instances

The reference implementation SHALL treat each Google Maps Data Portability owner authorization as a connection-scoped provider authorization. It SHALL NOT reuse Gmail static-secret credentials, Google app passwords, or deployment-level OAuth client secrets as per-account source credentials.

#### Scenario: Deployment lacks Google provider app configuration

- **WHEN** the Google Maps Data Portability manifest is registered but the deployment lacks required Google provider app material
- **THEN** setup surfaces SHALL report a deployment prerequisite
- **AND** they SHALL NOT ask the owner for a Google password, Gmail app password, or owner bearer token.

#### Scenario: Owner authorizes one Google account

- **WHEN** the owner completes Google provider authorization and account inventory or connection testing succeeds
- **THEN** the reference SHALL create one connector instance for that authorization
- **AND** provider tokens SHALL be sealed for that connector instance only.

#### Scenario: Owner authorizes a second Google account

- **WHEN** the owner repeats Google provider authorization for another account or owner-labeled binding
- **THEN** the reference SHALL create a second connector instance
- **AND** runs, schedules, state, diagnostics, and records SHALL remain separated by connector instance.

#### Scenario: Account identity is not verified by Google response

- **WHEN** the provider response does not supply a reliable account email or subject identifier
- **THEN** owner surfaces SHALL present any owner-supplied label as a label, not verified provider identity
- **AND** the connector instance SHALL still use an opaque stable binding id for storage and scheduling.

#### Scenario: Owner reads setup or connection status

- **WHEN** owner-agent, console, CLI, or reference read surfaces expose Google Maps Data Portability setup status
- **THEN** they MAY expose non-secret token presence, capture time, expiry, scope, coverage, and account-label metadata
- **AND** they SHALL NOT expose Google access tokens, refresh tokens, OAuth client secrets, owner cookies, or bearer-equivalent material.
