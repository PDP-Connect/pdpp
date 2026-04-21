# Control plane discovery brief

**Status:** deferred-phase shaping draft  
**Date:** 2026-04-19

## Why this exists

The current reference now has a durable substrate for an operator surface:

- public and reference-only HTTP surfaces
- `_ref` traces, grant timelines, and run timelines
- a real CLI that already proves those surfaces end to end
- a local-only proto-dashboard that can browse owner data

The next phase should not begin by drawing cards and charts. It should begin by being explicit about **who this console is for**, **what jobs it must do**, and **which prior-art patterns are actually worth carrying forward**.

This brief is intentionally product/UX planning for the deferred control-plane phase. It does **not** widen the current implementation phase and does **not** commit the project to a dashboard build yet.

## Feature summary

The first PDPP control plane should be a **local-first operator console** for understanding and demonstrating the reference implementation's real behavior. Its job is to let an implementer or operator move quickly from a failing request, grant, or run to the exact artifacts, timelines, and data surfaces that explain what happened.

It is **not** an end-user product surface, not a marketing analytics dashboard, and not a hidden control backdoor that bypasses the public or reference-designated surfaces.

## Primary user archetypes

### 1. Reference operator / implementer

This is the primary user.

They are:

- running the reference locally or in a protected environment
- debugging provider-connect, owner-device, disclosure, or collection behavior
- trying to answer "what failed, where, and why?" quickly

Their state of mind is usually:

- focused
- skeptical
- under time pressure
- comfortable with technical detail

### 2. Connector author

They are:

- building or validating a connector against the reference runtime
- verifying `START.scope`, `INTERACTION`, `STATE`, and `DONE` behavior
- checking what records landed and how a run failed

They need:

- fast access to run timelines and record-level results
- confidence that what they see is the real engine contract, not a second interpretation layer

### 3. Presenter / reviewer

This is the secondary user.

They are:

- walking a founder, standards reviewer, or internal stakeholder through the system
- trying to show a protocol story with evidence, not just prose

They need:

- stable URLs
- crisp read-only narratives
- safe drilldown without operator clutter taking over the whole interface

## Primary user jobs

The first control plane should optimize for these jobs, in order:

1. **Debug a request or run failure quickly**
   Start from a `Request-Id`, `PDPP-Reference-Trace-Id`, grant id, or run id and get to the relevant timeline and payload details immediately.

2. **Inspect lineage across artifacts**
   Move from request -> consent -> grant -> token -> run -> disclosed record without losing correlation.

3. **Verify collected data and scope effects**
   Confirm what records actually landed, which fields were visible, and whether a scope or grant choice changed the result.

4. **Explain the system to another technical person**
   Use the same console to narrate a real flow without switching to internal-only tools or raw database inspection.

5. **Browse local owner data intentionally**
   Keep the current local record-browsing value, but subordinate it to the operator story rather than letting it define the whole console.

## Anti-goals

The first control plane should **not** be:

- a KPI or business analytics dashboard
- a chart-heavy home page with weak drilldown
- a second control surface that invents non-CLI, non-HTTP mutation paths
- a remotely deployed public console by default
- a blended docs/marketing/admin hybrid
- a generic CRUD admin over every database table

## Primary user action

The single most important thing a user should be able to do is:

**Start from any live protocol artifact and reach the explaining timeline in one move, then pivot across adjacent artifacts without losing context.**

If that is slow, the control plane is wrong even if the visuals are good.

## Design direction

This should feel like:

- **Linear's speed**
- **Stripe's inspectability**
- **Vercel's request-grouped observability**
- **Plaid's operational clarity around connected systems**

Within the repo's design context, the control plane should express:

- technically precise
- visually restrained
- dense but calm
- evidence-first

The memorable thing should not be decorative styling. It should be the feeling that:

**every important PDPP artifact is connected, inspectable, and navigable without guesswork.**

## Prior-art lessons worth carrying forward

### Stripe

Stripe's developer tooling centers on requests, failures, events, and payload drilldown rather than on decorative dashboard metrics. Their docs emphasize request logs, failed requests, event payloads, and the relationship between dashboard and CLI workflows.  
Sources: [Stripe Developers Dashboard / Workbench](https://docs.stripe.com/development/dashboard), [Stripe Dashboard search](https://docs.stripe.com/dashboard/search)

Pattern to steal:

- start from the concrete failing artifact
- make the reason for failure easy to find
- make logs, events, and payloads first-class
- keep CLI and dashboard mutually reinforcing

Pattern to avoid:

- importing Stripe's payments/business KPI framing into an operator console

### Linear

Linear's documentation shows a stable sidebar, default views, strong keyboard navigation, and peek/detail workflows that reduce navigation cost.  
Sources: [Linear Team pages](https://linear.app/docs/default-team-pages), [Linear Search](https://linear.app/docs/search), [Linear Peek](https://linear.app/docs/peek)

Pattern to steal:

- a stable information architecture with a small number of durable top-level views
- keyboard-first navigation and command palette routing
- list + detail / peek workflows instead of constant full-page churn

Pattern to avoid:

- letting custom views explode into an information architecture nobody can remember

### Vercel

Vercel's observability docs emphasize logs grouped per request, real-time viewing, strong filtering, request ids, and direct movement from deployment to logs.  
Sources: [Vercel Runtime Logs](https://vercel.com/docs/logs/runtime), [Vercel Observability](https://vercel.com/docs/observability), [Vercel Audit Logs](https://vercel.com/docs/audit-log)

Pattern to steal:

- group runtime evidence by request/run rather than by flat log lines
- filters that narrow quickly by route, deployment, time, level, and request id
- clear separation between operational logs and audit logs

Pattern to avoid:

- requiring a separate third-party tool or raw backend access before the built-in console becomes useful

### Plaid

Plaid's dashboard docs are useful because they show how an integrations company treats operational activity, detail pages, product-specific views, and the line between dashboard-supported actions and API-only actions.  
Sources: [Plaid Transfer Dashboard](https://plaid.com/docs/transfer/dashboard/), [Plaid Dashboard logs and troubleshooting](https://plaid.com/docs/account/activity/)

Pattern to steal:

- overview + activity table + detail-page rhythm
- product-specific sub-areas when the workflow is materially different
- explicit statement that some actions are dashboard-supported and others are API-only

Pattern to avoid:

- mixing every product surface into one giant undifferentiated activity feed

## Recommended information architecture

The first control plane should be organized around operator jobs, not data model purity.

### Top-level sections

1. **Overview**
   Local system state, recent failures, recent approvals/denials, recent runs, and obvious action-needed items.

2. **Traces**
   Request-centric debugging surface for provider-connect, owner-device, owner reads/mutations, and client reads.

3. **Grants**
   Grant lineage, access contract, revocation state, and grant-scoped state/timeline.

4. **Runs**
   Collection/runtime debugging with checkpoints, interactions, progress, skips, and failures.

5. **Records**
   Owner-visible local record browser across connectors/streams/records, preserving the useful parts of the current local dashboard. Includes the activity timeline as `/dashboard/records/timeline`. The section is named `Records` rather than `Data` so it is not conflated with the cross-artifact `Search` surface.

6. **Search / Command**
   Global jump surface for ids, connectors, streams, and known artifact types. The only cross-artifact search/jump surface.

### Information architecture principles

- no top-level "analytics" section in v1
- no giant "everything" event feed as the home page
- traces, grants, and runs are first-class because the reference already exposes them as stable substrate
- data browsing is important, but it is downstream of the operator/debug story

## Layout strategy

The first control plane should use a **three-zone operator layout**:

1. **Left rail**
   Durable navigation and saved pivots

2. **Center worklist**
   Search results, filtered lists, timelines, and tables

3. **Right context pane or peek**
   Selected artifact details, payload summary, or raw JSON preview

This follows the repo's "dense but restrained" design context and matches the prior-art lesson that list-and-detail beats modal churn.

Visual hierarchy should favor:

- IDs and statuses first
- timestamps and correlation second
- raw payload access always available but not always expanded

Charts should be rare. They should only appear when they answer an operator question better than a table or timeline.

## Key states

### 1. Local server unreachable

The user needs:

- immediate truth
- the target RS/AS URL
- the exact command or environment hint needed to recover

This state already exists in the local dashboard and should remain a first-class control-plane state.

### 2. Fresh / empty instance

The user needs:

- reassurance that the console is working
- a clear statement that no grants/runs/data exist yet
- next steps: start a grant, run a connector, or seed local data

### 3. Active healthy instance

The user needs:

- recent activity
- fast drilldown
- stable navigation between traces, grants, runs, and records

### 4. Failure-heavy instance

The user needs:

- failures ranked before successes
- quick filters for recent failures and deterministic contract violations
- clear correlation across artifact types

### 5. Drift / invalid-state case

The user needs:

- explicit invalid-state labeling (`grant_invalid`, `connector_invalid`, etc.)
- the relevant persisted id and source descriptor
- no false healing or silent masking

### 6. Long-running or interaction-pending run

The user needs:

- live-ish run state
- visible checkpoint status
- clear pending interaction state
- proof that secrets are not being surfaced in durable artifacts

## Interaction model

### Global movement

- command palette first
- keyboard shortcuts for traces, grants, runs, and search
- every list row should be URL-addressable and shareable

### Primary workflow

1. enter an id, query, or choose a default view
2. narrow with filters
3. open a row in peek/detail
4. pivot to the adjacent artifact
5. optionally open raw JSON or CLI-equivalent command

### Detail behavior

- default to structured summaries first
- keep raw JSON one click away
- keep correlation ids, status, source identity, and timestamps pinned near the top

### Mutations in the first phase

The recommended first operator surface is **inspection first**, not full control.

That means:

- reading, filtering, and pivoting are core
- copy-id, copy-JSON, and open-CLI-equivalent are core
- broad mutation surfaces are deferred

If the first control plane includes actions at all, they should be tightly scoped to already-existing, already-proved reference actions and should call the same public/reference-designated surfaces the CLI uses.

## Content requirements

The console will need consistent labels for:

- trace ids
- request ids
- grant ids
- run ids
- source descriptors
- terminal reasons
- invalid-state reasons
- checkpoint state
- interaction state

The tone should stay:

- short
- literal
- operator-grade

Avoid:

- marketing copy
- conversational empty states
- "helpful" prose that hides the machine-readable reason

## Recommended implementation references

For eventual build work, the most relevant impeccable references are:

- `reference/spatial-design.md`
  For the three-zone list/detail layout and density/rhythm decisions.

- `reference/interaction-design.md`
  For command palette, peek/detail flows, filter behavior, and multi-step operator journeys.

- `reference/typography.md`
  For building a dense but readable tool surface without defaulting to generic dashboard typography.

- `reference/color-and-contrast.md`
  For keeping a restrained operator palette while preserving strong failure/status hierarchy.

- `reference/motion-design.md`
  For subtle transitions between list/detail, peek, and live-ish timeline updates without noisy animation.

- `reference/ux-writing.md`
  For concise operator copy, error states, and machine-truthful microcopy.

## Explicit recommendations

1. The first control plane should remain **local-first** and **non-remote by default**.
2. The first control plane should be **inspection-first**, not a full mutation surface.
3. The current local `/dashboard` data browser should survive, but as the **Records** section of a broader operator console.
4. The first build should optimize around **trace -> grant -> run -> records** pivoting, not overview charts.
5. The console should consume only:
   - public PDPP surfaces
   - the explicitly stable `_ref` readers
   - no hidden control-only backdoors

## Recommended first-release slice

The first control-plane release should be intentionally narrow and should ship as a coherent operator workflow, not as a partial admin shell.

### Recommended v1 scope

Ship:

- overview with recent failures and recent activity
- trace list + trace detail
- grant list + grant detail/timeline
- run list + run detail/timeline
- global search / jump by id
- current local data browser folded into a Records section (with the activity timeline at `/dashboard/records/timeline`, not a parallel top-level surface)
- raw JSON drilldown everywhere it matters

Do not ship yet:

- scenario orchestration
- replay studio
- broad write controls
- role/permissions model beyond the local-first default
- aggregate analytics for their own sake

## Recommended route map

The initial control plane should keep its route model boring and durable:

- `/dashboard`
  - Overview
  - recent failures
  - recent approvals/denials
  - recent runs
  - quick jump/search

- `/dashboard/traces`
  - filtered trace worklist

- `/dashboard/traces/[traceId]`
  - end-to-end trace narrative
  - request/response artifacts
  - pivots to grant and run when present

- `/dashboard/grants`
  - filtered grant worklist

- `/dashboard/grants/[grantId]`
  - grant contract summary
  - grant timeline
  - pivots to originating trace and related runs

- `/dashboard/runs`
  - filtered run worklist

- `/dashboard/runs/[runId]`
  - run timeline
  - checkpoint summary
  - interaction/progress/skip/failure details
  - pivots to related grant and data

- `/dashboard/records`
  - current owner-record entry point
  - connector/stream/record navigation

- `/dashboard/records/timeline`
  - cross-stream activity timeline folded under Records (no parallel top-level `/dashboard/timeline`)

- `/dashboard/records/[connectorId]`
  - connector detail and streams

- `/dashboard/records/[connectorId]/[stream]`
  - stream list/query view

- `/dashboard/records/[connectorId]/[stream]/[recordId]`
  - record detail with raw envelope

- `/dashboard/search`
  - global jump/search surface spanning ids, sources, and record content where locally practical

The important rule is that detail pages should always be linkable and should always have adjacent pivots rather than becoming dead ends.

## Surface mapping

The first build should prefer composition over new backend invention.

### Existing surfaces the control plane should consume directly

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`
- current public grant, record, and stream readers already used by the CLI and local dashboard

### Surface gaps that may justify new read-only helpers later

These are not approved yet, but they are the likely read-only additions if the first UI needs them:

- trace listing with filters
- grant listing with filters
- run listing with filters
- lightweight cross-artifact search index

If any of those are added, they should remain:

- read-only
- reference-designated
- equally usable by CLI or future operator tooling

They should not be created as browser-only helpers hidden behind the web app.

## Open questions for the deferred phase

These are implementation/product questions, not blockers to writing the brief:

1. Should the first control plane ship with **read-only replay** or should replay remain a later adjacent phase?
2. Should the first operator surface include **any** write actions beyond those already exercised by CLI/HTTP flows?
3. Should traces, grants, and runs live in separate top-level sections, or should a global investigations surface unify them while preserving dedicated deep links?
4. How much of the current local data browser should remain query-oriented versus move toward artifact-oriented drilldown?
5. If the control plane ever becomes remotely deployable, what role model and deployment-protection stance should gate it?
