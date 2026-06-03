# Tasks: promote connector configuration schema

## 1. Additive wire field (safe, landed)

- [x] 1.1 Add optional `connector_options?: Record<string, unknown>` to the
  canonical `StartMessage` (`connector-runtime-protocol.ts`).
- [x] 1.2 Refresh `connector-options.ts` doc/pointer to this change; confirm
  `readOptions` precedence (START options → env → default) is unchanged.

## 2. Manifest schema fields (review-gated)

- [ ] 2.1 Add OPTIONAL `options_schema` (JSON-Schema) and `credentials_schema`
  (JSON-Schema) to the manifest type / JSON-Schema validator.
- [ ] 2.2 Backfill `options_schema` for one exemplar connector that already has
  knobs (Slack: lookback/channel-types/skip-files) as a worked example.

## 3. Runtime validation hook (review-gated)

- [ ] 3.1 Add `validateConnectorOptions(manifest, startMsg)` — shape-validate
  `START.connector_options` against `options_schema` before spawn; fail fast with
  a named error on mismatch.
- [ ] 3.2 Capture `connector_options` into the run spine; assert credentials are
  never captured there.

## 4. Honesty + tests

- [ ] 4.1 Manifest-honesty test: no `options_schema` field name overlaps a
  `credentials_schema` field name (no secret smuggled as an option).
- [x] 4.2 Unit test for `readOptions` precedence (START > env > default) and
  coercion (int/bool/csv/string).

## 5. Validation

- [ ] 5.1 `openspec validate promote-connector-config-schema --strict`.
- [ ] 5.2 `pnpm --filter @pdpp/polyfill-connectors test` green for touched files.

## Owner-review gates (must clear before archive)

- [ ] R.1 RI owner: confirm `options_schema`/`credentials_schema` belong in
  reference/polyfill manifest metadata (not Core / Collection Profile).
- [ ] R.2 PDPP owner: confirm the credential-leakage boundary and the
  options-frozen-in-spine semantics.
