## 1. Postgres helpers

- [ ] 1.1 Add `postgresAnySemanticProgressRow()` to
  `reference-implementation/server/postgres-search.js` mirroring the SQLite
  `searchSemanticProgressExistsAny` shape.
- [ ] 1.2 Add `postgresListAllSemanticMetaIdentities()` returning
  `{ model_id, dimensions, distance_metric }` rows from
  `semantic_search_meta`.
- [ ] 1.3 Export both helpers and import them into `search-semantic.js`.

## 2. State machine

- [ ] 2.1 Convert `computeIndexState()` to `async` and branch on
  `isPostgresStorageBackend()` for both the progress check and the meta
  identity walk.
- [ ] 2.2 Preserve the `building` short-circuit before any storage read.
- [ ] 2.3 Preserve the meta-empty-implies-built semantics with the same
  inline comment as the SQLite-only version.

## 3. Caller updates

- [ ] 3.1 Update `resolveSemanticCapability()` in
  `reference-implementation/server/index.js` to `await
  computeSemanticIndexState()` and become async.
- [ ] 3.2 Update `/_ref/deployment` wiring to declare the dep as
  `computeIndexState: () => computeSemanticIndexState()` (already async-
  compatible; the inner returns a Promise).
- [ ] 3.3 Update `DeploymentDiagnosticsRuntimeDeps.computeIndexState` to
  return `Promise<SemanticIndexState>` and `await` it in
  `collectDeploymentDiagnostics`.
- [ ] 3.4 Update `executeRsProtectedResourceMetadata()` to be async and
  `await` `resolveSemanticCapability()`.
- [ ] 3.5 Update `mountRsProtectedResourceMetadata` route handler to
  `await` the operation.

## 4. Tests

- [ ] 4.1 Update `rs-protected-resource-metadata-operation.test.js` to
  `await` every `executeRsProtectedResourceMetadata` call.
- [ ] 4.2 Add a regression test in
  `reference-implementation/test/semantic-retrieval.test.js` that drives
  Postgres-mode `computeIndexState()` through its public path (or directly
  via the exported function) and asserts that orphan SQLite progress rows
  do not flip the advertised state to `"stale"`.

## 5. Validation

- [ ] 5.1 `pnpm exec openspec validate fix-semantic-index-state-postgres-routing --strict`.
- [ ] 5.2 `pnpm exec openspec validate --all --strict`.
- [ ] 5.3 `node --test reference-implementation/test/semantic-retrieval.test.js`.
- [ ] 5.4 `pnpm --dir reference-implementation typecheck`.
