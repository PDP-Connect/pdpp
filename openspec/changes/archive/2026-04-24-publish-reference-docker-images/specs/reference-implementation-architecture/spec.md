## ADDED Requirements

### Requirement: Public Docker images SHALL be built and published from CI
The reference implementation SHALL provide a CI workflow that builds public
Docker images for the supported Docker runtime targets and publishes them only
from trusted refs.

#### Scenario: A pull request changes Docker-relevant files
- **WHEN** CI runs for a pull request that changes Docker-relevant files
- **THEN** CI SHALL build the supported Docker image targets
- **AND** CI SHALL NOT push images to a public registry from the pull request

#### Scenario: A trusted ref is built
- **WHEN** CI runs for a trusted publishing ref such as the default branch or a
  version tag
- **THEN** CI SHALL build the supported Docker image targets
- **AND** CI SHALL push the resulting images to the configured public registry

#### Scenario: Image publication runs
- **WHEN** CI publishes Docker images
- **THEN** the workflow SHALL use runtime CI credentials or the platform token
- **AND** it SHALL NOT require committed registry credentials
- **AND** it SHALL NOT bake owner passwords, connector credentials, SQLite data,
  embedding cache contents, or browser profile state into the image layers

### Requirement: Public Docker images SHALL carry useful tags and metadata
Published reference Docker images SHALL include documented tags and metadata
that support both convenient testing and reproducible operation.

#### Scenario: An operator chooses an image tag
- **WHEN** an operator reads the Docker documentation
- **THEN** the documentation SHALL explain which tags are moving tags
- **AND** it SHALL explain which tags or digests are appropriate for
  reproducible self-hosting

#### Scenario: CI publishes image metadata
- **WHEN** CI pushes a Docker image
- **THEN** the image SHALL include OCI metadata that identifies the source
  repository and image role
- **AND** the workflow SHALL request SBOM or provenance metadata when the
  registry and builder support it

### Requirement: Docker documentation SHALL support pull-based self-hosting
The reference documentation SHALL describe how to run the reference stack from
public images without requiring a local source build.

#### Scenario: An operator starts from public images
- **WHEN** an operator follows the Docker documentation for public images
- **THEN** they SHALL be told how to prepare runtime environment configuration
- **AND** they SHALL be told how to pull images and start the Compose stack
- **AND** they SHALL be told where the browser-facing origin is expected to be

#### Scenario: An operator persists state
- **WHEN** an operator follows the Docker documentation for public images
- **THEN** the documentation SHALL identify the persisted SQLite database,
  embedding cache, and browser connector/session state locations
- **AND** it SHALL distinguish persisted runtime state from image contents

#### Scenario: An operator upgrades images
- **WHEN** an operator updates a public-image deployment
- **THEN** the documentation SHALL describe how to pull newer images and restart
  the Compose stack without deleting persisted runtime volumes

#### Scenario: A contributor develops with Docker
- **WHEN** a contributor reads the Docker documentation
- **THEN** the documentation SHALL distinguish public-image operation from local
  image builds, smoke validation, and opt-in Docker hot reload
