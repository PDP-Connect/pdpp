## Context

`define-reference-operation-environments` established that AS/RS behavior should live behind canonical operation capsules and that hosts (Fastify, Next sandbox, tests) should adapt requests and supply environment dependencies. The `rs.streams.list`, `rs.streams.detail`, `rs.schema.get`, `rs.records.list`, `rs.records.get`, `rs.search.{lexical,semantic,hybrid}`, `ref.dataset.summary`, `ref.connectors.{list,detail}`, and `ref.approvals.list` proofs landed that pattern.

The remaining public RS read routes that still implement AS/RS semantics inline in `reference-implementation/server/index.js` are:

- `GET /v1/connectors` (`listConnectors`) — owner and client branches build a `{object: 'list', data}` envelope of connector discovery items inline. The route owns the `query.received` `connector_list` data block, the `disclosure.served` `connector_count`/`stream_count` fields, and source-descriptor selection.
- `GET /v1/streams/:stream/aggregate` (`aggregateStream`) — owns request-param shaping into a `stream_aggregate` query-shape data block, the manifest-stream-not-found visibility check (owner branch), `validateRequestedQueryFieldParams` invocation, and the `aggregateRecords` call. The native route returns `aggregateRecords`'s output verbatim.
- `GET /v1/blobs/:blob_id` — still inline. **Out of scope** here. Capsuling it requires a `BlobStore` (or equivalent) capability shape that does not yet exist; the route reads `blobs` and `blob_bindings` via raw SQL through `getDb()` and resolves visibility via per-binding `getRecord` calls. That contract belongs in a follow-up change (`add-blob-store-conformance-harness` or similar).

This change closes the operation-extraction gap for the two remaining capsule-able public RS read routes, leaving only `/v1/blobs/:blob_id` as the named exception in the next route audit.

## Goals / Non-Goals

**Goals:**

- Define canonical `rs.connectors.list` and `rs.streams.aggregate` operation modules whose semantics are independent of HTTP framework, sandbox UI, concrete database driver, and `process.env`.
- Mount each operation from the native Fastify reference server.
- Preserve existing public JSON shapes and instrumentation event shapes (`query.received`, `disclosure.served`).

**Non-Goals:**

- Do not migrate `GET /v1/blobs/:blob_id`. That requires a new `BlobStore` capability per `define-reference-operation-environments`.
- Do not extract a production `RecordStore`, `Kysely`, `BlobStore`, or `StorageBackend` interface. Operations accept narrow capability-shaped dependencies that wrap existing helpers (`buildConnectorDiscoveryItem`, `aggregateRecords`).
- Do not touch the connector-discovery item shape, the aggregate response shape, manifest/grant resolution, or `validateRequestedQueryFieldParams` semantics. These flow through the dependencies unchanged.
- Do not introduce sandbox routes for these endpoints — they have no website-sandbox parallel today.
- Do not refactor `server/index.js` outside the two route handlers being mounted.

## Decisions

### 1. Operation owns envelope, query-shape data, and visibility; capability owns storage and assembly

`rs.connectors.list`:

- owns the `{object: 'list', data}` envelope shape and the `query.received` / `disclosure.served` `connector_list` data block (including `connector_count` and `stream_count` totals);
- delegates connector-item assembly to a `listConnectorItems(): Promise<readonly ConnectorListItem[]>` capability. The host wires the actor branch (owner-native vs owner-multi-connector vs client-grant) and which `buildConnectorDiscoveryItem(...)` calls to make;
- delegates source descriptor to `getSourceDescriptor()`. The host computes this once and threads it through.

`rs.streams.aggregate`:

- owns request-param normalization into the `stream_aggregate` query-shape data block (`metric`, `field`, `group_by`, `limit` parsed as today);
- owns the owner-branch manifest-stream-not-found visibility error (matching the previous native route's `not_found` mapping);
- delegates the actual aggregation to an `aggregate(input)` capability that wraps `aggregateRecords` with `(storageBinding, stream, grant, requestParams, manifest)` already bound by the host;
- delegates the `validateRequestedQueryFieldParams` pre-check to a `validateRequest(requestParams)` capability so the operation does not statically import the validator (which lives in `server/records.js`);
- returns the aggregate result verbatim plus the `disclosure.served` data fields the host needs (`metric`, `field`, `group_by`, `filtered_record_count`, `group_count`).

Storage- and adapter-bound concerns stay behind dependencies. The operation does not import Fastify, Next, SQLite, Postgres, raw SQL handles, or `process.env`.

### 2. Hosts still own auth, instrumentation, response writing

Native Fastify retains:

- token/session authentication and `requireToken`-shaped pre-checks;
- request id / trace id assignment;
- `query.received` / `disclosure.served` event emission and `rejectQuery` error mapping;
- response writing (`res.json`);
- manifest resolution, grant resolution, and storage-binding resolution (these stay in the host because they currently couple to native server modules; the operation only consumes their results through capabilities).

Operation-thrown visibility errors carry a typed code (`not_found`) so host adapters can map them to existing error shapes without re-deriving the rule. For `rs.streams.aggregate`, `aggregateRecords` already throws typed `not_found` / `grant_stream_not_allowed` errors — the operation's own `not_found` is only the owner-branch pre-check that mirrors the previous route behavior.

### 3. No sandbox or fixture wiring in this change

Neither `/v1/connectors` nor `/v1/streams/:stream/aggregate` has a website-sandbox parallel today (unlike `/v1/streams/:stream/records*`, which does). The operation modules accept the same capability shape regardless of host; if a sandbox parallel is added later, it wires the capabilities the same way.

### 4. Operation modules MUST NOT import host or storage concretes

Same boundary as the existing operations: no Fastify, Next, SQLite, Postgres, raw DB modules, sandbox UI, `process` / `process.env`, or `server/index.js` / `server/records.js`. The shared `operation-boundary.js` gate enumerates the operations directory and enforces the rule for every operation, including the two new ones. Per-operation tests pin additional negative imports (no `server/records.js`).

### 5. Public response shape preserved

The change is structural, not behavioral. `/v1/connectors` SHALL continue returning `{object: 'list', data: [...connector items]}` with byte-equivalent items. `/v1/streams/:stream/aggregate` SHALL continue returning whatever `aggregateRecords` produces today (verbatim passthrough). Existing route tests are the regression baseline.

## Risks / Trade-offs

- **Capability surface for `rs.connectors.list` is broad.** The operation accepts a single `listConnectorItems()` capability that the host populates with the entire owner-native / owner-multi-connector / client-grant branching. We deliberately keep the branching in the host because the branching depends on `tokenInfo.pdpp_token_kind`, `resolveNativeManifest`, and `listRegisteredConnectorIds` — all of which couple to host modules. Pulling that into the operation would require extracting more capabilities than this slice can justify; the operation's job here is the envelope plus the data-block totals, not the multi-actor item-shaping.
- **`rs.streams.aggregate` thin-passes the result.** The operation does not constrain the aggregate response shape. That preserves the `aggregateRecords` contract verbatim but means the operation cannot grow stricter typing without coupling to records.js. We accept this trade-off; future work may narrow the result type once `aggregateRecords` itself moves under a capability with a typed return.
- **Validator coupling.** `validateRequestedQueryFieldParams` lives in `server/records.js`. Calling it through a capability dependency (`validateRequest`) keeps the operation boundary clean, and the per-operation boundary test pins the absence of a static `server/records.js` import.

## Migration Plan

1. Add the two operation modules under `reference-implementation/operations/rs-connectors-list/` and `rs-streams-aggregate/`.
2. Switch the native `GET /v1/connectors` route to mount `rs.connectors.list`. Preserve auth, request id / trace id, query/disclosure events, and the `{object: 'list', data}` envelope.
3. Switch the native `GET /v1/streams/:stream/aggregate` route to mount `rs.streams.aggregate`. Preserve auth, request id / trace id, query/disclosure events, owner-branch manifest visibility, validator invocation, and verbatim aggregate response.
4. Add per-operation boundary tests and operation-behavior tests with stub deps.
5. Run targeted tests, typecheck, and validation.

Rollback: the operation modules are additive until the routes are switched. If a regression is found before merge, revert the route handlers; the operation modules can stay or be deleted with no other consumer impact.

## Open Questions

- Should `rs.connectors.list` validate the `connector_list` query-shape limit (`stream_count_limit`) the way `rs.streams.list` echoes it? Decision: no — the previous native route did not echo a limit on this query shape, and adding one would change the `query.received` data block. Keep the data block at `{query_shape: 'connector_list'}` to preserve byte equivalence.
- Should `rs.streams.aggregate` move the owner-branch manifest visibility check after the validator call? Decision: preserve the previous native ordering — manifest visibility runs before the validator (during host-side manifest resolution); the validator runs against the resolved manifest stream.
