## Context

The reference implementation already has a repo-local `pdpp` CLI under
`reference-implementation/cli`, but external coding agents cannot reliably get
it. Hosted discovery advertises `pdpp_agent_discovery` and a skill URL, while
authenticated `/v1/**` failures can point to protected-resource metadata, but
the next step still depends on an agent knowing how to install or manually
recreate the CLI flow. In practice weak agents discover the metadata, fetch the
skill, fail to find `pdpp`, and drift toward owner-token or ad hoc raw-HTTP
fallbacks.

The release workflow already uses semantic-release for GitHub releases and then
publishes GHCR images from the resolved version. It intentionally does not
publish npm packages today. To make delegated data access work like mature
developer platforms, PDPP needs an executable public CLI package and a single command that
performs discovery, owner approval, scoped token storage, and schema
verification. The current release config already uses the `conventionalcommits`
preset for `@semantic-release/commit-analyzer` and
`@semantic-release/release-notes-generator`; npm publishing must preserve that
release-analysis behavior.

This design treats the official semantic-release and npm trusted-publishing
documentation as constraints:

- `semantic-release` runs in CI after all required checks pass.
- Conventional Commits remain the release-analysis and release-notes preset.
- Until launch readiness, the active release workflow triggers only from a
  dedicated beta prerelease branch rather than stable `main`.
- The release job checks out full git history, runs on latest Node LTS, and
  does not configure `actions/setup-node` with `registry-url`.
- npm publishing uses `@semantic-release/npm`, not a custom `npm publish` shell
  command hidden inside `@semantic-release/exec`.
- GitHub Actions trusted publishing/OIDC is required for the normal npm release
  path, with npm provenance enabled when the source repository is public.
- The root workspace is private; only the dedicated CLI package is publishable.
- Version bump commits and changelog commits are avoided unless we later accept
  the semantic-release trade-off explicitly.

## Goals / Non-Goals

**Goals:**

- Publish a public npm CLI package, preferably `@pdpp/cli`, that exposes
  `pdpp`.
- Keep semantic-release as the single source of release versioning, Git tags,
  GitHub releases, npm publication, and downstream GHCR image publication.
- Make `npx -y <configured-cli-package> connect <provider-url>` the default
  agent instruction and the default machine-readable discovery hint.
- Ensure `connect` never asks for or stores an owner bearer token during routine
  agent data access.
- Package only the CLI and client-side helpers needed for delegated access; do not
  publish the reference server, connector runtime, databases, fixtures, or local
  deployment secrets inside the CLI tarball.
- Add pack/install/connect smoke tests so the npm artifact is proven before a
  release can publish.

**Non-Goals:**

- This change does not define a new PDPP protocol version.
- This change does not publish all workspace packages.
- This change does not make owner-token bootstrap a routine agent path.
- This change does not solve broad consent, refresh schedules, or sandbox/live
  parity beyond the copy and metadata needed to advertise the CLI.

## Decisions

1. Publish a scoped CLI package named `@pdpp/cli` unless the npm organization is
   unavailable.

   A scoped package communicates authority better than an unscoped name and
   gives the eventual project room for related packages. If the npm `pdpp` scope
   cannot be claimed, use `pdpp-cli` as the fallback and make discovery metadata
   carry the actual package name. The advertised command must be generated from
   package metadata, not hardcoded across docs.

   Alternatives considered: publish `pdpp-reference-implementation` directly or
   keep only repo-local CLI usage. Publishing the reference package would expose
   too much server/runtime surface and make `npx` install slow and confusing.
   Repo-local usage is the current failure mode.

2. Extract the CLI into `packages/cli` and leave the reference
   implementation as a consumer.

   `packages/cli` owns the public npm manifest, bin entrypoint, CLI HTTP
   helpers, project-local cache handling, and delegated-access UX. Reference-only owner,
   seed, trace, and server inspection commands either stay in
   `reference-implementation/cli` or move behind explicit `reference` subcommands
   only if they can be shipped without server-only dependencies. The reference
   implementation can delegate `pnpm --dir reference-implementation cli` to the
   workspace CLI to avoid two divergent command implementations.

   Alternatives considered: symlink the current CLI into npm packaging or build
   a new CLI from scratch. Symlinking risks leaking reference internals into the
   tarball; a rewrite duplicates behavior already covered by tests.

3. Make `pdpp connect <provider-url>` the happy path and keep `pdpp agent ...`
   as advanced/compatibility commands.

   The agent prompt should not require the user or agent to know AS/RS URLs,
   PAR, DCR, RAR, or local cache layout. `connect` performs protected-resource
   metadata discovery, authorization-server discovery, client registration or
   reuse, scoped grant request construction, owner approval handoff, token
   receipt/storage, `/v1/schema` verification, and final status output.

   The implementation should prefer an actual no-paste approval flow. If the
   current AS cannot safely poll for an approved client grant, the auth surface
   must add a narrow agent-connect completion endpoint or device-style flow for
   scoped client grants before `connect` is advertised as complete. Raw HTTP
   remains documented as a maintainer/debug fallback, not the agent happy path.

4. Publish npm through official semantic-release mechanisms on a beta lane until
   launch.

   Add `@semantic-release/npm` to `.releaserc.yaml` with `pkgRoot:
   packages/cli`. Keep `@semantic-release/commit-analyzer` and
   `@semantic-release/release-notes-generator` configured with the
   `conventionalcommits` preset, and keep `@semantic-release/github`. Keep the
   existing `@semantic-release/exec` only for repository-specific GitHub-output
   plumbing and Docker image coordination; do not use it to run `npm publish`.
   The semantic-release branch config includes `main` as the future stable
   branch because semantic-release requires at least one non-prerelease release
   branch, but the workflow triggers only from the `beta` prerelease branch until
   the owner intentionally enables stable `latest` publication.

   Semantic-release's first release defaults to `1.0.0`; therefore the first
   prerelease from an empty tag history would be `1.0.0-beta.1`. If the owner
   wants true pre-1.0 npm versions such as `0.1.0-beta.1`, create a non-release
   baseline tag such as `v0.0.0` before the first beta publish. Semantic-release
   can then increment from that baseline according to Conventional Commits.

   The normal GitHub Actions release path must use npm trusted publishing for
   the workflow file that triggers the release. The release job must depend on
   release-quality checks and release-image validation, use `fetch-depth: 0`,
   grant `contents: write` and `id-token: write`, run on latest Node LTS, and
   avoid `setup-node.registry-url`. `NPM_TOKEN` is allowed only as an
   emergency/manual fallback outside the normal release scenario; if used, it
   must be granular, automation-scoped, time-limited, rotated, and removed after
   trusted publishing is verified. npm provenance remains disabled while the
   GitHub repository is private because npm rejects provenance bundles from
   private source repositories.

5. Keep the root package private and make the CLI package narrowly allowlisted.

   The root `package.json` becomes `"private": true` so semantic-release cannot
   publish the workspace root by accident. The CLI package gets an explicit
   `files` allowlist, `bin`, `exports` if needed, `engines.node`, repository
   metadata matching the GitHub repo, and `publishConfig` for the npm registry,
   beta tag, public access, and provenance. CI must inspect the packed
   tarball and fail on `.env`, local profiles, databases, screenshots,
   connector captures, real fixture artifacts, or reference server files.

6. Discovery and human surfaces advertise the exact executable command.

   Protected-resource metadata gains an `pdpp_agent_discovery.cli` object with
   the package name, bin name, npm command, version policy, and no-owner-token
   policy. Bearer 401 errors include a short `next_step` that points to the
   metadata and, when safe, includes the generated command. The hosted skill,
   `llms.txt`, `llms-full.txt`, deployment docs, and dashboard/reference surface
   show the same command. The dashboard should expose this as a "Connect an AI
   agent" card with a copyable command and a note that the owner approves
   scoped access in the browser.

## Risks / Trade-offs

- Npm scope ownership is not guaranteed -> Decide `@pdpp/cli` vs `pdpp-cli`
  before implementation and make all discovery metadata package-name-driven.
- First npm package creation may require token bootstrap before package settings
  exist -> Use the existing organization `NPM_TOKEN` only if needed to create or
  recover the package, then configure trusted publishing and keep token use out
  of the normal release workflow.
- Trusted publishing requires npm-side setup -> Track owner setup as an
  explicit release task and keep any `NPM_TOKEN` fallback outside the normal
  release path as emergency/manual only.
- The current repo-local CLI may contain reference-only server assumptions ->
  Separate public commands from reference commands before packaging and
  prove the tarball contents in CI.
- A one-command connect flow may reveal AS gaps -> Treat no-paste scoped client
  grant completion as part of this tranche; do not advertise `connect` as done
  while it still requires manual token pasting.
- Semantic-release dry-run cannot prove npm trusted publishing end-to-end ->
  Add pack/install smoke tests pre-release and perform a first real publish to a
  temporary dist-tag or throwaway prerelease branch if needed before switching
  discovery metadata to the public command.
- Stable-release perception can outrun product readiness -> Keep npm and GHCR
  publication on the `beta` dist-tag/channel until `pdpp connect` works
  end-to-end and the owner intentionally changes semantic-release back to a
  stable branch. npm keeps a `latest` dist-tag on the only published bootstrap
  version; that `0.0.0` version is deprecated as a placeholder and should be
  superseded by the first semantic-release beta.
- npm provenance currently rejects private GitHub source repositories -> Keep
  `publishConfig.provenance` disabled while `vana-com/pdpp` is private, then
  re-enable it when the repository becomes public.
- Auth completion may be underspecified -> Gate all public metadata/docs that
  advertise `connect` on a proven-safe completion mechanism: either polling with
  bounded server-side state and no token disclosure, or a device/agent-connect
  flow explicitly designed for scoped client grants.
