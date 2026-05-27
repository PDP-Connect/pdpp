## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/schema` owner/client behavior, bearer projection, source descriptor selection, instrumentation, and response shape.
- [x] 1.2 Inventory current sandbox `GET /sandbox/v1/schema` behavior and route tests.
- [x] 1.3 Add or update focused tests that capture intended native and sandbox schema response shapes before refactoring. (Existing `query-contract.test.js` schema tests + sandbox `routes.test.ts` schema test cover owner, client, empty, source-descriptor, and live-shape invariants — preserved unchanged through the migration.)
- [x] 1.4 Confirm the operation module path and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-process-env boundary. (See `reference-implementation/operations/rs-schema-get/index.ts` header comment + `rs-schema-get-boundary.test.js`.)

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.schema.get` operation with explicit request, response, error, and dependency inputs.
- [x] 2.2 Add native dependencies that preserve existing owner-visible and grant-visible schema semantics. (Native `/v1/schema` route now wires `listConnectorItems` for the three branches: owner+native binding, owner+registered connectors, client+grant.)
- [x] 2.3 Add sandbox fixture dependencies backed by deterministic demo data, without importing sandbox UI/page code into the operation. (See `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` `createSandboxSchemaGetDependencies`.)
- [x] 2.4 Add operation-level tests for owner-style schema, client/grant bearer projection, source descriptor flow, and connector/stream counts where feasible. (`reference-implementation/test/rs-schema-get-operation.test.js` — 7 tests.)

## 3. Host Mounts

- [x] 3.1 Migrate the native Fastify `GET /v1/schema` route to call the operation while preserving request id, trace id, query-received, and disclosure-served behavior.
- [x] 3.2 Migrate the Next sandbox `GET /sandbox/v1/schema` route to call the same operation with the fixture profile and preserve sandbox demo headers.
- [x] 3.3 Delete or demote `buildLiveSchemaResponse` so the public sandbox route cannot import a parallel AS/RS builder. (Function and the now-unused `LiveSchemaResponse` / `LiveConnectorSchemaItem` types removed; replaced with a no-reintroduction comment alongside the existing stream-list / stream-detail demotion notes.)
- [x] 3.4 Add a grep/import-boundary test proving sandbox schema route code no longer imports `buildLiveSchemaResponse` and the operation does not import host or concrete storage modules. (`reference-implementation/test/rs-schema-get-boundary.test.js` — 3 tests.)

## 4. Validation

- [x] 4.1 Run targeted reference schema tests relevant to `/v1/schema`. (`query-contract.test.js`: 40/40 pass; `pdpp.test.js`: 112/112 pass; `provider-metadata.test.js` + `connector-failure-diagnostics-control-plane.test.js`: 30/30 pass.)
- [x] 4.2 Run targeted sandbox route tests relevant to `/sandbox/v1/schema`. (`apps/web/src/app/sandbox/_demo/routes.test.ts`: 20/20 pass.)
- [x] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`. (Pass.)
- [x] 4.4 Run `pnpm --filter pdpp-web types:check`. (Pass.)
- [x] 4.5 Run `pnpm --filter pdpp-web build` if web imports change. (Build succeeded; `/sandbox/v1/schema` still pre-renders.)
- [x] 4.6 Run `openspec validate mount-rs-schema-get-operation --strict`. (Pass.)
- [x] 4.7 Run `openspec validate --all --strict`. (50 passed / 0 failed.)
- [x] 4.8 Run `pnpm workstreams:status -- --no-fail` before owner review/merge. (Reports the expected dirty worktree for this branch; no other risks.)
