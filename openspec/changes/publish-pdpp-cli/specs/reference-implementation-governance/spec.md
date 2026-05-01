## ADDED Requirements

### Requirement: The PDPP CLI SHALL be published by semantic-release
The repository SHALL publish the public PDPP CLI package to npm through
the official `@semantic-release/npm` plugin as part of the semantic-release
workflow while preserving Conventional Commits release analysis and release-note
generation.

#### Scenario: A release-worthy commit reaches the active release branch before launch
- **WHEN** all release-required CI checks pass and semantic-release determines a new prerelease version
- **THEN** semantic-release SHALL publish the CLI package to npm from the configured package root on the beta distribution channel
- **AND** the npm package version SHALL be the semantic-release version
- **AND** release type and release notes SHALL continue to be derived from Conventional Commits
- **AND** npm publication SHALL NOT be implemented as a custom `npm publish` command in `@semantic-release/exec`

#### Scenario: The first beta publish must remain below 1.0.0
- **WHEN** no prior semantic-release tag exists and the owner wants prerelease versions below `1.0.0`
- **THEN** the repository SHALL establish a non-release baseline tag below `1.0.0` before the first beta publish
- **AND** the beta lane SHALL publish from a prerelease branch rather than treating `main` as prerelease-only

#### Scenario: The owner declares the CLI stable
- **WHEN** `pdpp connect` works end-to-end and the owner intentionally enables stable publication
- **THEN** semantic-release MAY publish from a stable branch to the default `latest` npm dist-tag
- **AND** the change SHALL remove beta-only Docker tags intentionally rather than by accident

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
- **AND** it SHALL NOT set `actions/setup-node` `registry-url` for npm publishing

### Requirement: Only intended npm artifacts SHALL be publishable
The repository SHALL prevent accidental npm publication of the workspace root or
reference-server internals.

#### Scenario: semantic-release evaluates npm publication
- **WHEN** semantic-release runs from the repository root
- **THEN** the root package SHALL be marked private
- **AND** npm publication SHALL target only the dedicated CLI package root

#### Scenario: The CLI package is packed for release
- **WHEN** CI builds or packs the CLI package
- **THEN** the packed tarball SHALL include the CLI bin, client helpers, package metadata, license, and readme needed by npm users
- **AND** it SHALL exclude local environment files, token caches, databases, connector captures, real personal data fixtures, reference-server runtime files, and deployment-only assets

#### Scenario: A maintainer verifies the release locally
- **WHEN** a maintainer runs the documented release dry-run or package smoke test
- **THEN** the command SHALL verify semantic-release configuration and CLI package contents without publishing to npm
