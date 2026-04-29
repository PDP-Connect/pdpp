## 1. Baseline And Boundary

- [ ] 1.1 Inventory current native `GET /v1/schema` owner/client behavior, bearer projection, source descriptor selection, instrumentation, and response shape.
- [ ] 1.2 Inventory current sandbox `GET /sandbox/v1/schema` behavior and route tests.
- [ ] 1.3 Add or update focused tests that capture intended native and sandbox schema response shapes before refactoring.
- [ ] 1.4 Confirm the operation module path and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-process-env boundary.

## 2. Operation Implementation

- [ ] 2.1 Implement canonical `rs.schema.get` operation with explicit request, response, error, and dependency inputs.
- [ ] 2.2 Add native dependencies that preserve existing owner-visible and grant-visible schema semantics.
- [ ] 2.3 Add sandbox fixture dependencies backed by deterministic demo data, without importing sandbox UI/page code into the operation.
- [ ] 2.4 Add operation-level tests for owner-style schema, client/grant bearer projection, source descriptor flow, and connector/stream counts where feasible.

## 3. Host Mounts

- [ ] 3.1 Migrate the native Fastify `GET /v1/schema` route to call the operation while preserving request id, trace id, query-received, and disclosure-served behavior.
- [ ] 3.2 Migrate the Next sandbox `GET /sandbox/v1/schema` route to call the same operation with the fixture profile and preserve sandbox demo headers.
- [ ] 3.3 Delete or demote `buildLiveSchemaResponse` so the public sandbox route cannot import a parallel AS/RS builder.
- [ ] 3.4 Add a grep/import-boundary test proving sandbox schema route code no longer imports `buildLiveSchemaResponse` and the operation does not import host or concrete storage modules.

## 4. Validation

- [ ] 4.1 Run targeted reference schema tests relevant to `/v1/schema`.
- [ ] 4.2 Run targeted sandbox route tests relevant to `/sandbox/v1/schema`.
- [ ] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.4 Run `pnpm --filter pdpp-web types:check`.
- [ ] 4.5 Run `pnpm --filter pdpp-web build` if web imports change.
- [ ] 4.6 Run `openspec validate mount-rs-schema-get-operation --strict`.
- [ ] 4.7 Run `openspec validate --all --strict`.
- [ ] 4.8 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
