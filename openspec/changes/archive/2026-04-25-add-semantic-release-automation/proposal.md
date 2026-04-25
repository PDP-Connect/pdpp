## Why

PDPP now has public Docker images, but release creation and image publication
are still split between ad hoc trusted refs and manual maintainer discipline.
We need a conventional, auditable release path that creates GitHub releases and
publishes stable image tags from the same CI run.

## What Changes

- Add semantic-release automation for the repository's default branch.
- Publish GitHub releases and `v${version}` tags from Conventional Commits.
- Publish versioned GHCR images for the reference AS/RS and web targets as part
  of the successful semantic-release workflow.
- Keep pull-request Docker validation separate from trusted image publication.
- Document maintainer release expectations, Docker image tags, and local dry-run
  checks.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-governance`: adds durable release-governance
  requirements for semantic-release and public Docker image publication.

## Impact

- Adds semantic-release-related development dependencies and scripts.
- Adds a GitHub Actions workflow for automated releases and release image
  publication.
- Adds a small helper script for passing semantic-release version data to later
  workflow jobs.
- Updates Docker/release documentation in the root and reference
  implementation READMEs.
