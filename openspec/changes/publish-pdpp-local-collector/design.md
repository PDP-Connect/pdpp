# Design

## Context

`introduce-local-collector-runner` (now archived-eligible after this change
lands) generalized the device-exporter into a collector runner exposed by
`pdpp collector advertise|enroll|run`. The runner lives in
`@pdpp/polyfill-connectors` (`bin/collector-runner.ts` +
`src/collector-runner.ts`) and `pdpp collector` is a workspace-walking
`tsx`-spawn shim in `@pdpp/cli`. From `npm install -g @pdpp/cli` the shim
fails fast with a message that points operators at the monorepo, because:

- `@pdpp/polyfill-connectors` is `private: true` and pulls in `playwright`,
  `patchright`, `better-sqlite3`, `pdf-parse`, `imapflow`, `linkedom`, and a
  `postinstall` Chromium download via Patchright.
- `connector-runtime.ts` (the protocol runtime for every connector, including
  filesystem-only ones) imports Playwright types at the top level. Even pure
  filesystem connectors like Claude Code and Codex transitively reference the
  heavy surface today.
- `publish-pdpp-cli` design explicitly excludes the connector runtime from
  the CLI tarball; `unify-pdpp-cli-command-surface` keeps server-coupled and
  local-dev commands repo-local pending separate publishability review.

The result is a real gap: an operator with only Node/npm and local
`~/.claude` or `~/.codex` data on a host has no push-button path to feed a
remote PDPP reference deployment with their agent transcripts. The monorepo
flow works but is not "publishable" by any reasonable definition.

The audit lane (this change) settles the contract before any code is written.
The mandatory boundary primitives are: `@pdpp/cli` remains the single owner
of `pdpp`, the connector runtime stays separable from filesystem-class
connectors, and the device-scoped ingest contract remains the only path data
takes to the server.

## Goals / Non-Goals

**Goals:**

- Operator with only `node` + `npm` + local Claude/Codex data on disk can run
  the collector against a remote reference deployment in **one shell command**
  per phase (advertise / enroll / run) using `npx -y @pdpp/local-collector` or
  via `pdpp collector` once `@pdpp/cli` is also installed.
- Keep `@pdpp/cli` slim. The published `@pdpp/cli` tarball SHOULD NOT pull
  Playwright, Patchright, Chromium, `better-sqlite3`, `pdf-parse`, or
  `imapflow` even when `pdpp collector` is invoked.
- The published runner ships only filesystem-class connectors (Claude Code,
  Codex). Browser/Patchright-bound connectors stay private until each has its
  own publishability review.
- Compatibility with the reference-server device-exporter ingest contract is
  asserted at enrollment, not implied by version drift.
- Acceptance includes a real `pack-install-run` test against a running
  reference deployment, not just unit tests.

**Non-Goals:**

- Do not publish `@pdpp/polyfill-connectors`. It remains private and remains
  the source of truth in the monorepo.
- Do not introduce a plugin/extension system for the CLI. Connector
  entrypoints are bundled into the published runner; arbitrary
  `--command <bin>` is not a public contract.
- Do not ship browser/Patchright-bound connectors yet. That is a follow-up
  with its own runtime size / browser-download / consent posture.
- Do not change PDPP Core. All collector surfaces remain
  reference/control-plane behavior (per `introduce-local-collector-runner`).
- Do not own a second `pdpp` binary (per
  `unify-pdpp-cli-command-surface`). `@pdpp/local-collector` exposes
  `pdpp-local-collector` and a programmatic entry; only `@pdpp/cli` owns
  `pdpp`.

## Decisions

### 1. Package shape: `@pdpp/local-collector` as a second public package; `@pdpp/cli` shim resolves it

`@pdpp/cli` adds a runtime dependency on `@pdpp/local-collector` is rejected
because the slim-CLI invariant from `publish-pdpp-cli` says the public CLI
tarball must not drag any connector runtime. Even though the filesystem
slice is small, putting it inside `@pdpp/cli` would (a) couple CLI release
cadence to runner release cadence and (b) re-create the temptation to grow
the CLI tarball as more connectors get shipped.

Inlining the runner into `@pdpp/cli` is rejected for the same reason. A pure
CLI shim that fetches a runner package at runtime (an `npx`-on-demand model)
is rejected because it requires network access at every `pdpp collector run`
and obscures the supply chain at the operator's host.

**Chosen shape:**

- `@pdpp/local-collector` is a public, runtime-bearing package. It exports:
  - a CLI binary `pdpp-local-collector` (mirrors today's
    `bin/collector-runner.ts` subcommands `advertise | enroll | run`);
  - a programmatic entry `@pdpp/local-collector/runner` exposing
    `runCollectorConnector`, `enrollCollector`, advertised capabilities, and
    bundled connector entrypoints keyed by `connector_id`;
  - typed errors (`CollectorUsageError`, `RuntimeCapabilityMismatchError`,
    `CollectorStateReadError`) re-exported from
    `@pdpp/local-collector/errors`.
- `@pdpp/cli` keeps owning the `pdpp` binary. `pdpp collector ...` resolves
  `@pdpp/local-collector` lazily and execs its binary, so an operator who
  only installs `@pdpp/cli` never pays for the runner footprint and never
  hits Patchright postinstall noise. The shim's resolution order is:
  1. monorepo workspace walk (preserves current dev flow);
  2. `require.resolve('@pdpp/local-collector/package.json')` from the CLI's
     own `node_modules`;
  3. fail fast with one line:
     `pdpp collector requires @pdpp/local-collector. Install once with
     "npm i -g @pdpp/local-collector" or run "npx -y @pdpp/local-collector ..."`.

This preserves the boundary set by `unify-pdpp-cli-command-surface`
(`@pdpp/cli` is the only public owner of `pdpp`) while letting the collector
runner ship on its own schedule with its own dependency surface.

### 2. Minimum runtime slice: filesystem-class connectors only, separated from the Playwright surface

The audit of today's runtime found:

- `bin/collector-runner.ts` (entry) → `src/collector-runner.ts` (loop) →
  `src/local-device-{client,envelope,queue}.ts` and
  `src/runtime-capabilities.ts` → `src/connector-runtime.ts` (types only for
  the runner; full implementation only for the connector child process) →
  `src/safe-emit.ts` and `src/scope-filters.ts`.
- The runner imports only `EmittedMessage | StartMessage | StreamScope`
  types from `connector-runtime.ts`. The Playwright runtime path is reached
  through the connector child process, not through the runner's own import
  graph.
- Filesystem-class connectors (Claude Code, Codex) import from
  `src/connector-runtime.ts` for `runConnector` and the protocol types. They
  reach `playwright` only via that file's top-level
  `import type { Browser, ... } from "playwright"`. Because it is `import
  type`, TypeScript erases it at build time and the JS output does not
  contain a Playwright require — but the runtime import graph still names
  the package in any tooling that follows imports textually.

**Chosen slice:**

The published `@pdpp/local-collector` package builds from
`packages/polyfill-connectors/src/runner/` — a thin re-export bundle
that depends only on:

- `node:` builtins (`fs`, `path`, `os`, `crypto`, `readline`, `sqlite`,
  `child_process`, `url`);
- `zod` (used by connector validators);
- a new `connector-runtime-protocol.ts` containing only the protocol message
  types (`EmittedMessage`, `StartMessage`, `StreamScope`, `RecordData`,
  `InteractionResponse`, etc.) extracted from `connector-runtime.ts`. The
  existing `connector-runtime.ts` re-exports these types for backward
  compatibility, so connectors keep importing from one place during
  development.
- Filesystem-class connector entrypoints bundled into the runner package:
  Claude Code (`connectors/claude-code` once it lands per
  `complete-local-agent-collectors`) and Codex
  (`connectors/codex/index.ts`). Browser-bound connectors stay in
  `@pdpp/polyfill-connectors` outside this slice.

The build is enforced by:

- a `tsconfig.runner.json` whose `include` does not contain
  `connector-runtime.ts` or any browser-bound connector;
- a CI grep gate that fails the build if the published artifact ever
  contains the strings `from "playwright"`, `from "patchright"`,
  `from "imapflow"`, `from "pdf-parse"`, `from "better-sqlite3"`, or
  `from "linkedom"` outside `node:sqlite` (`node:sqlite` is the
  built-in SQLite Codex already uses).

This is the minimum slice that makes filesystem-only Claude/Codex collection
real without splitting Playwright-bound connectors away from filesystem-only
ones in the monorepo.

### 3. Connector entrypoints are bundled and versioned with the runner package

Two rejected alternatives:

- **`--command <bin>` only.** Letting operators point the runner at any
  binary makes the public package essentially a connector-protocol process
  spawner with no supply chain over connectors. Connectors gain access to a
  device token; arbitrary binaries with that scope is a security regression.
- **Per-connector packages (`@pdpp/connector-claude-code`,
  `@pdpp/connector-codex`).** Premature for two connectors. The release
  surface multiplies, version-skew bugs multiply, and the operator command
  grows extra `npx -p ... -p ... ...` noise.

**Chosen shape:**

- `@pdpp/local-collector` ships Claude Code and Codex entrypoints inside its
  own `dist/`. The runner resolves them by `connector_id`. `--connector
  claude_code` and `--connector codex` are the supported flags; `--command`
  remains for monorepo development but is **not advertised** in the public
  package help. The published runner refuses `--command` unless
  `PDPP_LOCAL_COLLECTOR_ALLOW_CUSTOM_COMMAND=1` is set, with a one-line
  error pointing at the OpenSpec change for the rationale.
- Versioning: the runner package version is the connector-bundle version.
  Connectors do not declare their own published versions until and unless a
  per-connector publishability review (future change) decides to split them.
- Compatibility with the reference server's device-exporter ingest contract
  is declared explicitly:
  - Both `@pdpp/local-collector` and
    `reference-implementation/server` export a
    `COLLECTOR_PROTOCOL_VERSION` constant (semver-major-only; starts at
    `"1"`).
  - On enrollment the client sends
    `collector_protocol_version` and the server stores it on the device row.
  - Each request to a device-exporter ingest route carries the version in
    `X-PDPP-Collector-Protocol`; the server rejects mismatches with
    `409 collector_protocol_mismatch` and a JSON body listing supported
    versions, **before** persisting any record.
  - The `runtime_capabilities` row on deployment-diagnostics shows
    `protocol_version`, `runner_version`, and bundled `connector_versions`
    for visible drift.

### 4. Operator command on a fresh host

The supported operator path for a fresh host with only Node and local agent
homes is:

```bash
# one-time install (either form is supported)
npm i -g @pdpp/local-collector
# or use npx for each invocation:
#   npx -y @pdpp/local-collector advertise

# sanity check capabilities (network, filesystem, local_device)
pdpp-local-collector advertise

# enroll against the reference deployment (one-time per host+source)
pdpp-local-collector enroll \
  --base-url https://<reference-host> \
  --code <one-time-code>

# run a connector (repeat with --connector codex)
pdpp-local-collector run \
  --base-url https://<reference-host> \
  --device-id <id> --device-token <token> \
  --source-instance-id <id> \
  --connector claude_code
```

If `@pdpp/cli` is also installed (the recommended path for agents), the same
flow is reachable through `pdpp collector advertise|enroll|run`, which the
CLI shim execs against the resolved `@pdpp/local-collector` binary. The shim
does not duplicate flag definitions; it forwards argv. The `pdpp collector`
help text in `@pdpp/cli` defers to `pdpp-local-collector --help` for the
runner-owned flags.

Browser/Patchright-bound connectors are explicitly out of scope here; the
fresh-host path covers Claude Code and Codex only.

### 5. Release wiring

`publish-pdpp-cli` established the semantic-release pipeline, npm trusted
publishing/OIDC, and provenance. This change extends that pipeline:

- Add `@pdpp/local-collector` to the publish set with the same
  trusted-publishing posture.
- `@pdpp/cli` and `@pdpp/local-collector` publish from one shared
  semantic-release version stream (single `.releaserc.yaml`, single set of
  `branches:`, one tag per release). Both packages move in lockstep so an
  operator on `@pdpp/cli@x.y.z` and `@pdpp/local-collector@x.y.z` can rely
  on a known protocol compatibility window. We do **not** introduce
  multi-semantic-release or per-package independent versions here —
  splitting that pipeline is its own change with its own publishability
  review, and not in scope for this closeout.
- Within that shared release, Conventional Commit scopes drive readable
  per-package release-notes sections, not independent versions.
  `feat(local-collector): X` lands under `### Features (@pdpp/local-collector)`,
  `feat(cli): Y` lands under `### Features (@pdpp/cli)`, and an unscoped
  `feat: Z` falls back to the generic `### Features` section. The mapping
  is configured via the conventionalcommits preset's `presetConfig.types`
  in `.releaserc.yaml` and exercised by
  `packages/local-collector/test/release-notes-grouping.test.js` so the
  contract is testable without booting semantic-release.
- The publish pipeline runs the new `pack-install-run` test (Decision 7
  below) against a fixture-backed reference deployment before any tag is
  pushed to npm.
- Patchright postinstall stays in `@pdpp/polyfill-connectors` only. The
  published `@pdpp/local-collector` SHOULD NOT have a `postinstall` script;
  if a future browser-class connector needs Patchright the connector
  package itself owns that script.

### 6. Reference-server compatibility surface (minimum)

- Device row gains `collector_protocol_version` (text, non-null on
  collector-enrolled devices).
- Device-exporter ingest endpoints validate `X-PDPP-Collector-Protocol`
  against the server's accepted set before record persistence.
- The deployment-diagnostics `runtime_capabilities` payload adds
  `collector_protocol_version`, `runner_version`, and
  `connector_versions: { [connector_id]: version }`.
- The dashboard shows a `collector_protocol_outdated` warning when the
  bound device's version is not in the accepted set, distinct from the
  existing `browser_connectors_need_collector` warning.

This is a controlled extension of the surfaces already added in
`introduce-local-collector-runner`. No new device-scoped capability is
granted; collectors still cannot read records, mint owner tokens, or mutate
unrelated devices.

### 7. Acceptance: a `pack-install-run` smoke test is the gate

Unit and integration tests over the runner alone do not prove the package
is usable outside the monorepo. The blocking acceptance test is:

1. `pnpm --filter @pdpp/local-collector pack` produces a tarball.
2. A clean Node container (no monorepo, no pnpm workspace) `npm i`s the
   tarball.
3. The container runs `pdpp-local-collector advertise` and asserts
   `network, filesystem, local_device` (no `browser`).
4. The container `enroll`s against a fixture-backed reference deployment.
5. The container `run`s with `--connector codex` against a captured
   `pilot-real-shape` fixture for Codex and asserts records appear at
   ingest under a device-scoped token.
6. The container does **not** download Chromium or otherwise show
   evidence of Playwright/Patchright postinstall.
7. The container runs `npm i -g @pdpp/cli && pdpp collector advertise` and
   asserts the shim resolves `@pdpp/local-collector` and prints the same
   capabilities.

This proves the package is usable on a fresh host without leaking heavy
runtime, without leaking device tokens via logs, and without leaking the
operator's local paths into ingest envelopes (the existing
`local-device-envelope` redaction already covers this).

## Alternatives Considered

- **Inline the runner in `@pdpp/cli`.** Rejected: violates the slim-CLI
  invariant from `publish-pdpp-cli`, couples release cadences, and grows the
  CLI tarball as more connectors ship.
- **Publish `@pdpp/polyfill-connectors`.** Rejected: drags Playwright,
  Patchright postinstall, Chromium, and a broad connector surface into a
  public artifact whose security and supply-chain review covers only a
  subset.
- **A pure CLI shim that `npx`s a runner package on demand.** Rejected:
  forces a network round trip on every `pdpp collector run`, hides the
  supply chain at the operator's host, and breaks offline runs.
- **Per-connector packages.** Rejected as premature; reconsidered when a
  third connector arrives or a browser-class connector is ready to publish.
- **`--command <bin>` as the only entrypoint contract.** Rejected: hands a
  device token to an arbitrary binary; no supply-chain ownership.

## Owner Self-Review

- **Boundary respected:** `@pdpp/cli` keeps `pdpp`. New package owns its
  own binary (`pdpp-local-collector`). No second `pdpp` binary.
  Reference server stays read/query-authoritative; collector remains
  device-scoped ingest only.
- **Public tarball stays slim:** `@pdpp/local-collector` declares
  `dependencies` of only `zod` (and `node:` builtins). No Playwright, no
  Patchright, no `better-sqlite3` (Codex uses `node:sqlite`), no
  `imapflow`, no `pdf-parse`, no `linkedom`. CI grep gate enforces this on
  every release.
- **No new core claims:** every behavior in the spec delta is qualified as
  reference/control-plane behavior. No PDPP Core requirement is added.
- **Versioning is explicit, not implied:** `COLLECTOR_PROTOCOL_VERSION` is
  exported from both sides and asserted at enrollment + on every ingest
  request.
- **Acceptance is real:** the `pack-install-run` test runs the published
  tarball in a clean Node container against a fixture-backed reference
  deployment. Unit tests alone are not the gate.

## Open Questions (intentionally deferred)

- When the first browser-bound connector is publishable, do we extend
  `@pdpp/local-collector` with an opt-in dependency group, or publish a
  sibling `@pdpp/browser-collector`? Decision deferred until at least one
  browser connector has a real publishability review.
- Should `@pdpp/local-collector` learn to discover bundled connector
  versions from a manifest file rather than a hardcoded re-export map?
  Deferred until a connector ships outside the runner's bundle.
- Long-term: do we ever ingest collector versions into the run ledger so a
  later run can be replayed against the same protocol version? Deferred
  until a real run-replay use case forces it.

## Acceptance Checks

- `openspec validate publish-pdpp-local-collector --strict`
- `pnpm workstreams:status -- --no-fail`
- `pnpm --filter @pdpp/local-collector test` (new package)
- `pnpm --filter @pdpp/local-collector run pack-install-run`
- `pnpm --filter @pdpp/cli test` covers the new shim resolution + install hint
- `pnpm --dir reference-implementation test` covers
  `COLLECTOR_PROTOCOL_VERSION` enforcement
- A grep gate proves the published `@pdpp/local-collector` tarball contains
  no Playwright/Patchright/Chromium/`better-sqlite3`/`imapflow`/`pdf-parse`/
  `linkedom` imports.
- Dashboard renders `collector_protocol_version`, `runner_version`, and
  `connector_versions` on the runtime-capabilities row.
- `pdpp collector --help` no longer says "monorepo only"; advertises the
  `npx`-able flow as the supported public path.
