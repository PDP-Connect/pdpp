## ADDED Requirements

### Requirement: Reference operation modules SHALL be gated by a discovery-based boundary test

The reference implementation SHALL gate every canonical reference operation module under `reference-implementation/operations/<name>/index.ts` against forbidden host, storage, and process-environment dependencies through a discovery-based test, so that adding a new operation module without an explicit per-operation test does not silently bypass the gate.

#### Scenario: A new operation module is added

- **WHEN** a developer adds `reference-implementation/operations/<new-name>/index.ts`
- **THEN** the discovery-based boundary test SHALL include that module
- **AND** the test SHALL fail if the module statically imports Fastify, Express, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox UI/page code, `_demo/` builders, or the Node `process` module, or if the module references `process.env` in executable source outside of comments

#### Scenario: An operation module imports a forbidden concrete

- **WHEN** any operation module under `reference-implementation/operations/<name>/index.ts` introduces a static import that resolves a specifier of `fastify`, `express`, `next/`, `better-sqlite3`, `pg`, `./db`, `../db`, `../lib/db`, `../server/db`, `../server/records`, `../server/auth`, `../server/index`, `apps/web`, `_demo/`, `node:process`, or `process`
- **AND** the import takes any standard ES static-import shape — bare side-effect (`import "<x>";`), default (`import x from "<x>";`), namespace (`import * as x from "<x>";`), named (`import { x } from "<x>";`), type-only (`import type { X } from "<x>";`), or re-export (`export { x } from "<x>";`, `export * from "<x>";`)
- **THEN** the discovery-based boundary test SHALL fail with a message that names the module and the forbidden import

#### Scenario: An operation module accesses the process environment

- **WHEN** any operation module under `reference-implementation/operations/<name>/index.ts` references the process environment in executable source — either by spelling `process.env` directly outside of comments, or by statically importing the Node `process` module under the bare specifier (`process`) or the `node:` specifier (`node:process`) in any standard ES static-import shape
- **THEN** the discovery-based boundary test SHALL fail
- **AND** the test SHALL strip block and line comments before checking the literal `process.env` shape so module headers that document the rule do not trip the guard
- **AND** the failure message SHALL name the module and either the literal `process.env` rule or the forbidden Node `process` specifier
- **AND** dynamic imports of the Node `process` module (e.g., `await import("node:process")`) are intentionally out of scope for this static gate; this is a documented trade-off, not a guarantee

#### Scenario: The operations directory layout changes

- **WHEN** the discovery-based boundary test runs
- **THEN** it SHALL discover at least one operation module
- **AND** it SHALL fail loudly if zero operation modules are discovered, so a refactor that moves or renames the directory cannot silently neuter the gate
