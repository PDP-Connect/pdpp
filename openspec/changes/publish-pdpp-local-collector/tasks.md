# Tasks

## 1. OpenSpec And Scope Guard

- [x] 1.1 Validate this change with `openspec validate publish-pdpp-local-collector --strict`.
- [x] 1.2 Confirm in `design.md` that browser/Patchright-bound connectors stay private until each has its own publishability review.
- [x] 1.3 Confirm `@pdpp/cli` keeps single ownership of the `pdpp` binary (per `unify-pdpp-cli-command-surface`); `@pdpp/local-collector` only owns `pdpp-local-collector` + a programmatic entry.

## 2. Runtime Slice Extraction

- [x] 2.1 Extract protocol message types out of `packages/polyfill-connectors/src/connector-runtime.ts` into a new `connector-runtime-protocol.ts` with no Playwright import; re-export from the old file for backward compatibility.
- [x] 2.2 Move the runner-side modules (`collector-runner.ts`, `local-device-client.ts`, `local-device-envelope.ts`, `local-device-queue.ts`, `runtime-capabilities.ts`, `safe-emit.ts`, `scope-filters.ts`, `is-main-module.ts`) under a `src/runner/` directory or otherwise build them through `tsconfig.runner.json`.
- [x] 2.3 Add a CI grep gate that fails if the published `@pdpp/local-collector` build contains imports from `playwright`, `patchright`, `imapflow`, `pdf-parse`, `better-sqlite3`, or `linkedom`.
- [x] 2.4 Add a `tsconfig.runner.json` build target whose `include` excludes `connector-runtime.ts` and every browser-bound connector entrypoint.

## 3. New `@pdpp/local-collector` Package

- [x] 3.1 Add `packages/local-collector/package.json` declaring `bin.pdpp-local-collector`, `exports` for `./runner` and `./errors`, runtime dependency on `zod` only, `"private": false`, and `publishConfig.access: "public"`.
- [x] 3.2 Build `packages/local-collector/dist/` from the polyfill-connectors runner slice plus filesystem-class connector entrypoints (Claude Code, Codex).
- [x] 3.3 Export `COLLECTOR_PROTOCOL_VERSION`, advertised capabilities (`network`, `filesystem`, `local_device`), the bundled connector registry, and typed errors from `@pdpp/local-collector/runner`.
- [x] 3.4 Refuse `--command <bin>` unless `PDPP_LOCAL_COLLECTOR_ALLOW_CUSTOM_COMMAND=1` is set; help text advertises only `--connector claude_code|codex`.

## 4. `@pdpp/cli` Shim Update

- [x] 4.1 Replace `resolveCollectorRunnerScript` with a resolver that prefers `require.resolve('@pdpp/local-collector/package.json')` and keeps the monorepo workspace walk as a fallback for in-repo dev.
- [x] 4.2 Replace the multi-line monorepo `RUNNER_MISSING_MESSAGE` with a single actionable install hint (`npm i -g @pdpp/local-collector@beta` or `npx -y @pdpp/local-collector@beta ...` until stable promotion).
- [x] 4.3 Remove the "monorepo only" copy from `pdpp collector --help`; defer runner-owned flag descriptions to `pdpp-local-collector --help`.
- [x] 4.4 `pdpp collector` MUST NOT add a transitive runtime dependency on `@pdpp/local-collector`; resolution is lazy and the shim survives `@pdpp/local-collector` being absent.

## 5. Reference Server Compatibility

- [x] 5.1 Add `COLLECTOR_PROTOCOL_VERSION` export to `reference-implementation/server` and accept the value via `X-PDPP-Collector-Protocol` on device-exporter ingest routes.
- [x] 5.2 Reject incompatible versions with `409 collector_protocol_mismatch` (typed body listing supported versions) **before** persisting any record.
- [x] 5.3 Persist `collector_protocol_version` on the device row at enrollment time.
- [x] 5.4 Surface `collector_protocol_version`, `runner_version`, and `connector_versions` in the deployment-diagnostics `runtime_capabilities` payload.
- [x] 5.5 Dashboard renders a `collector_protocol_outdated` warning when the bound device's version is not in the accepted set, distinct from the existing `browser_connectors_need_collector` warning.

## 6. Release Wiring

- [x] 6.1 Add `@pdpp/local-collector` to the semantic-release publish set with the same trusted-publishing/OIDC posture as `@pdpp/cli`.
- [x] 6.2 Ensure the published `@pdpp/local-collector` has no `postinstall` script.
- [x] 6.3 Conventional Commit scopes drive per-package release-notes sections inside the shared semantic-release stream: `feat(local-collector): X` is routed to `### Features (@pdpp/local-collector)`, `feat(cli): Y` to `### Features (@pdpp/cli)`, with unscoped commits falling back to the generic section. Configured via `presetConfig.types` on both `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator` in `.releaserc.yaml` and verified by `packages/local-collector/test/release-notes-grouping.test.js`. Truly independent per-package versions are intentionally out of scope (see `design.md` §5) — both packages publish in lockstep from one version stream.

## 7. Acceptance: `pack-install-run` smoke test

- [x] 7.1 `pnpm --filter @pdpp/local-collector run pack-install-run` packs the package, `npm i`s the tarball in a clean temp npm project, then drives the *installed* `pdpp-local-collector advertise`, `enroll`, and `run --connector codex` end-to-end against an in-process reference server (`startServer({ dbPath: ':memory:' })`) seeded with an on-disk Codex prompts/rules fixture. The smoke asserts at least one record is persisted at ingest (`SELECT COUNT(*) FROM records WHERE connector_id = 'local-device:codex' AND connector_instance_id = <enrolled>` > 0) and that the device row carries the runner's advertised `collector_protocol_version`. No real owner token, no remote deployment, no live Codex home is required.
- [x] 7.2 Same test asserts the clean container does **not** download Chromium or otherwise execute Patchright postinstall.
- [x] 7.3 Same test installs `@pdpp/cli` in the clean container and runs `pdpp collector advertise`, asserting the shim resolves the runner and matches `pdpp-local-collector advertise` output.
- [x] 7.4 Same script's second smoke re-boots the reference server with `acceptedCollectorProtocolVersions: ["0"]` (an alternate set the published runner cannot satisfy) and drives `pdpp-local-collector enroll` against it, asserting the CLI exits non-zero with a typed `LocalDeviceHttpError` that surfaces `collector_protocol_mismatch` and that no device row is persisted on the pinned server. Mechanically equivalent to a deployment pinned to an older protocol, without needing a real older server image.

## 8. Documentation

- [x] 8.1 Add `docs/local-collector.md` covering install, enroll, run, troubleshooting, and the protocol-version compatibility surface.
- [x] 8.2 Update `pdpp connect` and dashboard onboarding copy: the supported public path is `npx -y @pdpp/local-collector@beta ...` while the package is beta-tagged (no monorepo clone required for Claude/Codex).
- [x] 8.3 Update `unify-pdpp-cli-command-surface` cross-references in dashboard help so every displayed command names which public package it lives in.

## 9. Validation

- [x] 9.1 `openspec validate publish-pdpp-local-collector --strict`
- [x] 9.2 `pnpm workstreams:status -- --no-fail`
- [x] 9.3 `pnpm --filter @pdpp/cli run verify`
- [x] 9.4 `pnpm --filter @pdpp/local-collector run verify`
- [x] 9.5 `pnpm --dir reference-implementation test` was run. The targeted tests that exercise the surface touched by this change — `test/device-exporter-routes.test.js` (7/7 pass) and `test/device-exporter-state-routes.test.js` (11/11 pass) — are green, as are `packages/polyfill-connectors/src/local-device-client.test.ts` (9/9 pass) and `packages/local-collector/test/*` (31/31 pass) including the new `release-notes-grouping.test.js`. The full reference-implementation suite still has 12 unrelated failing files (`test/cli.test.js`, `test/pdpp.test.js`, `test/scheduler.test.js`, `test/event-spine.test.js`, `test/migrate-storage.test.js`, `test/browser-surface-leases.test.js`, `test/composed-origin.test.js`, `test/display-messages.test.js`, `test/connector-failure-diagnostics.test.js`, `test/blob-bindings-json-path-migration.test.js`, `test/polyfill-refresh-defaults.test.js`, `test/runtime-pipe-resilience.test.js`). Reproduced as baseline at `HEAD` with all of this change's edits stashed — failures cover unrelated areas: `pdpp trace show` deprecation-warning copy drift, native-provider RS internals returning 500 instead of 400/200, browser-surface lease reconciliation, schema-table count drift (32 vs expected 31), reddit polyfill manifest posture validation, blob_bindings JSON-path migration, and `runConnector` stderr handling. None touch device-exporter, collector-protocol, local-device-client, semantic-release config, or the runner published surface this change owns.
- [x] 9.6 `pnpm --filter @pdpp/local-collector run pack-install-run`
- [x] 9.7 Grep proves the published `@pdpp/local-collector` tarball contains no forbidden imports.
- [x] 9.8 Grep proves dashboard / docs no longer advertise "monorepo only" as the public collector path.
