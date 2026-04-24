# Control-plane UI audit

**Status:** audit note  
**Date:** 2026-04-21

## Purpose

Capture the current `apps/web` dashboard state before the next broader control-plane planning pass so later implementation work does not need to re-derive:

- what the current operator console already does well
- where it is still only an inspection surface
- which gaps matter most for operator usefulness

This note is intentionally about the shipped UI and its visible route/client behavior. It does not reopen the v1 product contract or propose spec changes by itself.

## Intended baseline

The current dashboard should still be judged against the first control-plane contract:

- local-first, inspection-first, read-only by default
- optimized for reference operators, connector authors, and technical reviewers
- one-move access from request/trace/grant/run id to the explaining artifact
- stable IA: `Overview`, `Traces`, `Grants`, `Runs`, `Records`, `Search`
- list + detail / peek workflow on the investigative spine

Relevant source notes:

- `control-plane-discovery-brief.md`
- `control-plane-implementation-plan.md`
- `control-plane-v1-follow-up.md`

## What exists now

### 1. The IA and route map are real

The main IA now exists as durable routes:

- `/dashboard`
- `/dashboard/traces`
- `/dashboard/grants`
- `/dashboard/runs`
- `/dashboard/records`
- `/dashboard/records/timeline`
- `/dashboard/search`

The shared shell and left rail are in:

- [apps/web/src/app/dashboard/components/shell.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/shell.tsx:12)

Legacy route cleanup is also in place:

- `/dashboard/data/...` redirects to `/dashboard/records/...`
- `/dashboard/timeline` redirects to `/dashboard/records/timeline`

See:

- [apps/web/next.config.mjs](/home/user/code/pdpp/apps/web/next.config.mjs:85)

### 2. The console is still local-first and inspection-first

The dashboard remains gated locally by default:

- [apps/web/src/app/dashboard/lib/dashboard-access.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/dashboard-access.ts:1)

The data clients are read-only wrappers around:

- reference-designated `_ref` readers for traces/grants/runs/search
- public `/v1/streams` owner-self-export readers for records

See:

- [apps/web/src/app/dashboard/lib/ref-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/ref-client.ts:1)
- [apps/web/src/app/dashboard/lib/rs-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/rs-client.ts:1)

There are still no operator write controls in the dashboard itself. The only POST usage in the dashboard code is the internal server-side owner-token bootstrap helper, not a visible operator action:

- [apps/web/src/app/dashboard/lib/owner-token.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/owner-token.ts:36)

### 3. The investigative spine is real

`Traces`, `Grants`, and `Runs` each have:

- a paginated worklist
- a list-plus-peek interaction using `?peek=<id>`
- full-page detail routes
- pivots across related artifacts
- raw event timelines and CLI-equivalent affordances

See:

- [apps/web/src/app/dashboard/traces/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/traces/page.tsx:33)
- [apps/web/src/app/dashboard/grants/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/grants/page.tsx:33)
- [apps/web/src/app/dashboard/runs/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/runs/page.tsx:32)
- [apps/web/src/app/dashboard/components/peek.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/peek.tsx:6)
- [apps/web/src/app/dashboard/traces/[traceId]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/traces/[traceId]/page.tsx:10)
- [apps/web/src/app/dashboard/grants/[grantId]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/grants/[grantId]/page.tsx:10)
- [apps/web/src/app/dashboard/runs/[runId]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/runs/[runId]/page.tsx:11)

This is a real operator console now, not a disguised data browser.

### 4. Overview is a real operator landing page

`/dashboard` now leads with:

- recent failed traces
- recent failed runs
- recent grant decisions
- recent runs
- a top-line action-needed banner

See:

- [apps/web/src/app/dashboard/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/page.tsx:23)

### 5. Search is useful, but narrow

`/dashboard/search` does two distinct things:

- exact id jump through `_ref/search`
- substring search across locally fetched records

See:

- [apps/web/src/app/dashboard/search/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:139)

This means the command palette is currently a thin router into Search, not a richer multi-action command surface:

- [apps/web/src/app/dashboard/components/command-palette.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/command-palette.tsx:15)

### 6. Records remains a mostly separate owner-data browser

`Records` includes:

- connector index
- connector -> stream -> record drilldown
- stream health
- timeline/activity view

See:

- [apps/web/src/app/dashboard/records/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/page.tsx:8)
- [apps/web/src/app/dashboard/records/[connector]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/page.tsx:15)
- [apps/web/src/app/dashboard/records/[connector]/[stream]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/[stream]/page.tsx:20)
- [apps/web/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx:9)
- [apps/web/src/app/dashboard/records/[connector]/[stream]/health/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/[stream]/health/page.tsx:12)
- [apps/web/src/app/dashboard/records/timeline/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/timeline/page.tsx:14)

### 7. Mobile-specific adaptations exist, but mostly at the layout level

Visible responsive choices in the code:

- left rail collapses into a wrapped top nav on small screens
- investigative list + peek becomes a single-column stack below `lg`
- `PeekEmpty` is hidden below `md`
- record-table views switch to card/list layouts on small screens
- search and timeline rows collapse into stacked grids on small screens

See:

- [apps/web/src/app/dashboard/components/shell.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/shell.tsx:30)
- [apps/web/src/app/dashboard/components/peek.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/peek.tsx:58)
- [apps/web/src/app/dashboard/records/[connector]/[stream]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/[stream]/page.tsx:79)
- [apps/web/src/app/dashboard/records/timeline/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/timeline/page.tsx:97)
- [apps/web/src/app/dashboard/search/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:205)

## What is still missing or weak for operator usefulness

### 1. There are still no control actions

This is the biggest practical gap if the next phase wants the control plane to be useful for operating the system, not just inspecting it.

Today the dashboard does not let an operator:

- trigger a connector run
- retry a failed run
- pause or schedule connectors
- mint or inspect non-owner tokens explicitly
- start a consent flow
- approve or deny pending owner actions
- revoke a grant
- clear state or replay a scenario

That is still consistent with the v1 non-goal, but it is the main reason the current console is not yet a true operator cockpit.

Relevant contract note:

- [openspec/changes/reference-implementation-program/design-notes/control-plane-implementation-plan.md](/home/user/code/pdpp/openspec/changes/reference-implementation-program/design-notes/control-plane-implementation-plan.md:26)

### 2. Search is helpful, but weaker than the intended “global jump” surface

The intended IA said Search / Command should cover ids, connectors, streams, and known artifact types. Today Search is strong for exact ids and acceptable for substring record search, but it is still weak for:

- connector name search as a first-class workflow
- stream name search as a first-class workflow
- scoped jump actions beyond “go to exact artifact” or “search records”
- artifact-aware filters from a single surface

The command palette itself is especially thin: it offers only section shortcuts plus redirect to Search.

See:

- [openspec/changes/reference-implementation-program/design-notes/control-plane-discovery-brief.md](/home/user/code/pdpp/openspec/changes/reference-implementation-program/design-notes/control-plane-discovery-brief.md:214)
- [apps/web/src/app/dashboard/components/command-palette.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/command-palette.tsx:6)
- [apps/web/src/app/dashboard/search/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:151)

### 3. The investigative worklists do not expose enough filtering for real triage

The `_ref` clients support `since`, `until`, `client_id`, `provider_id`, `connector_id`, and other filters, but the UI only surfaces a narrow subset:

- `Traces`: `q`, `status`
- `Grants`: `q`, `status`
- `Runs`: `q`, `connector_id`, `status`

There is no exposed time-range filtering, no provider/client filters on-screen, and no saved or default operator slices beyond the Overview shortcuts. That is materially thinner than the OpenSpec intent and thinner than the prior-art patterns the brief wanted to emulate.

See:

- [apps/web/src/app/dashboard/lib/ref-client.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/ref-client.ts:190)
- [apps/web/src/app/dashboard/traces/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/traces/page.tsx:191)
- [apps/web/src/app/dashboard/grants/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/grants/page.tsx:80)
- [apps/web/src/app/dashboard/runs/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/runs/page.tsx:78)

### 4. Records is still not well integrated into lineage/debug workflows

The intended job was to move across request -> consent -> grant -> token -> run -> disclosed record. Today the investigative spine can pivot among traces, grants, and runs, but Records barely pivots back:

- connector page links to filtered runs for that connector
- stream/record pages do not link back to grant, trace, or run
- record detail is raw JSON only
- no artifact lineage is surfaced next to records

This means verifying “what data landed because of which run/grant/scope choice” is still partly a manual reconstruction exercise.

See:

- [apps/web/src/app/dashboard/records/[connector]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/page.tsx:55)
- [apps/web/src/app/dashboard/records/[connector]/[stream]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/[stream]/page.tsx:57)
- [apps/web/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/records/[connector]/[stream]/[recordKey]/page.tsx:46)

### 5. Records search and timeline are bounded approximations, not authoritative operator tools

Two important surfaces still work by bounded client-side scanning:

- Search record-content search loads up to `500` records per stream and stops after `50` hits
- Records timeline loads up to `50` newest row-ordered records per time-anchored stream and filters client-side

Both are useful, but both are approximation layers over the RS, not strong operator-grade readers:

- Search can miss older hits in large streams
- Timeline can miss records outside the bounded fetch budget
- Timeline itself says row id ordering is only “close enough” to timestamp ordering in the current corpus

See:

- [apps/web/src/app/dashboard/search/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:22)
- [apps/web/src/app/dashboard/search/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/search/page.tsx:82)
- [apps/web/src/app/dashboard/lib/timeline.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/timeline.ts:9)
- [apps/web/src/app/dashboard/lib/timeline.ts](/home/user/code/pdpp/apps/web/src/app/dashboard/lib/timeline.ts:126)

This matters because these are exactly the kinds of views operators will trust more than they should if the UI does not signal their bounded nature clearly.

### 6. Overview is better, but still not a full operator home

Overview now highlights failures and recent decisions, which is good. But it still does not answer several high-value operator questions:

- is the server reachable and healthy beyond “hard unreachable”
- is the owner token bootstrap healthy
- are there pending interactions needing attention
- is scheduling active or stale
- what connectors are “stuck” or idle
- what grants are close to expiry or recently revoked

It is a strong v1 landing page, but not yet a control center.

See:

- [apps/web/src/app/dashboard/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/page.tsx:23)

### 7. Full-detail pages still underuse the richer summary opportunities promised in OpenSpec

The implementation plan called for:

- artifact summary headers
- contract summaries
- source/client/provider identity summaries
- payload summaries alongside raw JSON

Current detail pages are still mostly:

- breadcrumb
- title
- small summary line
- pivots
- timeline
- CLI equivalent

The Run detail page goes furthest with its checkpoint/progress/interaction/failure summary panels, but Trace and Grant detail pages are still sparse.

See:

- [openspec/changes/reference-implementation-program/design-notes/control-plane-implementation-plan.md](/home/user/code/pdpp/openspec/changes/reference-implementation-program/design-notes/control-plane-implementation-plan.md:192)
- [apps/web/src/app/dashboard/traces/[traceId]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/traces/[traceId]/page.tsx:42)
- [apps/web/src/app/dashboard/grants/[grantId]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/grants/[grantId]/page.tsx:44)
- [apps/web/src/app/dashboard/runs/[runId]/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/runs/[runId]/page.tsx:45)

### 8. Mobile is supported structurally, but the main operator interaction model degrades sharply below `lg`

The list-plus-peek model is only truly side-by-side at `lg`. Below that:

- the peek pane stacks under the list
- `PeekEmpty` disappears below `md`
- long timelines and raw JSON become much harder to scan in-flow
- the left rail becomes a wrapped nav row that competes with page headers

So the dashboard is responsive, but not yet intentionally optimized for “serious operator work on mobile.” It is mostly “mobile-safe,” not “mobile-good.”

See:

- [apps/web/src/app/dashboard/components/shell.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/shell.tsx:30)
- [apps/web/src/app/dashboard/components/peek.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/components/peek.tsx:20)
- [apps/web/src/app/dashboard/traces/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/traces/page.tsx:81)
- [apps/web/src/app/dashboard/grants/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/grants/page.tsx:105)
- [apps/web/src/app/dashboard/runs/page.tsx](/home/user/code/pdpp/apps/web/src/app/dashboard/runs/page.tsx:109)

## Recommended implementation priorities

### Priority 1: close the operator-action gap carefully

If the next phase wants a more useful control plane, the highest-value shift is not cosmetic. It is adding a small, explicit action model for the real jobs operators will do.

Recommended first actions:

- manual connector run / “sync now”
- safe rerun / retry from failed run context
- grant revoke from grant detail
- explicit token mint/copy flows where they already exist via CLI/HTTP
- owner action surfaces only where the underlying flow already exists cleanly

The key rule should stay: no hidden browser-only backdoor. Any action surfaced in the UI should either:

- use an existing CLI/HTTP flow, or
- force the same underlying runtime/reference substrate to become explicit and testable

### Priority 2: make Search and worklists operator-grade

Before adding many actions, the investigation surfaces should become stronger triage tools.

Recommended next work:

- expose `since` / `until` filters on traces, grants, and runs
- expose provider/client filters where supported
- make Search cover connectors and streams explicitly
- enrich the command palette into true jump/action entry instead of a thin redirect shell

### Priority 3: make lineage into and out of Records real

The next substantial usefulness gain is to connect Records back to the investigative spine.

Recommended work:

- show related run / grant / trace pivots on record or stream pages where derivable
- surface stream metadata and effective query/field contract next to records
- make “what landed because of this run/grant” a first-class navigation path instead of a manual reconstruction exercise

### Priority 4: replace bounded approximation views with stronger server-backed surfaces

If Search and Timeline are going to be trusted, they should be honest and preferably stronger:

- replace bounded client-side record search with explicit server-backed search/index helpers or constrain the UI language so it is obviously approximate
- replace bounded timeline scanning with a more authoritative timeline/query surface or label it clearly as a sampled/local convenience view

This matters more than visual polish because approximate operator views create false confidence.

### Priority 5: deepen Overview and mobile intentionally

Once action/control and lineage improve:

- add a real “pending interactions / stale connectors / recent grant changes / scheduler state” operator summary
- design a deliberate small-screen operator mode rather than letting the desktop layout merely collapse

## Bottom line

The current dashboard is a legitimate v1 operator console and broadly matches the original inspection-first contract. The strongest parts are:

- durable IA
- list-plus-peek investigative spine
- CLI-aligned detail pages
- local-first guardrails

The main remaining weakness is not that the UI is fake or off-plan. It is that it is still mostly a **reader** over traces, grants, runs, and owner data. For the next phase to be meaningfully more useful, the project should focus first on:

1. explicit operator actions on top of real runtime/reference flows
2. stronger search/filter/triage
3. real lineage into and out of Records
4. more authoritative search/timeline surfaces

That sequence will improve usefulness far more than styling or minor page polish.
