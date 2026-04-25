## 1. Discovery Endpoint

- [ ] Add contract/schema for `GET /v1/schema`.
- [ ] Implement the RS route by reusing/extracting the current stream metadata capability builders.
- [ ] Owner-token polyfill mode: enumerate owner-visible connectors and streams without requiring `connector_id`.
- [ ] Client-token mode: scope discovery to the grant's source and streams.
- [ ] Add tests for owner discovery, client-grant discovery, field-limited grants, and empty connectors.

## 2. Query Docs And Cookbook

- [ ] Document stream-scoped lexical and semantic search filters with `streams[]=...&filter[field]...`.
- [ ] Document `changes_since=beginning` as the initial incremental-sync path.
- [ ] Document `GET /v1/streams/:stream/aggregate` with valid `metric`, `field`, `group_by`, `filter[...]`, and error examples.
- [ ] Document blob byte access through `blob_ref.fetch_url` and explicitly avoid attachment-specific content endpoint claims.
- [ ] Update generated docs/OpenAPI after contract changes.

## 3. Error Polish

- [ ] Audit the assistant-observed 404/400 paths and improve valid-endpoint invalid-parameter messages where safe.
- [ ] Keep absent endpoints absent; do not add compatibility aliases unless the design explicitly approves them.

## 4. Validation

- [ ] Run `pnpm --dir reference-implementation exec node --test test/query-contract.test.js`.
- [ ] Run `pnpm --filter @pdpp/reference-contract run check:generated`.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Run `openspec validate polish-assistant-query-api-discovery --strict`.
- [ ] Run `openspec validate --all --strict`.
