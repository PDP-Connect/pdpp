# Grant-Scoped State Implementation Plan

Status: Working implementation memo  
Date: 2026-04-16

## Purpose

This memo describes how to evolve the current Collection Profile state seam from:

- one global `connector_state` namespace
- one owner-authenticated `GET/PUT /v1/state/:connectorId` surface

to:

- the existing global namespace for proactive runs
- an **optional** `grant_id`-scoped namespace for `continuous` grant runs

The goal is to make the implementation match the current Collection Profile direction without overbuilding a generic state framework.

## Current substrate

The current E2E substrate is simple and real:

- database table: `connector_state`
- key shape: `(connector_id, stream)`
- server surface: `GET /v1/state/:connectorId` and `PUT /v1/state/:connectorId`
- request body shape: `{ state: { [stream]: cursor } }`
- runtime behavior:
  - stages `STATE` messages in memory as `newState`
  - persists state only after `DONE { status: "succeeded" }`
  - `persistState: false` is used for `single_use`-style behavior
- CLI/runtime helper:
  - `loadSyncState(connectorId, ownerToken, { rsUrl })`

Important constraints from the current code:

- the runtime currently has no notion of grant-scoped state
- the server state API has no query or path parameter for `grant_id`
- the DB schema has no place to store grant-specific cursors
- tests currently only prove one global namespace

Important spec pressure:

- the Collection Profile now says proactive runs use the connector's global state namespace
- `continuous` grant runs use a `grant_id`-scoped namespace
- `single_use` runs use `state: null`
- the spec text already points to `GET/PUT /v1/state/{connector_id}?grant_id={grant_id}`

## Design rule

Do **not** solve this by building a general-purpose namespace framework.

The thin implementation target is:

- preserve the current global namespace unchanged
- add one optional grant-scoped namespace keyed by `grant_id`
- keep the endpoint shape close to the spec draft
- make runtime decisions with one small explicit branch:
  - proactive => global state
  - `continuous` grant => grant-scoped state
  - `single_use` => no persisted state

That is enough for the reference.

## What must be true after the change

1. Existing proactive runs still read and write the current global connector state.
2. `single_use` runs still receive `state: null` and do not persist checkpoints.
3. A `continuous` grant run can load and persist state in a `grant_id`-scoped namespace without disturbing global state.
4. The runtime does not need to understand grant semantics beyond:
   - whether this run is using a `grant_id`
   - whether state should come from global, grant, or nowhere

## Schema options

### Option A: add a separate `grant_connector_state` table

Schema:

```sql
CREATE TABLE grant_connector_state (
  grant_id      TEXT NOT NULL,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (grant_id, connector_id, stream)
);
```

Pros:

- minimal migration risk
- keeps existing `connector_state` untouched
- easy to reason about in code
- matches the conceptual split in the spec: global state versus grant state
- no need to rewrite existing callers or table semantics immediately

Cons:

- duplicate schema shape across two tables
- if we later want more namespaces, this becomes less elegant

### Option B: replace `connector_state` with one unified `state_store` table

Schema sketch:

```sql
CREATE TABLE state_store (
  state_scope   TEXT NOT NULL,   -- 'global' | 'grant'
  grant_id      TEXT,
  connector_id  TEXT NOT NULL,
  stream        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (state_scope, grant_id, connector_id, stream)
);
```

Pros:

- one table, one set of helpers
- more extensible if future namespace kinds appear

Cons:

- more migration work now
- forces a conceptual abstraction the reference does not yet need
- easy to over-generalize into a pseudo-framework

### Option C: mutate `connector_state` in place to add nullable `grant_id`

Concept:

- add `grant_id`
- rebuild the primary key as `(connector_id, grant_id, stream)`

Pros:

- superficially compact

Cons:

- awkward SQLite migration because the current primary key changes
- mixes global and grant rows into one table without clear semantics unless extra rules are added
- makes existing code and assumptions more fragile than necessary

## Schema recommendation

Use **Option A** first: add a separate `grant_connector_state` table.

Why:

- it is the smallest truthful change
- it preserves current global behavior
- it avoids inventing a general namespace model before the reference needs one
- it makes migration and rollback straightforward

If the reference later needs more than two namespaces, that would be the right time to collapse toward a unified table.

## Endpoint shape options

### Option 1: keep `/v1/state/:connectorId`, add optional `?grant_id=...`

Examples:

- global state:
  - `GET /v1/state/{connector_id}`
  - `PUT /v1/state/{connector_id}`
- grant-scoped state:
  - `GET /v1/state/{connector_id}?grant_id={grant_id}`
  - `PUT /v1/state/{connector_id}?grant_id={grant_id}`

Pros:

- matches the current Collection Profile text
- smallest delta to current server and runtime helpers
- easy runtime call site: same function, optional `grantId`

Cons:

- query-string semantics can be easier to miss than path-based semantics

### Option 2: add a separate path for grant state

Examples:

- `GET /v1/grants/{grant_id}/state/{connector_id}`
- `PUT /v1/grants/{grant_id}/state/{connector_id}`

Pros:

- very explicit

Cons:

- diverges from current spec direction
- introduces another surface to maintain
- creates more branching in server/router code and runtime helpers

### Option 3: generic namespace path

Examples:

- `GET /v1/state/{connector_id}/{scope}`
- `GET /v1/state/{connector_id}/grant/{grant_id}`

Pros:

- potentially extensible

Cons:

- over-designed for the current need
- not aligned with current profile text

## Endpoint recommendation

Use **Option 1**:

- preserve `/v1/state/:connectorId`
- add optional `?grant_id=...`

That is the smallest change and keeps the runtime call sites clean.

## Response shape options

### Minimal response evolution

Current response:

```json
{
  "object": "stream_state",
  "connector_id": "...",
  "state": { "...": { } },
  "updated_at": "..."
}
```

Recommended response after the change:

```json
{
  "object": "stream_state",
  "connector_id": "...",
  "grant_id": "gr_123",   // omitted or null for global
  "state": { "...": { } },
  "updated_at": "..."
}
```

Reason:

- adds only the one field a client/runtime may need for observability/debugging
- does not require a new `state_scope` abstraction in the wire format

Do **not** add:

- `state_scope`
- `namespace`
- generic labels for future scopes

The runtime already knows whether it asked for global or grant state.

## Runtime changes

The runtime should gain one explicit optional parameter:

- `grantId`

### `runConnector` changes

Current relevant inputs:

- `state`
- `collectionMode`
- `persistState`

Recommended additions:

- `grantId = null`

Recommended behavior:

- if `persistState === false`, runtime uses `state: null` and never persists
- else if `grantId` is present, runtime loads and commits grant-scoped state
- else runtime loads and commits global state

This keeps the runtime branch surface small and avoids introducing a generalized `stateNamespace` option.

### `commitState` changes

Current:

- `commitState(stream, cursor)` writes via `PUT /v1/state/:connectorId`

Recommended:

- `commitState(stream, cursor, { grantId })`
- if `grantId` exists, write to `PUT /v1/state/:connectorId?grant_id=...`
- else write to the existing global endpoint

### `loadSyncState` changes

Current:

- `loadSyncState(connectorId, ownerToken, { rsUrl })`

Recommended:

- `loadSyncState(connectorId, ownerToken, { rsUrl, grantId })`
- if `grantId` exists, call `GET /v1/state/:connectorId?grant_id=...`
- else keep existing behavior

### Keep the runtime ignorant of grant semantics

The runtime should **not** parse grant objects to decide state policy.

It should receive already-normalized execution intent from its caller, such as:

- `grantId`
- `persistState`

That is enough.

## Server changes

### DB helpers

Keep the current helpers for global state:

- `getSyncState(connectorId)`
- `putSyncState(connectorId, stateMap)`

Add new grant-scoped variants:

- `getGrantSyncState(grantId, connectorId)`
- `putGrantSyncState(grantId, connectorId, stateMap)`

Do **not** replace the global helpers yet.

### HTTP handlers

Extend existing handlers:

- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

Pseudo-behavior:

```js
const grantId = req.query.grant_id || null;
if (grantId) {
  // read/write grant_connector_state
} else {
  // read/write connector_state
}
```

### Validation

For the first cut, validate only:

- `grant_id` is syntactically present and non-empty when supplied

Do **not** yet require:

- checking that the `grant_id` exists
- checking that the grant is still active
- checking that the owner token subject matches a grant subject

Reason:

- current E2E state surfaces are owner-authenticated operational surfaces, not client-facing grant APIs
- the immediate goal is namespacing correctness, not a new authorization subsystem

If we later want tighter semantics, we can add:

- grant existence validation
- optional subject/grant consistency checks

But those should be explicit later hardening, not hidden phase-1 scope creep.

## Migration and compatibility strategy

### Migration goal

Preserve the current global behavior completely while adding grant-scoped behavior as opt-in.

### DB migration

Phase 1 migration:

1. Create `grant_connector_state`.
2. Leave `connector_state` untouched.
3. No data copy required.

This makes rollout simple:

- old code keeps working
- new grant-scoped callers can use the new namespace immediately

### API compatibility

Existing callers of:

- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

continue to work unchanged.

Only new callers that pass `grant_id` get the new behavior.

### Runtime compatibility

Existing runtime callers can omit `grantId`.

The helper signatures can evolve compatibly by making `grantId` optional.

### Rollout order

1. Add DB table and DB helpers.
2. Add server query-param branch.
3. Add runtime helper support for optional `grantId`.
4. Add tests.
5. Only then let higher-level orchestration actually pass `grantId` for `continuous` runs.

This keeps the migration incremental and low-risk.

## Test plan

The state seam needs focused tests, not broad integration slop.

### 1. Global behavior unchanged

Existing tests should still pass:

- proactive/global state persists exactly as before
- `single_use` / `persistState: false` still results in no persisted state

### 2. Grant-scoped state round-trip

Add tests proving:

- `PUT /v1/state/:connectorId?grant_id=g1` writes grant-scoped state
- `GET /v1/state/:connectorId?grant_id=g1` reads that state back
- response includes `grant_id: "g1"`

### 3. Namespace separation

Add tests proving:

- global state and grant state do not overwrite each other
- `grant_id=g1` and `grant_id=g2` do not overwrite each other

This is the core property the seam must prove.

### 4. Runtime persistence path

Add runtime tests proving:

- `runConnector(..., { grantId: 'g1', persistState: true })` writes to grant namespace
- `runConnector(..., { grantId: null, persistState: true })` writes to global namespace
- `runConnector(..., { grantId: 'g1', persistState: false })` does not persist any state

### 5. State loading path

Add tests proving:

- `loadSyncState(connectorId, ownerToken, { rsUrl, grantId: 'g1' })` returns grant state
- `loadSyncState(connectorId, ownerToken, { rsUrl })` still returns global state

### 6. Optional future validation tests

These can wait:

- invalid or unknown `grant_id`
- subject mismatch
- revoked grant handling for grant-scoped state operations

Those are real questions, but not required to prove the namespace seam.

## Recommended implementation sequence

1. Add `grant_connector_state` table.
2. Add `getGrantSyncState` / `putGrantSyncState`.
3. Extend `/v1/state/:connectorId` with optional `grant_id`.
4. Extend `loadSyncState` with optional `grantId`.
5. Extend runtime commit path with optional `grantId`.
6. Add focused tests for separation and compatibility.
7. Only after that wire `grantId` into whatever orchestrates `continuous` runs.

## Recommendation

Implement grant-scoped state as **one optional parallel namespace**:

- global state stays where it is
- grant state lives in a new table
- server surface stays `/v1/state/:connectorId` with optional `?grant_id=...`
- runtime gets one new optional parameter: `grantId`

That is enough to align the E2E seam with the Collection Profile direction without turning state handling into a generalized framework prematurely.
