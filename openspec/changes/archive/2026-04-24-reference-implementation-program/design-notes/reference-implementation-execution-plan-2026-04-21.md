# Reference-Implementation Execution Plan — 2026-04-21

**Status:** canonical execution plan for the next multi-tranche program pass  
**Audience:** owner-directed implementation agent  
**Date:** 2026-04-21

## Purpose

Turn the current program state into one detailed, low-decision execution plan that another agent can follow mechanically.

This plan spans:

- record-query contract alignment
- a truthful machine-readable reference contract
- strict validation
- generated OpenAPI and related developer surfaces
- the long-haul Fastify migration
- the next control-plane tranche, including operator actions for collection, approvals, token/bootstrap flows, and data access

This plan assumes the recent Core/query revision and the current control-plane audits are authoritative inputs.

Relevant source notes:

- `record-query-contract-review-2026-04-21.md`
- `record-query-contract-research-2026-04-21.md`
- `record-query-contract-audit-2026-04-21.md`
- `record-query-contract-proposed-direction-2026-04-21.md`
- `control-plane-discovery-brief.md`
- `control-plane-implementation-plan.md`
- `control-plane-v1-follow-up.md`
- `control-plane-runtime-control-surface-audit-2026-04-21.md`
- `control-plane-ui-audit-2026-04-21.md`
- `control-plane-backing-surface-audit-2026-04-21.md`
- `control-plane-live-ux-audit-2026-04-21.md`

## How to use this plan

Treat the decisions in this note as frozen unless implementation uncovers a real contradiction with:

- the root PDPP specs
- the current code/tests
- the current OpenSpec design notes

Do not reopen product shape, IA, or protocol semantics casually. If implementation pressure suggests a different direction, stop only for:

- a real spec contradiction
- a real launch-direction fork
- a missing prerequisite that cannot be discovered locally

Otherwise execute this plan in order.

## Fixed decisions

These are no longer open questions for the implementation agent.

### 1. Public vs reference boundaries stay explicit

- Public PDPP / provider-connect surfaces remain under their existing public routes.
- Reference-only operator and inspection surfaces remain under `/_ref/*`.
- The dashboard may use public routes and `/_ref` routes.
- The dashboard must not gain a second hidden architecture with browser-only control routes that have no corresponding server contract.

Thin Next.js server actions or route handlers are acceptable only when they proxy already-existing public or `/_ref` routes without inventing new business logic.

### 2. The top-level control-plane IA stays stable

Keep:

- `Overview`
- `Traces`
- `Grants`
- `Runs`
- `Records`
- `Search`

Do not add new top-level nouns like `Tokens`, `Connectors`, or `Admin` in this tranche.

Instead:

- put operator actions on `Overview`
- make `Runs` own connector-run and schedule operations
- make `Grants` own pending approvals, registration, and grant-control actions
- make `Records` own data access, query-building, and record/stream drilldown
- make `Search` own global jump and quick actions

### 3. Use real public flows where they already exist

Do not invent new hidden control routes for flows the reference already supports publicly.

Use the real public routes for:

- dynamic client registration: `POST /oauth/register`
- provider-connect request staging: `POST /oauth/par`
- consent approval/denial: `POST /consent/approve`, `POST /consent/deny`
- grant revocation: `POST /grants/:grantId/revoke`
- owner device flow: `POST /oauth/device_authorization`, `GET /device`, `POST /device/approve`, `POST /device/deny`, `POST /oauth/token`
- token introspection: `POST /introspect`

The dashboard may add better UI on top of these, but it should still be exercising the real public path.

### 4. Add reference-designated control APIs only where no practical surface exists

The missing operator/control surfaces should be added as `/_ref` APIs, not as silent dashboard-only hacks.

This tranche should add:

- `GET /_ref/connectors`
- `GET /_ref/connectors/:connectorId`
- `GET /_ref/approvals`
- `GET /_ref/schedules`
- `POST /_ref/connectors/:connectorId/run`
- `PUT /_ref/connectors/:connectorId/schedule`
- `POST /_ref/connectors/:connectorId/schedule/pause`
- `POST /_ref/connectors/:connectorId/schedule/resume`
- `DELETE /_ref/connectors/:connectorId/schedule`
- `GET /_ref/records/timeline`

Do not add a generic `/_ref/control` bag or vague RPC endpoints.

### 5. Manual connector runs are async background actions

`POST /_ref/connectors/:connectorId/run` must:

- start work asynchronously
- return `202 Accepted` with the created `run_id` and `trace_id`
- reject if the connector already has an active run

It must not:

- block the HTTP request until completion
- stream run logs over the response
- create a second embedded server

If the connector already has an active run, return `409 run_already_active` with the active `run_id`.

### 6. Schedules are one-per-connector in v1

Do not design a multi-schedule-per-connector system in this tranche.

The schedule model is:

- one optional persisted schedule row per connector
- schedule config belongs to the long-lived reference server
- runtime state is in-memory but visible through server responses

That means:

- one connector can have zero or one active schedule
- `PUT /_ref/connectors/:connectorId/schedule` creates or replaces that one schedule
- pausing/resuming is explicit

This is intentionally narrower than a general cron system.

### 7. No hidden raw owner-token mint endpoint

Do not add a private `POST /_ref/tokens` or equivalent raw mint API.

If the control plane wants to help an operator obtain an owner token, it should do so through the real owner-device flow and make the resulting identifiers and token state inspectable.

Token help should include:

- start device flow
- show approval state
- show resulting token
- introspect token
- copy curl / CLI equivalents

### 8. Records lineage stays honest

Do not claim exact per-record causality unless the event spine actually proves it.

In this tranche:

- connector pages may link to connector-filtered runs
- stream pages may link to connector-filtered runs and show stream freshness
- record pages may show stream-level context, recent runs, and recent disclosures where provable

Do not fabricate “this record came from run X” if the durable artifacts do not prove it.

### 9. The query contract is now capability-declared, not globally uniform

This plan assumes the revised Core direction is correct:

- exact filters stay globally available for authorized top-level scalar fields
- range filters are valid only for fields declared in `query.range_filters`
- expansion is valid only for relationships declared under `relationships` and `query.expand`
- expansion depth is `1`
- expanded data lives under `expanded`
- stable sort is by `(cursor_field, primary_key)`
- `freshness` and blob fetch stay in the contract

Implementation must align to that shape rather than re-litigating it.

For the current execution horizon, treat the per-stream `query` object as the authoritative capability-discovery surface for stream-specific query power. Do **not** add a broader CapabilityStatement-style PDPP capability document during the current reference-contract / OpenAPI / Fastify tranche. If a future server-level capability layer becomes necessary, it must stay small, answer only genuinely cross-stream/global questions, and must not duplicate stream-specific `query` declarations.

### 10. The contract layer is JSON-Schema-first because Fastify is the long-haul target

The earlier discussion around a contract layer remains correct, but with Fastify chosen, the concrete direction is:

- create a shared contract package
- author route/request/response contracts as JSON-Schema-first definitions
- use those same definitions for:
  - runtime validation in the current server
  - OpenAPI generation
  - typed helpers
  - later Fastify registration

The package may be implemented in plain JS ESM or TypeScript. The important constraint is that the source of truth is JSON-Schema-first and directly usable by runtime validation and generation tools.

Prefer JSON-Schema-native definitions rather than making the reference contract Zod-first.

The web app may still use Zod locally for UI form ergonomics if helpful, but the reference contract source of truth should be JSON-Schema-first.

### 11. Generate two machine-readable contracts

Do not collapse public and reference-only surfaces into one undifferentiated artifact.

Generate:

- `reference-public.openapi.json`
  - public JSON APIs only
- `reference-full.openapi.json`
  - public JSON APIs plus `/_ref` and other reference-only operator surfaces

HTML consent/device pages can remain prose-described in this tranche; they do not need to be first-class OpenAPI operations yet.

### 12. Fastify migration happens after contract parity, not before

Do not begin the transport migration until:

- the public query/read surface matches the revised Core contract
- strict request validation is real
- generated OpenAPI is real
- the new `/_ref` control endpoints exist and are tested

Only then migrate the server adapter.

### 13. Mobile is second-pass operational refinement, not first-pass product design

Desktop operator workflows come first.

The dashboard must remain responsive and usable while work proceeds, but the first goal is:

- correct server substrate
- useful desktop operator flows
- truthful data/control APIs

After that, do a focused mobile pass on:

- Overview
- quick actions
- approvals
- run retry / schedule control
- stream query builder

## Target end state

The intended end state after all workstreams in this plan:

```text
                      ┌────────────────────────────┐
                      │     apps/web dashboard     │
                      │ Overview / Grants / Runs   │
                      │ Records / Search / Traces  │
                      └─────────────┬──────────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │ public JSON APIs + /_ref APIs  │
                    │    one truthful server stack   │
                    └───────────────┬────────────────┘
                                    │
                    ┌───────────────┴────────────────┐
                    │  packages/reference-contract   │
                    │ JSON schemas / validators /    │
                    │ OpenAPI / typed helpers        │
                    └───────────────┬────────────────┘
                                    │
                     ┌──────────────┴───────────────┐
                     │ reference runtime/controller │
                     │ run now / schedules / runs   │
                     └──────────────┬───────────────┘
                                    │
                           ┌────────┴────────┐
                           │ sqlite + spine  │
                           │ grants + state  │
                           │ records + auth  │
                           └─────────────────┘
```

## Workstream order

Execute in this order:

1. `W0` Guardrails and scaffolding
2. `W1` Align the live reference implementation to the revised record-query/read contract
3. `W2` Build the contract package, strict validation, and generated OpenAPI
4. `W3` Build the runtime controller and new `/_ref` operator/control APIs
5. `W4` Upgrade the dashboard from inspection console to operator cockpit
6. `W5` Extend CLI, generated docs, and AI-friendly developer surfaces
7. `W6` Migrate the server from Express to Fastify using the new contract layer
8. `W7` Finish the second-pass mobile/operator polish and close remaining truthfulness gaps

Do not reorder these broadly. Some tasks can overlap, but the sequence is deliberate.

## W0. Guardrails and scaffolding

### Goal

Create the minimum scaffolding needed so later work has obvious places to land and obvious tests to extend.

### Required decisions

- Keep the current OpenSpec notes as authoritative.
- Do not touch unrelated `packages/polyfill-connectors/...` work unless a specific control-plane dependency requires it.
- Keep the current dashboard IA stable.

### Implementation tasks

1. Add a new reference test file for the query-contract tranche, for example:
   - `reference-implementation/test/query-contract.test.js`
2. Add a new reference test file for operator/control APIs, for example:
   - `reference-implementation/test/control-actions.test.js`
3. Add a thin service boundary for long-lived operator actions, for example:
   - `reference-implementation/runtime/controller.js`
4. Add a contract package skeleton:
   - `packages/reference-contract/package.json`
   - `packages/reference-contract/tsconfig.json`
   - `packages/reference-contract/src/...`

### Exit criteria

- the new files/packages exist
- no route behavior changes are claimed yet
- current tests still pass

## W1. Align the live reference implementation to the revised record-query/read contract

### Goal

Make the live reference tell the truth relative to the revised Core contract before introducing generated machine-readable artifacts.

### Files likely involved

- `reference-implementation/server/index.js`
- `reference-implementation/server/records.js`
- `reference-implementation/server/db.js`
- stream/manifest metadata construction in the reference and shipped connectors
- `reference-implementation/cli/commands/owner.js`
- `reference-implementation/cli/commands/query.js`
- `reference-implementation/test/pdpp.test.js`
- `reference-implementation/test/cli.test.js`
- `reference-implementation/test/query-contract.test.js`

### W1.1 Stream metadata and capability declaration

#### Decision

`query` is an optional object on `stream_metadata`.

Rules:

- omit `query` entirely if the stream has no declared higher-risk capabilities
- if present, include only the capability families actually supported
- `query.range_filters` is an object keyed by field name
- `query.expand` is an array of relation capability objects
- do not introduce a parallel server-wide capability document in this tranche

`relationships` remain the base link declaration. `query.expand` only names which of those relationships are expandable and with what limits.

#### Implementation tasks

1. Standardize stream metadata builders so they can emit:
   - `relationships`
   - `query.range_filters`
   - `query.expand`
   - `freshness`
2. Backfill the shipped stream metadata/manifests with truthful declarations.
3. Do not declare range-filter support just because a field exists.
4. Do not declare expansion support unless a declared relationship is actually hydrable.

#### Acceptance criteria

- `GET /v1/streams/{stream}` returns truthful `query` metadata where supported
- undeclared capabilities are absent, not implied

### W1.2 Exact filter validation

#### Decision

Exact `filter[{field}]` remains globally available for authorized top-level scalar fields only.

#### Implementation tasks

1. Tighten parsing so unsupported shapes are rejected, not ignored.
2. Reject:
   - unknown fields
   - unauthorized fields
   - non-scalar fields
   - nested paths
3. Keep exact filtering on top-level scalar values only.

#### Acceptance criteria

- exact filter behavior matches Core
- bad filter shapes return helpful `400` / `403` responses

### W1.3 Range filters

#### Decision

Range filters are valid only when all of the following are true:

- the field is declared under `query.range_filters`
- the requested operator is declared for that field
- the field type is orderable and coercible

Supported field kinds in this tranche:

- `integer`
- `number`
- `string` with `format: date`
- `string` with `format: date-time`

Behavior:

- invalid query value -> `400 invalid_request`
- unsupported field/operator -> `400 invalid_request`
- record values that are null, absent, or not coercible -> treated as non-matching

#### Implementation tasks

1. Replace the current equality-only filter logic with explicit operator parsing.
2. Parse bracket query shapes correctly.
3. Coerce query values and record values based on declared field type/format.
4. Reject bare params like `since`, `after`, `before`, `date`, `from`, `to` instead of silently ignoring them.

#### Acceptance criteria

- `filter[field][gte|gt|lte|lt]` works for declared fields
- undeclared range queries fail loudly
- wrong query shapes fail loudly

### W1.4 Stable sort and logical cursors

#### Decision

Cursor pagination must use logical `(cursor_field, primary_key)` order, not row-id shortcuts.

Rules:

- sort by `cursor_field`, then `primary_key`
- null/absent `cursor_field` values sort after present values
- cursors encode logical sort position, not DB row ids
- both `asc` and `desc` must respect that logical ordering model

#### Implementation tasks

1. Replace row-id-based pagination in `records.js`.
2. Encode/decode logical cursor payloads.
3. Ensure `changes_since` remains a separate token space from page cursors.

#### Acceptance criteria

- normal list pagination is no longer row-id-based
- `order=asc` and `order=desc` are both provably correct
- cursor tokens are opaque and logical

### W1.5 Expansion

#### Decision

Expansion is deliberately narrow:

- only declared relationships
- only names declared under `query.expand`
- depth `1`
- expanded payload under `record.expanded`
- `expand_limit[relation]` valid only for expanded `has_many` relations

Response shape for a list item:

```json
{
  "object": "record",
  "id": "conv_123",
  "stream": "conversations",
  "data": { "...": "..." },
  "expanded": {
    "messages": {
      "object": "list",
      "has_more": false,
      "data": [
        { "object": "record", "id": "msg_1", "stream": "messages", "data": { "...": "..." } }
      ]
    }
  }
}
```

#### Implementation tasks

1. Add relation hydration to:
   - record list
   - single record read
2. Validate relation declarations against stream metadata.
3. Enforce grant scope and field projection for expanded children.
4. Enforce `default_limit` and `max_limit`.
5. Reject nested expansion requests and dotted paths.

#### Acceptance criteria

- list and detail reads support depth-1 expansion
- expanded children are bounded and grant-safe
- unsupported expansion fails loudly

### W1.6 Freshness

#### Decision

`freshness` is advisory, not a guarantee.

Rules:

- expose `captured_at`
- expose `last_attempted_at` when known
- expose `status` as `current`, `stale`, or `unknown`
- `unknown` is a first-class honest state

#### Implementation tasks

1. Compute freshness from the best durable information the reference already has:
   - successful collection completion
   - most recent attempted refresh
2. Publish `freshness` on:
   - `/v1/streams`
   - `/v1/streams/{stream}`
   - `/v1/streams/{stream}/records`
3. Do not imply stronger source guarantees than the server has.

#### Acceptance criteria

- the RS returns `freshness` where Core now expects it
- no response implies impossible certainty

### W1.7 Blob fetch

#### Decision

Blob fetch stays public and authorization is still record-discovery-based.

#### Implementation tasks

1. Add `GET /v1/blobs/{blob_id}` and optional `HEAD`.
2. Authorize based on:
   - referenced record exists
   - record remains grant-visible
   - blob-ref field is grant-visible
3. Return either:
   - direct response with correct headers
   - or redirect to a short-lived signed URL

For this tranche, the simplest truthful implementation is acceptable. Do not over-engineer remote blob storage.

#### Acceptance criteria

- blob access is real and grant-guarded
- stale blob ids return the correct not-found error

### W1.8 Helpful validation errors

#### Decision

Unsupported query shapes must fail loudly.

Examples:

- bare `since=...` -> `400 invalid_request`
- `expand[]=messages.author` -> `400 invalid_expand`
- `expand_limit[messages]=...` without `expand[]=messages` -> `400 invalid_expand`
- `filter[unknown]=...` -> `400 invalid_request`

#### Implementation tasks

1. Tighten query parsing.
2. Surface offending param names where practical.
3. Add black-box tests for the common wrong-shape mistakes.

### W1.9 CLI parity for the public read surface

#### Decision

The CLI must stop lagging behind the public query surface.

Add CLI support for:

- `--order`
- exact `--filter field=value`
- range `--filter field[gte]=...` style or equivalent flags
- `--expand relation`
- `--expand-limit relation=n`
- blob fetch

Do not redesign the CLI radically. Extend the existing `owner` and `query` commands.

### W1.10 W1 acceptance commands

At the end of W1, all of the following should pass:

- `node --test --test-force-exit reference-implementation/test/query-contract.test.js`
- `node --test --test-force-exit reference-implementation/test/pdpp.test.js`
- `node --test --test-force-exit reference-implementation/test/cli.test.js`

## W2. Build the contract package, strict validation, and generated OpenAPI

### Goal

Create the single machine-readable source of truth for the reference server.

### Package shape

Create:

- `packages/reference-contract/`

Recommended internal structure:

- `src/common/`
  - ids
  - pagination
  - freshness
  - error shapes
- `src/public/`
  - auth/token routes
  - record-query/read routes
  - connector/state/ingest routes that are part of the reference API
- `src/reference/`
  - `/_ref` read routes
  - `/_ref` control routes
- `src/examples/`
- `src/openapi/`
- `src/builders/`

### Technology choice

Use:

- JSON-Schema-first schema definitions
- plain JSON-Schema literals or a JSON-Schema-native helper library such as `@sinclair/typebox`
- `ajv` for compiled request validation

Do not maintain a hand-written YAML OpenAPI file.

### W2.1 Route manifests

For each API route, define one route manifest containing:

- method
- path
- operation id
- tags
- request params/query/body schemas
- success response schema(s)
- error response schema(s)
- examples
- whether the route belongs in:
  - public contract
  - full reference contract

### W2.2 Express integration

#### Decision

Before Fastify, use the contract package to validate requests in the current server.

#### Implementation tasks

1. Create reusable validators from contract-package route manifests.
2. Wire them into the Express routes before business logic runs.
3. Keep response runtime validation optional for now; enforce response truth primarily through tests until Fastify takes over serialization/schema enforcement.

### W2.3 Generated OpenAPI

Generate:

- `reference-implementation/openapi/reference-public.openapi.json`
- `reference-implementation/openapi/reference-full.openapi.json`

Rules:

- public artifact excludes `/_ref`
- full artifact includes `/_ref`
- both are generated from the same route manifests
- no hand-edited drift

### W2.4 Typed helpers

The contract package should also export small, boring helpers used by:

- CLI query-string building
- dashboard query builder
- tests
- future agent-facing tooling

Minimum helper set:

- `buildRecordsQuery(params)`
- `buildExpandParams(params)`
- `buildOwnerDeviceAuthorizationRequest(...)`
- `buildParRequest(...)`

These should be thin convenience builders, not a giant SDK.

### W2.5 W2 acceptance commands

At the end of W2, all of the following should pass:

- `node --test --test-force-exit reference-implementation/test/query-contract.test.js`
- `node --test --test-force-exit reference-implementation/test/pdpp.test.js`
- `openspec validate reference-implementation-program --type change --strict --json`
- a generation command for OpenAPI, for example `pnpm --filter @pdpp/reference-contract run generate:openapi`

## W3. Build the runtime controller and new `/_ref` operator/control APIs

### Goal

Unify long-lived local operator actions around the existing runtime and public auth/grant/data surfaces.

### Files likely involved

- `reference-implementation/runtime/index.js`
- `reference-implementation/runtime/scheduler.js`
- `reference-implementation/runtime/controller.js`
- `reference-implementation/server/index.js`
- `reference-implementation/server/db.js`
- `reference-implementation/test/control-actions.test.js`
- `reference-implementation/test/scheduler.test.js`
- `reference-implementation/test/control-plane.test.js`

### W3.1 Runtime controller service

Create a server-owned runtime controller that:

- owns the single active-run map
- exposes `runNow(connectorId)`
- owns long-lived schedule state
- can project connector and schedule status for `/_ref` reads

Do not rewrite `runConnector()`. Wrap it.

### W3.2 Persisted schedule model

Add a DB table for one schedule per connector.

Recommended columns:

- `connector_id` primary key
- `interval_seconds`
- `jitter_seconds`
- `enabled`
- `created_at`
- `updated_at`

Runtime state such as:

- `next_due_at`
- `active_run_id`
- `last_started_at`
- `last_finished_at`
- `last_error_code`

may be computed/projected rather than persisted, as long as the API is truthful.

### W3.3 New `/_ref` endpoints

#### `GET /_ref/connectors`

Return connector summaries including:

- connector identity
- display label
- registered manifest summary
- stream names
- last run summary
- schedule summary
- freshness summary

The dashboard must stop reading connector manifests directly from the filesystem once this exists.

#### `GET /_ref/connectors/:connectorId`

Return:

- connector summary
- manifest excerpt
- schedule
- recent runs
- stream summaries

#### `GET /_ref/approvals`

Return a normalized list of pending approval items across:

- provider-connect consent requests
- owner-device requests

Each item should include enough data to:

- render a useful queue
- open the corresponding public approval page
- call the corresponding public approve/deny action

#### `GET /_ref/schedules`

Return a list of all configured schedules and runtime status.

#### `POST /_ref/connectors/:connectorId/run`

Behavior:

- starts an async background run
- returns `202` with `run_id` and `trace_id`
- returns `409 run_already_active` when appropriate

Do not make this endpoint perform hidden embedded-server orchestration.

#### `PUT /_ref/connectors/:connectorId/schedule`

Request body:

```json
{
  "interval_seconds": 1800,
  "jitter_seconds": 60,
  "enabled": true
}
```

Creates or replaces the schedule.

#### `POST /_ref/connectors/:connectorId/schedule/pause`

Marks the schedule disabled without deleting config.

#### `POST /_ref/connectors/:connectorId/schedule/resume`

Re-enables the schedule.

#### `DELETE /_ref/connectors/:connectorId/schedule`

Deletes the schedule config.

#### `GET /_ref/records/timeline`

Provide a server-backed cross-connector recent-record feed for the `Records > Timeline` UI.

Supported filters:

- `connector_id`
- `stream`
- `since`
- `until`
- `limit`

Be explicit about boundedness and ordering in the response metadata.

### W3.4 Public-route wrappers the dashboard should use

The dashboard should exercise these public actions through thin server-side wrappers or actions:

- register client
- start PAR request
- approve/deny consent
- revoke grant
- start device flow
- approve/deny device flow
- introspect token

Those wrappers belong in `apps/web`, but the business logic remains in the reference server.

### W3.5 W3 acceptance criteria

- manual “run now” works against a long-lived server
- schedules persist across server restarts
- pending approvals are listable without scraping HTML pages
- no connector inventory page reads manifests directly from disk anymore

### W3.6 W3 acceptance commands

- `node --test --test-force-exit reference-implementation/test/control-actions.test.js`
- `node --test --test-force-exit reference-implementation/test/scheduler.test.js`
- `node --test --test-force-exit reference-implementation/test/control-plane.test.js`

## W4. Upgrade the dashboard from inspection console to operator cockpit

### Goal

Make the local dashboard materially useful for:

- collecting data
- scheduling collection
- seeing what needs attention
- accessing data through the real query contract
- registering clients and starting grant flows
- obtaining and inspecting tokens through the real public flows

### Files likely involved

- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/traces/page.tsx`
- `apps/web/src/app/dashboard/grants/page.tsx`
- `apps/web/src/app/dashboard/runs/page.tsx`
- `apps/web/src/app/dashboard/records/**`
- `apps/web/src/app/dashboard/search/page.tsx`
- `apps/web/src/app/dashboard/components/*`
- `apps/web/src/app/dashboard/lib/ref-client.ts`
- `apps/web/src/app/dashboard/lib/rs-client.ts`
- `apps/web/src/app/dashboard/lib/owner-token.ts`
- new dashboard action/client helpers

### W4.1 Overview becomes the action hub

Keep the current strengths:

- failures first
- recent decisions
- recent runs

Add:

- pending approvals panel
- schedule health panel
- stale connectors / stale streams panel
- quick action bar

Quick actions in this tranche:

- `Run connector`
- `Create or edit schedule`
- `Issue owner token`
- `Register client`
- `Start grant request`

Each action should:

- exercise a real public or `/_ref` route
- show the important ids
- show raw JSON or copyable curl/CLI equivalents

### W4.2 Runs owns connector operation

Add subviews or segmented controls under `Runs`:

- `Recent`
- `Connectors`
- `Schedules`

#### Connectors view

Use `GET /_ref/connectors`.

Show:

- connector name/id
- latest run status
- latest run time
- schedule state
- freshness
- `Run now` action
- link to connector records

#### Schedules view

Use `GET /_ref/schedules`.

Show:

- interval
- next due
- paused/enabled state
- last run
- pause/resume/edit/delete actions

#### Run detail

Add:

- `Run again` action that calls `POST /_ref/connectors/:connectorId/run`
- link back to connector operational view

Do not add “cancel run” until the runtime actually supports cancellation.

### W4.3 Grants owns approvals and consent-oriented operator work

Add a stronger `Pending` slice backed by `GET /_ref/approvals`.

Support:

- approve / deny provider-connect requests
- approve / deny owner-device requests
- revoke issued grants

Add two operator drawers or pages:

- `Register client`
- `Start grant request`

These should use the real public routes and show:

- request JSON
- resulting ids
- copyable curl/CLI equivalents
- consent URL or `request_uri`

Do not invent a raw “mint client token” shortcut.

### W4.4 Records becomes the data-access workbench

Keep existing connector/stream/record drilldown.

Improve it by:

1. Replacing filesystem connector inventory with `/_ref/connectors`.
2. Replacing bounded client-side timeline logic with `GET /_ref/records/timeline`.
3. Adding a stream query builder.
4. Surfacing freshness and recent-run context.

#### Stream query builder

On a stream page, render controls based on live metadata:

- `view`
- `fields`
- exact filters
- range filters from `query.range_filters`
- `order`
- `expand[]`
- `expand_limit[]`
- `changes_since`

Show:

- live result preview
- copyable curl
- copyable CLI command

This is the main “accessing data” UX for the control plane.

#### Lineage honesty

Add stream-level context:

- recent runs for the connector
- last successful run
- last failed run
- freshness

Do not claim exact record-to-run causality unless it is actually proven.

### W4.5 Search and command palette become action-capable

Keep exact id jump.

Add:

- connector results
- stream results
- pending approvals shortcut
- quick actions

The command palette should support both:

- jump
- action launch

Patterns to emulate:

- Linear-style quick preview / quick look
- Stripe/Vercel-style “copy the id / drill into the detail pane”

### W4.6 Token and bootstrap UX

Do not add a top-level `Tokens` page.

Instead add an operator action flow, reachable from `Overview`, `Grants`, and `Search`, that can:

1. start an owner-device flow
2. show the device code / verification state
3. complete approval via the real public flow
4. display and introspect the resulting token
5. show equivalent CLI / curl

This is enough for this tranche. Token inventory can stay out of scope unless implementation proves it is trivial and already durable.

### W4.7 Mobile follow-up inside W4

Only after the desktop action flows work:

- tighten Overview card density
- make quick actions easy to tap
- reduce scroll pain on approvals and schedules
- ensure the query builder remains usable on narrow screens

Do not try to invent an entirely separate mobile IA.

### W4.8 W4 acceptance criteria

- an operator can run a connector from the dashboard
- an operator can create, pause, resume, and delete a schedule
- an operator can see and act on pending approvals
- an operator can register a client and start a grant request
- an operator can complete an owner-token flow and inspect the resulting token
- an operator can query data through the real record-query surface from the Records UI

### W4.9 W4 acceptance commands

- `cd apps/web && pnpm types:check`
- `cd apps/web && pnpm build`
- `node --test --test-force-exit reference-implementation/test/control-plane.test.js`

Add at least one browser-level smoke test for each of:

- Run connector
- Approve/deny pending request
- Owner token flow
- Stream query builder

Keep browser coverage thin. Prove most behavior at HTTP/helper level.

## W5. Extend CLI, generated docs, and AI-friendly developer surfaces

### Goal

Make the truthful contract easier to consume for humans, CLI users, and agents.

### W5.1 CLI control affordances

Add CLI coverage for the new useful surfaces:

- manual connector run
- schedule list / set / pause / resume / delete
- pending approvals list
- explicit query contract flags
- blob fetch

Do not add giant subcommands if a thin extension of existing groups will do.

Suggested additions:

- `pdpp run now <connector>`
- `pdpp run schedules`
- `pdpp run schedule set <connector> --every 30m`
- `pdpp run schedule pause <connector>`
- `pdpp run schedule resume <connector>`
- `pdpp grant pending`

### W5.2 Generated docs

Generate human-readable reference docs from the contract package for:

- public JSON APIs
- reference-only `/_ref` APIs
- query cookbook examples

The query cookbook must include examples for:

- exact filter
- range filter
- fields
- view
- changes_since
- expansion
- blob fetch
- device flow
- dynamic client registration
- PAR request

### W5.3 AI-friendly surfaces

Generate at least:

- an OpenAPI artifact
- a concise markdown or text route/index summary for agents
- stable examples that match the generated contract

Do not hand-maintain separate prose that can drift from the contract.

### W5.4 W5 acceptance criteria

- the CLI can exercise the new operator actions
- generated docs match the current contract
- agents can discover supported query shapes without reverse-engineering route code

## W6. Migrate the server from Express to Fastify

### Goal

Move the reference server onto a schema-first transport that matches the new contract layer.

### Files likely involved

- `reference-implementation/server/index.js`
- new Fastify app factory files
- `reference-implementation/package.json`
- `packages/reference-contract/*`
- test harness bootstrap code

### Migration strategy

Do not “flip it all at once.”

#### W6.1 Extract adapter-neutral route handlers

Refactor business logic into adapter-neutral handler functions/modules first.

The transport layer should become thin:

- parse with contract validator
- call handler
- return response

#### W6.2 Introduce Fastify app factory in parallel

Create a parallel Fastify app factory that registers the same route manifests from `packages/reference-contract`.

Use the new contract package as the schema source.

#### W6.3 Parity-test both adapters

For at least one tranche, run the same server tests against:

- Express
- Fastify

Possible mechanism:

- env var like `PDPP_SERVER_ADAPTER=express|fastify`

#### W6.4 Route migration order

Migrate in this order:

1. public JSON read/query routes
2. `/_ref` read routes
3. `/_ref` control routes
4. public JSON auth/token routes
5. connector/state/ingest routes
6. HTML consent/device pages last

#### W6.5 Switch default, then delete Express

Only when parity is green:

- make Fastify default
- remove Express dependency
- delete adapter dead code

### W6 acceptance criteria

- the reference contract is registered directly on Fastify routes
- public and full OpenAPI artifacts still generate from the same source
- the existing black-box suites pass against Fastify

## W7. Final truthfulness and operator polish pass

### Goal

Close the last misleading seams before calling this tranche done.

### Required checks

1. Records and Search no longer imply stronger search/timeline coverage than they actually have.
2. Every operator action shows the underlying ids and route context.
3. The dashboard never hides the fact that it is using real public flows versus `/_ref` operator surfaces.
4. Mobile is safe on:
   - Overview
   - Pending approvals
   - Run now
   - Schedule edit
   - Stream query builder
5. The old route names and labels are fully gone after any cleanup.

### Required grep/readback discipline

After any naming or cleanup step:

- grep for old labels, old route segments, and stale API names
- read every touched file
- only then claim completion

## Cross-workstream risks and anti-patterns

### 1. Do not let the dashboard invent control semantics

If the dashboard needs a new control action, add the server surface first.

### 2. Do not widen the protocol by accident

This plan is implementing the revised Core contract and improving the reference, not inventing new PDPP query semantics.

### 3. Do not let OpenAPI become a second drifting spec

It must be generated from the contract package.

### 4. Do not overfit to the current local dataset

The control plane should feel like Stripe/Linear/Vercel/Plaid in usability, but the semantics must stay truthful to PDPP and the reference runtime.

### 5. Do not turn expansion or schedules into generic frameworks

Keep:

- depth-1 expansion
- one schedule per connector
- connector-centric control operations

## Definition of done for this plan

This plan is complete only when:

1. the public read/query surface matches the revised Core contract
2. the reference publishes truthful machine-readable contracts
3. request validation is strict
4. the long-lived server can run connectors and schedules without embedded orchestration hacks
5. the dashboard can:
   - run connectors
   - manage schedules
   - act on pending approvals
   - help an operator obtain and inspect tokens through real public flows
   - access data through the real query contract
6. the CLI and docs reflect the same truth
7. Fastify is the default server adapter

## Final acceptance command set

At the end of the whole plan, expect to run at minimum:

- `timeout 1200s pnpm --dir reference-implementation test`
- `node --test --test-force-exit reference-implementation/test/query-contract.test.js`
- `node --test --test-force-exit reference-implementation/test/control-actions.test.js`
- `node --test --test-force-exit reference-implementation/test/control-plane.test.js`
- `node --test --test-force-exit reference-implementation/test/cli.test.js`
- `node --test --test-force-exit reference-implementation/test/scheduler.test.js`
- `cd apps/web && pnpm types:check`
- `cd apps/web && pnpm build`
- `openspec validate reference-implementation-program --type change --strict --json`

Add a thin browser-level smoke suite for the dashboard action flows, but do not rely on browser tests as the primary oracle.
