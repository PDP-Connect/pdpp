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
- [x] 4.2 Replace the multi-line monorepo `RUNNER_MISSING_MESSAGE` with a single actionable install hint (`npm i -g @pdpp/local-collector` or `npx -y @pdpp/local-collector ...`).
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
- [ ] 6.3 Conventional Commits scoped to `local-collector` drive the package's release notes independently of `@pdpp/cli`.

## 7. Acceptance: `pack-install-run` smoke test

- [ ] 7.1 Add `pnpm --filter @pdpp/local-collector run pack-install-run` that: packs the package, `npm i`s the tarball in a clean Node container, runs `advertise`, `enroll`, and `run --connector codex` against a fixture-backed reference deployment, and asserts records appear at ingest.
- [x] 7.2 Same test asserts the clean container does **not** download Chromium or otherwise execute Patchright postinstall.
- [x] 7.3 Same test installs `@pdpp/cli` in the clean container and runs `pdpp collector advertise`, asserting the shim resolves the runner and matches `pdpp-local-collector advertise` output.
- [ ] 7.4 A second smoke test exercises the `409 collector_protocol_mismatch` path against a reference deployment pinned to an older protocol version.

## 8. Documentation

- [x] 8.1 Add `docs/local-collector.md` covering install, enroll, run, troubleshooting, and the protocol-version compatibility surface.
- [x] 8.2 Update `pdpp connect` and dashboard onboarding copy: the supported public path is `npx -y @pdpp/local-collector ...` (no monorepo clone required for Claude/Codex).
- [x] 8.3 Update `unify-pdpp-cli-command-surface` cross-references in dashboard help so every displayed command names which public package it lives in.

## 9. Validation

- [x] 9.1 `openspec validate publish-pdpp-local-collector --strict`
- [x] 9.2 `pnpm workstreams:status -- --no-fail`
- [x] 9.3 `pnpm --filter @pdpp/cli run verify`
- [x] 9.4 `pnpm --filter @pdpp/local-collector run verify`
- [ ] 9.5 `pnpm --dir reference-implementation test`
- [x] 9.6 `pnpm --filter @pdpp/local-collector run pack-install-run`
- [x] 9.7 Grep proves the published `@pdpp/local-collector` tarball contains no forbidden imports.
- [x] 9.8 Grep proves dashboard / docs no longer advertise "monorepo only" as the public collector path.
