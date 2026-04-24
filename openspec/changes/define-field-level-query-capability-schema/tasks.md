## 1. Current Metadata Audit

- [x] 1.1 Re-read the stream metadata builder and query-contract tests for `/v1/streams/:stream`.
- [x] 1.2 Confirm current owner-token and client-token metadata behavior, including field-limited grants.
- [x] 1.3 Identify generated docs/OpenAPI surfaces that need the new fields.

## 2. Capability Builder

- [x] 2.1 Add a pure helper that derives `field_capabilities` from schema, grant projection, exact-filter rules, `query.range_filters`, lexical fields, and semantic fields.
- [x] 2.2 Add a pure helper that derives `expand_capabilities` from validated `relationships[]` + `query.expand[]`.
- [x] 2.3 Keep existing `schema`, `query`, and `relationships` response fields unchanged.

## 3. Route Wiring And Contract

- [x] 3.1 Add the new metadata fields to the public route contract schema.
- [x] 3.2 Wire the helpers into `GET /v1/streams/:stream`.
- [x] 3.3 Regenerate reference OpenAPI and generated docs.

## 4. Tests

- [x] 4.1 Add owner-token tests proving exact, range, lexical, semantic, and expansion capabilities are advertised.
- [x] 4.2 Add client-token tests proving grant-limited fields are not marked usable.
- [x] 4.3 Add regression coverage that existing metadata fields remain present.

## 5. Validation

- [x] 5.1 Run targeted query-contract tests.
- [x] 5.2 Run `pnpm --dir reference-implementation run verify`.
- [ ] 5.3 Run `pnpm --filter @pdpp/reference-contract run check:generated`.
- [x] 5.4 Run `openspec validate define-field-level-query-capability-schema --strict`.
- [x] 5.5 Run `openspec validate --all --strict`.
- [x] 5.6 Run `git diff --check`.
