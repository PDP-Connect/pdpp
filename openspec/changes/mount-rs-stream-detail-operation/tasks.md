## 1. Baseline And Boundary

- [ ] 1.1 Inventory current native `GET /v1/streams/:stream` owner/client behavior, errors, instrumentation, and response shape.
- [ ] 1.2 Inventory current sandbox `GET /sandbox/v1/streams/:stream` behavior and tests.
- [ ] 1.3 Add or update focused tests that capture intended native and sandbox stream-detail response shapes before refactoring.
- [ ] 1.4 Confirm the operation module path and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-process-env boundary.

## 2. Operation Implementation

- [ ] 2.1 Implement canonical `rs.streams.detail` operation with explicit request, response, error, and dependency inputs.
- [ ] 2.2 Add native dependencies that preserve existing owner-visible and grant-visible stream-metadata semantics.
- [ ] 2.3 Add sandbox fixture dependencies backed by deterministic demo data, without importing sandbox UI/page code into the operation.
- [ ] 2.4 Add operation-level tests for found, missing, and grant-visible stream detail behavior where feasible.

## 3. Host Mounts

- [ ] 3.1 Migrate the native Fastify `GET /v1/streams/:stream` route to call the operation while preserving request id, trace id, query-received/rejected, and disclosure-served behavior.
- [ ] 3.2 Migrate the Next sandbox `GET /sandbox/v1/streams/:stream` route to call the same operation with the fixture profile and preserve sandbox demo headers.
- [ ] 3.3 Delete or demote `buildLiveStreamMetadataResponse` so the public sandbox route cannot import a parallel AS/RS builder.
- [ ] 3.4 Add a grep/import-boundary test proving sandbox stream-detail route code no longer imports `buildLiveStreamMetadataResponse` and the operation does not import host or concrete storage modules.

## 4. Validation

- [ ] 4.1 Run targeted reference stream-detail tests relevant to `/v1/streams/:stream`.
- [ ] 4.2 Run targeted sandbox route tests relevant to `/sandbox/v1/streams/:stream`.
- [ ] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.4 Run `pnpm --filter pdpp-web types:check`.
- [ ] 4.5 Run `pnpm --filter pdpp-web build` if web imports change.
- [ ] 4.6 Run `openspec validate mount-rs-stream-detail-operation --strict`.
- [ ] 4.7 Run `openspec validate --all --strict`.
- [ ] 4.8 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
