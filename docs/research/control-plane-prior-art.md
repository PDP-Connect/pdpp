# Control-Plane Prior Art

Date: 2026-04-16

## Bottom line

The best control-plane and orchestration UIs do not try to show "everything" at once. They pick one dominant organizing object, let operators pivot from that object into topology, state, logs, and traces, and keep the live surface tightly coupled to the same APIs and CLI surfaces used by real users and automation.

For PDPP, the strongest pattern is:

- one live control-plane surface for operators and implementers
- one canonical event/trace spine underneath it
- one or two dominant organizing objects, not a soup of cards
- CLI and API parity with the same underlying surfaces
- a separate illustrated marketing/reference flow, fed by the same trace model but not itself a live dashboard

The strongest references here are:

- Temporal for run history, event timelines, and execution-centric debugging
- Dagster for a clear top-level organizing object and health-first graphing
- Trigger.dev for trace-centric run inspection and API parity
- Prefect for control-plane vs infrastructure separation and CLI/UI symmetry
- GitHub Actions for simple dependency visualization and log ergonomics
- Airbyte for connection-centric activity timelines and change/event transparency

## What to study in each product

### Temporal

Temporal is strongest when debugging a single execution. Its UI keeps the workflow execution as the primary object, then lets the operator inspect:

- event history
- timeline
- child workflows
- status counts and visibility search

Why it feels good:

- It treats the append-only event history as the truth source.
- It improves the event timeline instead of layering more dashboard chrome on top.
- It handles large histories as a first-order UX problem, not an afterthought.

Relevant signals:

- Temporal shipped a major Event History timeline refresh specifically for large histories, with filtering, pending/failed views, live updates, pause, and child-workflow inspection in place. Source: <https://temporal.io/change-log/updated-event-history-timeline-view-is-now-available>
- Temporal also surfaces live execution-status counts and quick refresh directly in the workflow list. Source: <https://temporal.io/change-log/ui-server-v2-20-0>

Takeaway:

- If PDPP wants to be production-credible, the control plane needs a real event timeline and execution inspector, not just logs and status pills.
- Temporal is weak as a top-level system topology surface. It is excellent at "what happened inside this execution?" and less opinionated about "what is the whole system doing right now?"

### Dagster

Dagster is the best reference for a control plane built around the wrong primitive being rejected. It did not settle on jobs/runs as the primary view. It made the asset graph the main organizing object because that is what operators actually care about.

Why it feels world-class:

- The UI has a point of view: start from the thing that matters to the operator.
- Health is computed, surfaced, and explorable everywhere.
- Large graphs are treated as a serious product problem; the team invested in graph scaling, virtualization, and selective rendering rather than pretending one giant SVG was fine.
- The graph is customizable enough to serve quick scanning and deep debugging without becoming a toy.

Relevant signals:

- Dagster explicitly positions the UI as the control plane and discusses scaling the graph to 10K+ assets, including virtualization and edge-pruning for readability. Source: <https://dagster.io/blog/scaling-dag-visualization>
- The new Dagster+ UI emphasizes health, freshness, filterable status, and lineage facets rather than generic dashboard KPIs. Source: <https://dagster.io/blog/introducing-the-new-dagster-plus-ui>
- Dagster's own debugging story starts from the asset, not the run, because that is where user pain is perceived. Source: <https://dagster.io/blog/cut-debugging-time-with-dagster>

Takeaway:

- PDPP should choose its dominant object carefully. "Service health" is not enough. "Runs" alone are not enough. The likely candidates are:
  - grant
  - collection run
  - stream
  - provider/client pair
- The top-level PDPP control plane likely needs one dominant object plus one secondary timeline, not a 50/50 split.

### Prefect

Prefect is strongest as an architectural reference for separating the orchestration control plane from user infrastructure while keeping observability coherent.

Why it feels mature:

- It keeps saying the same thing everywhere: your code and data stay in your environment; Prefect manages scheduling, state, and observability.
- It treats events as a first-class substrate. In Prefect, events are not just logs; they power logs, automations, and audit logs.
- It keeps CLI, API, and UI in sync around the same control objects like work pools and runs.

Relevant signals:

- Prefect describes itself as a control/coordination plane and emphasizes that only logs and state updates flow back, not user data. Source: <https://www.prefect.io/how-it-works>
- Prefect's event model is explicit: events are records of activity in the stack and power flow run logs, automations, and audit logs. Source: <https://docs.prefect.io/v3/concepts/events>
- Work pools are a bridge between orchestration and infrastructure, and they are manageable in both UI and CLI. Sources: <https://docs.prefect.io/v3/concepts/work-pools> and <https://docs.prefect.io/v3/how-to-guides/deployment_infra/manage-work-pools>

Takeaway:

- PDPP should be equally explicit about what stays local versus what returns to the control plane.
- The control plane should not become the implementation substrate.
- If PDPP adds a control plane, it should have a clear event model and CLI parity from day one.

### Trigger.dev

Trigger.dev is the strongest reference for making traces first-class in a modern technical product without making the product feel academic or enterprise-heavy.

Why it feels world-class:

- The run page is the product. When you trigger something, you land in an execution surface that shows trace plus logs in real time.
- It uses OpenTelemetry directly and exposes run traces over an API instead of burying them in the UI.
- Realtime behavior is treated as part of the core debugging model, not as an add-on.

Relevant signals:

- Trigger.dev says its dashboard is powered by OpenTelemetry traces and logs, and it auto-correlates logs from parent/subtasks. Source: <https://trigger.dev/docs/how-it-works>
- Trigger.dev exposes `GET /api/v1/runs/{runId}/trace`, returning the full OTel trace tree for a run. Source: <https://trigger.dev/docs/management/runs/retrieve-trace>
- Their observability product page explicitly emphasizes real-time trace view, filtering, and alerts around the run inspector. Source: <https://trigger.dev/product/observability-and-monitoring>

Takeaway:

- PDPP should strongly consider a canonical event/trace API, not just a UI timeline.
- The live control plane should treat traces as exportable, replayable, and consumable by CLI/tests/website.
- Trigger.dev is a good model for making technical truth feel modern rather than bureaucratic.

### GitHub Actions

GitHub Actions is not fancy, but it is a good reference for simple dependency visualization and log ergonomics.

Why it still matters:

- The visualization graph is extremely simple and effective for showing dependency order.
- Logs are directly reachable from nodes in the graph.
- Failed steps are expanded automatically.
- Search, download, permalinks to log lines, and reruns make the operator flow fast.

Relevant signals:

- Every workflow run gets a real-time visualization graph; clicking a job opens its logs. Source: <https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph>
- GitHub's run logs are searchable, downloadable, and line-addressable. Failed steps expand automatically. Source: <https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs>

Takeaway:

- PDPP should not overcomplicate the dependency view. A simple run/actor flow diagram is often enough.
- The operator path from graph node to logs or trace needs to be one click.
- Log sharing and stable anchors matter more than fancy visuals.

### Airbyte

Airbyte is the best reference for connection-centric activity history in a system that mixes orchestration, platform changes, and connector runs.

Why it is useful:

- It moved from "job history" to "timeline," which is the right conceptual move.
- It widened the scope from sync runs only to schema changes, settings changes, connection updates, and user-attributed actions.
- It treats configuration changes as first-class operational events, not invisible admin metadata.

Relevant signals:

- Airbyte replaced the "Job History" tab with a Connection Timeline that includes syncs, refreshes, clears, schema updates, settings changes, and user attribution. Source: <https://airbyte.com/blog/audit-connections-with-the-new-timeline-feature>
- Airbyte also uses notifications for sync completion, schema changes, and auto-disable conditions. Source: <https://support.airbyte.com/hc/en-us/articles/16960944967963-Notification-Types-for-Airbyte-Cloud>

Takeaway:

- PDPP should not limit the event model to collection runs alone.
- Grant issuance, revocation, provider metadata changes, manifest changes, stream availability changes, and operator actions should be part of the same activity timeline.
- Airbyte is a good warning against treating "run history" as sufficient.

## Cross-product surface patterns

### 1. One dominant organizing object

The strongest surfaces pick one primary object:

- Temporal: workflow execution
- Dagster: asset
- Prefect: flow run / work pool / deployment depending on level
- Airbyte: connection
- Trigger.dev: run

Homemade tools fail by making everything equally primary:

- services
- runs
- logs
- alerts
- topology
- config

When everything is primary, nothing has narrative or navigational force.

### 2. Timeline or trace is first-class, not a buried tab

The best surfaces do not bury history:

- Temporal invests heavily in event timeline UX.
- Trigger.dev makes the trace tree part of the main run surface.
- Airbyte promotes a timeline above bare job history.
- Prefect makes events a core substrate, not merely a log sink.

PDPP implication:

- the event spine cannot be an implementation detail
- it should be a primary design object

### 3. Health is computed, not manually interpreted from raw logs

Dagster is best here. It turns materialization history, checks, and freshness into health signals. Airbyte does a smaller version via disabled-connection warnings and timeline events.

PDPP implication:

- grants, runs, streams, and providers need derived health/status, not just raw states
- examples:
  - provider reachable / degraded
  - collection stalled
  - grant valid but provider disconnected
  - sync current / lagging / blocked

### 4. Drill-down paths are short

World-class surfaces make it fast to pivot:

- graph node -> logs
- run -> trace
- asset -> upstream/downstream context
- timeline event -> exact changed object

PDPP implication:

- one click from:
  - grant -> last disclosure event
  - run -> emitted records / state / error
  - stream -> latest records + sync state
  - provider/client -> active grants and recent activity

### 5. CLI and API parity increase seriousness

Prefect, Trigger.dev, and GitHub Actions all reinforce the UI with matching CLI and/or API surfaces.

Why this matters:

- it keeps the UI honest
- it improves automation and testing
- it stops the dashboard from becoming a bespoke snowflake

PDPP implication:

- if the control plane needs a capability, ask whether CLI/tests should need it too
- if the answer is no, that capability may be dashboard-specific bloat

### 6. The control plane is not the data plane

Prefect is clearest on this. Trigger.dev also separates the dashboard from local dev/runtime execution, even while keeping them tightly linked.

PDPP implication:

- the control plane should observe and orchestrate
- it should not silently become the reference implementation's hidden substrate
- Docker Compose should stay assembly, not behavior

## What feels world-class vs homemade

### World-class signals

- A strong dominant object with obvious hierarchy
- A first-class trace or timeline
- Derived health/status, not raw noise
- Good density without visual clutter
- Fast pivot paths from summary to evidence
- Consistent CLI/API/UI object model
- Large-scale behavior is clearly considered
- The surface has a point of view

### Homemade signals

- Three or more equal-weight columns trying to show the whole system
- Card grids with every entity rendered as a generic tile
- Tabs for everything, primary narrative for nothing
- Logs as the only debugging primitive
- No stable event model underneath the UI
- Demo-only endpoints to make the dashboard easy
- Separate state models for website, CLI, and operator UI
- Topology diagrams that are pretty but not operable

## Anti-patterns to avoid for PDPP

### 1. Rebuilding the archived three-panel demo

That pattern is useful for developers but weak for everyone else. It equalizes actors that should not be equalized and forces too much context into one frame.

### 2. Treating the dashboard as a product page

If the control plane starts explaining PDPP from scratch, it will be bad at both explanation and operation.

### 3. Treating logs as the truth source

Logs are not enough. PDPP needs typed events and traces with stable IDs.

### 4. Showing topology without evidence

A nice architecture map without live run, grant, stream, and error drill-down is theater.

### 5. Letting the website define the operator model

The live control plane should come from the engine and event spine. The landing page should consume curated traces later, not dictate the runtime architecture.

### 6. Optimizing only for the happy path

Temporal, GitHub Actions, Trigger.dev, and Airbyte all invest in failure/debugging UX. PDPP needs the same:

- stalled collection
- grant revoked during active polling
- invalid provider metadata
- connector requires interaction
- stream schema drift

## Specific takeaways for PDPP

### 1. Choose two primary objects, not six

My current recommendation:

- top-level primary object: `grant`
- operational primary object: `collection run`

Why:

- the grant is the core PDPP boundary object
- the run is the core Collection Profile execution object

Everything else can hang off those:

- stream health
- provider/client identity
- emitted records
- revocations
- disclosures

Alternative viable top-level object:

- `provider/client relationship`

This may be useful for the native-provider vs personal-server worldview, but it is weaker than `grant` for protocol clarity.

### 2. Build a canonical event/trace spine before a rich dashboard

This is the highest-confidence design lesson from the research.

The spine should include typed events for:

- provider discovered
- request submitted
- consent rendered
- grant issued
- token introspected
- run started
- interaction required / satisfied
- record emitted
- state advanced
- disclosure served
- revoke requested
- revoke applied
- error emitted

Without this spine, the dashboard, CLI, tests, and illustrated flow will drift.

### 3. Use a layered surface model

Recommended PDPP surfaces:

- `Control plane home`
  - current grants
  - active runs
  - recent failures
  - provider/client status
- `Grant detail`
  - request
  - consent projection
  - current status
  - disclosure history
  - linked runs
- `Run detail`
  - event timeline
  - logs
  - interactions
  - state snapshots
  - emitted records summary
- `Topology`
  - Northstar HR
  - personal server
  - Longview
  - runtime
  - CLI
  - with live health and links into detail views

### 4. Make CLI parity a hard rule

The control plane should not have magic powers that the CLI and tests cannot reach.

Day-one CLI scope should cover:

- provider discovery
- owner self-export
- grant listing and inspection
- run listing and inspection
- trace retrieval
- scenario reset / seed

### 5. Keep the illustrated landing page separate

The research does not support collapsing the live control plane into `/`.

What it does support:

- the live control plane and landing page can share the same event spine
- the landing page can replay curated traces captured from the live system
- the control plane remains a technical surface with higher density and less narrative

### 6. Prefer timeline over raw "job history"

Airbyte's move here is exactly right for PDPP.

PDPP should likely use:

- `activity timeline`

instead of:

- `run history`

because PDPP activity includes more than runs:

- grants
- disclosures
- revocations
- manifest/provider changes
- connector and interaction events

### 7. Treat performance and scale as part of the design

Dagster and Temporal both made scaling/volume a UX problem worth solving explicitly.

PDPP should assume:

- long timelines
- many runs
- many streams
- many grants
- bursts of collection activity

This affects:

- event model
- filtering
- virtualization
- query APIs
- log retention
- trace pagination

## Recommendation

PDPP should not build a generic "system dashboard" first.

It should build, in this order:

1. A canonical event/trace spine with stable identifiers and typed events
2. A CLI and API that consume that spine and the same core objects
3. A live control plane centered on grants and runs, with timeline-first debugging
4. A curated illustrated flow that replays traces from the same system

The design target is not "a dashboard that shows everything together."

The design target is:

- a forkable reference implementation
- a serious operator surface
- a truthful illustrated narrative

all sharing the same underlying truth model.

## Sources

- Temporal UI changelog: <https://temporal.io/change-log/updated-event-history-timeline-view-is-now-available>
- Temporal UI status counts: <https://temporal.io/change-log/ui-server-v2-20-0>
- Dagster+ UI: <https://dagster.io/blog/introducing-the-new-dagster-plus-ui>
- Dagster graph scaling: <https://dagster.io/blog/scaling-dag-visualization>
- Dagster debugging: <https://dagster.io/blog/cut-debugging-time-with-dagster>
- Prefect events: <https://docs.prefect.io/v3/concepts/events>
- Prefect work pools: <https://docs.prefect.io/v3/concepts/work-pools>
- Prefect work-pool management: <https://docs.prefect.io/v3/how-to-guides/deployment_infra/manage-work-pools>
- Prefect architecture: <https://www.prefect.io/how-it-works>
- Trigger.dev how it works: <https://trigger.dev/docs/how-it-works>
- Trigger.dev run trace API: <https://trigger.dev/docs/management/runs/retrieve-trace>
- Trigger.dev observability: <https://trigger.dev/product/observability-and-monitoring>
- GitHub Actions visualization graph: <https://docs.github.com/en/actions/how-tos/monitor-workflows/use-the-visualization-graph>
- GitHub Actions run logs: <https://docs.github.com/en/actions/how-tos/monitor-workflows/use-workflow-run-logs>
- Airbyte Connection Timeline: <https://airbyte.com/blog/audit-connections-with-the-new-timeline-feature>
- Airbyte notifications and sync-disable behavior: <https://support.airbyte.com/hc/en-us/articles/16960944967963-Notification-Types-for-Airbyte-Cloud>
