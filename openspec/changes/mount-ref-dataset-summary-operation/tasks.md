## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /_ref/dataset/summary` behavior, including the three SQLite aggregates (`recordsDatasetGetRecordsAggregate`, `recordsDatasetGetRecordChangesBytes`, `recordsDatasetGetBlobBytes`), `getRealWorldTimeBounds` invocation gate (`recordCount > 0`), `getTopConnectorsByRecordCount(3)` shape, and envelope assembly.
- [x] 1.2 Inventory current sandbox `GET /sandbox/_ref/dataset/summary` behavior, including `DEMO_*` count semantics, `approximateRetainedBytes`, sorted record-time / ingested-time bounds, and `countConnectorRecords`-based top-connector list.
- [x] 1.3 Confirm operation module path (`reference-implementation/operations/ref-dataset-summary/index.ts`) and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-sandbox/no-process-env boundary.

## 2. Operation Implementation

- [x] 2.1 Implement canonical `ref.dataset.summary` operation with explicit dependency inputs (`getCounts`, `getRetainedBytes`, `getRecordTimeBounds`, `getIngestedTimeBounds`, `listTopConnectorCandidates`). The operation owns envelope assembly (`object: 'dataset_summary'`), `total_retained_bytes` derivation, top-connector sorting (`record_count` desc, `connector_id` asc tiebreak) and limit (3), `dataset_connector_summary` envelope wrapping, and the empty-corpus collapse rule (time bounds `null` when `record_count === 0`).
- [x] 2.2 Export the operation from `reference-implementation/package.json` under `./operations/ref-dataset-summary`.
- [x] 2.3 Split `getDatasetSummary` in `reference-implementation/server/records.js` into the smaller capability inputs the native route will wire (`getDatasetRecordsAggregate`, `getDatasetRecordChangesBytes`, `getDatasetBlobBytes`, `getDatasetRecordTimeBounds`, `listDatasetTopConnectorCandidates`). Keep `getRealWorldTimeBounds` private and reuse it. Delete the old combined `getDatasetSummary` and the previous private `getTopConnectorsByRecordCount` (the operation now owns the limit and envelope wrapping).
- [x] 2.4 Add sandbox fixture dependencies in `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` (`createSandboxRefDatasetSummaryDependencies`) backed by `DEMO_CONNECTORS`, `DEMO_STREAMS`, `DEMO_RECORDS`. Preserve today's sandbox arithmetic exactly.
- [x] 2.5 Add operation-level tests covering envelope assembly, `total_retained_bytes` derivation, top-connector sort/tiebreak/limit, `dataset_connector_summary` envelope wrapping, and the empty-corpus collapse rule for record-time and ingest-time bounds.

## 3. Host Mounts

- [x] 3.1 Migrate native Fastify `GET /_ref/dataset/summary` to call `executeRefDatasetSummary` while preserving `ownerAuth.requireOwnerSession`, response writing, and `handleError`. Delete the old `getDatasetSummary` import and call site.
- [x] 3.2 Migrate Next sandbox `GET /sandbox/_ref/dataset/summary` to call the same operation with sandbox fixture dependencies; preserve sandbox demo headers via `jsonResponse`.
- [x] 3.3 Delete `buildLiveDatasetSummary` and its `LiveDatasetSummary` type from `apps/web/src/app/sandbox/_demo/builders.ts` so the public sandbox route cannot import a parallel envelope writer.

## 4. Boundary Tests

- [x] 4.1 Confirm the new operation module is enumerated by the shared `reference-implementation/test/operations-boundary.test.js` discovery and that it passes the shared boundary rule.
- [x] 4.2 Add a per-operation boundary test (`reference-implementation/test/ref-dataset-summary-boundary.test.js`) proving the sandbox `/sandbox/_ref/dataset/summary` route does not statically import `buildLiveDatasetSummary` and that `_demo/builders.ts` no longer exports it (or its `LiveDatasetSummary` type).

## 5. Validation

- [x] 5.1 Run `node --test --test-force-exit reference-implementation/test/operations-boundary.test.js`.
- [x] 5.2 Run `node --test --test-force-exit reference-implementation/test/ref-dataset-summary-operation.test.js`.
- [x] 5.3 Run `node --test --test-force-exit reference-implementation/test/ref-dataset-summary-boundary.test.js`.
- [x] 5.4 Run `node --test --test-force-exit --import tsx apps/web/src/app/sandbox/_demo/routes.test.ts`.
- [x] 5.5 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.6 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.7 Run `pnpm --dir apps/web run types:check`.
- [x] 5.8 Run `pnpm --dir apps/web run check`.
- [x] 5.9 Run `openspec validate mount-ref-dataset-summary-operation --strict`.
- [x] 5.10 Run `openspec validate --all --strict`.
- [x] 5.11 Run `git diff --check main...HEAD`.
