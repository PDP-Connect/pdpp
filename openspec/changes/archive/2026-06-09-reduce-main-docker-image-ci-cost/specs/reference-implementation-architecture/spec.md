## MODIFIED Requirements

### Requirement: Public Docker images SHALL be built and published from CI
The reference implementation SHALL provide CI workflows that validate supported
Docker runtime targets on Docker-relevant changes and publish public Docker
images only from explicit trusted publishing events.

#### Scenario: A pull request changes Docker-relevant files
- **WHEN** CI runs for a pull request that changes Docker-relevant files
- **THEN** CI SHALL build the supported Docker image targets for validation
- **AND** CI SHALL NOT push images to a public registry from the pull request

#### Scenario: A default-branch push changes Docker-relevant files
- **WHEN** CI runs for a default-branch push that changes Docker-relevant files
- **THEN** CI SHALL build the supported Docker image targets for validation
- **AND** CI SHALL NOT push images to a public registry from that ordinary
  default-branch push

#### Scenario: A trusted publishing event runs
- **WHEN** CI runs for an explicit trusted publishing event such as a release tag
  or maintainer-dispatched image publication
- **THEN** CI SHALL build the supported Docker image targets
- **AND** CI SHALL push the resulting images to the configured public registry

#### Scenario: Image publication runs
- **WHEN** CI publishes Docker images
- **THEN** the workflow SHALL use runtime CI credentials or the platform token
- **AND** it SHALL NOT require committed registry credentials
- **AND** it SHALL NOT bake owner passwords, connector credentials, SQLite data,
  embedding cache contents, or browser profile state into the image layers

#### Scenario: Validation-only Docker CI runs
- **WHEN** CI builds Docker image targets only for validation
- **THEN** the workflow MAY use a cheaper single-platform build shape
- **AND** that validation-only build SHALL NOT be treated as the published
  platform set for stable release images
