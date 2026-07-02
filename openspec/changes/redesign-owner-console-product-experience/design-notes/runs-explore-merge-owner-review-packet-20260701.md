# Runs And Explore Merge Owner-Review Packet

Status: owner-review packet
Owner: RI owner
Created: 2026-07-01
Related tasks: 2.5, 2.6

## Purpose

Tasks 2.5 and 2.6 intentionally require owner review before the console commits
to either major route merger:

- whether Syncs/Runs merges into Sources or remains a secondary activity view;
- whether Explore and stream-scoped record views fully merge or remain separate
  destinations with shared rendering.

This packet prepares that review. It is not an accepted decision until the owner
reviews the mock and explicitly accepts one option for each question.

## Prior-Art Basis

Source inventory and status prior art points to a master-detail hierarchy:
Source -> configured Source/connection -> Stream -> record/event. It also says
run facts are most useful when reached from the Source they explain, with counts
and status predicates sharing the same drill-through query.

Evidence timeline prior art points in the same direction from the activity side:
logs, traces, and runs are evidence for a subject. The strongest products keep a
global activity index for operators, but the normal owner path reaches evidence
from the Source, Grant, record, or recovery action it explains.

Record workbench prior art says Explore is the cross-source query/workbench. It
should carry facets, query state, charts, pagination/virtualization, shareable
URLs, and result detail. Stream routes are source-context entry points and
full-set reachability surfaces. They should share the same record rendering and
filter URL model, but they do not necessarily collapse into one route.

## Question 1: Should Syncs/Runs Merge Into Sources?

### Option A: Merge Fully Into Sources

Sources becomes the only collection surface. Each Source detail owns recent
runs, per-stream run yield, failures, and recovery actions. A global Runs route
is removed or redirects to a filtered Sources/Activity view.

Strengths:

- strongest noun discipline: Source is the owner object;
- recovery starts where the owner already is;
- fewer primary nav items.

Risks:

- loses the owner-valued dense "what happened recently across all sources" view;
- can overload Source detail with run history and timeline mechanics;
- makes cross-source recent collection review harder unless a replacement
  activity rollup is equally dense.

### Option B: Retain Syncs/Runs As Secondary Activity View

Sources remains the recovery and source-health front door. Syncs/Runs remains a
secondary activity/evidence view, reachable from nav and Source detail, but it is
never the first answer to "what should I do about this Source?"

Strengths:

- preserves the dense per-run and per-stream facts the owner explicitly valued;
- matches prior art: evidence surfaces exist, but are subordinate to subjects;
- lower migration risk because current route value is retained.

Risks:

- keeps one more noun in the console;
- requires strict subject-scoped links so Runs does not become a competing source
  of truth;
- requires consistent copy: "Syncs" in nav, "Runs" as the execution object.

### Recommended Mock

Retain Syncs/Runs as a secondary activity view.

Mock shape:

```text
Sources
  [Source row] status · next action · latest meaningful run yield
    -> Source detail
       Streams on this source
       Latest collection
         +34 new · 1 retryable gap · 41s · View sync
       Recovery / schedule / credentials

Syncs
  Header: "What was recently collected, and what needs your hand?"
  Filter chips: All · Needs you · Review · Source · Stream
  Group cards:
    Needs you
      [Source] reason · one action · latest successful sync · View source
    Review
      [Source] retryable gap / no-action explanation · View run
    Recent successful syncs
      [Source] +N new · M unchanged · stream rows · View source / View run
```

Acceptance for owner review:

- A Source row can drill to its exact latest run without visiting a generic list.
- Syncs can filter to exactly the Sources counted by Dashboard "Needs you" and
  "Worth reviewing".
- The Syncs route preserves all per-stream run facts currently valued by the
  owner.
- No owner action is only available from Syncs; Source detail always gives the
  owner the same action.

## Question 2: Should Explore Fully Merge With Stream Routes?

### Option A: Merge Fully Into Explore

Every stream and record list route redirects into Explore with URL state. Source
detail links to Explore for all record inspection.

Strengths:

- one record workbench;
- query/facet/chart state is always available;
- fewer renderers if implemented cleanly.

Risks:

- weakens source context for the owner who starts from a Source/Stream;
- makes "show me all records for this stream" feel like a search task;
- can hide full-set stream reachability behind a general-purpose query surface.

### Option B: Keep Separate Destinations With Shared Record Model

Stream routes remain exact Source/Stream full-set destinations. Explore remains
the cross-source workbench. Both use the same record renderer, URL state helpers,
field presentation, pagination/full-set contract, and record-detail links.

Strengths:

- preserves a simple, source-context full-set path;
- keeps Explore optimized for cross-source analysis and saved/shareable views;
- matches current owner-spine proof: stream route proves full visibility, Explore
  proves scoped workbench continuity and link-out.

Risks:

- requires discipline to prevent renderers and filter URL state from drifting;
- owners may perceive duplicate ways to view records if copy does not explain
  the job difference.

### Recommended Mock

Keep separate destinations, share the record model and rendering.

Mock shape:

```text
Source detail
  Streams on this source
    messages · 133,848 records total · Coverage complete
      View stream records -> /dashboard/records/{source}/messages
      Explore this stream -> /dashboard/explore?connection={source}&stream=messages

Stream records
  Header: Source / Stream context
  Count basis: page N · X shown of Y total
  Filters: source-local and durable
  Primary job: complete stream reachability
  Secondary CTA: open in Explore with same source/stream filters

Explore
  Header: Cross-source workbench
  Query, facets, over-time chart, sort, saved/shareable state
  Count basis: current filter total + current page/window
  Result rows link back to exact Source/Stream/Record detail
```

Acceptance for owner review:

- A stream count always has a full-set path.
- Explore and stream routes render the same record fields for the same record.
- A scoped Explore URL round-trips after reload.
- A result row from Explore links to exact Source/Stream/Record detail.
- No bounded sample reads as the terminal answer.

## Owner Review Decision Needed

The RI recommendation is:

- Syncs/Runs: retain as a secondary activity/evidence view, subordinate to
  Sources for recovery actions.
- Explore/stream: keep separate destinations with one shared record model and
  shared URL/filter helpers.

Tasks 2.5 and 2.6 should remain open until the owner reviews this packet and
accepts or revises the recommendations.
