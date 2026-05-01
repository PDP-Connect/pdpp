## 1. Package And Naming Decisions

- [x] 1.1 Decide whether the public package name is `@pdpp/cli` or the fallback `pdpp-cli`, and record the npm owner/setup steps including whether first package creation needs the existing organization `NPM_TOKEN` before trusted publishing is configured.
- [x] 1.2 Add a package-name source of truth used by metadata, docs, CLI help, and tests.
- [x] 1.3 Mark the root `package.json` private to prevent accidental workspace-root npm publication.
- [x] 1.4 Create `packages/cli` with a narrow `package.json`, `bin.pdpp`, `files` allowlist, `engines.node`, repository metadata, README, and license handling.

## 2. CLI Extraction

- [x] 2.1 Move or extract public CLI code from `reference-implementation/cli` into `packages/cli` without importing server-only modules.
- [x] 2.2 Keep reference-only commands repo-local or explicitly mark them reference-only if they remain reachable.
- [x] 2.3 Make the existing `reference-implementation` CLI entry delegate to or reuse the workspace CLI where appropriate.
- [x] 2.4 Add unit tests for package startup, help output, cache layout, secret file permissions, and missing-dependency behavior from outside the repo.

## 3. Connect Flow

- [x] 3.1 Implement `pdpp connect <provider-url>` or finalize an equivalent command name and make it the advertised happy path.
- [x] 3.2 Implement provider URL normalization and protected-resource/authorization-server metadata discovery.
- [x] 3.3 Implement public-client registration or safe client reuse for delegated access.
- [x] 3.4 Choose and document the scoped-grant completion mechanism: proven-safe polling, device-style flow, or a narrow hosted agent-connect completion endpoint. Backend uses a narrow hosted `/agent-connect` polling handoff over an existing PAR `request_uri`.
- [x] 3.5 Implement owner approval handoff and token completion without requiring an owner-token paste.
- [x] 3.6 Store approved scoped client credentials in the project-local `.pdpp/` cache with `.gitignore` hygiene.
- [x] 3.7 Verify the new grant with `/v1/schema` and print a bounded success summary.
- [x] 3.8 Return actionable bounded errors for metadata failure, denied approval, expired grant, insufficient scope, and token verification failure.
- [x] 3.9 Gate public metadata/docs that advertise `pdpp connect` on the completed no-owner-token token-completion mechanism.
- [x] 3.10 Add a minimal `pdpp token <provider-url>` command so agents can use an approved cached credential without reading cache internals.

## 4. Semantic-Release Npm Publishing

- [x] 4.1 Add official `@semantic-release/npm` publishing for the CLI package root while keeping the existing `conventionalcommits` commit analysis, release notes, GitHub release, and repository output integration.
- [x] 4.2 Configure the release job to follow official semantic-release GitHub Actions guidance: full git checkout, latest Node LTS or documented supported-LTS equivalent, no `setup-node.registry-url`, and semantic-release only after required checks pass.
- [x] 4.3 Add `id-token: write` to the npm-publishing semantic-release job and configure npm trusted publishing for the triggering workflow file.
- [x] 4.4 Document any emergency/manual `NPM_TOKEN` fallback as granular, automation-scoped, time-limited, rotating, removable after trusted publishing is verified, and not part of the normal release path.
- [x] 4.5 Add release dry-run checks that validate semantic-release config without publishing.
- [x] 4.6 Preserve existing GHCR image publication behavior after semantic-release publishes a repository version.
- [x] 4.7 Reset the accidental stable `v1.0.0` release/tag and keep prerelease publication on the beta channel until launch readiness.
- [x] 4.8 Create a `beta` prerelease branch and, if the first public prerelease must stay below `1.0.0`, push a non-release `v0.0.0` baseline tag before the first beta publish.
- [x] 4.9 Bootstrap the `@pdpp/cli` npm package as public `0.0.0`, deprecate it as a placeholder, and remove the temporary bootstrap branch/worktree.

## 5. Package Validation

- [x] 5.1 Add a CLI package pack smoke test that inspects `npm pack --dry-run` or equivalent output against an explicit allow/deny list.
- [x] 5.2 Add a temp-project install smoke test that installs the packed tarball and runs `pdpp --help`.
- [x] 5.3 Add a local reference integration smoke test for `pdpp connect <local-reference-url>` with mocked or test-only owner approval. `pnpm cli:connect-smoke` now starts an isolated native reference server, runs the local CLI from a temp project, approves via the test-only consent path, verifies `/v1/schema`, and fails if the flow does not complete.
- [x] 5.4 Add a regression check that the package tarball excludes `.env*`, `.pdpp`, databases, connector captures, personal data fixtures, screenshots, node reports, and server-only runtime files.

## 6. Discovery, Skill, And Web Surface

- [x] 6.1 Extend `pdpp_agent_discovery` metadata with CLI package, bin, install/run command, connect command, version policy, and no-owner-token policy.
- [x] 6.2 Update bearer-auth 401 next-step text to point agents at the CLI connect flow when safe.
- [x] 6.3 Update hosted `pdpp-data-access` skill content so the first fallback for missing CLI is `npx -y <package> connect <provider-url>`, not raw HTTP.
- [x] 6.4 Update `llms.txt`, `llms-full.txt`, reference docs, and deployment docs with the same generated command.
- [x] 6.5 Add a dashboard/reference "Connect an AI agent" card with a copyable command and live-vs-sandbox labeling.
- [x] 6.6 Add tests that metadata, skill text, llms text, and web copy use the same package-name source of truth.

## 7. Acceptance Checks

- [x] 7.1 Run `pnpm install --frozen-lockfile`.
- [x] 7.2 Run the final CLI package test command, for example `pnpm --filter <configured-cli-package> test`.
- [x] 7.3 Pack the final CLI package and install the resulting tarball in a temporary project.
- [x] 7.4 Run the local `pdpp connect` integration smoke test against the reference server. `pnpm cli:connect-smoke` passed.
- [x] 7.5 Verify metadata/docs do not advertise `pdpp connect` until the scoped-grant token-completion path passes the integration smoke test. The smoke now passes for native reference providers; metadata reports `no_owner_token: true` only when the deployment can complete the one-command flow, and docs/skills describe owner-browser approval instead of owner-token paste.
- [x] 7.6 Run `pnpm --dir reference-implementation run verify`.
- [x] 7.7 Run `pnpm spec:check`.
- [x] 7.8 Run `pnpm release:dry-run` and verify semantic-release reaches npm verify/publish planning without publishing. With local GitHub auth exported as `GH_TOKEN`/`GITHUB_TOKEN`, semantic-release verified npm and GitHub conditions, found `v0.0.0`, analyzed zero commits, and published nothing.
- [x] 7.9 Run `openspec validate publish-pdpp-cli --strict`.
