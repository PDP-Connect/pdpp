## Context

The current schema discovery surface has two semantic homes:

- Native `GET /v1/schema` in `reference-implementation/server/index.js` resolves bearer scope, manifests, storage bindings, field capabilities, freshness, and disclosure events.
- Sandbox `GET /sandbox/v1/schema` returns a live-shaped response through `buildLiveSchemaResponse()` in `apps/web/src/app/sandbox/_demo/builders.ts`.

The sandbox response is useful and close to live shape, but it remains a parallel AS/RS implementation. Schema is also a high-leverage agent-discovery endpoint: if this drifts, fresh agents learn the wrong contract before they make any data call.

## Goals / Non-Goals

Goals:

- Introduce a canonical `rs.schema.get` operation with explicit input, output, error, and dependency boundaries.
- Preserve native `/v1/schema` owner/client behavior, bearer projection, response shape, request id / trace id, `query.received`, and `disclosure.served` behavior.
- Preserve sandbox `/sandbox/v1/schema` live-shaped response and `x-pdpp-demo` header while sourcing behavior from the operation.
- Keep schema-item envelope assembly operation-owned or dependency-owned in a way that does not import Fastify, Next, SQLite, or process globals into the operation.
- Add boundary tests that prevent the sandbox route from importing a parallel public schema builder.

Non-goals:

- Do not change the public schema JSON shape except for an explicitly tested compatibility correction.
- Do not introduce a production `RecordStore`, `ManifestStore`, generic repository, Postgres adapter, or generated OpenAPI client.
- Do not migrate records, search, grants, traces, runs, well-known metadata, or `_ref` routes.
- Do not solve field-capability completeness or schema documentation gaps in this slice.

## Decisions

### 1. Schema discovery is an operation, not a sandbox builder

The operation should own the schema-discovery result shape:

```ts
{
  object: "schema",
  bearer: { token_kind, scope, grant_id?, client_id? },
  connectors: [...]
}
```

Hosts may assemble environment-specific dependencies, but the public schema route should not call a website-local `buildLiveSchemaResponse()`.

### 2. Connector schema rows may remain dependency-assembled if bounded

The native implementation already has `buildConnectorSchemaItem()`, which combines manifest stream definitions, grant field selection, and stream freshness. The worker may either move that logic into the operation or pass a narrow dependency that returns connector schema items.

The hard boundary is import direction: the operation must not import Fastify, Next, SQLite, raw SQL handles, `server/index.js`, sandbox UI/page code, or `process.env`.

### 3. Native instrumentation remains host-owned

The native route should keep request id, trace id, response writing, and disclosure-spine emission in `server/index.js` for this slice. The operation should return enough data for the host to emit the same `query_shape: "schema"`, `connector_count`, `stream_count`, and source descriptor behavior as before.

This avoids turning the operation into an event bus abstraction before the reference operation pattern is proven.

### 4. Sandbox fixture data is an environment profile

The sandbox may continue using `DEMO_CONNECTORS`, `DEMO_STREAMS`, and `DEMO_RECORDS`. Those are fixture data. What must go away is the public route depending on a separate live-shaped schema response builder.

`buildLiveStreamMetadata()` may remain as a shared envelope helper if it is used by operation fixture dependencies and existing schema/stream-detail fixtures. A route-visible `buildLiveSchemaResponse()` should be deleted or demoted so it cannot be the semantic owner of `/sandbox/v1/schema`.

### 5. Tests must prove non-drift, not just green-path output

Required evidence:

- Operation-level tests for owner-style schema, client/grant bearer projection, source descriptor flow, connector/stream counts, and dependency call ordering where feasible.
- Sandbox route tests proving `/sandbox/v1/schema` returns the live-shaped schema envelope from fixture dependencies.
- Boundary tests proving the operation does not import host/storage concretes and the sandbox schema route does not import `buildLiveSchemaResponse`.
- Native route regression evidence through focused existing tests or new targeted tests that exercise `/v1/schema` for owner/client behavior.

## Risks / Trade-offs

- Schema connector-item assembly may be too large for the operation. Mitigation: keep assembly behind narrow dependencies, but require operation-level output and boundary tests.
- Native route instrumentation may accidentally shift. Mitigation: preserve host-owned emission and assert query/disclosure behavior where existing tests make that practical.
- Sandbox schema shape may diverge from live shape. Mitigation: keep existing sandbox route invariants and add a boundary check against the old builder.
- This may reveal current shape inconsistencies between `/v1/schema` and `/v1/streams/:stream`. Fix only if clearly a bug and covered by tests; otherwise document as follow-up.

## Migration Plan

1. Inventory native and sandbox schema behavior and tests.
2. Add `rs.schema.get` operation with explicit dependencies.
3. Add sandbox fixture dependencies that derive schema connectors/streams from demo data.
4. Migrate native `GET /v1/schema` to call the operation without losing instrumentation.
5. Migrate sandbox `GET /sandbox/v1/schema` to call the operation and remove/demote `buildLiveSchemaResponse`.
6. Add operation and boundary tests.
7. Run targeted native/sandbox tests, typechecks, web build if imports change, and OpenSpec validation.

Rollback: restore prior route bodies and sandbox builder import. Because the operation is additive until routes are switched, rollback is limited to this slice.
