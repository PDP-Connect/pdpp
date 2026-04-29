## Context

`mount-rs-streams-list-operation` introduced the first shared RS operation and fixture-backed sandbox mount. Stream detail is adjacent: the native route already computes metadata from manifest/grant/source state, and the sandbox route currently calls `buildLiveStreamMetadataResponse` from `_demo/builders.ts`.

This change continues the same migration discipline: one operation, two hosts, fixture dependencies, deletion of the public parallel builder.

## Goals / Non-Goals

**Goals:**

- Define a canonical `rs.streams.detail` operation with framework-independent request, response, error, and dependency inputs.
- Mount native `GET /v1/streams/:stream` through the operation while preserving auth, query/disclosure instrumentation, errors, and response shape.
- Mount sandbox `GET /sandbox/v1/streams/:stream` through the same operation using deterministic fixture dependencies.
- Remove `buildLiveStreamMetadataResponse` from public route reachability.
- Add tests proving operation behavior and host parity.

**Non-Goals:**

- Do not migrate stream list again except where shared dependency names need small reuse.
- Do not migrate `/v1/schema`, records, search, grants, runs, traces, `_ref`, or well-known routes.
- Do not introduce a production `RecordStore`, generic repository, Postgres adapter, or broad sandbox refactor.
- Do not alter public JSON shape except for a documented compatibility bug fix with tests.

## Decisions

### 1. Build on the streams-list operation seam

The worker should reuse or colocate with the `rs.streams.list` operation pattern rather than inventing a second architecture. If a shared `operations/rs-streams/**` directory is cleaner than two sibling operation folders, that is allowed only if it is a small move with grep validation.

### 2. Operation owns metadata assembly, hosts own transport

The operation should own which stream is visible, how manifest stream metadata becomes the live `stream_metadata` envelope, and how grant projection affects field capabilities. Hosts own path/query adaptation, response writing, headers, and disclosure events.

### 3. Errors must stay route-compatible

Missing or unauthorized stream behavior must remain compatible with current native and sandbox tests. If native and sandbox currently differ intentionally, preserve the difference in host adaptation and document it.

### 4. Builder deletion is the evidence

The public sandbox route must not import `buildLiveStreamMetadataResponse`. If helper code remains, it must be fixture-only dependency code or test-only support, not an AS/RS response builder reached by the route.

## Risks / Trade-offs

- Metadata assembly is richer than stream list -> keep this slice to a single stream detail response and avoid schema-wide graph migration.
- Grant projection can be subtle -> add at least one client/grant-scoped test if feasible; otherwise preserve existing native route test coverage and document the gap.
- Refactoring stream helper functions from `server/index.js` can cause churn -> prefer small extraction over broad cleanup.
- Sandbox/native behavior might not be byte-identical today -> preserve public expectations and write tests around the chosen compatibility shape.

## Migration Plan

1. Snapshot current native and sandbox stream detail behavior in targeted tests.
2. Add the operation and minimal native/sandbox dependency adapters.
3. Switch native and sandbox stream detail routes to the operation.
4. Delete/demote `buildLiveStreamMetadataResponse`.
5. Run targeted reference/web tests, typechecks, build if web imports change, and OpenSpec validation.

Rollback: restore the previous route call sites and sandbox builder import. The operation is additive until the routes are switched.
