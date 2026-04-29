## Why

The reference-architecture refactor now has operation capsules, boundary gates, conformance harnesses, and second-adapter evidence. The lowest-risk storage domains have enough proof to move from test-only driver shapes into production interfaces.

Keeping all persistence inside `server/auth.js` and controller helpers now slows further extraction and keeps security-sensitive state harder to review. The next tranche should promote only the proven low-risk store seams, while leaving records/search/spine production adapters out of scope until their stricter contracts are ready.

## What Changes

- Extract production `ConsentStore` and `OwnerDeviceAuthStore` interfaces from the current pending-consent and device-code storage paths.
- Extract production `ConnectorStateStore` and `SchedulerStore` interfaces from connector state, schedules, and active-run storage paths.
- Provide SQLite-backed implementations that preserve current behavior and reuse existing conformance harnesses as the contract gate.
- Keep runtime Postgres, Kysely, `RecordStore`, `DisclosureSpineStore`, `LexicalIndex`, `SemanticIndex`, `BlobStore`, and operation rewiring out of scope.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: define the first production storage-interface extraction gate for proven low-risk reference stores.

## Impact

- `reference-implementation/server/**` — move low-risk persistence helpers behind store interfaces without changing route behavior.
- `reference-implementation/test/**` — run existing conformance suites against the production SQLite stores.
- `openspec/changes/extract-low-risk-reference-stores/tasks.md` — track worker lanes and owner merge gates.
