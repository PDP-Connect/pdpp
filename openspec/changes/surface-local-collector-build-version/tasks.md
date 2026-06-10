# Tasks: surface-local-collector-build-version

## 1. Build-info module + build-time revision stamp

- [x] 1.1 Add `packages/polyfill-connectors/src/collector-build-info.ts` exporting
  `CollectorBuildInfo`, the committed `COLLECTOR_BUILD_INFO` source default
  (`{ version: "0.0.0", revision: "source", builtAt: null }`), and
  `buildAgentVersion()` composing `version+revision`.
- [x] 1.2 Add `collector-build-info.ts` to `local-collector/tsconfig.build.json`
  `include`, and keep its `.d.ts` in `postbuild.mjs` `declarationKeep`.
- [x] 1.3 Extend `postbuild.mjs` to overwrite the compiled
  `dist/polyfill-connectors/src/collector-build-info.js` with the real
  `version` (resolved package.json), `revision` (`PDPP_BUILD_REVISION` env →
  `git rev-parse --short=12 HEAD` → `source` fallback), and `builtAt`.

## 2. Send agent_version on heartbeats

- [x] 2.1 Add optional `agent_version?: string` to `HeartbeatRequest` in
  `local-device-client.ts` (the wire schema already permits it).
- [x] 2.2 In `collector-runner.ts`, compute `buildAgentVersion()` once and include
  `agent_version` on every heartbeat call site: `starting`, final, corrective
  post-throw (`emitCorrectiveHeartbeatFromOutbox`), and skip-for-backlog.

## 3. Surface in owner diagnostics + console

- [x] 3.1 Add `agent_version: device.agentVersion ?? null` to the projected
  `device_exporter` object in `projectDeviceExporter`
  (`ref-device-exporters.ts`).
- [x] 3.2 Render the reported agent version in the console device-exporters page
  (`apps/console/.../device-exporters/page.tsx`), owner-only, shown only when
  present, distinct from the connector protocol version and freshness axes.

## 4. Tests

- [x] 4.1 `collector-build-info` unit test: committed default is `0.0.0+source`;
  `buildAgentVersion()` composes `version+revision`; the string matches
  `^[^+]+\+([0-9a-f]{7,40}|source)$` and carries no path/secret.
- [x] 4.2 `collector-runner.test.ts`: a run's heartbeats carry a non-empty
  `agent_version` equal to `buildAgentVersion()` (`0.0.0+source` in test).
- [x] 4.3 Device-exporter route/projection test: the diagnostics projection
  includes `agent_version` — `null` before any versioned heartbeat, the stored
  string after one.

## 5. Validation

- [x] 5.1 `openspec validate surface-local-collector-build-version --strict`.
- [x] 5.2 Focused tests: `collector-runner.test.ts`, `collector-build-info` test,
  device-exporter route/store tests, local-collector `runner.test.js`.
- [x] 5.3 Typechecks: polyfill-connectors / local-collector, reference-implementation,
  console types:check.
- [x] 5.4 `pnpm --filter @pdpp/reference-contract run check:generated` (expect
  clean — no schema change).
- [x] 5.5 Biome on changed files; `git diff --check`.

## 6. Owner closeout (owner-only)

- [ ] 6.1 After merge, rebuild the deployed `@pdpp/local-collector` artifact so the
  host begins reporting a real `+<revision>` on its next heartbeat; confirm the
  owner diagnostics show the build revision for each enrolled device.

## Acceptance checks

```bash
# OpenSpec
openspec validate surface-local-collector-build-version --strict

# Build-info + collector-runner + CLI
cd packages/polyfill-connectors && pnpm exec tsx --test src/collector-build-info.test.ts src/collector-runner.test.ts
cd packages/local-collector && pnpm test

# Reference device-exporter projection
cd reference-implementation && node --test test/device-exporter-routes.test.js

# Contract is unchanged (field already exists)
pnpm --filter @pdpp/reference-contract run check:generated

git diff --check
```
