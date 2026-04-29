## Context

The larger refactor is not trying to make storage generic for its own sake. The goal is to isolate PDPP capability semantics from SQLite implementation details without weakening security, cursor, versioning, or audit behavior.

The evidence bar is now met for four low-risk store seams:

- consent / pending provider-connect storage;
- owner device authorization storage;
- connector state storage;
- connector schedule / active-run storage.

These domains already have conformance harnesses and second-adapter or Postgres-oriented proof. They avoid the hardest remaining surfaces: record JSON filtering, `changes_since`, field projection, vector search, FTS scoring, blob bytes, and disclosure-spine sequence contracts.

## Decisions

### 1. Extract only proven low-risk stores first

This change promotes the conformance-driver shapes for `ConsentStore`, `OwnerDeviceAuthStore`, `ConnectorStateStore`, and `SchedulerStore` into production interfaces. It does not introduce a broad `Database`, `Repository`, or `StorageBackend` abstraction.

### 2. SQLite remains the only runtime implementation

The production runtime continues using SQLite. Postgres stays a proof/test backend. No `PDPP_STORAGE_BACKEND`, `PDPP_DATABASE_URL`, runtime Kysely dependency, or runtime adapter selection is introduced here.

### 3. Conformance harnesses become the interface gate

The existing conformance suites are the acceptance contract. Each new production SQLite implementation must pass the relevant harness through a production-store-backed test adapter, not just through the older test helper wrapper.

### 4. Interfaces are semantic, not table-shaped

Interface methods must name capability operations: start pending consent, approve consent, poll device code, read connector state, upsert schedule, claim active run, drain active runs. They must not expose raw SQL, query builders, table rows, or `getDb()`.

### 5. Records/search/spine remain intentionally deferred

`RecordStore`, `DisclosureSpineStore`, `LexicalIndex`, `SemanticIndex`, and `BlobStore` need stricter contracts before production extraction. This change must not pre-design those interfaces by analogy.

## Worker Lanes

### Lane A: consent and owner-device stores

Extract interfaces and SQLite implementation for pending consent and owner device auth. Preserve current route behavior and token/security semantics. Add production-store-backed conformance tests.

### Lane B: connector state and scheduler stores

Extract interfaces and SQLite implementation for connector state, connector schedules, and active runs. Preserve grant isolation, schedule upsert, active-run uniqueness, and reconciliation semantics. Add production-store-backed conformance tests.

### Lane C: owner integration review

After both lanes report, owner reviews diffs together, checks interface naming against the design, runs the combined conformance and route suites, and updates tasks. Workers do not merge directly.

## Acceptance Checks

- No route/API behavior changes.
- No runtime Postgres backend.
- No broad storage framework abstraction.
- No production interface for records/search/spine/blob.
- Production SQLite stores pass existing conformance suites.
- Existing route/controller tests remain green.
- OpenSpec strict/all passes.

## Stop Conditions

- A store interface needs to expose raw SQL, `Database`, prepared statements, or query-builder objects.
- A worker needs to alter public auth, grant, token, schedule, or connector-state behavior to make the interface fit.
- A worker tries to include record/search/spine/blob extraction.
- A worker introduces runtime backend selection or runtime Postgres configuration.
