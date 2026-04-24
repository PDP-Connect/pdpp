# Control plane implementation plan

**Status:** v1 delivered (2026-04-19) — phases 0–5 complete, see `tasks.md`.
**Date:** 2026-04-19

## Purpose

Translate the control-plane discovery brief into an implementation-grade plan that can be executed without re-litigating the product shape.

This plan is for the first deferred operator-console phase only. It assumes:

- the current reference-implementation hardening phase is complete
- the control plane remains local-first by default
- the first release is inspection-first, not a broad mutation surface

## Scope of this plan

This plan covers:

- the first release of the operator console in `apps/web`
- the route map and page/component composition
- the read-only backend/helper surfaces it will need
- the migration path from the current local proto-dashboard
- the test and verification strategy

This plan does **not** cover:

- broad write controls
- scenario orchestration
- replay studio
- remote multi-user production deployment
- broader storage abstraction

## Product contract for v1

The first control plane is:

- local-first by default
- inspection-first
- built on public PDPP and explicitly reference-designated `_ref` surfaces
- optimized for operators, connector authors, and technical reviewers

The first control plane is **not**:

- a generic admin console
- a business analytics dashboard
- a second hidden control path
- a public remote product surface by default

## Success criteria

The first release is successful when an operator can:

1. start from a request id, trace id, grant id, or run id
2. reach the explaining timeline in one move
3. pivot to adjacent artifacts without losing context
4. inspect raw JSON or copy an equivalent CLI command
5. browse the local owner data corpus through the same console without switching tools

## Phase plan

## Phase 0: preserve guardrails while opening the deferred phase

### Goal

Start control-plane work without weakening the current architectural guarantees.

### Deliverables

- keep `/dashboard` local-first by default
- preserve current Vercel gating behavior unless explicitly widened later
- keep the console inspection-first
- keep all console reads on public or `_ref` surfaces only

### Implementation notes

- keep [apps/web/src/app/dashboard/lib/dashboard-access.ts](/apps/web/src/app/dashboard/lib/dashboard-access.ts:1) as the local-first gate
- treat any new server helper as read-only and reference-designated, not browser-only glue
- avoid mutation routes in `apps/web` unless they merely proxy already-existing, already-proved CLI/HTTP flows

### Exit criteria

- no new hidden control-only backend route exists
- remote deployments still do not expose `/dashboard` by default

## Phase 1: establish the operator shell and durable IA

### Goal

Replace the current data-browser home page with a real operator shell.

### Deliverables

- stable left-rail navigation
- top-level sections:
  - Overview
  - Traces
  - Grants
  - Runs
  - Records
  - Search
- URL-addressable list/detail pages
- right-side peek/detail pattern on Traces, Grants, and Runs list pages via a `?peek=<id>` search param
  - the peek is a persistent detail region next to the list, not a full page swap
  - the full-page `/dashboard/{section}/[id]` detail routes remain available and are linked from inside the peek as "open full →" so deep links and the peek interaction coexist

### Route plan

- `/dashboard`
- `/dashboard/traces`
- `/dashboard/traces/[traceId]`
- `/dashboard/grants`
- `/dashboard/grants/[grantId]`
- `/dashboard/runs`
- `/dashboard/runs/[runId]`
- `/dashboard/records`
- `/dashboard/records/timeline`
- `/dashboard/records/[connectorId]`
- `/dashboard/records/[connectorId]/[stream]`
- `/dashboard/records/[connectorId]/[stream]/[recordId]`
- `/dashboard/search`

There is intentionally no top-level `/dashboard/timeline` route — the activity timeline is a `Records` sub-view, not a parallel section.

### UI modules to create

- `dashboard-shell`
- `left-rail`
- `global-jump`
- `artifact-status-badge`
- `json-drawer` or `json-pane`
- `artifact-header`
- `pivot-links`
- `empty-state` and `server-unreachable` shared blocks

### Migration notes

- current `/dashboard` becomes `Overview`, not the record browser, and leads with action-needed signals (recent failed traces, recent failed runs, recent grant decisions, recent runs) rather than generic counts
- current connector/stream/record browsing moves under `/dashboard/records`
- the former standalone `/dashboard/timeline` view moves under `/dashboard/records/timeline`
- current search page evolves into global search rather than record-only search

### Exit criteria

- all top-level routes exist with durable URLs
- navigation no longer assumes the dashboard is only a record browser
- the current useful record-browsing workflows still exist under `Records`

## Phase 2: traces and grants as the first-class investigative spine

### Goal

Make request/grant debugging faster than the CLI for browsing, while remaining aligned with it.

### Deliverables

- trace worklist
- trace detail page
- grant worklist
- grant detail page with timeline
- artifact pivoting:
  - trace -> grant
  - grant -> originating trace
  - grant -> related runs where present

### Existing surfaces to consume

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- existing public grant readers already used by the CLI

### Likely helper additions

If needed, add read-only reference-designated listing helpers:

- `GET /_ref/traces`
- `GET /_ref/grants`

Each should support:

- time filters
- status filters
- source/client/provider filters where practical
- pagination

These helpers must be:

- read-only
- usable by CLI as well as web
- documented as reference-only, not core PDPP

### Page requirements

#### Trace detail

- artifact summary header
- timeline/event list
- request/rejection/approval/issuance summary cards or rows
- raw JSON drilldown
- copyable ids
- adjacent pivots to grants and runs

#### Grant detail

- grant contract summary
- source and client summary
- revocation state
- grant timeline
- raw JSON drilldown
- pivots to trace, runs, and data

### Exit criteria

- an operator can debug provider-connect and owner-device flows without leaving the console
- every detail page has copyable ids and raw JSON access
- CLI-equivalent commands are visible or one click away

## Phase 3: runs as a first-class operational surface

### Goal

Expose Collection/runtime behavior in a way that is faster to scan than raw run timelines while preserving the exact substrate.

### Deliverables

- run worklist
- run detail page
- strong treatment of:
  - `run.state_staged`
  - `run.state_advanced`
  - `run.state_commit_failed`
  - `run.failed`
  - `run.progress_reported`
  - `run.stream_skipped`
  - `run.interaction_required`
  - `run.interaction_completed`

### Existing surfaces to consume

- `GET /_ref/runs/:runId/timeline`

### Likely helper additions

If needed, add:

- `GET /_ref/runs`

with filters for:

- connector / source
- status
- failure reason
- time range

### Page requirements

#### Run detail

- run header with source, connector/provider identity, timing, terminal status
- checkpoint summary block
- interactions block
- progress / skip block
- failure reason block
- timeline
- raw JSON drilldown
- pivots to related grant, trace, and resulting data

### Special handling

- never surface `INTERACTION_RESPONSE` secrets in durable UI artifacts
- visually distinguish staged-vs-committed checkpoint outcomes
- visually distinguish connector-declared failures from runtime validation failures

### Exit criteria

- connector authors can use the console as their main run-debug surface
- staged/committed checkpoint behavior is obvious without reading raw event names first

## Phase 4: fold the current local data browser into a real Records section

### Goal

Preserve the useful owner-record browsing workflows while making them subordinate to the operator console rather than the console's identity. The section is named `Records` rather than `Data` so it is not confused with cross-artifact search.

### Deliverables

- move current connector index under `/dashboard/records`
- keep connector -> stream -> record drilldown
- fold the standalone activity timeline under `/dashboard/records/timeline` instead of keeping it as a parallel top-level surface
- improve pivots from Records -> traces/grants/runs when possible
- preserve current local search capability where practical

### Existing code to adapt

- [apps/web/src/app/dashboard/page.tsx](/apps/web/src/app/dashboard/page.tsx:1)
- [apps/web/src/app/dashboard/search/page.tsx](/apps/web/src/app/dashboard/search/page.tsx:1)
- [apps/web/src/app/dashboard/lib/timeline.ts](/apps/web/src/app/dashboard/lib/timeline.ts:1)
- `apps/web/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx`

### Migration rule

Do not throw away the existing local browser value. Move and normalize it. The former `/dashboard/data/...` and `/dashboard/timeline` paths receive redirects to `/dashboard/records/...` and `/dashboard/records/timeline` respectively.

### Exit criteria

- owner record browsing still works end to end
- browsing records no longer defines the whole console IA
- there is no standalone top-level `timeline` route parallel to `Records`

## Phase 5: search and command palette

### Goal

Make the operator console fast enough that ids and artifacts are easier to reach than by memorizing routes.

### Deliverables

- command palette / global jump
- id-aware search for:
  - request id
  - trace id
  - grant id
  - run id
  - connector / provider / stream identifiers
- record-content search where locally practical

### Interaction rules

- command palette opens from keyboard
- exact id hit should deep-link directly
- fuzzy hit should open a filtered worklist
- search should never strand the user on a page with no adjacent pivots

### Exit criteria

- an operator can jump from a copied id to the right detail page in one interaction

## Backend/helper surface plan

## Existing surfaces that should remain the default

- public PDPP read/query surfaces
- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`

## Allowed read-only additions if needed

Only add new helpers when the UI cannot be made practical on the current substrate.

Preferred additions:

- `GET /_ref/traces`
- `GET /_ref/grants`
- `GET /_ref/runs`
- optional lightweight cross-artifact search endpoint

## Rules for any new helper

- read-only
- reference-designated
- same data model usable by CLI
- no hidden browser-only shaping that cannot be tested or reused elsewhere

## Test plan

## 1. Backend/read-surface tests

- list/filter pagination tests for any new `_ref` listing helpers
- correlation and artifact-shape tests
- failure-state tests

## 2. Web route tests

- route-level smoke coverage for every top-level section
- local-first gating coverage for `/dashboard`
- unreachable-server and empty-state coverage

## 3. End-to-end operator journey tests

Add AI-friendly journey tests that prove:

- request id -> trace detail
- trace -> grant pivot
- grant -> run pivot
- run -> data pivot
- search -> direct detail jump

## 4. Non-regression tests

- current local data-browser routes still resolve after moving under `Records`, including redirects from `/dashboard/data/...` and the standalone `/dashboard/timeline`
- raw JSON drilldown remains available
- no interaction secret leaks into rendered durable artifacts

## Rollout order

Implement in this order:

1. Phase 0 guardrails
2. Phase 1 shell + IA
3. Phase 2 traces + grants
4. Phase 3 runs
5. Phase 4 data migration
6. Phase 5 search / command palette

This order follows the primary operator workflow:

- first establish navigation
- then make the investigative spine useful
- then deepen run debugging
- then re-home data browsing
- then optimize movement with search and jump

## Definition of done for the first control-plane release

The first release is done when:

- the console is still local-first by default
- the console is inspection-first
- traces, grants, runs, and data are all browsable through stable routes
- an operator can move across those artifact types without losing context
- raw JSON and CLI-equivalent affordances exist on the main detail pages
- any added helper surfaces remain read-only and reference-designated
- the current proto-dashboard has been absorbed into the broader IA rather than left as a parallel product

## Out of scope until a later phase

- replay authoring or replay studio
- wide mutation/control surfaces
- remote multi-user deployment posture
- broad storage abstraction
- turning the console into a polished end-user product
