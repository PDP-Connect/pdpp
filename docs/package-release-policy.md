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

## Install Instructions Pin `@beta` While In Beta-Only Posture

The release train publishes prereleases to npm's `beta` dist-tag. It does **not**
publish a stable release, so the default `latest` dist-tag still points at the
placeholder `0.0.0` that was created during owner bootstrap. Installing either
publishable package by bare name (no `@beta` tag) therefore resolves to that
empty placeholder.

Until a publishable package is intentionally promoted to a real stable release
(see the promotion step below), every operator-facing install/exec instruction
SHALL pin the package with an explicit `@beta` tag (or a pinned version):

```sh
npx -y @pdpp/local-collector@beta advertise
npm i -g @pdpp/cli@beta
```

`pnpm release:policy-check` enforces this statically and offline: it fails when
an active install doc references a publishable package in an `npm`/`pnpm`/`npx`
install or exec command without an explicit tag. Shell comments and Markdown
headings are ignored.

## Verifying The Live Dist-Tag Posture

`pnpm release:policy-check` is hermetic and runs before every publish, so it
cannot inspect the registry. Use the network-aware companion check to confirm
the live posture:

```sh
pnpm release:dist-tag-check
```

It queries `npm view <package> dist-tags` for each publishable package and fails
when `latest` resolves to the placeholder `0.0.0` (or is missing while a `beta`
version exists). Unpublished packages and an unreachable registry are reported
as `SKIP`, not failures, unless you pass `--require-reachable`.

This check is an owner/release-readiness gate, not part of the blocking publish
path, because the placeholder `latest` it detects is the known consequence of
the beta-only posture and only an owner promotion can clear it. While the
posture is intentional, acknowledge it explicitly:

```sh
PDPP_RELEASE_DIST_TAG_WAIVER="Beta-only pre-launch posture; promotion gated on owner release-readiness decision." \
  pnpm release:dist-tag-check
```

The waiver exits `0` but still prints the finding and the reason, so the
acknowledgement stays visible rather than silently passing.

## Enforcement

Run:

```sh
pnpm release:policy-check
pnpm release:policy-check:test
```

`pnpm release:policy-check` (and its unit test) runs in the semantic-release
quality job before npm publication. `pnpm release:dist-tag-check` is run by the
release owner during a release-readiness review, not in the blocking publish
path.

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

### Owner step to move `latest` off the placeholder `0.0.0`

`pnpm release:dist-tag-check` fails today because `@pdpp/cli` and
`@pdpp/local-collector` both have `latest` pinned to the bootstrap placeholder
`0.0.0`. Clearing this is an owner action against npm registry state (CI does
not mutate dist-tags outside a real publish):

1. Land the OpenSpec-backed release-readiness change that adds a non-prerelease
   release lane (publishing from `main` in `.releaserc.yaml`), so
   `@semantic-release/npm` produces a real stable version and publishes it to
   the default `latest` dist-tag.
2. After that stable version exists on npm, retire the placeholder so it can
   never be resolved again — for each publishable package:

   ```sh
   # latest now points at the real release; deprecate the dead placeholder
   npm deprecate @pdpp/cli@0.0.0 "Placeholder bootstrap version; use the published release."
   npm deprecate @pdpp/local-collector@0.0.0 "Placeholder bootstrap version; use the published release."
   ```

   (`npm unpublish @pdpp/<pkg>@0.0.0` is also possible inside npm's unpublish
   window, but deprecation is the durable, always-available option.)
3. Re-run `pnpm release:dist-tag-check` (without a waiver) and confirm it reports
   `OK` for every publishable package, then drop the `@beta` pin from the
   install docs in the same release-readiness change.

Until step 1 ships, keep the install docs pinned to `@beta` and acknowledge the
posture with `PDPP_RELEASE_DIST_TAG_WAIVER` rather than letting the check pass
silently.
