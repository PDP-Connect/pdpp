# publish-mcp-server-package — Tasks

## 1. Manifest and Release-Train Wiring (repo side)

- [x] 1.1 Remove `"private": true` from `packages/mcp-server/package.json`.
- [x] 1.2 Add `publishConfig` (`access: public`, `provenance: false`,
  `registry: https://registry.npmjs.org/`, `tag: latest` — originally `beta`,
  flipped by `adopt-single-release-channel`) to
  `packages/mcp-server/package.json`.
- [x] 1.3 Strengthen `scripts.verify` to run tests AND smoke the bin entrypoint
  (`node bin/pdpp-mcp-server.js --help`, exit-0 check).
- [x] 1.4 Add `scripts.pack:dry-run` to `packages/mcp-server/package.json`.
- [x] 1.5 Add `pkgRoot: "packages/mcp-server"` entry under
  `@semantic-release/npm` plugins in `.releaserc.yaml`.
- [x] 1.6 Add `mcp-server` scope entries (feat/fix/perf) to both
  `commit-analyzer` and `release-notes-generator` plugin sections in
  `.releaserc.yaml`.

## 2. README

- [x] 2.1 Replace the "private workspace package" Publication status paragraph in
  `packages/mcp-server/README.md` with the published-package posture paragraph.

## 3. OpenSpec

- [x] 3.1 Author `openspec/changes/publish-mcp-server-package/proposal.md`.
- [x] 3.2 Author `openspec/changes/publish-mcp-server-package/tasks.md`.

## 4. Verification (repo side — run before merge)

- [x] 4.1 Run `pnpm --filter @pdpp/mcp-server run verify` — tests pass and
  `--help` exits 0.
- [x] 4.2 Run `pnpm --filter @pdpp/mcp-server run pack:dry-run` — inspect
  tarball manifest: only `bin/`, `src/`, `README.md`, and `package.json`;
  no `test/`, `node_modules/`, or fixture bloat.
- [x] 4.3 Run `node scripts/check-package-release-policy.mjs` from repo root —
  policy check passes for all four publishable packages.
- [x] 4.4 Run `openspec validate publish-mcp-server-package --strict`.
- [x] 4.5 Run `openspec validate --all --strict`.
- [x] 4.6 Fix the published-package dependency contract after `npx` proved
  `@pdpp/mcp-server@0.18.11` still carried workspace protocol dependencies.
  Publishable packages now reject `workspace:` dependencies in release policy,
  and the release quality job verifies every publishable package before
  publishing.
- [x] 4.7 Pack the MCP server tarball locally, inspect `package/package.json`
  for registry-resolvable `@pdpp/cli` and `@pdpp/read-core` dependency ranges,
  install the tarball into a scratch npm project, and run
  `pdpp-mcp-server --help` successfully.

## 5. Owner-Gated Bootstrap (after merge, before the first release cut)

> These steps cannot be performed by a repo contributor. They require owner
> access to the npm organization and the GitHub repository settings.

- [x] 5.1 **[OWNER]** On npmjs.com, create the `@pdpp/mcp-server` package with
  a placeholder `0.0.0` publish (matching the bootstrap procedure used for
  `@pdpp/cli` and `@pdpp/local-collector`).
- [x] 5.2 **[OWNER]** On npmjs.com → `@pdpp/mcp-server` → Settings →
  "Publishing access", add the GitHub Actions trusted publisher:
  `vana-com/pdpp` repository, `semantic-release` workflow, `release` job —
  matching the existing trusted-publisher entries for `@pdpp/cli` and
  `@pdpp/local-collector`.
- [x] 5.3 **[OWNER]** Land the first release-worthy Conventional Commit on
  `main` to trigger the release pipeline. The initial `0.18.11` release proved
  package bootstrap and trusted publishing, then exposed the workspace-protocol
  manifest bug fixed in task 4.6.
- [x] 5.4 **[OWNER]** Verify `npx -y @pdpp/mcp-server@latest --help` resolves and
  exits 0 after the release pipeline completes. Verified against
  `@pdpp/mcp-server@0.18.12`, whose published manifest uses
  registry-resolvable `@pdpp/cli` and `@pdpp/read-core` dependency ranges.
