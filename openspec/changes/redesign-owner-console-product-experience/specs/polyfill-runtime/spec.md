## ADDED Requirements

### Requirement: Browser-backed connectors SHALL authenticate sources with source-scoped material

Browser-backed connectors SHALL NOT use deployment-wide provider-account
credentials to authenticate a source. Any stored credential, OTP helper, recovery
code, cookie, or browser profile used to authenticate a provider account SHALL be
bound to the source being created, refreshed, or reauthorized.

#### Scenario: A browser-backed connector starts a new source

- **WHEN** a browser-backed connector run is scoped to a pending or newly-created source
- **THEN** the connector SHALL authenticate through an owner-visible browser session scoped to that source, a credential bundle scoped to that source, or an already-authenticated browser profile scoped to that source
- **AND** it SHALL NOT read deployment-wide provider-account env vars to fill the login form
- **AND** it SHALL fail closed or request owner interaction when no source-scoped authentication path is available

#### Scenario: A source-scoped stored credential is available

- **WHEN** the runtime provides a stored provider credential bundle to a browser-backed connector
- **THEN** the credential bundle SHALL be explicitly associated with the source identity for that run
- **AND** connector login helpers MAY use that bundle to assist the source-scoped browser login
- **AND** the connector SHALL still verify that the resulting browser session belongs to the source profile before accepting records for the source

#### Scenario: Ephemeral browser authentication is requested

- **WHEN** a browser-backed connector run is configured for ephemeral authentication cleanup
- **THEN** the connector SHALL clear the source browser session or credential material it created after the run reaches a terminal state
- **AND** the run timeline SHALL record non-secret cleanup status
- **AND** the connector SHALL NOT advertise the mode as supported until tests prove cleanup on that connector

## MODIFIED Requirements

### Requirement: Connectors SHALL request credentials via INTERACTION when missing

Connectors SHALL emit `INTERACTION` for missing source-scoped credentials or
manual browser action when required source authentication is absent and an
interactive binding is available. Deployment-wide provider-account credentials
SHALL NOT be treated as a valid fallback for a source.

#### Scenario: Missing credentials with interactive binding

- **WHEN** a connector is spawned with `interactive: {}` in its bindings and source-scoped credentials are unavailable
- **THEN** the connector SHALL emit an INTERACTION with a human-readable `message` explaining the source-scoped credential or browser action needed
- **AND** the runtime SHALL park the run until the interaction is answered or the grant expires

#### Scenario: Missing credentials without interactive binding

- **WHEN** a connector is spawned without `interactive: {}` and required source-scoped credentials are missing
- **THEN** the connector SHALL emit DONE with status `failed` and an error message naming the missing source-scoped credential or action
- **AND** the run SHALL NOT hang waiting for an unavailable interaction channel

#### Scenario: Deployment-wide provider credentials are configured

- **WHEN** deployment env contains a provider-account credential for a connector
- **THEN** a connector SHALL NOT use that credential to authenticate a source
- **AND** tests SHALL prove the credential is ignored or rejected for source setup and scheduled source runs
