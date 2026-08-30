## 1. Durable optional builder

- [x] 1.1 Add required HNSW job state and a bounded builder with one advisory owner.
- [x] 1.2 Remove global and hot-source HNSW construction from synchronous bootstrap.
- [x] 1.3 Schedule and isolate the builder after AS/RS listeners bind.

## 2. Verification

- [x] 2.1 Add fail-before readiness, no-index read, builder idempotency, and
  restart/crash/failure observability tests.
- [x] 2.2 Preserve required migration fail-closed coverage and SQLite parity.
- [x] 2.3 Run focused Postgres tests, typecheck, Biome, readiness/restart mutants,
  and the five-part checklist.

## Acceptance checks

- `openspec validate defer-postgres-hnsw-build --strict`
- `openspec validate --all --strict`
- Dedicated Postgres tests pass when the Postgres profile is available.
- Required checks pass or the handoff names the unavailable external boundary.
