# Owner Console — Evidence Timelines, Runs & Traces (Prior Art, Lens 7)

**Date:** 2026-06-18
**Owner:** Claude (research lens, owner-console SLVP redesign corpus)
**Status:** Research / design only — no product code, no deploy
**Why this note exists (and what it extends):** This is Lens 7 of the owner-console prior-art corpus. It **extends** `docs/research/trace-surface-patterns.md` (2026-04-16), which already established the core thesis — *one append-only typed event spine, projected into a dense operator surface and a compressed explainer surface* — and surveyed Temporal / Jaeger / OTel / Grafana / Trigger.dev / Inngest. That doc answered "what is the substrate and the two-panel detail shape." It did **not** answer the questions the owner's concrete complaints now force:

- How do leading products keep a timeline **dense yet readable** (vs. PDPP's "wall-of-text unreadable status copy")?
- How is a trace reached **as a subordinate of the thing it explains** (owner: run/sink detail subordinate to the source; *"if the answer is view the trace, there should be a link to the trace"*) rather than as a top-level destination?
- What is the **reusable timeline primitive** (the owner referenced reusable primitives + Datadog-consumability) — its component contract, event grammar, and states?
- How do products expose **raw payload as a clearly-secondary tab**, not the default view ("feels fairly vibe-coded")?

**Relationship to trace-surface-patterns.md — stated plainly to avoid a false impression of novelty.** The prior doc already establishes (a) the append-only typed event spine, (b) the waterfall/timeline two-panel projection, and (c) a **canonical PDPP event-type list** (its lines ~226–248) that *already includes* `collection.run.started`, `collection.run.completed`, `collection.run.failed`, `collection.record.accepted`, `query.received`, `query.projected`, `query.responded`, `grant.issued`/`revoked`, `token.minted`, etc. So when this note talks about a "PDPP event grammar" or "access-trace `query.*` events keyed by `client_id`," it is **reusing that existing vocabulary, not introducing a new one** — and this doc treats `trace-surface-patterns.md` §"Event types PDPP should treat as canonical" as the **single source of truth for event names**. The net-new contribution of *this* note is everything the prior doc did *not* cover: a concrete reusable component contract (`<EvidenceTimeline>` props + `TimelineEvent` shape), subject-scoped IA (Source › Connection › Run as the owner's path), the inspector tab order (Summary → Artifact → Raw-JSON-last), a prose→typed-row copy table mapping the owner's exact strings, and two density/activity sources the prior doc lacks (Sentry breadcrumb attribute schema, Linear Activity feed + grouping). It does **not** re-derive the spine or coin alternate event names.

This note also relates to `explorer-workbench-and-access-transparency-prior-art-2026-06-18.md` (facets/filters; "what does ChatGPT have access to / read") and `slvp-ideal-stuck-run-liveness-2026-06-14.md` (the blinking-cursor / no-progress complaint).

---

## 1. Prior-art sources

All retrieved **2026-06-18**.

1. **Datadog — Trace View (flame graph + span list)** — https://docs.datadoghq.com/tracing/trace_explorer/trace_view/ (retrieved 2026-06-18). A single trace renders as a **flame graph** (each span a horizontal bar positioned/sized by start-time and duration, nested by parent/child) with alternate views (span list, waterfall). Selecting a span opens a **side/lower panel** with that span's metadata, tags, and **correlated logs** for the span. The trace also surfaces a **breakdown** of where time went. Key pattern: the visual (durations, nesting) and the detail panel are split — you scan the graph, click one bar, and read its details without leaving the trace.

2. **Datadog — Trace Explorer (search, facets, group-by, visualize)** — https://docs.datadoghq.com/tracing/trace_explorer/ (retrieved 2026-06-18). The list of spans/traces is driven by a **search query bar + facet rail**; results can be shown as a list, **grouped** by a facet (e.g., by service/status), or **visualized** as a timeseries/top-list. A facet selected in the rail rewrites the query string (query and facets are the same source of truth). This is the "index/list" surface that *precedes* the single-trace flame graph.

3. **Datadog — Correlate Logs and Traces** — https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/ (retrieved 2026-06-18). Logs are injected with `trace_id`/`span_id` so a log line links directly to its trace and vice-versa; from a span you jump to its logs, from a log you jump to the trace. The documented principle: **correlation is by stable id, navigable in both directions** — the answer to "show me the evidence for this moment" is a *link*, not a copy of the evidence inline.

4. **Datadog — Log Explorer** — https://docs.datadoghq.com/logs/explorer/ (retrieved 2026-06-18). A reorderable **column-based list** over a query + facets, plus a **timeline histogram** above the list (volume over time, color-segmented by status), and a side panel for the selected log. Patterns: compact columnar rows (not free-text lines), a scannable time histogram for "when did this spike," and saved/shareable views.

5. **Sentry — Breadcrumbs** — https://docs.sentry.io/product/issues/issue-details/breadcrumbs/ (retrieved 2026-06-18). Breadcrumbs are a **chronological trail of events that led up to** the error, each a compact typed row: **category, type, level, message, timestamp**, with severity coloring. They are rendered as a tight table (one row per event), filterable, and shown **inside the issue (the thing they explain)** — never as a standalone destination.

6. **Sentry — Issue Details** — https://docs.sentry.io/product/issues/issue-details/ (retrieved 2026-06-18). The issue page composes: header (title, level, status), **tags** (key/value pills — environment, release, browser), the stack trace, and the breadcrumb timeline. Tags are **clickable facets** ("show all issues with this tag value"). The event detail is reached *from* the issue; the raw JSON event is a secondary "JSON" affordance, not the default.

7. **Temporal — Workflows / Event History overview** — https://docs.temporal.io/workflows (retrieved 2026-06-18). Each Workflow Execution has an **append-only Event History that is the source of truth**; the UI is a projection of it.

8. **Temporal — Events reference (typed event grammar)** — https://docs.temporal.io/references/events (retrieved 2026-06-18). The history is a sequence of **strongly-named typed events** (`WorkflowExecutionStarted`, `ActivityTaskScheduled`, `ActivityTaskStarted`, `ActivityTaskCompleted`/`Failed`, `TimerStarted`, `WorkflowExecutionSignaled`, etc.). Each event carries a typed attributes payload and references prior events by id (e.g., `scheduledEventId`). This is a closed, documented vocabulary — the grammar is finite and meaningful, which is what makes the timeline scannable and testable.

9. **Temporal — Web UI** — https://docs.temporal.io/web-ui (retrieved 2026-06-18). The Web UI shows event history as a **compact event list with a timeline**, with **filters** (e.g., pending/failed-only), **related-event grouping**, expand-on-demand of an event's full attributes, and **live updates** for running executions. Reached by drilling from a workflow execution — not a global event firehose.

10. **GitHub Actions — Using workflow run logs** — https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-workflow-run-logs (retrieved 2026-06-18). Logs are organized by **job → step**; each step is a **collapsible group** with a status glyph and **per-line timestamps** (toggleable). You can **search within the log**, matching lines auto-expand their step, and **link to a specific line** (anchor URL) to share evidence. Default is collapsed step headers (scan first), expand the failing step.

11. **GitHub Actions — Viewing workflow run history** — https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history (retrieved 2026-06-18). The run list shows status (per job and step), and you drill from the run into its logs.

12. **GitHub Actions — Visualization graph** — https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-the-visualization-graph (retrieved 2026-06-18). "Every workflow run generates a **real-time graph that illustrates the run progress**" — a job DAG with live status per node, used to monitor and debug. The graph and the logs are two projections of the same run; clicking a job node jumps to that job's logs.

13. **Linear — Activity feed (assign/delegate docs)** — https://linear.app/docs/assigning-issues (retrieved 2026-06-18). Linear's issue **Activity feed** is a single chronological feed of compact, typed rows — actor + verb + object — threaded **inside the issue**. The docs state verbatim that "the assignment and delegation history is tracked in its **Activity feed, which shows changes over time and who made them**" (each row = actor + change + time). The same page documents that an issue can be **assigned to or delegated to an agent** via the same assignee/properties field, so an agent's actions land as rows in the *same* Activity feed rather than a separate log — confirming "agent steps as same-feed typed rows."

13b. **Linear — Collapsed issue history (changelog, dated April 3 2025)** — https://linear.app/changelog/2025-04-03-collapsed-issue-history (retrieved 2026-06-18). A dated, durable changelog entry: to keep the activity feed focused, Linear "**group[s] similar consecutive events and collapse[s] older activity between comment threads**" (verbatim). This anchors the density mechanism for a typed activity feed — consecutive same-type rows collapse with a count, comments stay expanded.

14. **trace-surface-patterns.md** (this repo, 2026-04-16) — the doc this note extends; canonical-spine + two-panel + projections thesis, plus Jaeger/OTel/Grafana/Trigger.dev/Inngest survey. (Internal.)

---

## 2. Observed patterns (cross-source synthesis)

**P1 — The timeline is reached *from* the subject, never as a top-level tab.** Sentry breadcrumbs live inside an issue; GitHub step logs live inside a run; Temporal event history lives inside an execution; Datadog spans live inside a trace; Linear activity lives inside an issue. None of these is a global "Events" destination. The entry point is always "open the thing, then see its evidence." (Sources 5–13.)

**P2 — Correlation is by stable id and is bidirectional; "the answer is a link."** Datadog logs↔traces navigate by `trace_id`/`span_id`; GitHub log lines have anchor URLs; Temporal events reference prior events by id. You never inline-paste the evidence into a status sentence — you link to the row/artifact. (Sources 3, 8, 10.)

**P3 — Rows are typed and compact, not free text.** Temporal events, Sentry breadcrumbs, Linear activity, and Datadog log columns are all **one structured row per event** with a fixed grammar (type/category, actor, object, status, time). Density comes from a closed vocabulary + columns, not prose; when volume grows, Linear *groups similar consecutive events and collapses older activity* (Source 13b) rather than letting rows pile up — the antidote to "wall-of-text unreadable status copy." (Sources 4, 5, 8, 13, 13b.)

**P4 — Scan first (collapsed/summary), expand on demand, raw last.** GitHub steps are collapsed until you open the failing one; Temporal events expand to show typed attributes; Datadog/Sentry show a summary then a side panel; raw JSON is a secondary tab. The default view is scannable; full fidelity is one click away; raw payload is the *last* tab, not the first. (Sources 5, 6, 9, 10.)

**P5 — A histogram/graph orients "when/where" before the list.** Datadog Log Explorer puts a status-segmented time histogram above the list; GitHub renders a live job DAG; Datadog trace view shows a duration breakdown. A small visual answers "where did time go / when did it fail" before you read any rows. (Sources 1, 4, 12.)

**P6 — Filters/facets share one query state.** Datadog facets rewrite the query string; Temporal has pending/failed-only toggles; GitHub log search auto-expands matches. Filtering is first-class and the filter *is* the URL state (shareable, restorable). (Sources 2, 9, 10.)

**P7 — Live + terminal use the same surface.** GitHub's graph is "real-time," Temporal updates live, Trigger.dev/Inngest stream. A running run and a finished run render in the same component; "in progress" is a state of the same rows, with a spinner/progress on the active node — not a separate blank screen. (Sources 9, 12; ties to the blinking-cursor complaint.)

---

## 3. PDPP implications (tie to surfaces + the owner's complaints)

- **"Can't see run/sink detail from the summary" + "if the answer is view the trace, there should be a link to the trace."** Every summary statement on a Source card, a connection-health advisory, or a run row that *references* an event must render that reference as a **link to the exact timeline row/trace**, not as terminal prose (P2). PDPP currently states conclusions ("Suppressed evidence. Drain detail gap backlog.") with no navigable target. Each such phrase should resolve to `→ View run` / `→ View the 6 affected records` / `→ View trace`.

- **Subject-scoped navigation (owner: run/sink detail subordinate to the source).** The run/trace timeline is **not** a top-level nav item. It is reached as `Source → Connection → Run → (timeline)` and `Source → Connection → "what AI read" → (access trace)` (P1). The top-level nav may keep a flat "Runs"/"Traces" index for operators, but the owner's primary path is drill-down from the source they care about. This directly resolves "can't tell if I'm looking at a source or a connection" by making the hierarchy the navigation.

- **"Wall-of-text unreadable status copy."** Replace prose status with **typed compact rows** (P3) drawn from the **existing** canonical grammar in trace-surface-patterns.md §"Event types" — not new ad-hoc names. "Suppressed evidence. Drain detail gap backlog." becomes rows keyed to canonical types: a `collection.record.accepted` outcome carrying a `deferred` count, and a `collection.run.completed` row `1,177 written · 6 deferred`. **One reconciliation owed:** the canonical list has `collection.record.accepted` and `collection.state.updated` but no explicit *deferred / needs-review* transition; that should be added to the source-of-truth list in trace-surface-patterns.md (proposed `collection.record.deferred`) rather than coined locally — see §4.1 and OpenSpec note.

- **"Collected" confusing — no change vs how many NEW records** + **"1 needs review" with no way to see which one.** A run row must carry a structured **outcome breakdown**, not one ambiguous "Collected" number: `new`, `updated`, `unchanged`, `deferred/needs-review`, `failed` — each a clickable facet that filters to those records (P3/P6, Datadog group-by). "1 needs review" becomes `→ 1 needs review` linking to the single deferred record. This mirrors Sentry tags-as-facets and GitHub step-status.

- **"What does ChatGPT have access to / what did ChatGPT read."** Model AI access reads as **first-class events on the same spine**, using the *already-canonical* `query.received` / `query.projected` / `query.responded` types (defined in trace-surface-patterns.md) keyed by `client_id` + `stream` + record counts, so the connection page can render an **access timeline** scoped to that client — the breadcrumb pattern (P1) applied to grant usage. "What it read" = a filtered projection of read events; "what it can access" = the grant scope shown above that timeline. (Coordinate with the access-transparency lens doc.)

- **Local recovery "blinking cursor; no progress indicator."** The live run must use the **same timeline component in a live state** (P7) — streaming typed rows as the collector emits them, with a progress affordance on the active step (GitHub's real-time graph; Temporal live updates). A command that then shows a blank cursor is the anti-pattern; the CLI should emit the same event grammar the console renders.

- **"Feels fairly vibe-coded."** The cure is a **single reusable timeline primitive** (§4) used identically across runs, access traces, and the explainer, with a closed event grammar — consistency across surfaces is what reads as "engineered," and it makes the surface Datadog-consumable (stable typed events can be shipped to Datadog/OTel later).

- **Bounded sample "6 of 1,183" + jump-to-ID undiscoverable.** Belongs to the explorer lens, but the timeline shares the rule: any truncated row set must label its **basis** ("most recent 50 events") and offer **"View all N"**; jump-to-event-id should give visible feedback (scroll + highlight the matched row), mirroring GitHub log search auto-expanding the matched line.

---

## 4. Concrete affordance / copy / IA recommendations

### 4.1 The reusable timeline primitive — `<EvidenceTimeline>`

One component, used by run detail, access trace, grant history, and the explainer. Contract:

```
EvidenceTimeline({
  events: TimelineEvent[],        // already projected from the canonical spine
  subject: { kind, id, label },   // the thing this timeline explains (run, connection, grant)
  mode: "live" | "terminal",
  density: "compact" | "expanded",
  view: "list" | "waterfall",     // list = Temporal/Sentry rows; waterfall = Datadog flame
  filters: FacetState,            // shared query state, serialized to URL
  onSelect(eventId): void,        // opens the right/lower inspector
})

TimelineEvent {
  id, seq, occurred_at, duration_ms?,   // duration present => can render as a bar
  type,                                  // closed PDPP grammar — MUST be a value from trace-surface-patterns.md
                                         //   §"Event types PDPP should treat as canonical"
                                         //   (e.g. collection.run.started, collection.record.accepted,
                                         //    collection.run.completed, query.received, query.responded).
                                         //   Do NOT coin short aliases like "run.started"/"query.responded".
  severity: "info" | "warn" | "error" | "success",
  actor: { kind, id, label },            // owner | collector | client(ChatGPT) | system
  object_ref?: { kind, id, label },      // record / stream / grant / connection
  summary,                               // ONE short line, no paragraphs
  links: { trace?, record?, artifact?, run? },  // P2: the row IS a link target
  payload_ref?,                          // raw artifact, loaded lazily into the secondary tab
}
```

Render rules:
- **Compact row** (default): `[severity dot] [HH:MM:SS] [type chip] [actor→object] [summary] [duration badge]`. One line, ellipsized; never wrap into a paragraph.
- **Group header** per phase (request/consent/grant · token/query · run/records/state), collapsed-with-count by default (GitHub step grouping).
- **Waterfall view** for duration-bearing events (runs, queries, waits) — Datadog flame-graph layout, bars positioned by `occurred_at` + `duration_ms`, nested by parent.
- **Selected event → inspector panel** with tabs in this order: **Summary** (typed attributes as a key/value table, Sentry-tags style) · **Artifact** (the request/response/RECORD payload, rendered) · **Raw JSON** (last tab — secondary, never default).
- **Live mode**: append rows as they stream; active event shows a progress spinner/bar; "Pause live" toggle; auto-scroll with a "jump to latest" pill.

### 4.2 Subject-scoped entry points (no top-level dump)

- On a **Run** summary row: `→ View run timeline` opens `<EvidenceTimeline subject={run}>`.
- On a **Connection** ("what AI read"): `→ View access activity` opens the same primitive filtered to `actor.kind = client`.
- On a **health advisory**: every conclusion ends in a link to the originating event (`→ View the run where this happened`).
- Keep an operator-only flat index (`/runs`, `/traces`) but the **owner's labelled path is the source hierarchy**.

### 4.3 Event-grammar copy (replace prose)

| Bad (current, prose) | Good (typed compact row) |
|---|---|
| "Suppressed evidence. Drain detail gap backlog." | `09:14 · collector · deferred 6 records · reason: missing detail · → review` |
| "Collected" (ambiguous) | `Run complete · 1,177 new · 4 updated · 1,002 unchanged · 6 deferred` |
| "1 needs review" | `⚠ 1 record needs review · → open` |
| (blinking cursor) | live rows: `Enrolling…` → `Fetching page 3/12…` → `Wrote 240 records…` |

(The right column shows the **rendered row text** an owner reads, not the underlying `type` identifier. Each row is still backed by a canonical event `type` from trace-surface-patterns.md — e.g. the "deferred 6 records" row is a `collection.record.deferred` event; "Run complete …" is `collection.run.completed`; the live rows are `collection.run.started` → `collection.interaction.requested` → `collection.record.accepted`. The summary string is cosmetic; the type is the closed, testable, Datadog-exportable value.)

### 4.4 Filters / facets (shared query state)

- Facet rail: **type**, **severity** (errors-only / needs-review-only toggle, à la Temporal pending-only), **actor**, **object/stream**, **time window**.
- A facet click rewrites the URL query (Datadog model); the URL is the shareable, restorable state.
- Free-text search over `summary` + ids; matched rows auto-expand and scroll into view (GitHub log search; fixes jump-to-ID feedback).

### 4.5 Orientation visual

- A small **status-segmented histogram** (Datadog Log Explorer) or **duration bar** above the list: "where did time go / when did errors cluster," before any rows are read.

### 4.6 Datadog-consumability

- The closed event grammar maps 1:1 to OTel span/event attributes (`type`→span name, `object_ref`→resource attrs, `severity`→status, `links`→span links), so the same spine can be exported to Datadog/OTel without inventing a second vocabulary. State this as a primitive design constraint.

---

## 5. Anti-patterns to avoid

1. **Top-level "Events"/"Traces" firehose as the owner's primary path.** Evidence must be subject-scoped (P1). A global stream with no subject is the "is this a source or a connection?" confusion at scale.
2. **Prose status sentences with no link target.** "If the answer is view the trace, there must be a link to the trace." A conclusion with no navigable origin is a dead end (violates P2).
3. **Raw JSON as the default view.** Raw payload is the *last* tab. Defaulting to JSON is what reads as "vibe-coded" (violates P4).
4. **One ambiguous aggregate number** ("Collected: 1,183") instead of a typed outcome breakdown with clickable facets.
5. **A separate, differently-styled screen for live runs.** Live and terminal must be the same primitive in two modes; a bespoke "in progress" page (or a blank blinking cursor) breaks P7 and the SLVP consistency bar.
6. **Free-text log lines as the canonical row.** Untyped strings can't be filtered, faceted, or tested (violates P3); keep the closed grammar from trace-surface-patterns.md.
7. **Inventing event types — including short aliases — instead of using trace-surface-patterns.md's canonical list.** Re-stated and sharpened from the extended doc: do not coin `run.started`/`query.responded`/`record.deferred` as parallel names for the canonical `collection.run.started`/`query.responded`/proposed `collection.record.deferred`. Two name spaces = two grammars = the AC-9 contradiction and a non-Datadog-consumable spine. New types are added to the one source-of-truth list, then used. The primitive (and its grammar) must be shared, including for the marketing/explainer surface.
8. **Inconsistent nav vs route labels.** The drill-down breadcrumb (Source › Connection › Run › Timeline) must match the nav and route names exactly (owner: "routes named differently than nav").

---

## 6. Acceptance checks (owner-walkable, testable)

1. **Subject-scoped entry:** From a Source, an owner can reach a run's timeline in ≤2 clicks (Source → Run → timeline) and there is **no** top-level nav item required to get there. *Check:* the run timeline URL is nested under the source/connection, and breadcrumbs read `Source › Connection › Run`.
2. **Every conclusion links:** No status string that references an event/run/record renders without a corresponding link to it. *Check:* grep the run/health/access surfaces for terminal sentences; each must be accompanied by a `→ View …` link resolving to a timeline row or artifact. ("Suppressed evidence…" → has a link.)
3. **Typed compact rows:** Each timeline row is a single non-wrapping line with `[severity][time][type][actor→object][summary]`; no row renders a paragraph. *Check:* visual + a test asserting `summary` length and single-line layout; rows derive from the closed event-type enum.
4. **Raw-payload-secondary:** The inspector's default tab is Summary; Raw JSON is the last tab and is never the initial selection. *Check:* default `activeTab === "summary"`; tab order asserts JSON last.
5. **Outcome breakdown, not one number:** A completed run shows new/updated/unchanged/deferred/failed counts, and each count is a filter that scopes the timeline/records. *Check:* clicking "6 deferred" filters to exactly those 6 records; "1 needs review" links to the one record.
6. **Live = terminal:** A running run renders the same `<EvidenceTimeline>` component in `mode="live"`, streaming rows with a progress affordance on the active step; no blank/cursor-only state. *Check:* component identity is shared; live mode shows ≥1 progress indicator while running.
7. **Access trace answers the two questions:** From a connection, an owner can see (a) what the client *can* access (grant scope) and (b) what it *did* read (a filtered timeline of `query.*` events with stream + counts). *Check:* the connection page renders both, scoped to that `client_id`.
8. **Shared filter state in URL:** Applying a severity/type/actor facet updates the URL; loading that URL restores the filtered view; free-text search auto-expands and scrolls to matched rows. *Check:* round-trip a filtered URL; jump-to-id highlights the row.
9. **One closed, Datadog-consumable grammar — sourced, not re-coined:** Run detail, access trace, grant history, and the explainer all instantiate the same `<EvidenceTimeline>`, and every `TimelineEvent.type` is a value drawn from the canonical list in `trace-surface-patterns.md` §"Event types PDPP should treat as canonical" (`collection.run.started`, `collection.record.accepted`, `query.received`/`query.responded`, etc.). *Check:* single component import (no per-surface bespoke timeline); a test asserts `TimelineEvent.type ∈` the canonical enum imported from one shared module — and that this note introduces **no** alternate short names (e.g. no `run.started`/`record.deferred` aliasing the canonical `collection.run.started`/proposed `collection.record.deferred`). Any new type (e.g. `collection.record.deferred`) is added to that one source-of-truth list before use.

---

## 7. Sources (URLs + retrieval date 2026-06-18)

- Datadog Trace View — https://docs.datadoghq.com/tracing/trace_explorer/trace_view/ — 2026-06-18
- Datadog Trace Explorer — https://docs.datadoghq.com/tracing/trace_explorer/ — 2026-06-18
- Datadog Correlate Logs and Traces — https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/ — 2026-06-18
- Datadog Log Explorer — https://docs.datadoghq.com/logs/explorer/ — 2026-06-18
- Sentry Breadcrumbs — https://docs.sentry.io/product/issues/issue-details/breadcrumbs/ — 2026-06-18
- Sentry Issue Details — https://docs.sentry.io/product/issues/issue-details/ — 2026-06-18
- Temporal Workflows — https://docs.temporal.io/workflows — 2026-06-18
- Temporal Events reference — https://docs.temporal.io/references/events — 2026-06-18
- Temporal Web UI — https://docs.temporal.io/web-ui — 2026-06-18
- GitHub Actions — Using workflow run logs — https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-workflow-run-logs — 2026-06-18
- GitHub Actions — Viewing workflow run history — https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/viewing-workflow-run-history — 2026-06-18
- GitHub Actions — Visualization graph — https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/monitoring-workflows/using-the-visualization-graph — 2026-06-18
- Linear Activity feed (assign/delegate docs) — https://linear.app/docs/assigning-issues — 2026-06-18
- Linear Collapsed issue history (changelog, dated 2025-04-03) — https://linear.app/changelog/2025-04-03-collapsed-issue-history — 2026-06-18
- (internal) trace-surface-patterns.md — 2026-04-16
