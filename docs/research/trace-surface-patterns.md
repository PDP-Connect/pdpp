# Trace / Event / Timeline Surface Patterns for PDPP

**Date:** 2026-04-16  
**Purpose:** Capture prior art for trace, event-history, and run-timeline surfaces so PDPP can build one canonical event spine and project it into both a live control plane and a curated explainer surface.

---

## Bottom line

The strongest prior art converges on one rule:

> Keep one append-only source of truth for execution history, then project it into different views for different audiences.

For PDPP, that means:

- the **truth source** should be a typed append-only event spine
- the **operator surface** should project that spine into a searchable live timeline with drilldown
- the **illustrated explainer** should project the same spine into a compressed, curated protocol story

PDPP should not choose between an event log and a trace model. It should use a **hybrid**:

- **event-history semantics** for exact state transitions and auditability
- **trace/span semantics** for durations, overlaps, waits, retries, and causal links

The right model is: **an append-only event history that can be rendered as a trace-like waterfall and as a simpler milestone timeline**.

---

## Research question

What should PDPP borrow from:

- Jaeger / OpenTelemetry-style trace viewers
- Temporal event-history and workflow timeline views
- Trigger.dev / Inngest run timelines
- adjacent observability systems such as Grafana trace views

Specifically:

- what should the canonical PDPP event spine include?
- how should timeline + drilldown work?
- what belongs in operator surfaces versus explainer surfaces?
- what anti-patterns should PDPP avoid?

---

## Precedent table

| System | Truth model | Surface shape | Strong lesson | Weakness if copied literally |
|---|---|---|---|---|
| [Jaeger](https://www.jaegertracing.io/docs/2.16/features/) | traces as DAGs with span references, tags, and logs | search list + waterfall trace view + dependency graph | durations, concurrency, and causal structure should be visually obvious | weak at product/domain semantics unless spans are heavily enriched |
| [OpenTelemetry](https://opentelemetry.io/docs/concepts/signals/traces/) | spans with attributes, events, links, status | protocol/data model more than a specific UI | clear split between duration-bearing spans and point-in-time events; links matter for async work | raw OTel concepts are too low-level for a product-facing reference surface |
| [Grafana trace view](https://grafana.com/docs/grafana/latest/visualizations/explore/trace-integration/) | trace data plus correlations to logs/metrics/profiles | searchable trace view with filters, critical path, and linked signals | users need filters, critical-path focus, and cross-links to adjacent evidence | too observability-heavy if copied directly into an explainer UI |
| [Temporal](https://temporal.io/change-log/updated-event-history-timeline-view-is-now-available) | append-only event history as source of truth | event table + timeline + filters + live updates | exact ordered history is the substrate; the UI is only a projection | event rows alone can feel dry and hard to scan without stronger semantic grouping |
| [Trigger.dev](https://trigger.dev/changelog/run-page-timeline) | run lifecycle + attempts + waits + realtime updates | run page timeline showing journey before, during, and after execution | expose queueing, waiting, and retries explicitly; the “before execution starts” phase matters | not enough by itself for deep artifact inspection |
| [Inngest](https://www.inngest.com/docs/platform/monitor/traces) | traced function runs with step spans and retry attempts | two-panel waterfall + contextual details | two-panel layout is excellent for step selection and contextual drilldown | run-centric model needs adaptation for PDPP’s multi-object protocol artifacts |

---

## What the precedents actually teach

### 1. Temporal: event history is the source of truth

Temporal is the clearest precedent for the **shape of the substrate**, not just the UI.

Important takeaways:

- each execution has an **event history that is the source of truth**
- the history is an **ordered append-only record**
- developers can access it from **code, CLI, and UI**
- the modern UI emphasizes **filters**, **pending/failed-only views**, **live updates**, and **related event grouping**

This is the most relevant precedent for PDPP’s internal model:

- the canonical spine should not be “whatever the UI happens to need”
- the UI should be derived from a stable event history
- live feed and drilldown should work over the same event sequence tests use

Temporal’s biggest useful constraint is that it treats the execution history itself as a first-class object, not as exhaust from logs.

### 2. Jaeger / OpenTelemetry / Grafana: time and causality must be visible

Jaeger and related OpenTelemetry/Grafana trace viewers are strongest at showing:

- parent/child structure
- overlap and concurrency
- duration and waiting time
- causal links across async boundaries
- “critical path” emphasis

OpenTelemetry’s model is particularly useful for PDPP:

- **spans** represent work with duration
- **events** represent meaningful point-in-time moments
- **links** represent causal relationships that are not strict parent/child

This is exactly the shape PDPP needs because:

- a grant request and consent rendering are not the same kind of thing as a collection run or RS query
- a collection run can trigger later queries and state updates asynchronously
- revocation and follow-up queries may belong to different traces but still be causally linked

The UI lessons are:

- use a waterfall/timeline for durations and overlaps
- preserve links for async handoff
- allow span filtering
- always expose details for the selected row/bar
- link traces to adjacent evidence rather than forcing everything into one pane

### 3. Trigger.dev / Inngest: run timelines should make lifecycle friction visible

Trigger.dev and Inngest are the best precedents for **operator-facing run history**, not generic distributed tracing.

Their strongest patterns:

- distinguish queued / waiting / executing / completed / failed / canceled states clearly
- show retries as separate attempts, not as one collapsed success/failure blob
- show work before execution starts
- use a **two-panel layout**:
  - left: timeline / bars / hierarchy
  - right: details for the selected run/step/span
- expose exact input/output/error payloads in the details panel

Inngest is especially useful because its traces include:

- queue delays
- retry attempts as distinct spans
- step-level input/output/error data
- a resizable two-panel timeline view

For PDPP, this maps well to:

- collection runs
- sync attempts
- approval waits
- revocation propagation
- failed introspection/query paths

### 4. Adjacent observability systems: traces are better when they are not isolated

Grafana’s trace view is useful less because of its base waterfall and more because of the surrounding affordances:

- trace search and filtering
- critical path highlighting
- span filters
- trace-to-logs
- trace-to-metrics
- trace-to-profiles
- service graph / node graph

PDPP does not need all of that, but it should borrow the principle:

> a timeline surface gets much more useful when it links to the exact artifact or adjacent signal needed to explain the selected moment.

For PDPP, those adjacent signals are likely:

- request JSON
- consent surface snapshot
- grant JSON
- introspection result
- RECORD / STATE / DONE payloads
- query response or projection diff
- CLI command/result

---

## Recommended canonical event spine for PDPP

PDPP should define one append-only execution spine that is rich enough to support:

- control-plane debugging
- CLI inspection
- tests and scenario replay
- illustrated-flow projection

### Core design rule

The canonical model should be **typed events with optional span semantics**, not raw logs and not a UI-only view model.

That means:

- every event has a stable identity and ordering
- some events open or close duration-bearing spans
- all UI surfaces derive from this model

### Minimum event fields

Every event in the spine should include:

- `event_id`
- `sequence`
- `occurred_at`
- `trace_id`
- `span_id` (when the event belongs to a duration-bearing span)
- `parent_span_id` (when applicable)
- `links[]` for async or cross-trace causality
- `event_type`
- `phase`
- `actor_type` and `actor_id`
- `object_refs[]`
- `status`
- `summary`
- `artifact_refs[]`
- `redaction_level`

### Object references PDPP should support natively

The event spine needs first-class references to the protocol objects that matter:

- `scenario_id`
- `request_id`
- `grant_id`
- `token_id` or token handle reference
- `query_id`
- `run_id`
- `interaction_id`
- `client_id`
- `subject_id`
- `stream`
- `record_id`
- `cursor` / `changes_since`

These should be references, not repeated blobs.

### Event types PDPP should treat as canonical

The event spine should include at least:

- `request.received`
- `request.validated`
- `consent.rendered`
- `consent.submitted`
- `grant.issued`
- `grant.denied`
- `grant.revoked`
- `token.minted`
- `token.introspected`
- `query.received`
- `query.projected`
- `query.responded`
- `collection.run.started`
- `collection.interaction.requested`
- `collection.interaction.responded`
- `collection.record.accepted`
- `collection.state.updated`
- `collection.run.completed`
- `collection.run.failed`
- `sync.cursor.advanced`
- `owner.export.started`
- `owner.export.completed`

This is intentionally protocol-shaped, not connector-shaped.

### Spans versus point events

Use **spans** for things with duration:

- collection runs
- queries
- sync operations
- approval waits
- replay/scenario runs

Use **point events** for meaningful state transitions:

- grant issued
- grant revoked
- token minted
- state checkpoint persisted
- response emitted

Use **links** for cross-trace causality:

- request trace -> later collection trace
- revocation trace -> subsequent failed query trace
- owner export trace -> CLI invocation trace

### Artifact pointers, not just messages

The most important addition for PDPP is that event rows must point to **real protocol artifacts**, not only carry human-readable summaries.

Every relevant event should be able to link to or embed:

- request payload
- consent rendering input/output
- grant snapshot
- runtime interaction payload
- RECORD / STATE / DONE payload
- query response and projection diff

Without artifact pointers, PDPP’s timeline becomes a pretty event log instead of a usable reference surface.

---

## Recommended UI model

PDPP should build one shared UI grammar across the live control plane and the explainer surface.

### 1. Index / list view

The top-level surface should answer:

- what is active?
- what failed?
- what finished recently?
- what object do I need to inspect next?

Recommended list dimensions:

- type: request / grant / query / collection run / owner export
- status
- last updated
- scenario / world
- client
- provider
- stream
- error count / retry state

This should not be the same page as the deep trace.

### 2. Detail view: left timeline, right inspector

The best default shape is the Inngest-style **two-panel detail surface**:

- **Left panel**
  - ordered timeline with waterfall bars where duration matters
  - collapsible hierarchy
  - filters for type, failure, pending, and actor
- **Right panel**
  - exact details for the selected item
  - protocol artifact viewer
  - linked related objects
  - error / retry / queue metadata when relevant

This is better than a three-panel “system diagram” because it lets one item be selected and understood deeply.

### 3. Grouping and summarization

The raw event stream should be grouped into semantic blocks:

- request / consent / grant
- token / introspection / query
- collection run / interactions / state
- owner export
- revoke / post-revoke failures

Operators need access to the raw history, but the default view should still be grouped enough to scan.

### 4. Search and filters

Borrow from Grafana + Temporal:

- filter by event type
- filter by pending/failed only
- filter by client/provider/stream
- filter by object id (`grant_id`, `run_id`, `query_id`)
- highlight critical path or dominant waits

Without filters, the timeline becomes unusable as soon as the traces stop being toy-sized.

### 5. Live updates

Borrow from Temporal + Trigger.dev:

- live feed for active traces/runs
- ability to pause live updates
- ascending or descending order

This matters because active collection runs and in-flight approvals are part of PDPP’s story.

---

## Operators vs explainer surfaces

PDPP should not use one timeline projection for every audience.

### Operator surface

Audience:

- implementers
- operators
- presenters debugging the live stack
- test/conformance authors

Needs:

- full fidelity
- live updates
- failures and retries
- exact timestamps
- exact queue/wait durations
- object references
- raw JSON / artifact drilldown
- links to related operations

Good default:

- searchable index
- detail page with timeline left, inspector right
- raw event table as an expandable lower-level view

### Explainer surface

Audience:

- standards readers
- prospects
- reviewers
- people trying to understand the protocol

Needs:

- fewer event types
- stable milestones
- curated labels
- strong artifact snapshots
- almost no operational noise

Good default:

- hide retries unless they matter to the teaching point
- compress repeated state updates
- show one causal chain at a time
- let the reader inspect the corresponding artifact without needing the full operator UI

### Shared rule

Both surfaces must be projections of the same canonical spine.

If the explainer surface invents events or the operator surface relies on extra hidden state, the system will drift.

---

## Anti-patterns

### 1. Card soup

Do not build the timeline surface as a dashboard full of loosely related cards.

Why it fails:

- weak sequencing
- no source of truth
- hard to scan causality
- impossible to replay or test rigorously

### 2. Logs pretending to be history

Raw log lines are not a canonical execution spine.

Why it fails:

- unstable shape
- weak identity/correlation
- hard to filter semantically
- encourages UI scraping of strings instead of stable objects

### 3. Only tree structure, no links

PDPP will have async boundaries and cross-object causality.

If the model only allows parent/child nesting, it will misrepresent:

- handoff from request to later run
- revoke -> later failed query
- owner export triggered from CLI

### 4. Only span waterfall, no exact history

A pretty waterfall is not enough.

Operators and standards reviewers need:

- exact order
- exact object ids
- exact state changes
- exact artifacts

This is why PDPP should keep Temporal-style event-history semantics underneath the trace visualization.

### 5. No retry / pending / queue visibility

Trigger.dev and Inngest are right here: “before execution starts” and “waiting to resume” are part of the real lifecycle.

If PDPP hides those, operators will not understand collection delays, approval waits, or replay behavior.

### 6. Topology view as the truth source

Service maps and node graphs are useful secondary projections, not the canonical substrate.

PDPP should not make a topology diagram the primary debugging surface.

### 7. Demo-only traces

If the illustrated landing page uses a fake timeline that the live stack cannot produce, the reference stops being trustworthy.

The explainer should replay a real or scenario-generated trace from the same canonical model.

---

## Explicit takeaways for PDPP

### 1. Build a canonical event history first

Before building a serious dashboard, PDPP needs a shared event spine with stable ids, event types, artifact pointers, and causal links.

### 2. Make the event spine protocol-shaped

The spine should speak in PDPP objects:

- requests
- grants
- queries
- collection runs
- interactions
- owner exports
- revocations

Do not let connector-specific task vocabulary become the main language.

### 3. Support both event-table and waterfall projections

PDPP needs:

- a Temporal-like event-history substrate
- an Inngest/Jaeger-like timeline/waterfall projection

One without the other is not enough.

### 4. Build one operator detail surface, not a multi-panel theatrical demo

The right live reference surface is:

- index/list for “what needs attention”
- detail page with timeline left and inspector right
- optional raw event table below

Not:

- equal-weight three-panel demo chrome
- not a product-landing hybrid

### 5. Keep the landing page curated

The public illustrated flow should consume the same event spine, but it should:

- compress noise
- foreground the canonical artifacts
- focus on one protocol story at a time

### 6. Treat artifact drilldown as mandatory

The selected timeline item should always be able to open the exact relevant artifact:

- request JSON
- consent surface input/output
- grant snapshot
- query projection diff
- runtime payload

That is what makes the timeline a reference implementation surface rather than a generic observability UI.

### 7. Distinguish protocol history from logs and audit records

PDPP should maintain a clear boundary:

- canonical protocol/run history
- operational logs
- local audit/transparency records

They can be linked, but they are not the same thing.

---

## Recommended PDPP surface stack

### Canonical spine

Append-only typed event history with span semantics and artifact references.

### Control plane

Consumes the canonical spine and shows:

- active runs
- recent failures
- grant/query history
- detail timelines
- artifact drilldown

### CLI

Consumes the same objects and ids, and can fetch or replay the same history.

### Tests

Assert against the same scenarios, object ids, and event order.

### Illustrated flow

Replays a curated projection of the same scenario traces.

---

## Recommendation

PDPP should model its trace/timeline surface after **Temporal for truth**, **Inngest for detail-layout**, and **Jaeger/Grafana for causality and filtering**.

The clearest implementation rule is:

> Build one append-only PDPP event spine, then project it into two views: a dense operator surface and a compressed explainer surface.

That keeps the system:

- debuggable
- explainable
- testable
- forkable

without coupling the protocol reference to either a marketing page or a generic observability dashboard.

---

## Sources

- [Jaeger Features](https://www.jaegertracing.io/docs/2.16/features/)
- [Jaeger Terminology](https://www.jaegertracing.io/docs/2.0/terminology/)
- [OpenTelemetry Traces Concepts](https://opentelemetry.io/docs/concepts/signals/traces/)
- [Grafana Trace View](https://grafana.com/docs/grafana/latest/visualizations/explore/trace-integration/)
- [Grafana Tempo / Explore distributed traces](https://grafana.com/docs/learning-paths/beyla-tempo/explore-traces/)
- [Temporal updated event history timeline](https://temporal.io/change-log/updated-event-history-timeline-view-is-now-available)
- [Temporal Web UI v2.26.0](https://temporal.io/change-log/temporal-web-ui-v2-26-0)
- [Temporal Web UI docs](https://docs.temporal.io/web-ui)
- [Trigger.dev run timeline refresh](https://trigger.dev/changelog/run-page-timeline)
- [Trigger.dev runs lifecycle](https://trigger.dev/docs/runs)
- [Trigger.dev realtime overview](https://trigger.dev/docs/realtime/overview)
- [Inngest traces](https://www.inngest.com/docs/platform/monitor/traces)
