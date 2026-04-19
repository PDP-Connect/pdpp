# Live Reference Surface Recommendation

Date: 2026-04-16  
Status: Working recommendation  
Scope: Competing live-surface models for the PDPP reference implementation

## Purpose

PDPP now needs a serious answer to a different question than the landing page solved:

- not `what is the protocol story?`
- but `what live surface should a real reference implementation expose?`

This memo evaluates competing models for that live surface and recommends the strongest one.

The goal is not to produce a flashy demo shell. The goal is to define a live reference surface that:

- helps implementers understand and run the system
- preserves forkability of the core reference
- keeps the landing page truthful without turning it into an ops console
- supports the reference worlds now in play: native provider, personal-server polyfill, Longview client, and CLI

## Constraints from the repo

The repo already contains several hard-won conclusions:

- `/` should stay an illustrated protocol, not a dashboard.
- the old three-panel demo was useful for debugging but structurally wrong for comprehension.
- the inherited `reference-implementation/` stack is real extracted substrate, not toy sample code.
- the next system shape should be one protocol with two realization paths:
  - native provider
  - personal-server polyfill
- the website must remain downstream of the forkable reference, not in its dependency path.
- a control plane is justified, but only if it does not drive the engine toward demo-only surfaces.

That means the live-surface decision is not just a UX decision. It is an architecture boundary decision.

## Prior-art instincts worth transferring

These are the main instincts that still feel right for this decision:

- `Illustrated TLS`: use one artifact to prove protocol behavior, but do not confuse the illustration with the executable system.
- `Stripe samples + Stripe CLI`: the CLI and sample surfaces should consume the same real APIs, not secret admin paths.
- `Plaid`: the real data model should be the thing the system surfaces, not a separate “demo ontology.”
- `Temporal / Jaeger / Trigger.dev` instinct: state alone is not enough; a serious live system needs a run/timeline/trace view.
- `old PDPP demo failure`: equal-weight actor panels are good for debugging and bad for understanding.

The implication is simple: PDPP needs a live surface, but that surface should be built around state + trace + artifact inspection, not actor theater.

## Evaluation criteria

Any live-surface model should be judged against the following:

1. `Forkability`
   Can another team ignore the website and still fork a strong reference implementation?

2. `Truthfulness`
   Does the surface reflect the real engine and wire contracts rather than demo-only state?

3. `Audience clarity`
   Does it know whether it is for implementers, operators, presenters, or readers?

4. `Narrative fit`
   Can the landing page stay curated without drifting from the live system?

5. `Operational usefulness`
   Can someone actually inspect grants, runs, records, revocation, and errors?

6. `Standards hygiene`
   Does it avoid inventing extra protocol surfaces just to make the UI convenient?

7. `Complexity discipline`
   Does it avoid creating a second product that the team now has to maintain forever?

## Model A: Unified Live Dashboard

### Shape

One primary surface does everything:

- shows topology
- explains the system
- lets the user drive consent and grant flows
- shows records and results
- shows logs/runs/events
- acts as the “live reference”

This is the natural descendant of the old demo instinct.

### Strengths

- One URL feels simple.
- The system can be shown end to end without switching contexts.
- Demo presenters often like a single surface.

### Weaknesses

- It forces one surface to answer incompatible questions:
  - `why should I care?`
  - `what is happening right now?`
  - `what is normative?`
  - `what failed?`
- It almost inevitably becomes actor theater again: client / server / runtime / logs all competing on one canvas.
- It pressures the engine to add demo-only endpoints for convenience.
- It makes the forkable reference harder to separate from the website.
- It recreates the exact failure mode the repo already diagnosed: debugging utility masquerading as reference comprehension.

### What it would optimize for

- presenter convenience
- local “wow, everything is on one screen”

### What it would degrade

- architectural purity
- implementer clarity
- landing-page quality
- long-term maintainability

### Kill criteria

Reject this model if any of the following are true:

- the landing page or website becomes part of the engine dependency path
- the control plane requires private or demo-only APIs the CLI would not also use
- the surface needs separate “modes” to hide its own complexity
- the UI starts expressing actor layout rather than protocol/state/trace layout
- the same page is trying to be landing page, spec index, ops console, and demo shell

### Verdict

Reject.

This is the easiest model to start and the hardest to keep clean. It is exactly the kind of local simplification that would make the reference less forkable and less credible over time.

## Model B: Split Narrative + Live Console over a Shared Event/Trace Spine

### Shape

Two distinct top-level projections over one canonical substrate:

- `Illustrated narrative`
  - remains curated
  - shows the proof chain
  - may replay deterministic traces
- `Live console`
  - stateful and operational
  - shows topology, grants, runs, records, traces, and controls

Both consume:

- one state model
- one identifier scheme
- one scenario registry
- one append-only event/trace spine

### Strengths

- Preserves the current architectural direction of the repo.
- Gives implementers and operators a real system view without contaminating `/`.
- Makes the landing page more truthful, because it can replay or cite real traces rather than inventing its own state.
- Keeps the CLI, tests, console, and illustrated flow aligned around the same underlying objects and events.
- Lets the reference remain forkable:
  - delete website, still have engine
  - delete console, still have engine

### Weaknesses

- Requires discipline: two surfaces are inherently more work than one.
- The event/trace spine becomes a real design responsibility, not an afterthought.
- If the trace model is weak, the two surfaces will still drift.

### What it would optimize for

- architectural cleanliness
- live-system credibility
- future alignment between docs, tests, CLI, and UI

### What it would degrade

- short-term speed compared to a single stitched-together dashboard

### Implementation consequences

This model requires three explicit shared primitives:

1. `Scenario registry`
   Named worlds and flows such as:
   - native Northstar HR grant
   - personal-server polyfill collection run
   - owner self-export
   - revocation after issuance

2. `Canonical identifiers`
   Stable IDs spanning system layers:
   - `scenario_id`
   - `grant_id`
   - `run_id`
   - `client_id`
   - `provider_id`
   - `connector_id` where relevant
   - correlation IDs for request/run/query chains

3. `Event/trace spine`
   Typed append-only events, for example:
   - `request.received`
   - `consent.rendered`
   - `grant.issued`
   - `grant.revoked`
   - `run.started`
   - `record.ingested`
   - `state.advanced`
   - `query.executed`
   - `token.introspected`
   - `error.raised`

### Kill criteria

Reject this model if any of the following become true:

- the trace spine is treated as optional or deferred indefinitely
- the console starts inventing derived objects that are not explainable from the engine state or trace model
- the landing page begins calling live operational APIs directly just to stay “in sync”
- the console becomes a second landing page with explanatory hero copy instead of operational state

### Verdict

Recommend.

This is the strongest model because it preserves the purity of the reference, gives implementers a real operational surface, and creates a truthful bridge between live system and illustrated narrative.

## Model C: Replay-First Reference Surface

### Shape

A single “live reference” surface exists, but it is not actually live-by-default. It is primarily a deterministic replay viewer over recorded traces and fixture state. Live mode, if present at all, is secondary.

This model is closer to:

- protocol filmstrip
- scenario player
- artifact inspector

than to a true console.

### Strengths

- Strong narrative control.
- Very stable for demos, docs, and screenshots.
- Easy to keep beautiful and deterministic.
- Naturally compatible with the illustrated protocol style.

### Weaknesses

- It is not enough for implementers who want to inspect the real running system.
- It risks becoming “clever slideware” unless it is clearly subordinate to a real console or CLI.
- It may produce false confidence if failures, drift, and runtime volatility are hidden by replay.

### What it would optimize for

- narrative fidelity
- deterministic demos
- explainability

### What it would degrade

- operational usefulness
- debugging value
- confidence that the live system really behaves this way now

### Kill criteria

Reject this model as the primary live surface if any of the following are true:

- the replay view becomes the only way to inspect the system
- the replay artifacts are not obviously backed by real engine traces
- implementers cannot inspect current grants, runs, and errors without leaving the replay model entirely

### Verdict

Reject as the primary live surface. Keep as a supporting projection.

This is the right model for the illustrated flow and for stable demo/research playback. It is not enough to serve as the main live reference on its own.

## Model D: Console-First Reference, Website as Thin Shell

### Shape

Make the live console the real center of gravity. The website mostly points to it, lightly wraps it, or explains how to use it. The console becomes the true public face of the reference.

### Strengths

- Keeps effort focused on the real system.
- Minimizes duplicated UI work.
- Makes the reference feel practical and concrete.

### Weaknesses

- Gives up the strongest thing the repo now has: an illustrated protocol that can explain PDPP to mixed audiences.
- Pushes too much cognitive load onto implementers and reviewers immediately.
- Makes PDPP look like a tool suite rather than a protocol with a clear conceptual story.
- Encourages “ops-console as product identity,” which is not the real message of PDPP.

### What it would optimize for

- engineering focus
- operational honesty

### What it would degrade

- communication quality
- persuasion
- standards clarity for non-operators

### Kill criteria

Reject this model if any of the following are true:

- the main public explanation of PDPP now requires console literacy
- the landing page becomes little more than a route hub into internal surfaces
- reviewers cannot understand the protocol without learning the console’s mental model first

### Verdict

Reject.

This model is honest but strategically weak. PDPP needs a live console, but it also needs an explanation layer that is better than “go inspect the system.”

## Recommendation

Choose `Model B: Split Narrative + Live Console over a Shared Event/Trace Spine`.

That gives PDPP the cleanest separation of concerns:

- `/`
  - curated illustrated protocol
  - answers `why does this matter?` and `what is the proof chain?`
- `live console`
  - operational surface
  - answers `what is running now?`, `what happened?`, `what failed?`
- `CLI`
  - scriptable/debug/operator client over the same engine
- `spec/docs`
  - normative definitions and profile boundaries
- `engine`
  - remains forkable without website or console

This is the model most likely to survive contact with real implementation work.

## What the recommended model implies

### 1. The first missing artifact is not the dashboard UI

It is the `shared event/trace spine`.

Without that, the console becomes hand-wired operational state and the landing page remains a separate fiction. With it, both become trustworthy projections of the same engine.

### 2. The console should be built around three views, not many widgets

The strongest operator surface is probably:

- `Topology`
  - native provider, personal server, runtime, Longview, CLI
- `Timeline`
  - append-only events and runs
- `Artifact inspection`
  - request, consent, grant, query result, introspection, runtime state

This avoids slipping back into equal-weight card soup.

### 3. The landing page should consume deterministic traces, not live control APIs

The illustrated flow should stay replay-first and deterministic.

It can later consume:

- captured traces from real scenarios
- canonical specimen state generated from the live engine

But it should not become a live console with hidden polling and operational volatility.

### 4. Docker Compose remains assembly only

Compose should:

- start the native provider
- start the personal server/runtime
- start the CLI-supporting services
- optionally start the console

Compose should not define protocol behavior or become a hidden UX layer.

### 5. Connectors stay loadable, not load-bearing

The console can inspect connectors and runs where they exist, but the live-surface architecture must still make sense when the native provider path has no connectors at all.

That is a critical test of whether the surface is truly PDPP-shaped instead of MVP-shaped.

## Rejected-model summary

### Why not unified dashboard

Because it collapses explanation, operation, and proof into one surface and will almost certainly force demo-driven coupling into the engine.

### Why not replay-first only

Because it is insufficient for implementers and operators who need to inspect the live system and verify failure behavior.

### Why not console-first public reference

Because it sacrifices the strongest explanatory asset the repo has already developed and makes the protocol harder to understand for anyone who is not already in operator mode.

## Practical next step

Implement the live-surface program in this order:

1. define canonical identifiers and scenario registry
2. define and emit the append-only event/trace spine
3. build a minimal console over topology + timeline + artifact inspection
4. make the landing page consume deterministic traces from the same substrate

If this order is not followed, the likely failure mode is predictable:

- a dashboard gets built first
- it invents local state and bespoke endpoints
- the website and engine drift
- the reference becomes harder, not easier, to fork and trust

## Final judgment

PDPP should not have one live surface. It should have one live substrate and two disciplined projections:

- a curated illustrated protocol
- a real operational console

The bridge between them is not shared styling or shared routes. It is shared truth: scenarios, identifiers, and an event/trace spine.
