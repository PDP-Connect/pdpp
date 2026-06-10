# PDPP Package Release Policy

PDPP uses one monorepo release train for publishable npm packages. The release
train is intentionally boring: semantic-release determines a single repository
version from Conventional Commits, GitHub Actions publishes from `main`, and
every publishable `@pdpp/*` package follows the same npm posture.

There is **one release channel**. Releases are 0.x versions published to npm's
default `latest` dist-tag. Semver 0.x already signals prelaunch — a separate
prerelease branch/dist-tag is a second moving part that goes stale (the retired
`beta` branch drifted three weeks behind `main`, broke two release runs, and
nearly regressed the live collector). `1.0.0` is the stability milestone, cut
intentionally, not a side effect of a commit type.

## Current Publishable Packages

- `@pdpp/cli`
- `@pdpp/local-collector`
- `@pdpp/mcp-server`

Packages such as `@opendatalabs/remote-surface` (formerly `@pdpp/remote-surface`),
`@pdpp/polyfill-connectors`, `@pdpp/reference-contract`, and `@pdpp/brand` remain
private unless a future OpenSpec change explicitly makes them publishable.

## Versioning

- Published npm versions are owned by semantic-release.
- Publishable package manifests keep `version: "0.0.0"` in git.
- Releases are cut from `main` and publish to npm's default `latest` dist-tag.
- Versions stay in the 0.x range until the owner intentionally declares 1.0.
  Conventional Commits on `main` use `feat`/`fix`/`perf` (never a breaking-change
  marker) until that decision is made.
- The packages publish in lockstep from the same repository version stream.
- Per-package readability comes from Conventional Commit scopes in release
  notes, not independent package versions. For example,
  `feat(local-collector): ...` is rendered under
  `Features (@pdpp/local-collector)`.

Independent per-package versioning is intentionally out of scope until package
cadence divergence becomes real enough to justify that complexity.

Note on release cadence and noise: semantic-release only cuts a release when a
Conventional `feat`/`fix`/`perf` commit lands on `main`. Most commits on `main`
do not follow the Conventional format and therefore do not release. The
commit-analyzer scopes in `.releaserc.yaml` group release notes per package;
they do **not** gate the release decision — a `feat(console): ...` commit bumps
the shared version and republishes all packages and images (the console ships
in the `web` image, so this is intentional, at the cost of occasional no-op npm
version bumps).

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
- declare `publishConfig` as public npm publication to the `latest` dist-tag
  with provenance disabled while this repository is private;
- declare `repository.directory`, `engines.node`, `license`, `description`, and
  an explicit `files` allowlist;
- expose `scripts.verify` for release quality checks;
- have a package-local `README.md`.

Private workspace packages SHALL NOT declare `publishConfig`. Every
`package.json` in this repository is private by default; a package may omit
`private: true` only when it is explicitly covered by this policy as a public
npm package.

## Install Instructions Use Plain Package Names

Install and exec instructions reference publishable packages by plain name —
`latest` is npm's default dist-tag, so no tag pin is needed:

```sh
npx -y @pdpp/local-collector advertise
npm i -g @pdpp/cli
```

The retired `@beta` dist-tag SHALL NOT appear in active install docs.
`pnpm release:policy-check` enforces this statically and offline: it fails when
an active install doc references a publishable package with the `@beta` tag in
an `npm`/`pnpm`/`npx` install or exec command. Shell comments and Markdown
headings are ignored, as are pinned versions (including historical
`@0.1.0-beta.N` versions, which are factual version names).

## Verifying The Live Dist-Tag Posture

`pnpm release:policy-check` is hermetic and runs before every publish, so it
cannot inspect the registry. Use the network-aware companion check to confirm
the live posture:

```sh
pnpm release:dist-tag-check
```

It queries `npm view <package> dist-tags` for each publishable package and fails
when `latest` resolves to the placeholder `0.0.0` (or is missing while another
published version exists). Unpublished packages and an unreachable registry are
reported as `SKIP`, not failures, unless you pass `--require-reachable`.

This check is an owner/release-readiness gate, not part of the blocking publish
path. It fails until the first `main` release lands a real stable version on
`latest`; during that window, acknowledge the known posture explicitly:

```sh
PDPP_RELEASE_DIST_TAG_WAIVER="First stable release from main not yet cut; placeholder latest pending graduation release." \
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

Both run in the semantic-release quality job before npm publication.
`pnpm release:dist-tag-check` is run by the release owner during a
release-readiness review, not in the blocking publish path — it detects a
condition (a placeholder `latest`) that only a real release plus owner cleanup
can clear.

The policy check also asserts the single-channel release shape itself:
`.releaserc.yaml` must release from `main` with no prerelease branch, and the
semantic-release workflow must trigger on pushes to `main`.

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

### Owner steps to retire the beta channel completely

The single-channel policy ships in the repo; the registry and branch cleanup is
owner work, after the first `main` release proves out:

1. Verify the first `main` release published a real 0.x version to `latest` for
   every publishable package (`pnpm release:dist-tag-check` reports `OK`).
2. Retire the bootstrap placeholder so it can never be resolved again:

   ```sh
   npm deprecate @pdpp/cli@0.0.0 "Placeholder bootstrap version; use the published release."
   npm deprecate @pdpp/local-collector@0.0.0 "Placeholder bootstrap version; use the published release."
   ```

   (`npm unpublish @pdpp/<pkg>@0.0.0` is also possible inside npm's unpublish
   window, but deprecation is the durable, always-available option.)
3. Point the npm `beta` dist-tag at the stable release (or remove it with
   `npm dist-tag rm <pkg> beta`) so stale `@beta` pins stop resolving old
   prereleases.
4. Delete the `beta` git branch.

### Declaring 1.0

`1.0.0` is an intentional stability milestone, not an accident of commit
phrasing. Before the owner declares it:

- Confirm the intended public packages are installable and proven from
  `latest`.
- Re-enable npm provenance when the source repository is public and trusted
  publishing is verified for every public package.
- Keep repository/package versions distinct from PDPP protocol versions.
- Land the major bump through an OpenSpec-backed release-readiness change (a
  deliberate breaking-change commit), not an incidental `feat!:`.
