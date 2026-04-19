# Reference Implementation Red-Team Memo

Date: 2026-04-16  
Status: Working memo  
Scope: What the current reference-implementation program plan still misses or overcomplicates after the latest convergence

## Bottom line

The plan is directionally right, but it still smooths over several hard decisions that will reappear in code quickly.

The biggest risk is not “we forgot a feature.” It is that the plan currently assumes a clean separation between:

- native provider
- personal-server polyfill
- CLI
- provider-connect profile
- event/trace spine
- live console

while the inherited substrate still has connector-centric, combined-server, demo-auth assumptions baked into important seams.

If those seams are not made explicit early, the project will look clean in docs and feel muddy in code.

## Main missing decisions

### 1. Is the native provider truly connector-free?

The plan says the same engine can back both:

- native Northstar HR
- personal-server polyfill

That is plausible, but not yet a real decision. The current substrate still treats `connector_id` as a deep organizing object in storage, grant binding, and owner query paths.

If that is not explicitly neutralized, the “native provider” will just be a disguised connector deployment.

Missing decision:

- what exact engine-level abstractions must stop depending on `connector_id` for the native path to be honest?

Implementation trap:

- the docs will say “two realization paths”
- the code will still have one realization path plus a nicer label

### 2. What is the day-one CLI contract?

The plan says the CLI is first-class, but that still hides a real choice:

- owner self-export only
- owner self-export + operator/debug inspection
- full client-connect flow via the companion profile

Those are materially different products.

Missing decision:

- what commands are in scope for day one, and which of them must work without any demo/admin helper endpoints?

Implementation trap:

- “CLI” turns into a pile of scripts over helper-only bootstrap or token-minting routes
- then gets called a reference client even though it is still riding demo backdoors

### 3. What is the actual discovery anchor?

The provider-connect memo is correct about reusing OAuth, but the project plan still papers over one concrete choice:

- RS-first discovery via RFC 9728
- AS-first discovery via RFC 8414
- PDPP-specific well-known metadata only if necessary

That choice affects:

- CLI UX
- example provider docs
- what the reference implementation must expose
- how the native and personal-server deployments advertise themselves

Missing decision:

- what exact discovery flow the reference will prove first

Implementation trap:

- the profile stays “thin” in prose
- but the code quietly accumulates custom assumptions because the first real flow was never pinned down

### 4. What is the truth source: state tables or event spine?

The control-plane plan correctly wants a shared event/trace spine, but it does not yet decide whether that spine is:

- the system of record
- a derived audit/debug projection
- a replay log built from state transitions

That is not a cosmetic decision.

It affects:

- ordering guarantees
- replay semantics
- test assertions
- console implementation
- landing-page trace reuse

Missing decision:

- what authoritative relationship exists between durable state and emitted events

Implementation trap:

- a console gets built over “events”
- tests assert against “state”
- the landing page replays something else
- now three truths exist

### 5. What is the storage seam actually supposed to support?

The plan tries to hold all of these at once:

- SQLite now
- remote adapter later
- serverless-friendly deployment assumptions
- runtime/stateful collection behavior

That is reasonable, but still underspecified.

Missing decision:

- what storage boundaries must be explicit immediately, versus which ones can remain local without architectural regret

Implementation trap:

- “serverless-friendly” becomes a slogan
- but runtime coordination, cursor state, and trace emission still assume local process or local disk behavior

## Main hidden coupling risks

### 1. Combined AS/RS personal-server assumptions leaking into core

The inherited substrate is strongest exactly where it is most opinionated:

- combined AS/RS
- owner-centric ingestion
- connector-oriented storage and lifecycle

That is good for the polyfill path, but dangerous if treated as a neutral protocol core.

Risk:

- the native provider gets implemented as “personal server with nicer seed data”

### 2. Control-plane needs quietly driving engine design

The current docs are good at saying “don’t let the dashboard do this,” but they still assume a dashboard/event spine/scenario registry will exist soon.

Risk:

- instrumentation work arrives before boundary cleanup
- the engine starts emitting whatever the console wants
- the trace model gets optimized for UI cards instead of protocol truth

### 3. Reference-world semantics leaking into protocol seams

Longview, Northstar HR, and the personal server are helpful, but they create another coupling risk:

- compensation streams become the implicit normative test of the protocol
- native-vs-polyfill differences get encoded in world-specific helpers
- the engine starts depending on reference-world fixtures to make sense

Risk:

- the project becomes “the Longview stack” rather than a forkable PDPP reference

### 4. Legacy demo auth routes lingering too long

The plan says these routes should become compat/demo surfaces, which is correct. But it does not yet force a point at which they stop being treated as primary.

Risk:

- new tests and new tooling keep using them because they are convenient
- the replacement path never actually becomes dominant

## Where the plan is overcomplicating

### 1. The event/trace spine may be too early

It is probably right long-term, but it may be one abstraction too far ahead of the current cleanup work.

If request/auth shape, runtime shape, and CLI contract are still in flux, a full event-spine push can become a second architecture project.

Sharper sequence:

- stabilize request/runtime/CLI surfaces first
- then define the minimal event model needed to project them

### 2. “One live substrate, multiple disciplined projections” is correct but still expensive

That sentence is architecturally good and operationally dangerous. It can justify:

- console
- replay system
- scenario registry
- trace capture
- fixture compiler

all before the core seams are truly settled.

Red-team view:

- the project should earn the richer projections by first making one clean runnable substrate and one clean CLI path

### 3. The native-provider world may not need its own early UX

There is a risk of over-building Northstar HR as a product surface instead of using it as a disciplined native deployment of the same engine.

Red-team view:

- prove the native path at the protocol and seed-data level before spending much on provider-specific UI

## Likely implementation traps

### 1. “Reuse the same server with different manifests” sounds simpler than it is

This is probably still the right direction, but only if there is an explicit acceptance test:

- native provider path must work without connector lifecycle assumptions leaking into the request/query path

Without that test, the shared-engine story will be too easy to fake.

### 2. “Thin companion profile” can hide real policy choices

OAuth reuse is right. But thinness does not remove the need to decide:

- whether public native clients are allowed
- whether device flow is required for CLI support
- whether registration is optional, required, or manually approved
- how owner self-export capability is advertised

If these are left soft, the profile will look elegant in docs and ambiguous in code.

### 3. Test harnesses may continue proving the wrong thing

The substrate audit already caught stale collection-profile tests. The bigger risk is that old green tests keep blessing legacy compatibility paths while the new paths remain undertested.

Red-team rule:

- every legacy route should either be explicitly compat-only or lose its privileged place in the tests

## What to tighten next

1. Decide the day-one CLI contract in writing.
2. Decide the first real provider-discovery flow in writing.
3. Define the minimum engine changes required for a connector-free native path.
4. Demote legacy demo auth routes from “still useful” to a clear compat boundary with an exit plan.
5. Delay any rich console work until request/runtime/CLI seams stop moving.
6. Define whether the event/trace spine is authoritative or derived before building consumers on top of it.

## Final judgment

The current plan is strong on direction and still weak on commitment at a few critical seams.

The most dangerous illusion in the current docs is:

- “we already know the architecture; now we just need to execute it”

The actual state is narrower and harsher:

- the architecture is mostly right
- but a small number of unresolved decisions will determine whether the implementation stays forkable and honest or slowly collapses back into a dressed-up MVP stack
