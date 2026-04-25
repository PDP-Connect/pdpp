## 1. Release Configuration

- [x] Add semantic-release configuration and package scripts for dry-run and CI release execution.
- [x] Add required release dependencies with pinned lockfile updates.
- [x] Ensure release automation follows Conventional Commits and does not infer protocol-version changes from package version alone.

## 2. CI Workflow

- [x] Add a trusted default-branch workflow that validates, computes the next version, creates a GitHub release, and publishes versioned GHCR images.
- [x] Keep PR Docker validation separate from release publication.
- [x] Publish both reference AS/RS and web image targets with stable version tags.
- [x] Ensure workflow permissions are least-privilege for contents, packages, and id-token usage.

## 3. Documentation

- [x] Document maintainer release flow, local dry-run command, and required GitHub secrets/permissions.
- [x] Document Docker image tag semantics for `main`, exact `${version}`, moving `${major}.${minor}`, `latest`, and `sha-*` tags.
- [x] Document that public release automation never bundles local `.env`, SQLite data, model cache, or owner data.

## 4. Validation

- [x] Run local semantic-release dry-run.
- [x] Run Docker build validation for reference and web targets.
- [x] Run relevant package verification before publication workflow is enabled.
- [x] Run `openspec validate add-semantic-release-automation --strict`.
- [x] Run `openspec validate --all --strict`.
