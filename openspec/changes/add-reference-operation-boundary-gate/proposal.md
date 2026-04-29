## Why

Each canonical RS operation (`rs.streams.list`, `rs.streams.detail`, `rs.schema.get`) currently has a hand-written boundary test that asserts no Fastify/Next/SQLite/Postgres/raw-DB/`process.env` imports. The forbidden-import list is duplicated three times. A future operation added under `reference-implementation/operations/<name>/index.ts` without an explicit per-operation boundary test would silently bypass the gate, which is exactly the drift class these tests are supposed to prevent.

## What Changes

- Add a single conformance gate that discovers all operation modules at `reference-implementation/operations/*/index.ts` and asserts no static imports of host, storage, sandbox, or Node `process` modules and no executable `process.env` access (the Node-process import ban closes the indirection path that lets `import { env } from "node:process"` bypass a literal `process.env` text scan).
- Centralize the forbidden-import list and comment-stripping rule in one shared helper so the rule cannot drift between operations.
- Keep the existing per-operation boundary tests for sandbox-route and `_demo` builder demotion checks, which are operation-specific evidence rather than a general rule. Migrate the "operation has no host or storage concretes" assertion in those files to consume the shared helper so the rule lives in one place.
- No production behavior changes. This is a test-only conformance gate.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Adds one shared test helper and one new test file under `reference-implementation/test/`.
- Updates the three existing per-operation boundary tests to consume the shared rule.
- No runtime, route, schema, manifest, or storage changes.
