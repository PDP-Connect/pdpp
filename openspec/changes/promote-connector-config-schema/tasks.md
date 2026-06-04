# Tasks: promote connector configuration schema

## 1. Additive wire field (safe, landed)

- [x] 1.1 Add optional `connector_options?: Record<string, unknown>` to the
  canonical `StartMessage` (`connector-runtime-protocol.ts`).
- [x] 1.2 Refresh `connector-options.ts` doc/pointer to this change; confirm
  `readOptions` precedence (START options → env → default) is unchanged.

## 2. Manifest schema fields (review-gated)

- [x] 2.1 Add OPTIONAL `options_schema` (JSON-Schema) and `credentials_schema`
  (JSON-Schema) to the manifest type / JSON-Schema validator.
  — `validate-connector-options.ts` carries the `ManifestWithConfigSchemas` type;
  honesty test reads these fields from every manifest.
- [x] 2.2 Backfill `options_schema` for one exemplar connector that already has
  knobs (Slack: lookback/channel-types/skip-files) as a worked example.
  — `manifests/slack.json` now declares `options_schema` (5 knobs) and
  `credentials_schema` (3 secrets), no overlap.

## 3. Runtime validation hook (review-gated)

- [x] 3.1 Add `validateConnectorOptions(manifest, startMsg)` — shape-validate
  `START.connector_options` against `options_schema` before spawn; fail fast with
  a named error on mismatch.
  — `src/validate-connector-options.ts` exported; 13 unit tests green.
- [ ] 3.2 Capture `connector_options` into the run spine; assert credentials are
  never captured there.
  — DEFERRED: spine writes live in `reference-implementation/lib/controller-boot.ts`
  and `reference-implementation/runtime/`. Adding `connector_options` to the
  `run.started` `data_json` payload requires a reference-implementation change
  outside this lane's scope (would touch the server's INSERT path, migration, and
  the run-timeline read path). Documenting the gap per R.2: no safe spine field
  exists in polyfill-connectors today; the credential-never-in-spine invariant is
  structurally guaranteed because `validateConnectorOptions` is the only path where
  `connector_options` is examined and credentials are never written there by
  contract. Owner should schedule as a separate reference-implementation lane.

## 4. Honesty + tests

- [x] 4.1 Manifest-honesty test: no `options_schema` field name overlaps a
  `credentials_schema` field name (no secret smuggled as an option).
  — `src/connector-config-schema-honesty.test.ts`; 2 tests green.
- [x] 4.2 Unit test for `readOptions` precedence (START > env > default) and
  coercion (int/bool/csv/string).

## 5. Validation

- [x] 5.1 `openspec validate promote-connector-config-schema --strict`.
  — PASS (44 items, 0 failed).
- [x] 5.2 `pnpm --filter @pdpp/polyfill-connectors test` green for touched files.
  — 563 tests, 0 failures; `tsc --noEmit` clean.

## Owner-review gates (must clear before archive)

- [x] R.1 RI owner: confirm `options_schema`/`credentials_schema` belong in
  reference/polyfill manifest metadata (not Core / Collection Profile).
  — CONFIRMED by owner before this lane launched.
- [x] R.2 PDPP owner: confirm the credential-leakage boundary and the
  options-frozen-in-spine semantics.
  — CONFIRMED by owner before this lane launched. Spine capture (3.2) deferred
  to a reference-implementation lane (see note above).
