## Why

The reference-architecture refactor has operation boundaries and first-pass conformance harnesses, but most storage semantics are still proven only against SQLite plus deliberately broken drivers. That is not enough evidence to extract production `RecordStore`, `DisclosureSpineStore`, or related adapter contracts without weakening semantics.

The next high-leverage batch is to add conforming second adapters to existing harnesses. This keeps production code untouched while proving the harnesses describe portable PDPP behavior rather than SQLite accidents.

## What Changes

- Add conforming in-memory drivers for record-read, record-mutation, and disclosure-spine conformance harnesses.
- Add an env-gated Postgres record-read conformance driver against the existing Compose Postgres proof service.
- Require self-falsification notes for each adapter lane so green tests do not become theater.
- Keep production storage/search interfaces, runtime Postgres configuration, Kysely adoption, operation rewiring, and `expand[]` harness expansion out of scope.

## Capabilities

### Modified Capabilities

- `reference-implementation-governance`: clarify that storage/search abstraction readiness requires at least one conforming second adapter for the relevant capability harness before production interfaces are extracted.

## Impact

- `reference-implementation/test/helpers/*` — add second-adapter test drivers.
- `reference-implementation/test/*conformance-*.test.js` — run existing harnesses against those drivers.
- `openspec/changes/add-second-conformance-adapters/tasks.md` — owner tracks the batch and marks tasks complete after consolidated review.

