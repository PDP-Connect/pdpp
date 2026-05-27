## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/streams/:stream` owner/client behavior, errors, instrumentation, and response shape.
- [x] 1.2 Inventory current sandbox `GET /sandbox/v1/streams/:stream` behavior and tests.
- [x] 1.3 Add or update focused tests that capture intended native and sandbox stream-detail response shapes before refactoring.
- [x] 1.4 Confirm the operation module path and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-process-env boundary.

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.streams.detail` operation with explicit request, response, error, and dependency inputs.
- [x] 2.2 Add native dependencies that preserve existing owner-visible and grant-visible stream-metadata semantics.
- [x] 2.3 Add sandbox fixture dependencies backed by deterministic demo data, without importing sandbox UI/page code into the operation.
- [x] 2.4 Add operation-level tests for found, missing, and grant-visible stream detail behavior where feasible.

## 3. Host Mounts

- [x] 3.1 Migrate the native Fastify `GET /v1/streams/:stream` route to call the operation while preserving request id, trace id, query-received/rejected, and disclosure-served behavior.
- [x] 3.2 Migrate the Next sandbox `GET /sandbox/v1/streams/:stream` route to call the same operation with the fixture profile and preserve sandbox demo headers.
- [x] 3.3 Delete or demote `buildLiveStreamMetadataResponse` so the public sandbox route cannot import a parallel AS/RS builder.
- [x] 3.4 Add a grep/import-boundary test proving sandbox stream-detail route code no longer imports `buildLiveStreamMetadataResponse` and the operation does not import host or concrete storage modules.

## 4. Validation

- [x] 4.1 Run targeted reference stream-detail tests relevant to `/v1/streams/:stream`.
- [x] 4.2 Run targeted sandbox route tests relevant to `/sandbox/v1/streams/:stream`.
- [x] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 4.4 Run `pnpm --filter pdpp-web types:check`.
- [x] 4.5 Run `pnpm --filter pdpp-web build` if web imports change.
- [x] 4.6 Run `openspec validate mount-rs-stream-detail-operation --strict`.
- [x] 4.7 Run `openspec validate --all --strict`.
- [x] 4.8 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
