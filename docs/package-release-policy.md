# PDPP Package Release Policy

PDPP uses one monorepo release train for publishable npm packages. The release
train is intentionally boring: semantic-release determines a single repository
version from Conventional Commits, GitHub Actions publishes from the `beta`
branch while the reference implementation is pre-launch, and every publishable
`@pdpp/*` package follows the same npm posture.

## Current Publishable Packages

- `@pdpp/cli`
- `@pdpp/local-collector`

Packages such as `@opendatalabs/remote-surface` (formerly `@pdpp/remote-surface`),
`@pdpp/polyfill-connectors`, `@pdpp/reference-contract`, and `@pdpp/brand` remain
private unless a future OpenSpec change explicitly makes them publishable.

## Versioning

- Published npm versions are owned by semantic-release.
- Publishable package manifests keep `version: "0.0.0"` in git.
- `beta` releases publish to npm's `beta` dist-tag.
- The packages publish in lockstep from the same repository version stream.
- Per-package readability comes from Conventional Commit scopes in release
  notes, not independent package versions. For example,
  `feat(local-collector): ...` is rendered under
  `Features (@pdpp/local-collector)`.

Independent per-package versioning is intentionally out of scope until package
cadence divergence becomes real enough to justify that complexity.

## Publishing Authentication

The normal release path is tokenless npm trusted publishing from GitHub Actions:

- `.github/workflows/semantic-release.yml` grants `id-token: write`.
- semantic-release uses `@semantic-release/npm` for each publishable package
  root.
- The workflow must not use `NPM_TOKEN` or `NODE_AUTH_TOKEN` for the normal npm
  publish path.
- `NPM_TOKEN` is only an emergency/manual fallback. If used, it must be
  granular, automation-scoped, time-limited, rotated, and removed after trusted
  publishing is verified.

First publication of a new package may still require owner-controlled bootstrap
work in npm before trusted publishing can be configured for that package.
Trusted publisher setup is package-specific; `@pdpp/cli` being configured does
not automatically configure `@pdpp/local-collector` or future packages.

## Package Manifest Contract

Every publishable PDPP package SHALL:

- live under `packages/`;
- be named `@pdpp/<name>`;
- declare `publishConfig` as public npm beta publication with provenance
  disabled while this repository is private;
- declare `repository.directory`, `engines.node`, `license`, `description`, and
  an explicit `files` allowlist;
- expose `scripts.verify` for release quality checks;
- have a package-local `README.md`.

Private workspace packages SHALL NOT declare `publishConfig`. Every
`package.json` in this repository is private by default; a package may omit
`private: true` only when it is explicitly covered by this policy as a public
npm package.

## Enforcement

Run:

```sh
pnpm release:policy-check
```

The same check runs in the semantic-release quality job before npm publication.

## Release-Readiness Checklist

Before adding or unprivatizing a public package:

- Add or update an OpenSpec change that names the package, binary/export
  contract, versioning model, and why it belongs on npm.
- Decide whether the package joins the shared semantic-release train. Today,
  the default answer is yes.
- Add package metadata, `files`, `scripts.verify`, `README.md`, and package
  validation before adding the package to `.releaserc.yaml`.
- Bootstrap the npm package under owner control if npm requires first-package
  creation before trusted publisher setup.
- Configure npm trusted publishing for
  `vana-com/pdpp/.github/workflows/semantic-release.yml` for that exact package.
- Run `pnpm release:policy-check`, the package's `verify` script, and
  `openspec validate <change> --strict`.

Before promoting from beta to stable/latest:

- Confirm the intended public packages are already published and installable
  from `beta`.
- Confirm docs, hosted metadata, and dashboard copy no longer describe beta as
  experimental.
- Change semantic-release branch/dist-tag behavior in an OpenSpec-backed
  release-readiness change.
- Re-enable npm provenance when the source repository is public and trusted
  publishing is verified for every public package.
- Keep repository/package versions distinct from PDPP protocol versions.
