# publish-pdpp-local-collector

## Why

`introduce-local-collector-runner` proved the local collector lane and added a
`pdpp collector` command surface in `@pdpp/cli`, but from an `npm install -g
@pdpp/cli` the command fails fast and points the operator at the monorepo. The
distribution gap is intentional: today the runner lives in
`@pdpp/polyfill-connectors`, which is `private: true`, depends on Playwright,
Patchright, Chromium, `better-sqlite3`, `pdf-parse`, `imapflow`, and a
`postinstall` browser download. Shipping any of that inside the public
`@pdpp/cli` tarball would break the boundaries set by `publish-pdpp-cli` and
`unify-pdpp-cli-command-surface`.

A 95%+ confidence distribution contract is needed before the `pdpp collector`
namespace can be advertised as npm-installable. This change defines that
contract end-to-end (package shape, runtime slice, connector entrypoints,
versioning, operator command, acceptance tests, out-of-scope) so the
implementation tranche that follows is bounded and reviewable.

## What Changes

- Define `@pdpp/local-collector` as a second public npm package owned by the
  PDPP monorepo. It ships the collector runner, the local-device client/queue/
  envelope helpers, the runtime-capabilities profile, and **only**
  filesystem-class connector entrypoints (Claude Code, Codex). The package
  does not own a `pdpp` binary; it exposes `pdpp-local-collector` for direct
  invocation and a programmatic entry for `@pdpp/cli` to spawn.
- Keep `@pdpp/cli` as the only public package that owns the `pdpp` binary, per
  `unify-pdpp-cli-command-surface`. `pdpp collector` becomes a thin shim that:
  (a) resolves `@pdpp/local-collector` via Node module resolution (falling
  back to the monorepo workspace walk when present); (b) on
  `MODULE_NOT_FOUND`, prints a single actionable install hint
  (`npm i -g @pdpp/local-collector` or `npx -y @pdpp/local-collector ...`);
  (c) spawns the runner with the operator's argv.
- Extract a filesystem-only collector runtime slice into `src/runner/` in
  `@pdpp/polyfill-connectors` (still the source of truth in the monorepo) that
  does **not** transitively import `playwright`. The slice is the subset
  already touched by `bin/collector-runner.ts`: collector-runner,
  local-device-client, local-device-envelope, local-device-queue,
  runtime-capabilities, safe-emit, scope-filters, is-main-module, and the
  filesystem-class connector entrypoints. The published `@pdpp/local-collector`
  build copies that slice plus a node-only re-export of the connector-runtime
  message types.
- Connector entrypoints are **bundled, not resolved**: Claude Code and Codex
  ship inside `@pdpp/local-collector` keyed by `connector_id`. There is no
  `--command` arbitrary-binary escape hatch in the public package. Browser /
  Patchright-bound connectors stay in `@pdpp/polyfill-connectors` and are not
  shipped in `@pdpp/local-collector` yet.
- Compatibility with the reference server's device-exporter ingest contract is
  declared by a `collector_protocol_version` constant exported by both
  packages and asserted on enrollment; the dashboard's
  `runtime_capabilities` section surfaces collector version + protocol version
  alongside the existing bindings list.
- Release wiring extends the existing semantic-release pipeline (from
  `publish-pdpp-cli`) to also publish `@pdpp/local-collector`, with a
  `pack-install-run` smoke test against a real reference deployment as the gate.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`
- `reference-surface-topology`

## Impact

- `packages/polyfill-connectors/src/runner/**` — new filesystem-only slice +
  bundled Claude/Codex entrypoints; existing files re-export from the slice
  so monorepo flows keep working.
- `packages/local-collector/**` — new publishable workspace package that
  re-exports the runner slice, owns the npm artifact, and declares
  `bin.pdpp-local-collector`.
- `packages/cli/src/collector/runner.js` — replace monorepo workspace walk
  with `require.resolve('@pdpp/local-collector/runner')`, keep the monorepo
  fallback for in-repo development, replace the npm-missing fail-fast message
  with a one-line install hint.
- `packages/cli/src/collector/commands.js` — drop the
  "monorepo-only" copy from `--help`; advertise the `npx`-able flow.
- `reference-implementation/server/src/**` — accept and surface
  `collector_protocol_version` on enrollment; reject incompatible versions
  with a typed diagnostic.
- `reference-implementation/web/**` — show collector version + protocol
  version on the deployment-diagnostics `runtime_capabilities` row.
- `release.config.cjs` / semantic-release — add `@pdpp/local-collector` to
  the publish set with the same trusted-publishing/OIDC posture.
- Operator-facing docs (`docs/local-collector.md` new, `pdpp connect`
  copy, dashboard hints) — replace "clone the monorepo" instructions with
  the `npx`-able flow.
- Tests — new `pack-install-run` smoke test under `packages/local-collector`,
  CLI shim resolution tests, and a reference server compatibility-version test.
