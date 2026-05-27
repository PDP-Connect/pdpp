## Context

`define-reference-operation-environments` establishes the target: AS/RS behavior belongs to canonical reference operations, while Fastify, Next, sandbox, and tests are hosts that adapt requests and provide environment dependencies. The sandbox currently violates that target for `/sandbox/v1/streams`: it calls `buildLiveStreamsList` in website code, which mirrors the live shape but remains a separate implementation.

`rs.streams.list` is the right first operation proof because it is read-only, already live in the native server, already live-shaped in the sandbox, and small enough to validate without touching record pagination, search, grants, or connector execution.

## Goals / Non-Goals

**Goals:**

- Define a canonical `rs.streams.list` operation module with request normalization, execution, response shape, and error behavior owned outside Fastify and Next.
- Mount the operation from the native reference server's `GET /v1/streams` route.
- Mount the same operation from the sandbox `GET /sandbox/v1/streams` route through a fixture environment profile/dependency.
- Delete or demote the public sandbox stream-list response builder so the sandbox route cannot drift independently.
- Prove parity with tests that exercise the operation directly and through both host adapters.

**Non-Goals:**

- Do not introduce a production `RecordStore`, generic repository, Postgres adapter, or broad storage abstraction.
- Do not migrate `/v1/schema`, `/v1/streams/:stream`, records, search, `_ref`, grants, runs, traces, or well-known routes.
- Do not change the public JSON shape of `/v1/streams` or `/sandbox/v1/streams` except for intentional bug fixes documented in tests.
- Do not make the sandbox a full protocol conformance suite in this slice.

## Decisions

### 1. Operation module first, package split later

Create the operation inside the reference implementation source tree rather than a new package. The worker may choose the smallest practical path, but the operation must be framework-independent and import no Fastify, Next, SQLite driver, `process.env`, or sandbox UI modules.

Rationale: package boundaries are not the proof. The proof is dependency direction and host reuse.

### 2. Dependencies are capability-shaped, not table-shaped

The operation should depend on narrow stream-summary capabilities, for example:

- list owner-visible stream summaries for a source/storage binding
- list grant-visible stream summaries with manifest metadata
- build stream discovery capabilities from manifest stream definitions

The exact names are implementation details, but the dependency shape must not be a generic repository or raw SQL/query-builder object.

Rationale: this keeps the slice aligned with PDPP semantics without prematurely extracting a full `RecordStore`.

### 3. Fastify and Next are hosts only

The native route should keep token validation, request id/header adaptation, and response writing in `server/index.js`, but stream-list business logic moves behind the operation. The sandbox route should adapt `Request`/`URLSearchParams` and call the same operation with fixture dependencies.

Rationale: hosts adapt transport; they do not define AS/RS behavior.

### 4. Sandbox fixture data is an environment dependency

The sandbox can continue using `_demo/dataset.ts` as deterministic input. It should not use a public builder named as live AS/RS behavior. If helper functions remain, they must be private fixture dependency helpers or test-only builders, not the route's semantic source of truth.

Rationale: fixture data is legitimate. Forked AS/RS logic is not.

### 5. Parity is proven by deletion and tests

The change must include at least:

- operation-level tests for owner/fixture and grant-visible stream-list behavior where feasible
- native-route regression coverage or direct route helper tests preserving current `/v1/streams` shape
- sandbox-route test proving `/sandbox/v1/streams` still returns the expected live-shaped list
- a grep/import-boundary check or targeted test proving the sandbox route no longer imports `buildLiveStreamsList`

Rationale: the sandbox drift class is only fixed if the old public builder is removed from route reachability.

## Risks / Trade-offs

- Operation shape grows too broad -> Keep the operation to stream list only and reject records/search abstractions in this change.
- Sandbox output accidentally changes -> Use existing route tests as the compatibility baseline and add fixture-operation tests before deleting the builder.
- Fastify route loses disclosure-spine/query instrumentation -> Treat request id, trace id, disclosure events, and query-received events as route/operation obligations that must remain covered.
- Worker invents architecture vocabulary -> Keep names boring and local; the owner can rename after the proof if needed.

## Migration Plan

1. Snapshot current `/v1/streams` and `/sandbox/v1/streams` behavior in tests.
2. Add the operation module and minimal dependency adapters for native SQLite-backed data and sandbox fixture data.
3. Switch the native `GET /v1/streams` route to call the operation while preserving auth, headers, and disclosure instrumentation.
4. Switch the sandbox route to call the same operation through fixture dependencies.
5. Delete or demote `buildLiveStreamsList` so it cannot be reached by the public route.
6. Run targeted reference and web tests, typechecks, and OpenSpec validation.

Rollback: restore the prior route call sites and sandbox builder import. Because the operation is additive until routes are switched, rollback is limited to this slice.

## Open Questions

- Whether the operation should live under `reference-implementation/src/operations/**` or a transitional `reference-implementation/server/operations/**` path is left to the worker, with the constraint that it must not import host/framework/storage concretes.
- Whether native route instrumentation remains outside the operation or is passed in as an operation event sink can be decided during implementation. The acceptance criterion is no loss of existing disclosure/query events.
