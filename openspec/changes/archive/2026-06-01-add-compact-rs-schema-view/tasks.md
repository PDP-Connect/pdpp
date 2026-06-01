## 1. Spec Delta

- [x] Add an `ADDED Requirement` for the additive compact `GET /v1/schema` view under `reference-implementation-architecture`, covering: omitted-view full-body preservation, the compact identity-preserving projection, single-stream scoping, empty-on-unknown-stream, and the route-level down-projection boundary.
- [x] Run `openspec validate add-compact-rs-schema-view --strict` and `openspec validate --all --strict`.

## 2. Projection Module

- [x] Add a pure, typed projection module `reference-implementation/operations/rs-schema-get/compact-view.ts` that:
  - [x] preserves the `{ object, bearer, connectors[] }` envelope and per-connector metadata;
  - [x] preserves per-stream identity (`name`, `primary_key`, `cursor_field`, `source`) and connection identity (`granted_connections`, `connection_id` / `connector_instance_id` / `display_name` where present);
  - [x] collapses `field_capabilities.<field>` to a terse flag string (declared type, grant flag, usable exact/range/lexical/semantic/aggregation flags) using the MCP compact flag vocabulary;
  - [x] compacts `expand_capabilities` to relation summary fields;
  - [x] drops the raw per-stream/per-field JSON Schema and other verbose blobs;
  - [x] adds a top-level `detail: "compact"` marker;
  - [x] supports `stream` scoping with recomputed `stream_count`.
- [x] Keep the module within the operation boundary (no Fastify/Next/SQLite/Postgres/raw-SQL/repository/`process.env` imports).

## 3. Route Wiring

- [x] Read `view` (case-insensitive, trimmed) and optional `stream` off `GET /v1/schema` in `server/routes/rs-read.ts` `mountRsSchema`.
- [x] Apply the projection after `executeSchemaGet` and before `finalizeCanonicalEnvelope`, only when `view=compact`.
- [x] Record `requested_view: "compact"` and the scoped connector/stream counts on the `disclosure.served` instrumentation; keep `query_shape: "schema"`.
- [x] Confirm the full body path is unchanged when `view` is omitted or non-compact.
- [x] Make the compact selector and compact response marker visible in `@pdpp/reference-contract`, generated OpenAPI, and generated route docs so REST agents can discover it without out-of-band notes.

## 4. Byte-Budget / Conformance Tests

- [x] Add `reference-implementation/test/rs-schema-compact-view.test.js` modeled on `packages/mcp-server/test/schema-token-budget.test.js`, driving the real `/v1/schema` route from a registered large-manifest fixture (no live data):
  - [x] fixture full body is large enough to model the problem;
  - [x] default (view omitted) stays full and current-compatible (raw JSON Schema present, no `detail` marker);
  - [x] `view=compact` stays under a documented byte budget and far smaller than full, carries `detail: "compact"`;
  - [x] `view=compact` drops per-field JSON Schema but keeps flags + `granted_connections`;
  - [x] `view=compact&stream=<name>` scopes to one stream under a tight budget;
  - [x] unknown stream scope yields an empty connector set, not an error;
  - [x] compact per-field cost stays bounded as field count grows.

## 5. Validation

- [x] `pnpm --dir reference-implementation run typecheck`
- [x] `node --test test/rs-schema-compact-view.test.js`
- [x] Existing schema regression suites green (`rs-schema-get-operation`, `schema-granted-connections`, `schema-capability-truth`, `rs-schema-get-boundary`).
- [x] `pnpm --dir packages/reference-contract run check:generated`
- [x] `pnpm --dir packages/reference-contract run test`
- [x] `git diff --check`

## Acceptance Checks

- [x] `openspec validate add-compact-rs-schema-view --strict`
- [x] `openspec validate --all --strict`
- [x] `GET /v1/schema` default is byte-equivalent to prior behavior (no field loss).
- [x] `GET /v1/schema?view=compact` is materially smaller, identity-preserving, and drops raw JSON Schema. Evidence (6 streams x 30 fields fixture): full ~693 KB -> compact ~10 KB (~69x), per-stream compact ~1.9 KB.
- [x] `@pdpp/reference-contract` / OpenAPI / generated docs advertise `view=compact` and allow the compact response marker + compact field-capability flag strings.
