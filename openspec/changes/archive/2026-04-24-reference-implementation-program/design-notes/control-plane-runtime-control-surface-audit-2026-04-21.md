# Runtime / Control Surface Audit (2026-04-21)

## Purpose

This note inventories the current runtime and control surface across:

- `reference-implementation/`
- `packages/polyfill-connectors/`
- the current local-first dashboard in `apps/web/src/app/dashboard/`

The goal is to support a later detailed execution plan for a more useful local control plane without guessing about what already exists, what is read-only, and what seams currently block a unified operator experience.

This note is intentionally descriptive. It does not propose new protocol semantics and does not change code.

## Executive summary

Today the reference has a `real data plane` and several `real control primitives`, but they are split across different entry points:

- the AS/RS server exposes grants, owner-device auth, client registration, connector registry, ingest, and state persistence
- the collection runtime exposes `runConnector()` and an experimental scheduler as local JS functions, not as server endpoints
- the polyfill package adds CLI wrappers (`orchestrate`, scheduler runner, interaction handler) around those runtime functions
- the dashboard is local-first and increasingly useful for inspection, but it is still fundamentally `read-only`

The result is a legitimate reference system, but not yet a unified local control plane.

The main architectural seam is:

- `long-lived AS/RS + read-only dashboard`
- `separate embedded or programmatic collection/orchestration paths`

So the current stack can:

- collect data
- schedule collection
- issue owner tokens
- stage and approve/deny client grants
- revoke grants
- inspect traces, grants, runs, and records

But it still cannot do those things from one coherent operator surface/process.

## Current trigger inventory

### 1. Manual collection: embedded orchestrator CLI

Primary entry point:

- `packages/polyfill-connectors/bin/orchestrate.js`

What it does:

- starts an embedded AS/RS server on ephemeral ports
- registers the requested connector manifest
- mints an owner token through the real owner-device flow helper
- loads prior sync state
- calls `runConnector()`
- verifies landed records through the RS
- shuts the embedded server down

Key files:

- [packages/polyfill-connectors/bin/orchestrate.js](/home/user/code/pdpp/packages/polyfill-connectors/bin/orchestrate.js:35)
- [packages/polyfill-connectors/src/orchestrator.js](/home/user/code/pdpp/packages/polyfill-connectors/src/orchestrator.js:135)
- [reference-implementation/runtime/index.js](/home/user/code/pdpp/reference-implementation/runtime/index.js:364)

Implication:

- this is the main human-facing “run a connector now” path today
- but it is `not` a long-lived local control-plane path, because it spins up its own server and tears it down again

### 2. Manual collection: programmatic existing-server path

Primary entry point:

- `packages/polyfill-connectors/src/orchestrator.js`

What exists:

- `runOne()` can register a manifest, issue an owner token against an existing AS/RS, and call `runConnector()` without embedding a new server

Key file:

- [packages/polyfill-connectors/src/orchestrator.js](/home/user/code/pdpp/packages/polyfill-connectors/src/orchestrator.js:163)

Implication:

- the architecture already has a path for “run against a long-lived server”
- but there is `no user-facing CLI or HTTP control surface` that exposes this cleanly

### 3. Scheduled collection: experimental scheduler

Primary entry points:

- `reference-implementation/runtime/scheduler.js`
- `packages/polyfill-connectors/src/scheduler-runner.js`

What exists:

- `createScheduler()` runs connectors on intervals, retries failures, tracks in-memory history, disables deterministic dead grants, and enforces one active run per connector
- `startPolyfillScheduler()` wraps that with:
  - manifest registration
  - owner-token issuance
  - per-connector default intervals + jitter
  - inbox/ntfy-backed interaction handling

Key files:

- [reference-implementation/runtime/scheduler.js](/home/user/code/pdpp/reference-implementation/runtime/scheduler.js:65)
- [packages/polyfill-connectors/src/scheduler-runner.js](/home/user/code/pdpp/packages/polyfill-connectors/src/scheduler-runner.js:33)

Implication:

- scheduled collection `does exist`
- but it remains explicitly experimental, local, and outside the server/dashboard surface
- there is currently no scheduler API, no schedule persistence model, and no control-plane UI for start/stop/pause/edit/retry

### 4. Owner self-export reads

Primary entry points:

- owner token via owner-device flow
- RS `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/records`, `/v1/streams/:stream/records/:id`

Human-facing surfaces:

- CLI `pdpp auth login`
- CLI `pdpp owner streams|query|get|export`
- dashboard Records pages

Key files:

- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:933)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1465)
- [reference-implementation/cli/commands/auth.js](/home/user/code/pdpp/reference-implementation/cli/commands/auth.js:32)
- [reference-implementation/cli/commands/owner.js](/home/user/code/pdpp/reference-implementation/cli/commands/owner.js:7)
- [apps/web/src/app/dashboard/lib/owner-token.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/owner-token.ts:36)
- [apps/web/src/app/dashboard/lib/rs-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/rs-client.ts:60)

Implication:

- owner self-export is the `one fully integrated read path`
- the dashboard is effectively an owner-self-export client that auto-mints and caches an owner token server-side

### 5. Grant / client-connect flow

Primary entry points:

- `POST /oauth/par`
- `GET /consent`
- `POST /consent/approve`
- `POST /consent/deny`
- `POST /grants/:grantId/revoke`
- client token usage on RS `/v1/streams...`

Human-facing surfaces:

- CLI `pdpp grant start`
- browser consent page
- CLI `pdpp query ...` with a client token
- dashboard inspection of grants and traces

Key files:

- [reference-implementation/server/auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1313)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1306)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1332)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1346)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1378)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1406)
- [reference-implementation/cli/commands/grant.js](/home/user/code/pdpp/reference-implementation/cli/commands/grant.js:8)
- [reference-implementation/cli/commands/query.js](/home/user/code/pdpp/reference-implementation/cli/commands/query.js:7)

Implication:

- the protocol-side client grant path is real and usable
- but the control plane currently treats it as an inspection subject, not an operation the operator can initiate/manage from the console

### 6. Owner-device auth / token issuance

Primary entry points:

- `POST /oauth/device_authorization`
- `GET /device`
- `POST /device/approve`
- `POST /device/deny`
- `POST /oauth/token`

Human-facing surfaces:

- CLI `pdpp auth login`
- browser device approval page
- dashboard internal owner-token helper

Key files:

- [reference-implementation/server/auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1642)
- [reference-implementation/server/auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1765)
- [reference-implementation/server/auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1840)
- [reference-implementation/server/auth.js](/home/user/code/pdpp/reference-implementation/server/auth.js:1895)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:998)
- [reference-implementation/cli/commands/auth.js](/home/user/code/pdpp/reference-implementation/cli/commands/auth.js:32)
- [apps/web/src/app/dashboard/lib/owner-token.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/owner-token.ts:36)

Implication:

- owner-token issuance is real and public
- but the dashboard currently uses it as an implementation detail, not as a visible token-management/operator feature

## Writable / control actions that already exist

These are the live control mutations today.

### Authorization server

- dynamic client registration
  - `POST /oauth/register`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:861)
- stage a pending client request
  - `POST /oauth/par`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1306)
- approve / deny client consent
  - `POST /consent/approve`
  - `POST /consent/deny`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1346)
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1378)
- revoke a grant
  - `POST /grants/:grantId/revoke`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1406)
- owner-device approve / deny
  - `POST /device/approve`
  - `POST /device/deny`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1054)
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1081)
- polyfill connector manifest registration
  - `POST /connectors`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1281)

### Resource server / collection support

- ingest records
  - `POST /v1/ingest/:stream`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1927)
- write sync state
  - `PUT /v1/state/:connectorId`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:2009)
- delete all records for a stream
  - `DELETE /v1/streams/:stream/records`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1860)
- delete one record
  - `DELETE /v1/streams/:stream/records/:id`
  - [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1893)

### Runtime / orchestrator control

- run one connector to completion
  - `runConnector()`
  - [reference-implementation/runtime/index.js](/home/user/code/pdpp/reference-implementation/runtime/index.js:364)
- schedule repeated runs
  - `createScheduler()`
  - [reference-implementation/runtime/scheduler.js](/home/user/code/pdpp/reference-implementation/runtime/scheduler.js:65)
- start a bundled scheduler with manifest registration, owner bootstrap, and interaction forwarding
  - `startPolyfillScheduler()`
  - [packages/polyfill-connectors/src/scheduler-runner.js](/home/user/code/pdpp/packages/polyfill-connectors/src/scheduler-runner.js:33)

### CLI wrappers for control actions

- `pdpp auth login`
  - owner-device login / token issuance
  - [reference-implementation/cli/commands/auth.js](/home/user/code/pdpp/reference-implementation/cli/commands/auth.js:32)
- `pdpp grant start`
  - stage PAR-backed consent request
  - [reference-implementation/cli/commands/grant.js](/home/user/code/pdpp/reference-implementation/cli/commands/grant.js:13)
- `pdpp grant revoke`
  - revoke grant
  - [reference-implementation/cli/commands/grant.js](/home/user/code/pdpp/reference-implementation/cli/commands/grant.js:28)
- `pdpp provider register`
  - DCR with initial access token
  - [reference-implementation/cli/commands/provider.js](/home/user/code/pdpp/reference-implementation/cli/commands/provider.js:63)
- `node packages/polyfill-connectors/bin/orchestrate.js run <connector>`
  - manual collection
  - [packages/polyfill-connectors/bin/orchestrate.js](/home/user/code/pdpp/packages/polyfill-connectors/bin/orchestrate.js:35)

## Read-only surfaces today

### Event spine / reference inspection

- `GET /_ref/traces`
- `GET /_ref/grants`
- `GET /_ref/runs`
- `GET /_ref/search`
- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`

Key files:

- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1186)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1201)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1216)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1231)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1246)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1257)
- [reference-implementation/server/index.js](/home/user/code/pdpp/reference-implementation/server/index.js:1268)

### Dashboard

The dashboard is local-first and gated off remote deployment by default:

- [apps/web/src/app/dashboard/lib/dashboard-access.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/dashboard-access.ts:1)
- [apps/web/src/app/dashboard/layout.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/layout.tsx:1)

Its main IA is:

- Overview
- Traces
- Grants
- Runs
- Records
- Search

Key files:

- [apps/web/src/app/dashboard/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/page.tsx:54)
- [apps/web/src/app/dashboard/components/shell.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/shell.tsx:13)
- [apps/web/src/app/dashboard/traces/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/traces/page.tsx:33)
- [apps/web/src/app/dashboard/grants/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/grants/page.tsx:33)
- [apps/web/src/app/dashboard/runs/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/runs/page.tsx:32)
- [apps/web/src/app/dashboard/records/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/page.tsx:8)
- [apps/web/src/app/dashboard/search/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:139)

Important current property:

- the dashboard is still `inspection-first and effectively read-only`
- there are no operator-triggered POST/PUT/DELETE actions in the dashboard itself
- the only write-like behavior in dashboard code is the internal owner-token minting helper, which performs the owner-device flow automatically on the server side so the UI can read owner data

Relevant files:

- [apps/web/src/app/dashboard/lib/owner-token.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/owner-token.ts:36)
- [apps/web/src/app/dashboard/lib/ref-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/ref-client.ts:133)
- [apps/web/src/app/dashboard/lib/rs-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/rs-client.ts:60)

## Missing surfaces

These are the most important gaps if the goal is a unified local control plane.

### 1. No “run connector now” server/control-plane action

What exists:

- `runConnector()` as a local JS function
- orchestrator CLI wrapper

What is missing:

- no HTTP endpoint like `POST /_ref/connectors/:id/run`
- no CLI command that targets an already-running long-lived server cleanly
- no dashboard button or action that starts a run

Consequence:

- manual collection exists, but only through separate orchestration paths

### 2. No scheduler management surface

What exists:

- experimental scheduler functions
- polyfill scheduler wrapper

What is missing:

- no persisted schedule model
- no scheduler start/stop/pause/edit surface
- no schedule status page
- no dashboard affordance for “this connector is scheduled every N hours”

Consequence:

- scheduled collection exists only as a separate runtime wrapper, not as part of the operator console

### 3. No interaction inbox/operator surface

What exists:

- runtime supports `INTERACTION`
- orchestrator CLI handler supports file-drop / terminal / ntfy
- scheduler runner expects an `inboxHandler`

Key files:

- [packages/polyfill-connectors/src/interaction-handler.js](/home/user/code/pdpp/packages/polyfill-connectors/src/interaction-handler.js:1)
- [packages/polyfill-connectors/src/scheduler-runner.js](/home/user/code/pdpp/packages/polyfill-connectors/src/scheduler-runner.js:63)

What is missing:

- no dashboard inbox for pending `INTERACTION`
- no operator action surface to respond to credentials / OTP / manual_action requests
- no shared local interaction service that both dashboard and scheduler/orchestrator use

Consequence:

- collection can require the human, but the control plane cannot currently mediate that interaction

### 4. No token-management/operator surface

What exists:

- owner token can be minted through device flow
- client token is issued on grant approval
- introspection exists

What is missing:

- no visible dashboard surface to mint owner tokens on demand, inspect active tokens, or revoke owner tokens
- no control-plane surface to stage a grant request, approve it, copy token material, or inspect active client-token state beyond traces/timelines

Consequence:

- token issuance exists as protocol behavior, not as operator tooling

### 5. No connector lifecycle management surface

What exists:

- manifest registration API and CLI
- Records browsing by manifest-derived connector list

What is missing:

- no dashboard registration/import/update surface
- no distinction between “manifest known to filesystem” and “manifest registered in server”
- no health/enabled/disabled/configured state model for connectors

Consequence:

- the dashboard can inspect records for connectors, but it is not yet a connector management surface

### 6. No unified control namespace

The current control mutations are spread across:

- AS endpoints
- RS owner-mutation endpoints
- local JS runtime APIs
- polyfill orchestration wrappers
- dashboard-internal server helpers

There is no single coherent control-plane API family.

Consequence:

- another agent trying to “add useful control-plane actions” will otherwise be tempted to improvise inconsistent write surfaces

## Architectural seams blocking a unified local control plane

### 1. Embedded-server vs long-lived-server split

The most important seam is the difference between:

- `orchestrate run` starting its own embedded AS/RS and then shutting it down
- the dashboard talking to a separate long-lived AS/RS via `PDPP_AS_URL` / `PDPP_RS_URL`

Key files:

- [packages/polyfill-connectors/bin/orchestrate.js](/home/user/code/pdpp/packages/polyfill-connectors/bin/orchestrate.js:42)
- [packages/polyfill-connectors/src/orchestrator.js](/home/user/code/pdpp/packages/polyfill-connectors/src/orchestrator.js:135)
- [apps/web/src/app/dashboard/lib/owner-token.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/owner-token.ts:13)

Why it matters:

- “click sync, watch run, inspect results” is not one system today unless the operator manually wires all pieces to the same long-lived server

### 2. Duplicate owner-token bootstrap logic

Owner-token issuance is duplicated in:

- polyfill orchestrator helper
- dashboard helper

Key files:

- [packages/polyfill-connectors/src/orchestrator.js](/home/user/code/pdpp/packages/polyfill-connectors/src/orchestrator.js:98)
- [apps/web/src/app/dashboard/lib/owner-token.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/owner-token.ts:36)

Why it matters:

- the two main operator-facing surfaces each bootstrap owner access independently
- that is a warning sign for later drift if control-plane actions are added piecemeal

### 3. Dashboard discovers connectors from the filesystem, not the server registry

The Records UI derives connector candidates from `packages/polyfill-connectors/manifests/`, then probes the RS.

Key file:

- [apps/web/src/app/dashboard/lib/rs-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/rs-client.ts:51)

Why it matters:

- dashboard connector inventory is not a pure reflection of server-registered state
- this is acceptable for today’s local reference, but it is a real seam for future control-plane management features

### 4. Runtime control is function-based, not server-based

The reference server exposes ingestion/state persistence, but not run orchestration itself.

What exists:

- `runConnector()` in runtime
- state + ingest endpoints in RS

What does not exist:

- run orchestration endpoint
- cancel/pause/retry endpoint
- scheduler endpoint

Why it matters:

- the server can observe and store run effects, but it cannot currently own the orchestration lifecycle

### 5. Interaction handling is separate from the dashboard

Interaction currently lives in CLI/runtime helper code, not in the dashboard/operator surface.

Key files:

- [packages/polyfill-connectors/src/interaction-handler.js](/home/user/code/pdpp/packages/polyfill-connectors/src/interaction-handler.js:1)
- [packages/polyfill-connectors/src/scheduler-runner.js](/home/user/code/pdpp/packages/polyfill-connectors/src/scheduler-runner.js:63)

Why it matters:

- a truly useful control plane needs an interaction inbox or equivalent
- otherwise any write/control feature that triggers real runs will still eject the user into terminal/file-drop flows

### 6. Control-plane product shape is ahead of control-plane capability shape

The dashboard now has:

- a strong investigative IA
- good read drilldown
- records browsing
- deep links and search

But the underlying control surfaces are still not packaged into an operator-first product.

Why it matters:

- the next execution plan should not just “add buttons”
- it needs to decide which control actions become first-class and what runtime/service substrate owns them

## Current capability matrix

| Area | Exists today | Human-facing surface | Notes |
| --- | --- | --- | --- |
| Owner token issuance | Yes | CLI login, browser device approval, dashboard internal helper | Public and real, but dashboard uses it implicitly |
| Client request staging | Yes | CLI `grant start`, raw API | No dashboard surface |
| Client consent approve/deny | Yes | Browser consent page, raw API | No dashboard surface |
| Client token issuance | Yes | Returned by consent approval / token exchange | No operator token-management UI |
| Grant revocation | Yes | CLI, raw API | No dashboard action |
| Manifest registration | Yes | CLI, raw API | No dashboard action |
| Manual collection | Yes | `orchestrate run`, programmatic `runOne()` | Split from long-lived control plane |
| Scheduled collection | Yes (experimental) | scheduler runner / local JS | No server/UI surface |
| Interaction handling | Yes | terminal/file-drop/ntfy/inboxHandler | No dashboard inbox |
| Run inspection | Yes | `_ref`, CLI, dashboard | Strongest integrated operator surface today |
| Record browsing | Yes | owner RS + dashboard | Read-only |
| Record deletion/reset | Yes | raw owner endpoints only | No CLI/dashboard control surface |
| State read/write | Yes | runtime + raw owner endpoints | No dashboard control surface |

## Implications for the later implementation plan

The later execution plan should assume:

1. The next useful control-plane work is `not` greenfield.
   There is enough real substrate already to build on:
   - owner-device auth
   - grant staging/approval/revocation
   - ingest/state endpoints
   - runtime events
   - experimental scheduler
   - strong read/inspection UX

2. The biggest problem is `integration`, not missing raw capability.

3. A unified local control plane will probably need:
   - one authoritative long-lived local server/process topology
   - a shared runtime-control service rather than more duplicated helper logic
   - a first-class interaction inbox/service
   - a principled operator action surface, not ad hoc write buttons scattered through dashboard pages

4. The current dashboard should be treated as:
   - `good inspection substrate`
   - `not yet the control plane`

5. The current server should be treated as:
   - `good protocol + persistence substrate`
   - `not yet the orchestration host`

## Recommended planning constraint

When writing the later execution plan, treat these as separate design questions:

- which actions the operator should be able to take
- which process/service actually performs those actions
- which of those actions deserve public/reference HTTP surfaces versus remaining local-only runtime calls

If those are blurred together, the next agent will likely produce a control plane that is superficially useful but architecturally messy.
