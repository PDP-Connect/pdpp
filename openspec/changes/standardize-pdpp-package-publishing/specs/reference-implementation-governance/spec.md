## ADDED Requirements

### Requirement: Publishable npm packages SHALL use the shared PDPP package release policy

Every publishable `@pdpp/*` npm package in the reference implementation SHALL
use the same semantic-release-governed npm publishing and versioning policy.

#### Scenario: A package is intended for public npm publication

- **WHEN** a workspace package under `packages/` is public and named `@pdpp/*`
- **THEN** its `package.json` SHALL declare public beta npm `publishConfig`
- **AND** its git-tracked package version SHALL remain `0.0.0`
- **AND** semantic-release SHALL own the published npm version
- **AND** `.releaserc.yaml` SHALL include the package root in the
  `@semantic-release/npm` publish set

#### Scenario: A package manifest is not listed for public npm publication

- **WHEN** a package manifest in the repository is not intended for public npm
  publication
- **THEN** it SHALL remain private
- **AND** it SHALL NOT declare npm `publishConfig`

#### Scenario: The release workflow publishes npm packages

- **WHEN** CI publishes a PDPP npm package through the normal release workflow
- **THEN** the workflow SHALL use GitHub Actions OIDC / npm trusted publishing
- **AND** the workflow SHALL NOT require `NPM_TOKEN` or `NODE_AUTH_TOKEN`
- **AND** token-based publication SHALL be limited to owner-controlled bootstrap
  or emergency recovery outside the normal release path

#### Scenario: A new public package is added

- **WHEN** an OpenSpec change makes another `@pdpp/*` package public
- **THEN** the package SHALL either join the shared release train and pass the
  package-release policy checker or explicitly define and justify a different
  release policy in that change

### Requirement: Package release policy SHALL be machine-checked before publication

The release workflow SHALL run a package-release policy checker before npm
publication.

#### Scenario: A release-worthy commit reaches the active release branch

- **WHEN** the semantic-release workflow prepares to publish npm packages
- **THEN** CI SHALL verify that publishable package manifests, semantic-release
  package roots, release workflow authentication, and private-package boundaries
  match the package-release policy
- **AND** CI SHALL fail before npm publication if the policy check fails
