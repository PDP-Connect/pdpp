## Why

PDPP now has more than one public npm package. The CLI release work established
semantic-release and npm trusted publishing, and the local collector extends
that path, but the shared rule is not yet a durable contract. Without an
explicit package-release policy, future packages can drift into mismatched
versioning, token-based publication, or accidental workspace publication.

## What Changes

- Define one package-release policy for publishable `@pdpp/*` packages in the
  reference implementation.
- Keep the current monorepo release train: semantic-release owns published
  versions, package manifests keep `0.0.0`, and beta releases publish from the
  `beta` branch.
- Require tokenless npm trusted publishing/OIDC as the normal path and reserve
  `NPM_TOKEN` for emergency/manual bootstrap only.
- Add a repo-local policy checker and run it in the semantic-release quality
  gate.

## Capabilities

### Modified Capabilities

- `reference-implementation-governance`: npm package publication becomes a
  governed release surface for all publishable PDPP packages, not only
  `@pdpp/cli`.

## Impact

- `.github/workflows/semantic-release.yml`
- `.releaserc.yaml`
- `package.json`
- `scripts/check-package-release-policy.mjs`
- `docs/package-release-policy.md`
- OpenSpec release-governance requirements
