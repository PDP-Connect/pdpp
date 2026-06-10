# reference-implementation-governance deltas: adopt-single-release-channel

## MODIFIED Requirements

### Requirement: Publishable npm packages SHALL use the shared PDPP package release policy

Every publishable `@pdpp/*` npm package in the reference implementation SHALL
use the same semantic-release-governed npm publishing and versioning policy:
a single release channel publishing 0.x versions from `main` to npm's default
`latest` dist-tag.

#### Scenario: A package is intended for public npm publication

- **WHEN** a workspace package under `packages/` is public and named `@pdpp/*`
- **THEN** its `package.json` SHALL declare public npm `publishConfig` targeting
  the `latest` dist-tag
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

### Requirement: The PDPP CLI SHALL be published by semantic-release
The repository SHALL publish the public PDPP CLI package to npm through
the official `@semantic-release/npm` plugin as part of the semantic-release
workflow while preserving Conventional Commits release analysis and release-note
generation. Releases are cut from `main` on a single channel: 0.x versions on
npm's default `latest` dist-tag, with no prerelease branch or dist-tag.

#### Scenario: A release-worthy commit reaches `main` before launch
- **WHEN** all release-required CI checks pass and semantic-release determines a new version from Conventional Commits on `main`
- **THEN** semantic-release SHALL publish the CLI package to npm from the configured package root on the default `latest` distribution channel
- **AND** the npm package version SHALL be the semantic-release version
- **AND** release type and release notes SHALL continue to be derived from Conventional Commits
- **AND** npm publication SHALL NOT be implemented as a custom `npm publish` command in `@semantic-release/exec`

#### Scenario: Published versions must remain below 1.0.0 until the owner declares stability
- **WHEN** semantic-release computes the next version on `main`
- **THEN** the repository SHALL keep a release baseline tag below `1.0.0` reachable from `main` so version computation continues the 0.x stream rather than defaulting to a first-release `1.0.0`
- **AND** commits on `main` SHALL NOT carry Conventional Commits breaking-change markers until the owner intentionally declares the 1.0 milestone

#### Scenario: The owner declares 1.0
- **WHEN** the owner intentionally declares the stability milestone
- **THEN** the major bump SHALL land through an OpenSpec-backed release-readiness change as a deliberate breaking-change commit
- **AND** the change SHALL NOT alter the single-channel release shape

#### Scenario: The release workflow publishes to npm from GitHub Actions
- **WHEN** the release job publishes the CLI package to npm
- **THEN** the normal GitHub Actions release path SHALL use npm trusted publishing with `id-token: write`
- **AND** the job SHALL avoid long-lived npm tokens for normal release publication
- **AND** the package SHALL publish provenance when npm supports provenance for the workflow and source repository visibility

#### Scenario: Emergency token publication is used
- **WHEN** trusted publishing is temporarily unavailable and a maintainer uses token-based npm publication
- **THEN** the token fallback SHALL be documented as an emergency/manual path
- **AND** the token SHALL be granular, automation-scoped, time-limited, rotated, and removed after trusted publishing is verified
- **AND** this fallback SHALL NOT satisfy the normal GitHub Actions release scenario

#### Scenario: The release job is configured
- **WHEN** the semantic-release job runs
- **THEN** it SHALL run only after release-required tests and validation have succeeded
- **AND** it SHALL check out full git history
- **AND** it SHALL run on a Node version supported by semantic-release, preferring latest LTS
