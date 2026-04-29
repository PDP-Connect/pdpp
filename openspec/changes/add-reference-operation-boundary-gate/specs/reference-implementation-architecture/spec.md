## ADDED Requirements

### Requirement: Reference operation modules SHALL be gated by a discovery-based boundary test

The reference implementation SHALL gate every canonical reference operation module under `reference-implementation/operations/<name>/index.ts` against forbidden host, storage, and process-environment dependencies through a discovery-based test, so that adding a new operation module without an explicit per-operation test does not silently bypass the gate.

#### Scenario: A new operation module is added

- **WHEN** a developer adds `reference-implementation/operations/<new-name>/index.ts`
- **THEN** the discovery-based boundary test SHALL include that module
- **AND** the test SHALL fail if the module statically imports Fastify, Express, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox UI/page code, or `_demo/` builders, or if the module reads `process.env` outside of comments

#### Scenario: An operation module imports a forbidden concrete

- **WHEN** any operation module under `reference-implementation/operations/<name>/index.ts` introduces a static import from `fastify`, `express`, `next/`, `better-sqlite3`, `pg`, `./db`, `../db`, `../lib/db`, `../server/db`, `../server/records`, `../server/auth`, `../server/index`, `apps/web`, or `_demo/`
- **THEN** the discovery-based boundary test SHALL fail with a message that names the module and the forbidden import

#### Scenario: An operation module references `process.env` outside of comments

- **WHEN** any operation module under `reference-implementation/operations/<name>/index.ts` contains executable `process.env` access
- **THEN** the discovery-based boundary test SHALL strip block and line comments before checking
- **AND** the test SHALL fail with a message naming the module

#### Scenario: The operations directory layout changes

- **WHEN** the discovery-based boundary test runs
- **THEN** it SHALL discover at least one operation module
- **AND** it SHALL fail loudly if zero operation modules are discovered, so a refactor that moves or renames the directory cannot silently neuter the gate
