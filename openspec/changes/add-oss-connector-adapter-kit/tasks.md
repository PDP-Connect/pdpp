# Tasks: add OSS connector adapter kit

## 1. Reusable external-tool adapter

- [x] 1.1 `external-tool-adapter.ts`: `ExternalToolSpec`, `resolveToolBin`,
  `formatMissingToolError`, `runExternalTool` (spawn + timeout + ENOENT/exit
  handling), `parseToolRecords` (JSON or JSONL). Tests (incl. node-as-tool e2e).

## 2. HPI adapter

- [x] 2.1 `hpi-adapter.ts`: `HPI_TOOL` spec, `buildHpiQueryArgs` (exact CLI
  contract), `windowFromScope`, `queryHpiStream`. Tests assert the argv contract
  + an end-to-end fake-hpi JSONL run.

## 3. HPI connector

- [x] 3.1 `connectors/hpi/index.ts` + `schemas.ts` + `manifests/hpi.json`:
  filesystem-binding connector, default reddit/commits mapping, HPI_STREAMS
  override, per-stream skip isolation, validateRecord wired (zod looseObject).
- [x] 3.2 Register `hpi` in orchestrator `KNOWN_CONNECTORS`.
- [x] 3.3 Declare `hpi` in `manifest.runtime_requirements.external_tools` and add
  it to the `external-tool-manifest-honesty` `KNOWN_EXTERNAL_TOOLS` gate.
- [x] 3.4 Connector e2e test (drives the entrypoint via START/stdin against a
  fake hpi; asserts records + per-stream skip + DONE succeeded).

## 4. Validation

- [x] 4.1 `pnpm --filter @pdpp/polyfill-connectors` adapter/connector tests green
  (23: adapter + hpi-adapter + connector e2e); honesty + schema gates pass;
  package typecheck clean.
- [x] 4.2 `openspec validate add-oss-connector-adapter-kit --strict`.

## 5. Follow-ups (future, no further spec change needed)

- [ ] 5.1 Live proof against a real `hpi` install with a configured module
  (flip the HPI connector's public_listing toward proven).
- [ ] 5.2 Second wrap (Timelinize: drive its import API + read its SQLite) reusing
  the adapter; or DiscordChatExporter (`export -f Json`) as a quick win.
