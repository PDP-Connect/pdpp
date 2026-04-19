# PDPP Control Plane Information Architecture

**Date:** 2026-04-16  
**Status:** Recommended IA for the live console above the reference engine

## Bottom line

The PDPP control plane should be a **separate operator console** over the reference engine, not a mode of the website and not a generic dashboard.

Its job is to answer:

- what is running right now?
- what happened recently?
- what failed and why?
- which exact request, grant, run, query, or artifact should I inspect next?

The cleanest IA is:

- one **overview** for current state
- one **activity/timeline** surface for the canonical event spine
- one **object inspector** model used consistently across requests, grants, queries, runs, and exports
- one **topology** view for system shape and health
- one **scenario/control** surface for seed/reset/replay actions

Everything else should be a projection of the canonical state model and the canonical event/trace spine.

---

## Audience

Primary audiences:

- implementers trying to understand or fork the reference
- operators/presenters running the stack locally or in demo mode
- protocol authors verifying that live behavior matches the spec
- test/conformance authors inspecting exact object state and event order

Secondary audiences:

- advanced reviewers who want evidence behind the illustrated landing page

Not the primary audience:

- general prospects
- first-time readers trying to learn what PDPP is

That is why the control plane should stay separate from `/`.

---

## Design constraints

The IA should preserve four boundaries:

1. The control plane is a **consumer** of the reference engine, not part of the protocol core.
2. The control plane should not require website-specific APIs or state.
3. The control plane should not invent demo-only objects; it should project canonical ones.
4. The control plane should remain useful even if an implementer forks the engine and discards the website entirely.

Practical implication:

- the console should live as a sibling operator surface, not as a sub-mode of the public landing page
- every screen should be explainable in terms of canonical objects and canonical events

---

## Dominant objects

The console should be organized around the objects that actually matter in PDPP:

- `request`
- `grant`
- `query`
- `collection run`
- `owner export`
- `interaction`
- `stream`
- `provider`
- `client`
- `scenario`

These are not equal in importance.

The dominant operational objects are:

- `grant`
- `collection run`
- `query`

The dominant narrative objects are:

- `request`
- `grant`
- `query`

The dominant infrastructural objects are:

- `provider`
- `runtime`
- `scenario`

The IA should therefore avoid a flat “all entities are peers” navigation model.

---

## Recommended navigation model

Use a **task-oriented primary nav** plus **object-oriented secondary navigation**.

Primary navigation:

- `Overview`
- `Activity`
- `Objects`
- `Topology`
- `Scenarios`

Secondary navigation inside `Objects`:

- `Requests`
- `Grants`
- `Queries`
- `Runs`
- `Exports`
- `Streams`
- `Clients`
- `Providers`

Why this model:

- operators first need a global answer to “what is happening?”
- then they need a way to inspect the event spine
- then they need exact object lists and detail pages
- topology and scenario control are important, but they are support surfaces, not the center of gravity

Do not use:

- a service-by-service primary nav
- a connector-by-connector primary nav
- a giant left rail exposing every table as a first-class destination

That would read like an internal admin tool, not a well-composed reference console.

---

## Minimum viable top-level views

### 1. Overview

Purpose:

- answer the current-state questions quickly

Must show:

- active grants
- active collection runs
- recent queries
- recent failures
- provider/runtime health summary
- currently selected scenario/world

Should feel like:

- one operational briefing page

Should not become:

- a card soup dashboard with every subsystem competing equally for attention

Recommended layout:

- top summary strip: scenario, services, active objects, failing objects
- center column: “attention needed” and “recently changed”
- side column: active runs and active grants

The Overview should be useful at a glance, but it should route users quickly into object or timeline detail.

### 2. Activity

Purpose:

- provide the authoritative event/trace history view

This is the most important screen after Overview.

Must show:

- the canonical event spine
- filters for type/status/object/provider/scenario
- event groups for request/grant/query/run lifecycles
- drilldown into the selected event/span

Recommended default:

- left: event/timeline hierarchy
- right: selected item inspector

This should be the home for:

- exact event order
- wait/retry visibility
- causal links
- artifact pointers

### 3. Objects

Purpose:

- provide exact lists and detail pages for canonical PDPP objects

This is where users go when they know what they are looking for:

- a specific grant
- a specific run
- a specific query

Minimum list views:

- grants
- runs
- queries
- requests

Minimum detail pages:

- grant detail
- run detail
- query detail

The same artifact-inspection model should appear on each detail page.

### 4. Topology

Purpose:

- show which systems exist, how they relate, and whether they are healthy

Must show:

- Longview client
- CLI
- native provider
- personal-server polyfill
- runtime/connectors when present

Recommended representation:

- a simple architecture map with health/status badges and selected-node inspection

This view should answer:

- what realization paths are currently active?
- which services exist in this scenario?
- what is degraded, unavailable, or idle?

It should not try to be the primary debugging surface. The event spine remains the truth source.

### 5. Scenarios

Purpose:

- manage repeatable reference-world state and demo/test flows

Must show:

- current scenario/world
- available scenarios
- seed/reset/replay controls
- whether the current state matches the expected fixture

This view should absorb:

- demo reset controls
- reference-world switching
- replay actions

Those controls should not be scattered through Overview or Topology.

---

## Artifact inspection model

The control plane needs one consistent inspection grammar for every object.

Every detail page and every selected timeline item should expose:

- `Summary`
  - id
  - status
  - timestamps
  - related objects

- `Artifacts`
  - exact protocol payloads and rendered surfaces

- `History`
  - the relevant slice of the event spine for that object

- `Relations`
  - linked request/grant/query/run/export/provider/client records

For the main object types, that means:

- `Request`
  - selection request payload
  - client metadata
  - resulting consent and grant links

- `Grant`
  - issued snapshot
  - lifecycle history
  - revocation state
  - related requests, queries, and runs

- `Query`
  - query payload
  - introspection result
  - projection result / response artifact

- `Run`
  - START / INTERACTION / RECORD / STATE / DONE artifacts
  - retries, waits, and failures
  - related stream and grant context

- `Export`
  - owner request
  - response artifacts
  - related CLI invocation if any

This is the most important non-negotiable rule:

> every interesting timeline item must be able to open the exact protocol artifact behind it.

Without that, the console becomes a telemetry viewer instead of a reference implementation surface.

---

## Relationship to the event / trace spine

The event/trace spine is the canonical execution history.

The IA should treat it as:

- the source of truth for Activity
- the shared historical substrate for Overview summaries
- the history source on object detail pages
- the replay source for Scenarios

It should not be:

- one view among many unrelated views
- a log stream parallel to object detail pages
- optional infrastructure hidden behind the console

Concretely:

- Overview widgets should be derived from current state projections plus recent slices of the spine
- object detail pages should show the object plus its relevant spine slice
- the illustrated landing page should be able to replay curated traces from the same spine

That keeps the console, tests, CLI, and illustrated flow aligned.

---

## Recommended topology view

The topology view should be intentionally small and legible.

Show:

- clients
- PDPP protocol surfaces
- native provider
- personal server
- runtime/connectors when present

Represent:

- nodes by role
- edges by interaction type
- status by health/state badge

Suggested node groups:

- `Consumers`
  - Longview
  - CLI

- `Protocol surfaces`
  - AS
  - RS

- `Realizations`
  - Northstar HR
  - personal server

- `Fulfillment`
  - runtime
  - connectors/imports

Selecting a node should show:

- role
- status
- recent events
- linked objects
- relevant endpoints or surfaces

Do not overload this with:

- low-level infrastructure
- container internals
- raw Compose details

Compose is assembly, not the console’s primary ontology.

---

## Recommended timeline view

The timeline view should combine:

- Temporal-style exact event history
- Inngest-style left/right detail layout
- Jaeger/Grafana-style duration and causality cues

Default structure:

- `Filter bar`
  - scenario
  - object type
  - status
  - provider/client
  - text/id search

- `Timeline pane`
  - grouped event history
  - waterfall bars where duration matters
  - retries/waits visible
  - live update mode

- `Inspector pane`
  - selected event/span summary
  - exact artifact
  - related object links
  - causal links and nearby events

Important behaviors:

- pending and failed-only filters
- pause live updates
- focus on one object or one trace
- jump from object detail -> relevant timeline slice
- jump from timeline item -> object detail

The view should support both:

- raw event order
- grouped semantic phases such as request -> grant -> query, or run -> interaction -> record -> state -> done

---

## Navigation and URL model

The console should support deep linking and direct inspection.

Recommended path shape:

- `/console`
- `/console/activity`
- `/console/activity?scenario=...&object=grant:...`
- `/console/objects/grants`
- `/console/objects/grants/:grantId`
- `/console/objects/runs/:runId`
- `/console/topology`
- `/console/scenarios`

The path model matters because:

- presenters need stable links
- tests may need deterministic URLs
- docs can point to exact live surfaces

This also helps keep the console independent from the website’s storytelling routes.

---

## Explicit anti-patterns to avoid

### 1. Recreating the old three-panel demo

Do not return to a theater-style simultaneous view of client, server, and connector panels.

Why:

- too much equal-weight information
- weak task orientation
- poor deep inspection

### 2. Card soup overview

Do not make Overview a mosaic of unrelated cards.

Why:

- no clear reading order
- hard to know where to click next
- hides the event spine under decorative summaries

### 3. Service map as primary debugger

Topology is a support view, not the center of the IA.

Why:

- topology explains shape, not history
- failures and causality are easier to understand in the timeline

### 4. Separate event model for the console

Do not invent console-only events or state transitions.

Why:

- breaks alignment with tests, CLI, and illustrated flow

### 5. Artifact-less history

Do not show timeline rows that cannot open their underlying request/grant/query/run artifact.

Why:

- operator surfaces become shallow
- the reference loses evidentiary value

### 6. Website coupling

Do not make the console depend on website-specific components, routes, or state.

Why:

- harms forkability
- makes the reference engine less clean

### 7. Dashboard-only controls

Do not add privileged actions that exist only for the console unless they are also justified for CLI/tests/scenario control.

Why:

- encourages hidden control-plane APIs
- bloats the engine for demo convenience

---

## Practical recommendation

Build the control plane as a small operator console with five primary destinations:

1. `Overview`
2. `Activity`
3. `Objects`
4. `Topology`
5. `Scenarios`

Make `Activity` and object detail pages the real center of gravity.

Use one consistent inspection model everywhere:

- summary
- artifacts
- history
- relations

Derive everything from:

- canonical object state
- canonical event/trace spine

Keep the website separate, but let it replay curated traces from the same spine later.

That gives PDPP:

- a usable operator surface
- a strong live reference
- a clean separation from the marketing site
- a forkable architecture another team could adopt without inheriting product goo
