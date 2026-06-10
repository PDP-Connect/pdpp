# publish-mcp-server-package

## Why

`@pdpp/mcp-server` is the canonical MCP adapter for grant-scoped PDPP reads. It is
advertised as an `npx -y @pdpp/mcp-server` command in:

- the deployed agent skill (`docs/agent-skills/pdpp-data-access/SKILL.md`)
- `packages/mcp-server/README.md` (Install section)
- `docs/operator/hosted-mcp-setup.md`

The package has never been published to npm. Every operator or agent that follows
these instructions receives an npm 404. This is a command-surface contract violation:
a documented, operative install command resolves to a non-existent package.

## What Changes

- `packages/mcp-server/package.json`: remove `private: true`; add `publishConfig`
  (public, `latest` dist-tag, provenance disabled while repo is private); add
  `scripts.verify` bin smoke (`--help` exit-0 check); add `scripts.pack:dry-run`.
- `.releaserc.yaml`: add `pkgRoot: "packages/mcp-server"` so the release train
  publishes the package on the next release cut; add Conventional Commit scope entries
  for `mcp-server` in both commit-analyzer and release-notes-generator plugins.
- `packages/mcp-server/README.md`: replace the "private workspace package" notice
  with the published posture paragraph, matching `@pdpp/cli` and
  `@pdpp/local-collector` README convention.

## Capabilities

### No New Capabilities

This change does not modify the MCP tool surface, credential semantics, or RS
protocol in any way. It only makes the existing implementation available via the
install path that the documentation already advertises.

### Modified Capabilities

- `mcp-adapter`: the stdio MCP adapter is now available as a published npm package
  (`@pdpp/mcp-server`) installable without cloning the repository, matching
  the install instructions in the operator docs and agent skill.

## Impact

- Requires a one-time owner npm trusted-publisher bootstrap for
  `@pdpp/mcp-server` (identical procedure to `@pdpp/cli` and
  `@pdpp/local-collector`).
- No change to the MCP protocol surface, tool list, credential handling, or
  hosted-MCP routing.
- The `workspace:*` dep on `@pdpp/cli` is replaced with the published semver
  range by pnpm at publish time (standard pnpm workspace protocol replacement).
