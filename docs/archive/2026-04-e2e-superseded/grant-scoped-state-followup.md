# Grant-Scoped State Follow-up

Date: 2026-04-16
Status: Narrow implementation memo against live `e2e/runtime` and `e2e/server`

## Bottom line

The smallest safe cut is still:

- keep the existing external RS state path: `GET/PUT /v1/state/:connectorId`
- add only an optional `?grant_id=...` selector for `continuous` grant runs
- keep global connector state as the default when `grant_id` is absent
- add one new grant-scoped table instead of abstracting a general namespace model
- thread optional `grantId` through runtime helpers, but do not overhaul ingest, query, or scheduler contracts yet

That gives the reference a truthful `continuous` grant state seam without pretending the whole runtime is already grant-aware.

## What the live code actually does today

### Server

- [e2e/server/db.js](/e2e/server/db.js:1)
  - stores sync state only in `connector_state`
  - key is `(connector_id, stream)`
- [e2e/server/records.js](/e2e/server/records.js:693)
  - `getSyncState(connectorId)` and `putSyncState(connectorId, stateMap)` are connector-global only
- [e2e/server/index.js](/e2e/server/index.js:543)
  - exposes `GET /v1/state/:connectorId`
  - exposes `PUT /v1/state/:connectorId`
  - neither route accepts `grant_id`

### Runtime

- [e2e/runtime/index.js](/e2e/runtime/index.js:26)
  - `runConnector()` has no `grantId` input
  - `commitState()` writes to `/v1/state/:connectorId`
  - `loadSyncState()` reads from `/v1/state/:connectorId`
- [e2e/runtime/scheduler.js](/e2e/runtime/scheduler.js:75)
  - only distinguishes `continuous` vs `single_use` through `grantAccessMode`
  - still keys all persisted state by `connectorId`
  - does not know any actual `grantId`

### Important live constraint

There is still no real grant-driven runtime caller in the repo. Current runtime tests call `runConnector()` directly, and the scheduler is still experimental. That means the first implementation cut should make the substrate grant-capable and prove it with a direct test, not redesign the orchestration layer.

## Smallest safe implementation cut

### 1. Add a separate grant-scoped table

Touch:

- [e2e/server/db.js](/e2e/server/db.js:1)

Add:

```sql
CREATE TABLE IF NOT EXISTS grant_connector_state (
  grant_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (grant_id, connector_id, stream)
);
```

Do not mutate `connector_state` in place. The additive table is the lowest-risk migration and keeps current proactive/global behavior intact.

### 2. Extend state helpers, do not generalize them

Touch:

- [e2e/server/records.js](/e2e/server/records.js:693)

Change helpers to accept an optional `grantId`:

- `getSyncState(connectorId, { grantId } = {})`
- `putSyncState(connectorId, stateMap, { grantId } = {})`

Behavior:

- no `grantId` => read/write existing `connector_state`
- `grantId` present => read/write `grant_connector_state`

Keep the response shape close to current shape. The only additive field should be `grant_id` when present.

Do not build a generic namespace abstraction yet.

### 3. Keep the RS API path stable; add only query-string selection

Touch:

- [e2e/server/index.js](/e2e/server/index.js:543)

Change:

- `GET /v1/state/:connectorId` to pass `req.query.grant_id || null`
- `PUT /v1/state/:connectorId` to pass `req.query.grant_id || null`

Do not change:

- path shape
- body shape
- ingest routes
- record query routes

This is the right minimal external contract delta.

### 4. Thread optional `grantId` through runtime helpers

Touch:

- [e2e/runtime/index.js](/e2e/runtime/index.js:26)

Add optional `grantId` to:

- `runConnector(opts)`
- internal `commitState()`
- `loadSyncState(connectorId, ownerToken, opts = {})`

Behavior:

- if `grantId` is present, append `?grant_id=...` to state GET/PUT
- if not present, preserve current behavior exactly

Do not change:

- `POST /v1/ingest/:stream`
- START payload shape beyond whatever current profile cleanup already requires

The runtime only needs to know whether this run has a grant-specific state namespace. It does not need a broader grant model here.

### 5. Do not make the scheduler carry this in the first cut

Probably do not touch yet:

- [e2e/runtime/scheduler.js](/e2e/runtime/scheduler.js:1)

Reason:

- it still has no real grant lifecycle/input
- forcing `grantId` into the scheduler now would enlarge the cut without proving more of the real contract

The first proof should be a direct `runConnector({ grantId, persistState: true })` test.

## Exact file touch points

### Must touch

- [e2e/server/db.js](/e2e/server/db.js:1)
- [e2e/server/records.js](/e2e/server/records.js:693)
- [e2e/server/index.js](/e2e/server/index.js:543)
- [e2e/runtime/index.js](/e2e/runtime/index.js:26)
- [e2e/test/collection-profile.test.js](/e2e/test/collection-profile.test.js:1)

### Likely touch for direct grant-aware proof

- [e2e/test/pdpp.test.js](/e2e/test/pdpp.test.js:1)

Use this only if you want to prove the `grant_id` came from a real approved grant rather than a synthetic runtime call.

### Probably do not touch in this cut

- [e2e/server/auth.js](/e2e/server/auth.js:1)
- [e2e/runtime/scheduler.js](/e2e/runtime/scheduler.js:1)
- [e2e/server/index.js](/e2e/server/index.js:495) ingest/delete/reset routes
- record storage/versioning logic in [e2e/server/records.js](/e2e/server/records.js:1)

## Migration advice

- Schema migration should be additive only. No backfill is required.
- Existing connector-global state remains authoritative for proactive/global runs.
- Grant-scoped state starts empty for every grant. Do not seed it from global state automatically.
- Deploy/order of implementation:
  1. add table
  2. add server helpers
  3. update RS routes
  4. thread optional `grantId` through runtime
  5. add direct tests

That order keeps the system working at every step and avoids breaking current callers.

## First tests to add

1. Global state remains unchanged:
   - `loadSyncState(connectorId, ownerToken)` still reads/writes the existing namespace

2. Grant-scoped state is isolated:
   - run with `grantId = A` and persist `items -> cursor_A`
   - run with `grantId = B` and verify it does not see `cursor_A`
   - verify global state is still empty

3. `single_use` still persists nothing:
   - `persistState: false` remains the only guard needed

4. Mixed-mode safety:
   - global state exists for connector
   - grant-scoped read for same connector still returns only grant rows

## Top regression risks

### 1. Silent fallback from grant scope to global scope

If `grant_id` is ignored or lost in one layer, a `continuous` grant run may quietly read/write global connector state.

Why it matters:

- leaks state across grants
- makes the feature look implemented while violating the intended boundary

### 2. Breaking current global state callers

The current tests and runtime all assume connector-global state. Any change that makes `grant_id` mandatory or changes the default namespace will break the existing reference behavior.

### 3. Overextending the cut into operational routes

If ingest/delete/reset or scheduler behavior is changed at the same time, the change gets much riskier than necessary.

### 4. Pretending the scheduler is grant-aware before it is

The scheduler currently has `grantAccessMode`, not real `grantId`. Using it as if it already supports grant-specific state would be misleading and likely wrong.

## Recommendation

Implement grant-scoped state as one additive table plus one optional `grant_id` selector on the existing state routes. Prove it first with direct runtime tests, keep all non-state RS surfaces unchanged, and leave scheduler/orchestration cleanup for the next pass once a real grant-aware caller exists.
