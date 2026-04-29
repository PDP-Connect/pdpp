## Why

`define-reference-operation-environments` says AS/RS behavior should be owned by canonical reference operations, with Fastify, Next, and sandbox fixtures acting as hosts. `/v1/schema` is still implemented directly in the native route, while `/sandbox/v1/schema` uses a website-local `buildLiveSchemaResponse` builder that mirrors the live shape independently.

This keeps an important discovery surface split across two implementations. Schema discovery is the first endpoint many agents read, so drift here is disproportionately costly.

## What Changes

- Add a canonical `rs.schema.get` operation for bearer-visible schema discovery.
- Mount native `GET /v1/schema` through the operation while preserving bearer projection, source selection, query/disclosure instrumentation, and response shape.
- Mount sandbox `GET /sandbox/v1/schema` through the same operation with fixture dependencies.
- Delete or demote the public sandbox schema response builder so `/sandbox/v1/schema` cannot keep a parallel AS/RS implementation.
- Add operation, host, sandbox, and import-boundary tests.

## Capabilities

Modified:

- `reference-implementation-architecture`
- `reference-web-bridge-contract`

## Impact

- Adds operation code under `reference-implementation/operations/**`.
- Updates native reference server route wiring for `/v1/schema`.
- Updates sandbox route/dependency wiring for `/sandbox/v1/schema`.
- Adds tests and OpenSpec validation requirements.
