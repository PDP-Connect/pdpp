# Control-Plane Backing Surface Audit

Date: 2026-04-21

Scope:
- `_ref` inspection surfaces
- CLI operator affordances
- public record-query/read surfaces
- auth / grant / token flows
- runtime/scheduler seams that a control plane might want to expose
- current tests that prove or fail to prove operator-facing behavior

This is a read-only audit. No implementation decisions are made here. The goal is to separate:
- real primitives the control plane can build on now
- missing APIs/helpers that would force awkward UI workarounds
- places where tests already prove behavior
- places where behavior is currently assumed rather than proved

## 1. Available Primitives the Control Plane Can Build On

### 1.1 Reference inspection (`_ref`) primitives

The AS already exposes a useful read-only inspection spine:

- `GET /_ref/traces`
- `GET /_ref/grants`
- `GET /_ref/runs`
- `GET /_ref/search`
- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1118)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1186)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1231)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1246)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1257)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1268)

Important details:
- list filters are parsed centrally via `parseListFilters()` and include `limit`, `cursor`, `since`, `until`, `status`, `client_id`, `provider_id`, `connector_id`, `grant_id`, and `q`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1119)
- grant summary status is normalized to lifecycle state (`issued`, `revoked`, `denied`, `failed`, `pending`) instead of leaking raw event status
  - [reference-implementation/lib/spine.js](../../../../reference-implementation/lib/spine.js:248)
- `_ref/search` supports exact deep-link matches for `trace_id`, `grant_id`, `run_id`, and `request_id -> trace`
  - [reference-implementation/lib/spine.js](../../../../reference-implementation/lib/spine.js:327)

Important limitation:
- these list/search helpers read the full `spine_events` corpus into memory and summarize in-process; they are reference-appropriate but not a stronger backend search/index layer
  - [reference-implementation/lib/spine.js](../../../../reference-implementation/lib/spine.js:272)

### 1.2 Public auth / grant / token primitives

The AS already exposes the core public flows the control plane can inspect or wrap:

- dynamic client registration
  - `POST /oauth/register`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:861)
- provider-connect request staging
  - `POST /oauth/par`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1306)
- consent UI and approval/denial
  - `GET /consent`
  - `POST /consent/approve`
  - `POST /consent/deny`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1332)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1346)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1378)
- grant revocation
  - `POST /grants/:grantId/revoke`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1406)
- owner self-export device flow
  - `POST /oauth/device_authorization`
  - `POST /oauth/token` (device code only)
  - `GET /device`
  - `POST /device/approve`
  - `POST /device/deny`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:933)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:964)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:998)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1054)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1081)
- token introspection
  - `POST /introspect`
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1108)

The auth subsystem behind those flows is already durable enough for operator use:
- pending provider-connect requests are persisted and revalidated against current client/manifest state at display and approval time
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1401)
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1436)
- owner device auth requests are persisted, correlated, and traced
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1642)
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1765)
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1840)
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1895)
- owner token issuance still has an internal bootstrap helper, but the file explicitly marks the public path as the device flow
  - [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:2086)

### 1.3 Public RS read/query primitives

The RS already exposes the main operator-readable data plane:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1464)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1538)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1640)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1773)

Useful properties of the current implementation:
- both owner and client tokens are supported on the same read routes
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1486)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1494)
- read requests emit `query.received`, `query.rejected`, and `disclosure.served` artifacts on the spine
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:250)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:281)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1505)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1577)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1692)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1821)
- auth-gate failures from introspection/inactive grants are also emitted as query artifacts when possible
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:449)
- field projection and exact-match filter validation are present
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:139)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:307)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:317)
- `changes_since` is implemented, including cursor validation, tombstones, and `next_changes_since`
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:334)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:350)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:467)

### 1.4 Owner mutation / ingest / state primitives

In polyfill mode only, the RS also exposes real owner/operator mutation surfaces:

- `POST /connectors`
- `GET /connectors/:connectorId`
- `DELETE /v1/streams/:stream/records`
- `DELETE /v1/streams/:stream/records/:id`
- `POST /v1/ingest/:stream`
- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1281)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1293)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1859)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1892)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1927)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1977)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:2009)

These are better than ad hoc helper hooks because they already emit trace/state/mutation artifacts:
- mutation events
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:415)
- state events
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:291)

Important limitation:
- all of these are guarded by `if (!nativeMode)`, so there is no matching native-provider operator surface for ingest/state/mutation today
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1279)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1858)

### 1.5 Runtime/orchestrator primitives

The local runtime already has strong non-HTTP primitives:

- `runConnector(opts)`
  - [reference-implementation/runtime/index.js](../../../../reference-implementation/runtime/index.js:364)
- `createScheduler(opts)` with `start()`, `stop()`, `getHistory()`, `getStats()`
  - [reference-implementation/runtime/scheduler.js](../../../../reference-implementation/runtime/scheduler.js:65)

Important limitation:
- scheduler is explicitly experimental and in-memory; there is no HTTP wrapper or persisted schedule registry
  - [reference-implementation/runtime/scheduler.js](../../../../reference-implementation/runtime/scheduler.js:1)

The current `orchestrate` CLI is not a long-lived control-plane primitive. It boots an embedded server, registers a connector, mints an owner token with the internal helper, runs one connector, prints verification, and shuts down.
- [packages/polyfill-connectors/bin/orchestrate.js](../../../../packages/polyfill-connectors/bin/orchestrate.js:35)

## 2. Current CLI Affordances

The reference CLI already covers a useful inspection/read envelope:

- `auth login`
- `auth introspect`
- `provider show`
- `provider register`
- `grant start`
- `grant revoke`
- `grant timeline`
- `trace show`
- `run timeline`
- `owner streams`
- `owner query` / `owner records`
- `owner get`
- `owner export`
- `query streams`
- `query records`
- `query get`

Files:
- [reference-implementation/cli/index.js](../../../../reference-implementation/cli/index.js:13)
- [reference-implementation/cli/commands/auth.js](../../../../reference-implementation/cli/commands/auth.js:8)
- [reference-implementation/cli/commands/provider.js](../../../../reference-implementation/cli/commands/provider.js:8)
- [reference-implementation/cli/commands/grant.js](../../../../reference-implementation/cli/commands/grant.js:8)
- [reference-implementation/cli/commands/trace.js](../../../../reference-implementation/cli/commands/trace.js:15)
- [reference-implementation/cli/commands/run.js](../../../../reference-implementation/cli/commands/run.js:7)
- [reference-implementation/cli/commands/owner.js](../../../../reference-implementation/cli/commands/owner.js:7)
- [reference-implementation/cli/commands/query.js](../../../../reference-implementation/cli/commands/query.js:7)

Important operator-positive aspects:
- CLI commands preserve `Request ID` and `Reference trace ID` metadata in output/error paths
  - [reference-implementation/cli/index.js](../../../../reference-implementation/cli/index.js:66)
- `auth login` uses the real owner device flow, not a fake direct token mint endpoint
  - [reference-implementation/cli/commands/auth.js](../../../../reference-implementation/cli/commands/auth.js:32)
- `grant start` uses real `/oauth/par`
  - [reference-implementation/cli/commands/grant.js](../../../../reference-implementation/cli/commands/grant.js:13)

Important helper limitations:
- `owner` and `query` commands expose only `limit`, `cursor`, `changes-since`, `view`, and `fields`
  - [reference-implementation/cli/commands/owner.js](../../../../reference-implementation/cli/commands/owner.js:28)
  - [reference-implementation/cli/commands/query.js](../../../../reference-implementation/cli/commands/query.js:25)
- there is no CLI support for:
  - `order`
  - exact `filter[...]`
  - range filters
  - `expand[]`
  - `expand_limit[...]`
  - stream metadata reads for client tokens
  - blob fetch
  - manual connector run
  - schedule start/stop/status
  - pending approval queue inspection
  - token inventory/mint/revoke beyond `auth login` and introspection

## 3. Backing Surfaces the Dashboard Uses Today

The current dashboard uses two thin server-side clients:

- `_ref` client for traces/grants/runs/search
  - [apps/web/src/app/dashboard/lib/ref-client.ts](../../../../apps/web/src/app/dashboard/lib/ref-client.ts:1)
- RS client for records/metadata
  - [apps/web/src/app/dashboard/lib/rs-client.ts](../../../../apps/web/src/app/dashboard/lib/rs-client.ts:1)

Important implementation fact:
- the dashboard does not have a server endpoint for listing connectors; it reads the shipped polyfill manifest directory from disk via `listConnectorManifests()`
  - [apps/web/src/app/dashboard/lib/rs-client.ts](../../../../apps/web/src/app/dashboard/lib/rs-client.ts:136)
- that means connector inventory is currently a local-filesystem convenience, not a real operator API

## 4. Missing APIs / Helpers

These are the main missing pieces if the control plane is meant to become materially more useful.

### 4.1 No active collection-control API

There is no HTTP/operator surface for:
- run connector now
- retry a failed run
- cancel a run
- inspect currently active runs
- see scheduler configuration
- start/stop scheduling
- edit intervals / enable / disable schedules

Evidence:
- runtime has `runConnector()` and `createScheduler()`, but no server route wraps them
  - [reference-implementation/runtime/index.js](../../../../reference-implementation/runtime/index.js:364)
  - [reference-implementation/runtime/scheduler.js](../../../../reference-implementation/runtime/scheduler.js:65)
- no matching routes exist in the AS or RS route tables
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1281)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1464)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1927)

Consequence:
- any “Sync now” or “Manage schedule” control-plane action would currently need to call runtime internals directly or spawn the separate embedded orchestrator path

### 4.2 No operator API for connector inventory

Current state:
- polyfill mode has `POST /connectors` and `GET /connectors/:connectorId`
- there is no `GET /connectors`

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1281)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1293)

Consequence:
- the dashboard cannot truthfully ask the server “what connectors exist?” and instead reads local manifest files

### 4.3 No operator queue/listing for pending approvals

Current state:
- provider-connect and owner-device approvals are driven by `request_uri` and `user_code`
- there is no JSON/operator list surface for:
  - pending consent requests
  - pending owner-device approvals
  - recently completed/expired/denied pending requests

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:998)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1332)
- [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1401)
- [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:1731)

Consequence:
- a control plane cannot render an approvals inbox without either:
  - new list endpoints, or
  - direct database access, which would be the wrong substrate

### 4.4 No token inventory / token-management surface

Current state:
- token introspection exists
- token issuance happens through owner-device approval or grant approval
- there is no operator-facing surface for:
  - list tokens
  - show token detail
  - revoke owner tokens
  - mint an owner token directly for operator use
  - mint a client token for an already-issued grant

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:964)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1108)
- [reference-implementation/server/auth.js](../../../../reference-implementation/server/auth.js:2086)

Consequence:
- “minting tokens” in a future control plane currently has no truthful public substrate besides walking the actual approval/device flows

### 4.5 Record-query contract gaps still block a fuller operator/data plane

The revised Core shape is ahead of the reference implementation in several places:

- range filters are not implemented
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:193)
- expansion is not implemented
  - no `expand[]` handling on the read routes
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1640)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:290)
- stable sort by `(cursor_field, primary_key)` is not implemented; normal pagination still uses internal row ids
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:477)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:500)
- `freshness` is not returned on stream list, stream metadata, or record-list responses
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1528)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1594)
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1763)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:688)
  - [reference-implementation/server/records.js](../../../../reference-implementation/server/records.js:755)
- blob fetch route is absent
  - no `/v1/blobs/:blobId` route exists
  - only `blob_not_found` is present in the server error map
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:78)
  - [reference-implementation/server/db.js](../../../../reference-implementation/server/db.js:178)

Consequence:
- a control plane can inspect records now, but cannot yet rely on the full intended query/read contract for richer data exploration

### 4.6 Native vs polyfill asymmetry is still significant

Polyfill-only:
- connector registry
- ingest
- owner state read/write
- delete-record / delete-all-records

Native-mode:
- read/query/auth/grant flows work
- but the operator control plane has no equivalent writable owner/runtime surface

Files:
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1279)
- [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1858)

Consequence:
- any unified operator console has to either:
  - clearly separate polyfill-only controls, or
  - grow native-provider-safe control abstractions

## 5. What the Current Tests Already Prove

### 5.1 `_ref` control-plane tests

Focused control-plane coverage exists for:
- trace listing
- trace pagination/limit/cursor
- run listing
- run filtering by `connector_id`
- run filtering by `status`
- exact deep-link search for trace ids
- exact deep-link search for run ids
- empty search behavior
- grant lifecycle status derivation
- run list -> run timeline pivot correlation

File:
- [reference-implementation/test/control-plane.test.js](../../../../reference-implementation/test/control-plane.test.js:104)

### 5.2 CLI/operator tests

The CLI suite gives broad operator-facing proof for:
- real owner device login
- honest denied/malformed owner-device failures
- introspection across active/inactive grant states
- provider metadata discovery
- protected dynamic client registration
- grant start / revoke / timeline
- trace show / run timeline
- owner and client read commands
- many inspectability guarantees on rejected queries, mutations, state operations, and run failures

Files:
- [reference-implementation/test/cli.test.js](../../../../reference-implementation/test/cli.test.js:519)
- [reference-implementation/test/cli.test.js](../../../../reference-implementation/test/cli.test.js:2558)
- [reference-implementation/test/cli.test.js](../../../../reference-implementation/test/cli.test.js:3346)
- [reference-implementation/test/cli.test.js](../../../../reference-implementation/test/cli.test.js:5784)

### 5.3 Event-spine tests

The deepest artifact-level proof lives here. These tests prove durable trace/grant/run artifacts for:
- owner-device flow
- provider-connect approvals/denials/rejections
- public RS query success and rejection paths
- owner mutation/state surfaces
- run progress/interaction/checkpoint/protocol-violation paths

File:
- [reference-implementation/test/event-spine.test.js](../../../../reference-implementation/test/event-spine.test.js:403)

### 5.4 Public AS/RS contract tests

The PDPP suite proves much of the real public contract:
- provider-connect request/consent/grant behavior
- public RS reads under grants and owner self-export
- query rejection semantics
- `changes_since` behavior
- auth-gate failure correlation

File:
- [reference-implementation/test/pdpp.test.js](../../../../reference-implementation/test/pdpp.test.js:265)

### 5.5 Scheduler tests

Scheduler tests prove runtime-only orchestration invariants:
- retry / non-retry behavior
- deterministic grant-failure handling
- single-use consumption rules
- active-run locking
- idempotent start/stop semantics

File:
- [reference-implementation/test/scheduler.test.js](../../../../reference-implementation/test/scheduler.test.js:92)

Important limitation:
- this is runtime coverage only, not control-plane HTTP/API coverage

## 6. Test Coverage Gaps

### 6.1 `_ref` list/filter coverage is still partial

Current focused control-plane tests do **not** explicitly prove:
- `/_ref/grants` pagination/cursor behavior
- exact grant-id hits through `/_ref/search`
- `since` / `until` filters
- `client_id` / `provider_id` / `grant_id` list filters
- trace-list filtering by status/client/provider

Evidence:
- [reference-implementation/test/control-plane.test.js](../../../../reference-implementation/test/control-plane.test.js:104) covers only a subset of supported filters and only one exact-id class per list family
- supported list filters live in:
  - [reference-implementation/server/index.js](../../../../reference-implementation/server/index.js:1119)
  - [reference-implementation/lib/spine.js](../../../../reference-implementation/lib/spine.js:238)

### 6.2 No operator-surface tests exist for active control features because the features do not exist

There is no test coverage for:
- run-now
- retry/cancel run
- schedule CRUD
- pending approval queue
- token inventory/mint/revoke flows
- connector inventory listing

This is a real surface gap, not just a test omission.

### 6.3 Query/read contract coverage is incomplete relative to revised Core

There is strong coverage for:
- `fields`
- `view`
- exact unauthorized filter rejection
- `changes_since`

But there is no corresponding proof for:
- range filter success/rejection semantics
- `order` semantics beyond implementation presence
- expansion
- `expand_limit`
- stable logical sort/cursor contract
- `freshness`
- blob fetch

Evidence:
- exact unauthorized filter rejection is covered
  - [reference-implementation/test/pdpp.test.js](../../../../reference-implementation/test/pdpp.test.js:5981)
  - [reference-implementation/test/cli.test.js](../../../../reference-implementation/test/cli.test.js:3015)
- `changes_since` flows are covered
  - [reference-implementation/test/pdpp.test.js](../../../../reference-implementation/test/pdpp.test.js:6165)
  - [reference-implementation/test/pdpp.test.js](../../../../reference-implementation/test/pdpp.test.js:6511)
- no corresponding test references exist for range filters, expansion, freshness, or blob routes in the current reference tests

### 6.4 No browser-level/dashboard render tests prove operator UX composition

The dashboard consumes the backing surfaces through `ref-client.ts` and `rs-client.ts`, but the proving layer is still mostly:
- server tests
- CLI tests
- build/type checks

There is not yet a browser/render test layer that proves:
- list -> peek -> detail operator journeys
- degraded/unreachable-state handling across the real UI
- mobile-specific operator flows

Relevant clients:
- [apps/web/src/app/dashboard/lib/ref-client.ts](../../../../apps/web/src/app/dashboard/lib/ref-client.ts:1)
- [apps/web/src/app/dashboard/lib/rs-client.ts](../../../../apps/web/src/app/dashboard/lib/rs-client.ts:1)

## 7. Practical Implications for the Next Control-Plane Tranches

If the control plane is going to become materially more useful, the substrate work likely needs to proceed in this order:

1. Keep using `_ref` + public RS reads for inspection; they are already real and well-proved.
2. Add truthful operator APIs for:
   - connector inventory
   - pending approval queues
   - run-now / retry / cancel
   - schedule read/write/status
   - token inventory / mint/revoke where appropriate
3. Close the remaining public record-query contract gaps (`range`, `expand`, `freshness`, `blob`, stable sort) before building richer data-exploration UI around them.
4. Add targeted tests for:
   - the missing `_ref` list/search filters
   - any new active-control surface
   - browser-level operator workflows once the surface area is worth freezing

## 8. Bottom Line

The current backing substrate is already strong for:
- inspection
- correlation
- read-path debugging
- grant/auth traceability
- runtime forensic analysis

It is **not yet** strong for:
- active operations
- scheduling/orchestration control
- approvals inboxes
- token management
- truthful connector inventory
- the full intended query/read contract

So the next control-plane leap is not “invent a UI.” It is “add a small set of honest operator APIs/helpers so the UI stops leaning on filesystem assumptions, embedded orchestration, and missing runtime controls.”
