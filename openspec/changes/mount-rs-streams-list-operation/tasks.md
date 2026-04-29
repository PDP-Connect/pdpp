## 1. Baseline And Boundary

- [ ] 1.1 Inventory current native `GET /v1/streams` behavior, including owner/client branches, query/disclosure instrumentation, and response shape.
- [ ] 1.2 Inventory current sandbox `GET /sandbox/v1/streams` behavior and tests, including `connector_id`, `cursor`, and `limit` handling.
- [ ] 1.3 Add or update focused tests that capture the intended native and sandbox stream-list response shapes before refactoring.
- [ ] 1.4 Confirm the operation module path and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-process-env boundary.

## 2. Operation Implementation

- [ ] 2.1 Implement a canonical `rs.streams.list` operation with explicit request, response, error, and dependency inputs.
- [ ] 2.2 Add native dependencies that preserve existing owner-visible and grant-visible stream-list semantics.
- [ ] 2.3 Add sandbox fixture dependencies backed by deterministic demo data, without importing sandbox UI/page code into the operation.
- [ ] 2.4 Add operation-level tests for fixture/owner behavior and, where feasible, grant-visible filtering.

## 3. Host Mounts

- [ ] 3.1 Migrate the native Fastify `GET /v1/streams` route to call the operation while preserving request id, trace id, query-received, and disclosure-served behavior.
- [ ] 3.2 Migrate the Next sandbox `GET /sandbox/v1/streams` route to call the same operation with the fixture profile and preserve sandbox demo headers.
- [ ] 3.3 Delete or demote `buildLiveStreamsList` so the public sandbox route cannot import a parallel AS/RS builder.
- [ ] 3.4 Add a grep/import-boundary test proving sandbox stream-list route code no longer imports `buildLiveStreamsList` and the operation does not import host or concrete storage modules.

## 4. Validation

- [ ] 4.1 Run targeted reference stream-list/records tests relevant to `/v1/streams`.
- [ ] 4.2 Run targeted sandbox route/builder tests relevant to `/sandbox/v1/streams`.
- [ ] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck` if TypeScript reference files are changed.
- [ ] 4.4 Run `pnpm --filter pdpp-web types:check` if web TypeScript files are changed.
- [ ] 4.5 Run `openspec validate mount-rs-streams-list-operation --strict`.
- [ ] 4.6 Run `openspec validate --all --strict`.
- [ ] 4.7 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
