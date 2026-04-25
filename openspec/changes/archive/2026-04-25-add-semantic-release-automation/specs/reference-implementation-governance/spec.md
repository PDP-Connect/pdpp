## ADDED Requirements

### Requirement: Releases are created by semantic-release

The repository SHALL use semantic-release to create durable public releases from
the default branch using Conventional Commits.

#### Scenario: A release-worthy commit reaches the default branch
- **WHEN** CI runs release automation for `main` and semantic-release determines
  that commits since the last release require a new version
- **THEN** CI SHALL create a GitHub release
- **AND** CI SHALL create a `v${version}` git tag for that release

#### Scenario: No release-worthy commit reaches the default branch
- **WHEN** CI runs release automation for `main` and semantic-release determines
  that no new version is required
- **THEN** CI SHALL complete without creating a GitHub release
- **AND** CI SHALL NOT publish release image tags

#### Scenario: A repository release version is published
- **WHEN** semantic-release publishes a repository version
- **THEN** that version SHALL NOT imply a new PDPP protocol version unless a
  protocol-version change is explicitly included in the relevant protocol
  artifacts

### Requirement: Release Docker images are published from the release workflow

The repository SHALL publish stable public Docker image tags as part of the
successful semantic-release workflow rather than relying on a second workflow
being triggered by the semantic-release-created tag.

#### Scenario: Semantic-release publishes a release
- **WHEN** semantic-release publishes a new release version
- **THEN** CI SHALL publish the supported reference Docker image targets to GHCR
- **AND** the published tags SHALL include the exact version tag, a moving
  major-minor tag, `latest`, and a commit SHA tag

#### Scenario: Release image validation fails
- **WHEN** the Docker targets do not build successfully before the release job
  runs
- **THEN** CI SHALL fail before semantic-release creates the GitHub release
- **AND** CI SHALL NOT publish release image tags

#### Scenario: Pull request CI builds Docker targets
- **WHEN** Docker-relevant files change in a pull request
- **THEN** CI SHALL build the supported Docker targets for validation
- **AND** CI SHALL NOT run semantic-release or publish Docker images from the
  pull request

### Requirement: Release automation keeps secrets out of source and images

Release automation SHALL use CI-provided credentials for GitHub release and GHCR
publication and SHALL NOT require release secrets to be committed or baked into
Docker layers.

#### Scenario: A release workflow runs
- **WHEN** CI creates a GitHub release or publishes Docker images
- **THEN** the workflow SHALL use GitHub Actions credentials or repository
  secrets scoped to CI
- **AND** committed files SHALL NOT contain release tokens, registry passwords,
  owner passwords, connector credentials, SQLite data, embedding cache contents,
  or browser profile state

#### Scenario: A maintainer checks release behavior locally
- **WHEN** a maintainer runs the documented semantic-release dry run
- **THEN** the command SHALL preview release calculation without publishing a
  GitHub release or Docker images
