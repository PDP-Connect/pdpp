## 1. Pre-work: shared helper

- [x] Add `src/schema-registry.ts` exporting `makeValidateRecord(schemas)` returning a `ValidateRecord` closure with consistent diagnostics.
- [x] Migrate `connectors/{amazon,chase,chatgpt,reddit,usaa}/schemas.ts` to use the helper. Remove duplicated boilerplate.
- [x] Drop the `validateRecord as ValidateRecord` cast in `connectors/amazon/index.ts` now that the helper returns the right type directly.
- [x] Confirm `pnpm typecheck` clean and `pnpm test` (640+ tests) green.

## 2. Pre-work: replay existing schemas vs real DB

- [x] Add `bin/replay-schemas.ts` that runs every record from the local sqlite through the connector's `validateRecord` and writes a JSON report under `local/`.
- [x] Add `bin/sample-records.ts` that emits 5 representative records per stream — used to ground new schemas in real shapes.
- [x] Replay the five existing schemas. Document drift: usaa 6/926 records fail on legitimate data-quality issues (missing currency, empty-string descriptions); reddit 1225/1225 fail because DB holds v0.1 records and the schema is v0.2.
- [x] Decide: do not loosen schemas to mask drift. The SKIP_RESULT path is the diagnostic signal.

## 3. Six new connectors

- [x] github: schemas.ts (6 manifest-declared streams). Replay: 8702/8702 pass.
- [x] ynab: schemas.ts (9 streams, milliunit-aware, composite transaction IDs). Replay: 21537/21537 pass.
- [x] gmail: schemas.ts (5 streams; `labels` keyed on `name`, not `id`). Replay: 50485/50485 pass.
- [x] codex: schemas.ts (6 streams) + manifest reconcile to declare `function_calls`. Replay: 74945/74945 pass.
- [x] claude_code: schemas.ts (6 streams). Replay: 252863/252863 pass.
- [x] slack: schemas.ts (13 manifest-declared streams; `messages.ts` is string-formatted float, not ISO). Replay: 349130/349130 pass.

## 4. Manifest version bumps

- [x] github 0.2.0 → 0.3.0
- [x] gmail 0.1.0 → 0.2.0
- [x] ynab 0.2.0 → 0.3.0
- [x] codex 0.2.0 → 0.3.0 (also adds `function_calls` stream)
- [x] claude_code 0.2.0 → 0.3.0
- [x] slack 0.3.0 → 0.4.0

## 5. Validation

- [x] `pnpm test` passes 640 tests, 0 failures.
- [x] My-files-only `biome check` clean (14 files).
- [x] Final replay: 771,485 records across 11 connectors. 9 at 100%, usaa at 99.4%, reddit at 0% (re-ingest required).
- [x] `openspec validate add-schema-validation-coverage --strict`.
- [x] `openspec validate --all --strict`.

## 6. Followups (not in this change)

- manifest/schema/emit reconciliation: audit every connector for declared streams with no emitted records, emitted streams missing from the manifest, and `SCHEMAS` keys that do not match the manifest. The owner review already fixed GitHub/Slack drift in this tranche; make this a reusable check.
- fixture replay tests: add committed `__fixtures__`/replay coverage for the six newly schemed connectors so schema confidence does not depend on the owner's local SQLite database.
- usaa: 6 records emit with missing currency or empty-string descriptions. File as data-quality issue; do not loosen schema.
- reddit: re-ingest from a v0.2 connector capture so the local DB matches the v0.2 schema. Tracked in `add-polyfill-connector-system/tasks.md`.
- zod cleanup: replace deprecated `z.string().url()` usage in connector schemas.
- The 18 connectors with no `parsers.ts` yet are out of scope — they don't have anything to validate.
