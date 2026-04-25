## ADDED Requirements

### Requirement: Demo bridge routes SHALL remain sandbox-only and non-authoritative

Website routes that expose mock AS/RS behavior for the public sandbox SHALL remain sandbox-prefixed, deterministic, and explicitly demo-only. They SHALL NOT redefine the primary reference contract or become required by the live reference dashboard.

#### Scenario: Sandbox exposes a mock public endpoint
- **WHEN** `apps/web` exposes a mock endpoint such as `/sandbox/v1/schema`, `/sandbox/v1/search`, or `/sandbox/v1/streams/:stream/records`
- **THEN** the endpoint SHALL return deterministic fictional data
- **AND** it SHALL preserve the relevant shape of the corresponding reference/public surface where practical
- **AND** it SHALL NOT be documented as the live AS/RS endpoint for real deployments

#### Scenario: Live dashboard fetches reference data
- **WHEN** `/dashboard/**` renders live reference state
- **THEN** it SHALL continue using the configured live AS/RS clients and owner-access rules
- **AND** it SHALL NOT silently fall back to sandbox data

#### Scenario: Sandbox dashboard fetches demo data
- **WHEN** `/sandbox/**` renders dashboard-like demo state
- **THEN** it SHALL use sandbox-specific demo clients or response builders
- **AND** it SHALL NOT mint owner tokens, forward owner-session cookies, or call the live AS/RS
