## Why

The `add-schema-validation-coverage` change (committed as `a3e1c8a`) wired schema validation into eleven connectors and surfaced three followups it explicitly did not address:

1. The reconciliation between manifest, schema registry, and emit-site stream literals only existed as ad-hoc inspection — there was no checked-in regression net to keep the three sources from drifting again. The previous tranche surfaced one such drift (codex's `function_calls` was emitted but not declared) by hand. A reusable check would have caught it automatically and would catch the next one.
2. Schema validation for the six newly-schemed connectors (github, gmail, ynab, codex, claude_code, slack) was grounded in the local owner database — the assertion "every record passes its schema" is only as durable as the worker's machine. Without a committed fixture, a future schema edit that rejects a real record can pass review and land before anyone notices.
3. Three z.string().url() call sites in amazon, chase, and usaa tripped zod 4 deprecation hints. Mechanical cleanup, blocked from the previous tranche only because it was out of scope.

This change closes all three. The usaa data-quality drift (6/924 records flagged in the previous replay) and the reddit re-ingest are tracked in `add-polyfill-connector-system/tasks.md`; this change documents that decision but does not loosen any schema or fabricate any records.

## What Changes

- Add `src/manifest-reconcile.ts` — pure reconciler over manifest streams, schema-registry keys, and emit-site stream literals. Plus `bin/reconcile-manifests.ts` (operator CLI) and `bin/reconcile-manifests.test.ts` (regression net for the eleven schema-bearing connectors).
- Author committed pilot fixtures for github, gmail, ynab, codex, claude_code, slack at `fixtures/<connector>/scrubbed/pilot-real-shape/records/<stream>.jsonl`. Synthetic-but-shape-real, [REDACTED_*]-placeholder content, all records pass `validateRecord` for their stream.
- Add `src/pilot-fixture-test-helper.ts` and one `pilot-fixture.test.ts` per connector. Helper enforces: fixture directory exists; ≥1 stream file present; each stream file has ≥1 record; every record passes validateRecord.
- Replace `z.string().url()` with `z.url()` in amazon, chase, usaa schemas (zod 4 idiomatic).
- Document the usaa replay drift as data cleanup (re-ingest, do not loosen) in `add-polyfill-connector-system/tasks.md`.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: codify the manifest/schema/emit reconciliation pattern as a reusable primitive (`reconcile`, `reconcileFromDisk`) and a regression test that runs against every schema-bearing connector.
- `reference-implementation-governance`: every connector that ships a `schemas.ts` SHALL also ship a committed pilot fixture and a per-connector replay test. Fixtures SHALL be synthetic-but-shape-real; PII placeholders only.

## Impact

- `packages/polyfill-connectors/src/manifest-reconcile.ts` (new)
- `packages/polyfill-connectors/src/manifest-reconcile.test.ts` (new, 16 tests)
- `packages/polyfill-connectors/src/pilot-fixture-test-helper.ts` (new)
- `packages/polyfill-connectors/bin/reconcile-manifests.ts` (new CLI)
- `packages/polyfill-connectors/bin/reconcile-manifests.test.ts` (new, 11 tests — one per schema-bearing connector)
- `packages/polyfill-connectors/bin/replay-pilot-fixtures.ts` (new diagnostic CLI)
- `packages/polyfill-connectors/connectors/{github,gmail,ynab,codex,claude_code,slack}/pilot-fixture.test.ts` (new, 6 files)
- `packages/polyfill-connectors/fixtures/{github,gmail,ynab,codex,claude_code,slack}/scrubbed/pilot-real-shape/records/*.jsonl` (new, 38 files, 62 records total)
- `packages/polyfill-connectors/connectors/{amazon,chase,usaa}/schemas.ts` (z.string().url() → z.url())
- `openspec/changes/add-polyfill-connector-system/tasks.md` (note usaa drift findings + decision)
- No runtime, manifest, or downstream-consumer changes.

## Validation evidence

- 16 manifest-reconcile unit tests pass; 11 fleet tests cover every schema-bearing connector with zero drift.
- 42 pilot-fixture replay tests pass; 62 fixture records validate against their schemas.
- The previous tranche's 640+ test suite continues to pass with these additions.
