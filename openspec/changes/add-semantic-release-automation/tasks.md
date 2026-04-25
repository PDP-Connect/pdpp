## 1. Release Configuration

- [ ] Add semantic-release configuration and package scripts for dry-run and CI release execution.
- [ ] Add required release dependencies with pinned lockfile updates.
- [ ] Ensure release automation follows Conventional Commits and does not infer protocol-version changes from package version alone.

## 2. CI Workflow

- [ ] Add a trusted default-branch workflow that validates, computes the next version, creates a GitHub release, and publishes versioned GHCR images.
- [ ] Keep PR Docker validation separate from release publication.
- [ ] Publish both reference AS/RS and web image targets with stable version tags.
- [ ] Ensure workflow permissions are least-privilege for contents, packages, and id-token usage.

## 3. Documentation

- [ ] Document maintainer release flow, local dry-run command, and required GitHub secrets/permissions.
- [ ] Document Docker image tag semantics for `main`, `v${version}`, and any prerelease/dev tags.
- [ ] Document that public release automation never bundles local `.env`, SQLite data, model cache, or owner data.

## 4. Validation

- [ ] Run local semantic-release dry-run.
- [ ] Run Docker build validation for reference and web targets.
- [ ] Run relevant package verification before publication workflow is enabled.
- [ ] Run `openspec validate add-semantic-release-automation --strict`.
- [ ] Run `openspec validate --all --strict`.
