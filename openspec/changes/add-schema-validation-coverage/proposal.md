## Why

Connector schema coverage was uneven before this change. Five connectors (amazon, chase, chatgpt, reddit, usaa) shipped a `schemas.ts` with `validateRecord`; six others (github, gmail, ynab, codex, claude_code, slack) had no shape-check at all despite emitting hundreds of thousands of records into the local owner database. The connector authoring guide §3 calls schema-validation the floor — "a connector must never emit a record that looks right but is wrong" — but in practice that floor only existed for some.

The schemaless connectors are also the highest-volume ones. Before this change, the local DB contained 50k gmail records, 75k codex records, 253k claude_code records, and 349k slack records flowing through the pipeline with no shape enforcement. Any drift in upstream APIs, parser bugs, or accidentally-captured cruft would land silently in the DB, indistinguishable from valid data.

In addition, the validateRecord function was duplicated verbatim across all five existing schemas — same 17 lines of safeParse-and-format-issues logic — making new schemas more tedious to author and correct than they should be.

## What Changes

- Add `src/schema-registry.ts` exporting `makeValidateRecord(schemas)` so every connector's schemas.ts becomes a registry plus one closure-binding line. Migrate the five existing schemas (amazon, chase, chatgpt, reddit, usaa) to use the helper.
- Author `schemas.ts` for the six previously-uncovered connectors: github, gmail, ynab, codex, claude_code, slack. Wire each into its connector's emit path. Schemas authored permissively-first per §3 of the authoring guide; tightening happens on observed failure.
- Add `bin/replay-schemas.ts` and `bin/sample-records.ts` — diagnostic tools that run every committed record through `validateRecord` and report pass/fail per stream. Used to ground the new schemas in real data and catch regressions on future schema edits.
- Reconcile codex's manifest to declare the previously-undeclared `function_calls` stream (47k records emitted; 0 declared).
- Bump connector versions: gmail 0.1.0→0.2.0; github, ynab, claude_code +0.1.0 minor; codex +0.1.0 (manifest also gains `function_calls`); slack +0.1.0.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: formalize the shared `makeValidateRecord` helper as the canonical pattern for connector schema validation; record the per-stream registry shape it expects.
- `reference-implementation-governance`: every connector with a `parsers.ts` and at least one stream SHALL ship a `schemas.ts` with shape-check coverage for every emitted stream.

## Impact

- `packages/polyfill-connectors/src/schema-registry.ts` (new)
- `packages/polyfill-connectors/connectors/{github,gmail,ynab,codex,claude_code,slack}/schemas.ts` (new, 6 files)
- `packages/polyfill-connectors/connectors/{amazon,chase,chatgpt,reddit,usaa}/schemas.ts` (migrated to helper)
- `packages/polyfill-connectors/connectors/*/index.ts` (validateRecord wired in for the 6 new connectors; cast cleanup for amazon)
- `packages/polyfill-connectors/manifests/{github,gmail,ynab,codex,claude_code,slack}.json` (version bump; codex also adds `function_calls`)
- `packages/polyfill-connectors/bin/{replay-schemas,sample-records}.ts` (new diagnostic tools)
- No changes to public RS protocol, runtime contract, or downstream consumers.

## Validation evidence

771,485 real owner records validated across 11 connectors. 9 of 11 pass at 100%; usaa passes at 99.4% (6 records flag legitimate data-quality issues already documented as a usaa-followup); reddit at 0% (DB still holds v0.1 records, schema is v0.2 — known, requires re-ingest).
