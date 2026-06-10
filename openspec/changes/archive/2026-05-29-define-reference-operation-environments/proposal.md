## Why

The reference implementation currently mixes AS/RS semantics, SQLite storage, Fastify transport, process startup, search indexes, connector control, and sandbox mocks in ways that make it too easy to create parallel behavior. We need an architecture that preserves one implementation of PDPP reference semantics while allowing local, Docker, test, and Vercel sandbox environments to provide different dependencies.

## What Changes

- Define the reference implementation around canonical operation implementations that can be mounted by multiple hosts.
- Define environment profiles as dependency composition, not alternate implementations of AS/RS behavior.
- Define capability-specific storage and retrieval contracts as the only acceptable abstraction shape for future SQLite/Postgres/mock portability.
- Define the evidence bar required before a storage/search abstraction is considered approved.
- Prohibit web/sandbox code from hand-building AS/RS semantics that the reference runtime owns.
- No runtime behavior changes are approved by this proposal alone; implementation remains experimental until each operation is migrated and proven by conformance evidence.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Adds operation-owned semantics, environment profiles, and capability-specific dependency contracts.
- `reference-implementation-governance`: Adds evidence requirements before storage/search abstractions or environment profiles can be treated as approved reference architecture.
- `reference-web-bridge-contract`: Requires website-hosted reference surfaces, including sandbox APIs, to mount reference operations rather than reimplement AS/RS behavior.

## Impact

- `reference-implementation/server/**`
- `reference-implementation/lib/**`
- `reference-implementation/runtime/**`
- `reference-implementation/server/queries/**`
- `apps/web/src/app/sandbox/**`
- `apps/web/src/app/dashboard/**`
- `packages/reference-contract/**`
- future dependency decisions such as `openapi-fetch` and Kysely
- future Postgres feasibility work, if pursued
