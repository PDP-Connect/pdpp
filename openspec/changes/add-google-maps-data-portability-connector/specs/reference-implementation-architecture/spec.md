## ADDED Requirements

### Requirement: Provider-auth API connectors SHALL use shared setup and runtime seams

The reference implementation SHALL implement Google Maps Data Portability through the shared provider-authorization setup lifecycle, encrypted credential store, run scheduler, and Collection Profile runtime seams rather than through source-specific console branches or per-account deployment environment variables.

#### Scenario: Add source renders Google Maps Data Portability

- **WHEN** the Google Maps Data Portability manifest is registered
- **THEN** Add source, owner-agent setup, and CLI setup helpers SHALL derive its state from the same manifest and setup-plan contract
- **AND** no source-specific React branch SHALL be required to explain or start setup.

#### Scenario: Provider app readiness changes

- **WHEN** the deployment gains or loses the required Google provider app configuration
- **THEN** setup surfaces SHALL update from the shared deployment-readiness projection
- **AND** they SHALL NOT require per-account env vars to add or remove owner accounts.

#### Scenario: Runtime needs provider tokens

- **WHEN** a Google Maps Data Portability run starts for a connector instance
- **THEN** the runtime SHALL resolve that instance's sealed provider tokens through the shared credential injection seam
- **AND** it SHALL NOT read process-level owner account credentials as the normal connection path.

#### Scenario: Future Google Data Portability sources are added

- **WHEN** the reference adds another Google Data Portability connector or resource group
- **THEN** it SHOULD reuse the same provider exchanger, archive lifecycle, scope/coverage projection, and token storage abstractions
- **AND** it SHOULD avoid duplicating Google-specific OAuth/archive machinery per connector.
