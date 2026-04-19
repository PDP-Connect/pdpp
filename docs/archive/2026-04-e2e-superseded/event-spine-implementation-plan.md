# Event Spine Implementation Plan

Date: 2026-04-16

## Bottom line

The first coding pass should add a small, append-only reference event spine to the existing `e2e/` substrate without trying to turn the whole system into a telemetry platform.

That means:

- persist canonical events
- persist a small set of durable artifacts
- keep current domain state in the existing tables
- derive timelines and summaries from the event spine at read time
- instrument only the main lifecycle seams that already exist in the current code

The first pass should be good enough to support:

- trace-backed test assertions
- CLI inspection
- future control-plane timelines
- future illustrated-flow playback

It should not attempt to solve every observability problem up front.

## What this plan is based on

This plan is grounded in the current code, not just the conceptual event-spine draft.

The main emission seams in the current substrate are:

- `e2e/server/auth.js`
  - `initiateGrant`
  - `approveGrant`
  - `denyGrant`
  - `issueToken`
  - `issueGrantToken`
  - `issueOwnerToken`
  - `introspect`
  - `revokeGrant`
- `e2e/server/index.js`
  - `/grants/initiate`
  - `/consent/:deviceCode/*`
  - `/owner-token`
  - `/grants/:grantId/revoke`
  - `/v1/streams/:stream/records`
  - `/v1/streams/:stream/records/:id`
  - `/v1/ingest/:stream`
  - `/v1/state/:connectorId`
- `e2e/server/records.js`
  - `ingestRecord`
  - `queryRecords`
  - `getRecord`
  - `deleteRecord`
  - `putSyncState`
- `e2e/runtime/index.js`
  - `runConnector`
  - `flushBatch`
  - `commitState`
  - `INTERACTION` handling
  - `DONE` handling

The first-pass plan should attach event emission to those seams rather than inventing new architecture first.

## First-pass scope

The first pass should implement:

1. persisted canonical event storage
2. persisted artifact storage for a very small artifact set
3. a small event-emission helper used by server and runtime code
4. a file-backed scenario registry
5. reference-only read surfaces for CLI/tests/control plane
6. one golden-path scenario trace with assertions

The first pass should not implement:

1. full OpenTelemetry export
2. separate materialized projection tables
3. generalized metrics aggregation
4. a public protocol API for event history
5. a full event taxonomy beyond the minimum needed to support the first reference path

## Storage shape

### 1. Persisted canonical events

Add one new append-only table to the SQLite database.

Recommended table:

- `spine_events`

Recommended columns:

- `event_id TEXT PRIMARY KEY`
- `event_type TEXT NOT NULL`
- `occurred_at TEXT NOT NULL`
- `recorded_at TEXT NOT NULL`
- `scenario_id TEXT NOT NULL`
- `trace_id TEXT NOT NULL`
- `span_id TEXT`
- `parent_span_id TEXT`
- `caused_by_event_id TEXT`
- `request_id TEXT`
- `grant_id TEXT`
- `run_id TEXT`
- `provider_id TEXT`
- `client_id TEXT`
- `subject_id TEXT`
- `stream_id TEXT`
- `token_id TEXT`
- `interaction_id TEXT`
- `actor_type TEXT NOT NULL`
- `actor_id TEXT NOT NULL`
- `subject_type TEXT NOT NULL`
- `object_type TEXT NOT NULL`
- `object_id TEXT NOT NULL`
- `status TEXT NOT NULL`
- `data_json TEXT NOT NULL`
- `artifact_refs_json TEXT`
- `redaction_json TEXT`
- `tags_json TEXT`
- `version TEXT NOT NULL`

Recommended indexes:

- `(trace_id, occurred_at)`
- `(scenario_id, occurred_at)`
- `(grant_id, occurred_at)`
- `(run_id, occurred_at)`
- `(event_type, occurred_at)`
- `(provider_id, client_id, occurred_at)`

Minimal rule:

- do not split spans into a separate table on day one
- infer spans from `*.started` and `*.completed`/`*.failed` events plus `trace_id` and `span_id`

### 2. Persisted artifacts

Add one small artifact table.

Recommended table:

- `spine_artifacts`

Recommended columns:

- `artifact_id TEXT PRIMARY KEY`
- `artifact_type TEXT NOT NULL`
- `content_type TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `hash TEXT`
- `summary TEXT`
- `body_json TEXT`
- `redaction_json TEXT`

Recommended indexes:

- `(artifact_type, created_at)`

First-pass artifact types:

- `selection_request`
- `grant_snapshot`
- `state_snapshot`
- `error_detail`

Do not store large record payload mirrors by default in the first pass. The existing record tables are already the source of truth.

### 3. Scenario registry

Do not persist scenarios in SQLite on day one.

Use a file-backed registry in the repo for the first pass. The registry should be checked in, stable, and human-readable.

Why:

- scenario definitions are reference fixtures, not runtime facts
- tests and docs need stable names under version control
- there is no reason to make scenarios mutable database state yet

## What stays persisted vs what stays derived

### Persisted

Persist:

- canonical event rows
- small artifact rows
- existing domain state in current tables:
  - `connectors`
  - `grants`
  - `tokens`
  - `records`
  - `record_changes`
  - `connector_state`
  - `version_counter`

### Derived

Do not persist separate projection tables in the first pass for:

- grant timeline
- run timeline
- recent activity
- provider status
- scenario playback index
- disclosure counters
- stream freshness summaries

These should be derived from:

- `spine_events`
- current domain tables

Reason:

- the first pass should prove that the event model is good enough before introducing projection maintenance logic
- every extra derived table creates consistency risk and migration burden

## Recommended minimal event vocabulary for the first pass

The first pass does not need the full draft vocabulary. It needs enough to support the current substrate and one golden path.

Recommended first-pass event types:

- `scenario.seeded`
- `request.submitted`
- `consent.approved`
- `consent.denied`
- `grant.issued`
- `grant.revoked`
- `token.issued`
- `token.introspected`
- `token.rejected`
- `run.started`
- `run.interaction_required`
- `run.interaction_completed`
- `run.record_emitted`
- `run.state_advanced`
- `run.completed`
- `run.failed`
- `query.received`
- `query.authorized`
- `query.rejected`
- `disclosure.served`

Anything beyond that can wait until the console and illustrated-flow consumers force a need.

## Emission strategy

### General rule

Prefer emitting events at domain seams, not at every low-level helper.

That means:

- emit at lifecycle boundaries
- attach stable IDs and object references once
- keep emitted `data` payloads summary-oriented

Do not:

- emit raw logs as events
- emit both route-layer and helper-layer duplicates for the same fact
- emit events for trivial reads unless they are part of a meaningful protocol/runtime action

### Context model for first pass

The first pass needs a lightweight execution context passed explicitly through the current code.

Recommended context fields:

- `scenario_id`
- `trace_id`
- `span_id`
- `request_id`
- `provider_id`
- `client_id`
- `subject_id`
- `grant_id`
- `run_id`

Do not introduce a complex async context mechanism in the first pass. Pass a small context object through the main route and runtime seams explicitly.

### Server-side emission points

#### `e2e/server/auth.js`

`initiateGrant(params, opts)`

- emit `request.submitted`
- attach:
  - `request_id`
  - `client_id`
  - `provider_id` derived from `connector_id` for now
  - `scenario_id`
  - `trace_id`
- write `selection_request` artifact
- store `trace_id` and `scenario_id` alongside the pending-consent entry so approval/denial can reuse them

`approveGrant(deviceCode, subjectId, opts)`

- emit `consent.approved`
- emit `grant.issued`
- emit `token.issued` for the issued client token
- write `grant_snapshot` artifact

`denyGrant(deviceCode)`

- emit `consent.denied`

`issueToken(...)`

- do not emit separately if the caller already emits `token.issued` for the meaningful lifecycle action
- for the first pass, let `approveGrant`, `issueGrantToken`, and `issueOwnerToken` be the emitting sites

`issueGrantToken(grantId)`

- emit `token.issued`

`issueOwnerToken(subjectId)`

- emit `token.issued`
- object should be the owner token, not a grant

`introspect(token)`

- emit `token.introspected` when active
- emit `token.rejected` when inactive
- keep `data` summary-only:
  - token kind
  - inactive reason
  - grant_id if relevant
- never emit raw token value

`revokeGrant(grantId)`

- emit `grant.revoked`

#### `e2e/server/index.js`

Prefer route-level emission only where the route itself is the lifecycle seam.

`POST /grants/initiate`

- create `request_id`
- resolve or default `scenario_id`
- call `initiateGrant` with emission context

`POST /consent/:deviceCode/approve`
`POST /consent/:deviceCode/approve-api`
`POST /consent/:deviceCode/deny`

- these routes should not emit independently if `approveGrant` / `denyGrant` already emit the facts

`POST /owner-token`

- call `issueOwnerToken` with context and let that helper emit

`POST /grants/:grantId/revoke`

- call `revokeGrant` with context and let that helper emit

`GET /v1/streams/:stream/records`

- emit `query.received` before `queryRecords`
- emit `query.authorized` on success after grant/owner authorization is established
- emit `disclosure.served` after the response body is ready
- on authorization or grant failure, emit `query.rejected`
- `data` should include:
  - stream
  - limit
  - order
  - changes_since present or not
  - records returned
  - next cursor present or not

`GET /v1/streams/:stream/records/:id`

- same pattern as above, but the object is a single record disclosure

`POST /v1/ingest/:stream`

- do not emit per-line ingest events at the route layer in the first pass
- the runtime should be the dominant source for `run.record_emitted`
- keep the route available to attach `request_id` and error details later if needed

`PUT /v1/state/:connectorId`

- do not emit here if `commitState` in the runtime emits `run.state_advanced`
- this avoids double-emission

### Runtime-side emission points

The runtime is where Collection Profile lifecycle should be captured.

`runConnector(opts)`

- emit `run.started` immediately after the run context is created
- create:
  - `run_id`
  - `trace_id`
  - root `span_id`

`INTERACTION` branch

- emit `run.interaction_required` when the message is received
- emit `run.interaction_completed` after the response is sent back
- never store secret response contents in cleartext
- if interaction data is useful, summarize field names only

`flushBatch(stream)`

- emit `run.record_emitted` only after successful POST to `/v1/ingest/:stream`
- this event should represent accepted record delivery into the RS, not mere connector stdout buffering
- `data` should include:
  - stream
  - count
  - batch size
  - maybe first/last record key summaries if safe

`commitState(stream, cursor)`

- emit `run.state_advanced` only after the RS accepts the new state
- write a `state_snapshot` artifact if the cursor is non-trivial

`DONE` branch

- emit `run.completed` on `succeeded`
- emit `run.failed` on `failed`
- treat `cancelled` distinctly if the runtime starts exposing it

### Records helper emission

Do not emit directly from `ingestRecord`, `queryRecords`, or `putSyncState` in the first pass unless route/runtime instrumentation proves insufficient.

Reason:

- those helpers are shared implementation details
- emitting there too early increases duplicate-event risk
- the first-pass goal is reliable lifecycle capture, not exhaustive instrumentation

## Reference-only access surfaces

The first pass needs one way for CLI, tests, and the future console to read the spine without direct database access.

Recommended approach:

- add a reference-only read namespace, clearly non-protocol

Suggested shapes:

- `GET /_ref/events`
- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/artifacts/:artifactId`
- `GET /_ref/scenarios`

Rules:

1. Keep these endpoints clearly outside PDPP core routes.
2. Make them read-only in the first pass.
3. Use them for CLI/tests/console rather than peeking directly into SQLite.

## How tests should assert it

### Test strategy

The current `e2e/test/pdpp.test.js` and `e2e/test/collection-profile.test.js` already prove real behavior. The first-pass spine work should add event assertions to those same tests or closely adjacent tests.

Tests should assert:

1. expected event sequence by trace or dominant object
2. required identifiers are present
3. required artifacts exist where expected
4. forbidden sensitive fields are absent
5. domain truth and event truth agree

Examples:

- if a grant exists in `grants`, the spine should contain `grant.issued`
- if a run completed and state persisted, the spine should contain `run.completed` and `run.state_advanced`
- if a revoked token is used, the spine should contain `grant.revoked` and a later `token.rejected` or `query.rejected`

### Minimal test helpers

Add reference-level test helpers, not database pokes:

- `listEvents(filters)`
- `getTrace(traceId)`
- `getGrantTimeline(grantId)`
- `getRunTimeline(runId)`
- `getArtifact(artifactId)`
- `assertEventSequence(events, expectedTypes)`

### What not to assert

Do not assert:

- exact timestamps
- exact event counts beyond the events the scenario truly requires
- raw token strings
- full record payload mirrors if they already live in the domain tables

## First golden-path trace

The first golden-path trace should prove the basic value of the spine without forcing every part of the future reference world into the first patch.

Recommended first golden path:

- current personal-server path with one collection run, one approved grant, and one successful client query

Why this is the right first path:

- it maps directly onto the existing `e2e` substrate
- it crosses auth, runtime, storage, and RS disclosure
- it does not require the native HR world to exist yet

Recommended sequence:

1. `scenario.seeded`
   - connector registered
   - owner token issued
2. `run.started`
3. one or more `run.record_emitted`
4. `run.state_advanced`
5. `run.completed`
6. `request.submitted`
7. `consent.approved`
8. `grant.issued`
9. `token.issued`
10. `token.introspected`
11. `query.received`
12. `query.authorized`
13. `disclosure.served`

Optional extension for the same scenario:

14. `grant.revoked`
15. `token.rejected` or `query.rejected`

Golden-path rule:

- the first trace should span a single named scenario and be fetchable by `scenario_id`
- it may include multiple spans under one `trace_id` if the harness drives the whole scenario
- if that proves awkward in the first pass, allow the scenario to contain multiple traces, but keep one stable scenario-level playback index

## Recommended implementation order

1. Add `spine_events` and `spine_artifacts` schema to `e2e/server/db.js`
2. Add a small event/artifact append helper module
3. Add file-backed scenario registry
4. Instrument grant/token lifecycle in `auth.js`
5. Instrument query lifecycle in `server/index.js`
6. Instrument run lifecycle in `runtime/index.js`
7. Add reference-only read endpoints
8. Add test helpers and first golden-path assertions

## Deliberate omissions in first pass

These should wait:

- provider/service lifecycle events beyond basics
- per-record event emission directly from `records.js`
- projection tables
- UI-facing pagination tuning
- website integration
- native-provider-specific event shapes

The first-pass bar is simpler:

- one durable event store
- one small artifact store
- real emission at real lifecycle seams
- one good scenario trace
- testable read access

## Recommendation

Keep the first coding pass narrow and disciplined. Persist events and a few artifacts. Emit at current lifecycle seams in `auth.js`, `server/index.js`, and `runtime/index.js`. Keep current domain tables as the source of truth for actual grants, tokens, records, and state. Derive everything else until the event model proves itself.

That is the cleanest path to an event spine that is real enough to anchor the console, CLI, tests, and illustrated flow without bloating the reference implementation.
