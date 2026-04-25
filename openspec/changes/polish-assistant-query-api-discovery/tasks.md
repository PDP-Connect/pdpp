## 1. Discovery Endpoint

- [x] Add contract/schema for `GET /v1/schema`.
- [x] Implement the RS route by reusing/extracting the current stream metadata capability builders.
- [x] Owner-token polyfill mode: enumerate owner-visible connectors and streams without requiring `connector_id`.
- [x] Client-token mode: scope discovery to the grant's source and streams.
- [x] Add tests for owner discovery, client-grant discovery, field-limited grants, and empty connectors.

## 2. Query Docs And Cookbook

- [x] Document stream-scoped lexical and semantic search filters with `streams[]=...&filter[field]...`.
- [x] Document `changes_since=beginning` as the initial incremental-sync path. (Already in cookbook; cross-referenced from new discovery section.)
- [x] Document `GET /v1/streams/:stream/aggregate` with valid `metric`, `field`, `group_by`, `filter[...]`, and error examples. (Already in cookbook; discovery section nudges toward `field_capabilities` for valid fields.)
- [x] Document blob byte access through `blob_ref.fetch_url` and explicitly avoid attachment-specific content endpoint claims.
- [x] Update generated docs/OpenAPI after contract changes.

## 3. Error Polish

- [x] Audit the assistant-observed 404/400 paths and improve valid-endpoint invalid-parameter messages where safe. (Search/semantic-search `filter[...]` error now names the supported `streams[]` shape and rejects `filter[stream]` / `filter[connector_id]` explicitly.)
- [x] Keep absent endpoints absent; do not add compatibility aliases unless the design explicitly approves them.

## 4. Validation

- [x] Run `pnpm --dir reference-implementation exec node --test test/query-contract.test.js`.
- [x] Run `pnpm --filter @pdpp/reference-contract run check:generated`.
- [x] Run `pnpm --dir reference-implementation run verify`.
- [x] Run `openspec validate polish-assistant-query-api-discovery --strict`.
- [x] Run `openspec validate --all --strict`.
