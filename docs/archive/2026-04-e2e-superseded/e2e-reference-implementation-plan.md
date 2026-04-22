# E2E Reference Implementation Plan

Status note: historical working plan. The active canonical program tracker now lives in `openspec/changes/reference-implementation-program/`.

Date: 2026-04-16  
Status: Working plan for the next focused implementation pass

## Why this plan exists

The current `e2e/` stack is already a meaningful protocol implementation, but it is split across three maturity levels:

- a fairly strong AS/RS enforcement core
- a materially improved Collection Profile/runtime contract that is no longer the main source of drift
- a still partially stale web demo/docs wrapper and some remaining auth/native-boundary seams

The goal of the next few hours is not to make the reference implementation bigger. It is to make it **more complete at the protocol seams** while keeping it narrow enough that another team could read it as a clean reference rather than a kitchen-sink product.

This plan defines what “production-credible” and “pure reference” should mean for PDPP.

It also treats the current `e2e/` stack honestly: it is not greenfield sample code. It was forked from a real Vana/OpenDataLabs MVP stack that existed before PDPP was conceptualized, then partially re-shaped to prove PDPP semantics.

---

## What “production-credible but pure” means here

### Production-credible

The reference implementation should:

- use real persistence, not in-memory state only
- exercise real wire contracts, not UI-only simulations
- expose a real CLI path for owner access and debugging
- prove the privacy-sensitive properties with tests
- keep the demo topology plausible for an actual deployment
- remain deployable on stateless/serverless compute from the application’s point of view

### Pure reference

The reference implementation should **not** become a speculative product platform.

It should:

- implement only the protocol surfaces another team would need to copy
- keep deployment-specific behavior clearly labeled as reference architecture
- avoid adding convenience APIs that bypass the protocol model
- avoid orchestrator/product features unless they teach a protocol boundary
- prefer one strong “golden path” over configurable abstraction layers

### Deployment discipline

The reference should assume:

- local Docker Compose is excellent for development, CI, and publishing a runnable system
- production-oriented deployments may run on serverless/stateless compute such as Vercel-style environments
- application instances should therefore avoid relying on in-process memory, sticky sessions, or local disk semantics as the normative model

Applied here:

- durable state should live behind explicit persistence seams
- ephemeral coordination state should be pushable into external stores such as a remote database, Redis, or object storage
- local SQLite is acceptable as the first adapter, but only if it is not baked so deeply into the runtime model that a remote adapter becomes architectural surgery later

The goal is not to build a giant storage abstraction layer up front. The goal is to keep storage assumptions narrow, explicit, and swappable.

### Standards discipline

The reference project should not duplicate standards text or invent “PDPP versions” of already-solved OAuth problems.

Default rule:

- reuse existing standards by reference when they already solve the problem
- define a PDPP profile only for the missing integration glue
- keep PDPP-original surface area narrow, legible, and justified by an actual interoperability gap

Applied here:

- use OAuth bearer-token presentation, PKCE, device flow, metadata discovery, and client metadata standards directly where possible
- add only the PDPP-specific pieces needed for “connect to your PDPP provider” interoperability

### Surface discipline

The reference project should also avoid collapsing all audiences into one app shell.

Default rule:

- the forkable engine is the thing another implementer should be able to clone and use
- the CLI is a first-class real consumer of that engine
- the control plane is optional operator tooling over the same surfaces
- the website is a downstream explainer and replay surface, not part of the engine dependency path

Applied here:

- `/` remains a curated illustrated protocol surface
- the live console, if built, is a separate operator/implementer surface
- `apps/web` must never become required runtime infrastructure for the reference
- any capability added “for the dashboard” is suspect unless the CLI and tests also legitimately need it

### Working standard

If a standards reviewer or a new implementer asks “what code should I read to understand how PDPP works end to end?”, the answer should be:

- `e2e/server/` for AS/RS behavior
- `e2e/runtime/` for Collection Profile behavior
- `e2e/client/` and `e2e/cli/` for consumer behavior
- `e2e/test/` for the properties the implementation claims to prove

Anything else should be secondary.

---

## Provenance and extraction doctrine

The current `e2e/` implementation should be treated as a **real extracted substrate**, not as a toy demo that happens to pass tests.

That matters because it already contains two different kinds of value:

- **durable protocol substrate** extracted from actual product pressure
- **legacy MVP dialect** that reflects pre-PDPP Vana assumptions and should not be mistaken for the standard

The project is therefore not “rewrite the E2E stack until it looks spec-shaped.”

It is:

- preserve the parts that already proved the right protocol instincts under real usage
- isolate and remove the inherited Vana/OpenDataLabs-specific assumptions
- re-express the system so another implementer can read it as PDPP rather than as “the Vana stack with comments”

### The durable substrate we should preserve

These are not accidents; they are the best evidence that the reference is grounded in a real use case:

- owner-authenticated ingest and state management
- a combined AS/RS deployment that is plausible for personal-server realization
- SQLite-backed record storage with explicit version history
- projection-aware `changes_since` behavior and tombstones
- real connector manifests and real connector/runtime plumbing
- concrete connector worlds (`spotify`, `github`, `reddit`) that came from real MVP integration pressure

### The inherited dialect we should extract away

These are the places where the code still speaks “pre-PDPP Vana” rather than “clean PDPP reference”:

- a recently removed compat `/grants/initiate` wrapper and `/consent/:deviceCode/*` layer that previously sat around the newer `/oauth/par` + `request_uri` consent-start seam
- demo-first consent/device-code wrapper treated as the main AS surface
- connector-centric request language where the current spec wants clearer separation between selection request, grant, runtime scope, and fulfillment path
- older Collection Profile START/state semantics
- implied Vana-specific auth mapping (`session_token`, `Web3Signed`, session relay) that should inform profiles but not leak into core reference behavior

### Extraction rule

Before adding new E2E features, ask:

1. Is this behavior already present in the inherited substrate and worth preserving?
2. Is it Vana/OpenDataLabs-specific and therefore something to isolate behind a profile or reference wrapper?
3. Is it actually missing from the substrate and therefore a true new implementation task?

That discipline should keep us from both over-rewriting and over-preserving.

---

## What the existing E2E stack already proves

The current plan should assume these are already substantial wins, not future aspirations:

- the RS enforcement core is real enough to test
- owner self-export is already a live pattern, not a speculative one
- the record model is already built around stream-scoped storage plus version history
- the current runtime already proves that collection can be treated as a bounded execution environment instead of being collapsed into the query path

So the next project phase is **not** “make the E2E stack real.”

It is:

- make the interfaces cleaner
- make the realization paths clearer
- make the auth/discovery/profile boundaries more standards-legible
- make the visible topology match what the code already substantively is

---

## Prior art and how to apply it

PDPP is unusual because it wants one artifact to be:

- an educational walkthrough
- a standards reference
- a real implementation

No single prior-art example does all three, but several clarify the target.

### 1. Illustrated TLS

Use for:

- “one artifact that shows the protocol running”
- intuition + raw artifacts + verification in one place

Apply to PDPP:

- every key E2E claim should have an inspectable artifact and a test
- the reference should prove behavior, not just describe it

Do not copy:

- static educational-only framing

PDPP must still be executable code, not just a narrated transcript.

### 2. Stripe samples + Stripe CLI

Use for:

- a small number of sample systems that consume the same public surfaces as real users
- a CLI that talks to the same APIs rather than to a hidden private control plane

Apply to PDPP:

- the CLI should consume standard owner-authenticated RS endpoints for self-export
- where the AS flow is deployment-specific, the CLI may wrap the reference AS, but must not pretend that wrapper is a core PDPP interface

### 3. Plaid Link / directed-graph precedent

Use for:

- the system’s actual data model being the thing that gets visualized and demonstrated

Apply to PDPP:

- the native HR platform, personal server, Longview client, and CLI should all operate on the same concrete streams and grants
- no separate “demo-only” data model

### 4. OAuth / FAPI conformance culture

Use for:

- clear separation between core protocol, profiles, and conformance harnesses

Apply to PDPP:

- core RS behavior should be tested directly
- Collection Profile behavior should be tested directly
- deployment-specific auth UX should be explicitly labeled as reference architecture, not silently treated as normative core
- auth/discovery gaps should be filled with a companion profile that composes existing OAuth RFCs rather than rewriting them

### 5. C4-style zoom discipline

Use for:

- keeping architecture views at one level at a time

Apply to PDPP:

- the E2E reference should pick one concrete topology and make it rigorous
- avoid mixing “all possible deployment models” into one code path

### 6. Control-plane and trace-surface prior art

Use for:

- choosing the right dominant objects for a live console
- deciding whether runs, grants, streams, or topology should organize the operator surface
- preventing the old equal-weight actor-panel demo from reappearing in a shinier form

Apply to PDPP:

- build one canonical append-only event/trace spine before building a rich dashboard
- keep the live console centered on a small number of protocol-native objects, not a card soup of everything
- treat the timeline as a first-class design object rather than burying it under logs
- let the illustrated flow replay deterministic traces from the same substrate rather than calling live operational APIs directly

### 7. Reference-implementation UX prior art

Use for:

- keeping docs, CLI, sample worlds, and runnable substrate separate but coordinated
- making the reference implementation obviously forkable

Apply to PDPP:

- keep the runnable reference in `e2e/`
- keep sample worlds narrow, concrete, and replaceable
- document the forkability boundary explicitly instead of assuming readers will infer it
- treat Docker Compose as assembly only, not as protocol surface or hidden control plane

---

## The target topology

The E2E reference should showcase **two realization paths** feeding one client-facing protocol model.

### A. Native platform: Gusto-like HR provider

Working name for implementation: `Northstar HR`  
This is a cooperating platform that supports PDPP natively.

It should act as:

- Authorization Server
- Resource Server

It should expose HR-adjacent streams such as:

- `pay_statements`
- `equity_grants`
- `benefits_enrollments`

Its role in the reference is to prove:

- native PDPP support is possible and desirable
- the platform can expose self-export via owner-authenticated RS endpoints
- the same Longview client can request data from a native platform without any scraper/runtime story

### B. Personal server: polyfill for non-native sources

This is the existing personal-server-style deployment:

- AS + RS + runtime co-located
- collects from non-native sources through connectors, imports, or push adapters

Its role in the reference is to prove:

- the same grant and enforcement model works when the source does not support PDPP
- collection is a realization path, not the ontology
- Collection Profile behavior is real and testable

### C. Longview client application

Longview remains the canonical client app.

Its role in the reference is to prove:

- the client sends a concrete data-access request
- the server issues a grant
- the client receives only the granted fields
- the same client can work against both native and polyfilled realizations

### D. CLI

The CLI should be a first-class part of the reference, not an afterthought.

It should support:

- owner-authenticated self-export against a PDPP RS
- listing streams available under owner access
- querying records from a stream
- optional debug commands for inspecting grants, revocation, and changes_since

Important boundary:

- **Yes**, PDPP core already supports an API a CLI can consume for self-export. `spec-core.md` explicitly allows owner-authenticated use of the standard RS query endpoints without a client grant.
- **No**, PDPP core does not yet normatively specify the full AS / user-consent HTTP interface end to end. The selection-request semantics are real, but the exact deployment flow remains profile/reference territory. The CLI may support the reference AS flow for development and debugging, but that should remain clearly labeled as reference/deployment-specific.

---

## The architectural principle

### One protocol, two realization paths

The E2E reference should make this visible in code:

- Native platform path:
  - Longview requests access from `Northstar HR`
  - `Northstar HR` issues a grant and serves records directly

- Polyfill path:
  - Longview requests access from the personal server
  - personal server fulfills reads from pre-collected data or triggers collection when needed

Both paths should converge on:

- the same grant model
- the same RS query semantics
- the same field projection and incremental sync behavior

This is the cleanest way to show that PDPP is bigger than the personal server without pretending the polyfill story does not matter.

### One live substrate, multiple disciplined projections

The reference should not have one super-surface that tries to be:

- landing page
- operator console
- runtime debugger
- docs site
- sample app shell

Instead it should have:

- one forkable engine substrate
- one shared scenario registry and identifier model
- one append-only event/trace spine
- multiple projections over that substrate:
  - curated illustrated narrative
  - live operator console
  - CLI
  - docs/spec references

This is the cleanest way to preserve forkability while still making the whole system explorable.

### Dominant organizing objects

The best current recommendation from the research is:

- top-level PDPP object: `grant`
- top-level Collection Profile object: `collection run`

Everything else should hang off those:

- provider/client relationship
- stream health
- emitted records
- revocations
- disclosures
- runtime interactions

This is much stronger than reviving the old “client / server / runtime” equal-weight actor layout.

---

## Scope for the next few hours

This pass should focus on the **minimum set of changes** that make the reference implementation feel complete at the protocol boundaries.

### In scope

1. Bring the `e2e/` request model closer to current core semantics.
2. Bring the runtime START / INTERACTION / state behavior closer to current Collection Profile semantics.
3. Add a real CLI surface for owner self-export and inspection.
4. Add a native HR platform realization to the E2E world.
5. Define the missing auth/discovery companion profile for “connect to your PDPP provider”.
6. Prototype that profile in the reference implementation where feasible.
7. Define the shared event/trace spine and scenario registry that both console and illustrated flow can consume.
8. Make the E2E docs explain the actual topology and artifact set.
9. Expand tests to cover the new claims.

### Out of scope

1. A full production auth product.
2. A generalized SDK.
3. Multi-tenant SaaS concerns.
4. A registry/discovery ecosystem.
5. A full browser-automation connector rewrite.
6. Rewriting OAuth standards in PDPP-specific language when the OAuth RFCs can be referenced directly.
7. New speculative protocol surface unless implementation pressure clearly demands it.
8. A single all-in-one dashboard that tries to be docs site, demo shell, operator console, and runtime UI.
9. Website-driven runtime coupling.

---

## Current gaps to close

These are the specific gaps this plan is trying to close.

Important framing:

- some “gaps” are true protocol incompleteness
- some are cases where the inherited MVP substrate is stronger than the visible reference framing
- some are places where the code still exposes legacy Vana/OpenDataLabs dialect at the boundary

### Gap 1: Request model drift

Current `e2e/server/auth.js` still accepts a flat grant-initiation request shape.

Needed outcome:

- the reference should exercise the current PDPP request semantics more faithfully
- if the AS interface remains deployment-specific, the implementation should still model the **selection request** clearly and preserve the right data shape internally

### Gap 2: Collection Profile drift

Current runtime still uses an older START shape:

- `config` instead of `scope`
- no grant-scoped state path
- stale interaction field names in tests

Needed outcome:

- START carries normalized `scope`
- `continuous` runs can use grant-scoped state
- tests assert the current message model, not a stale one

### Gap 3: Native realization path missing

Right now the reference implementation mostly proves the personal-server path.

Needed outcome:

- add a cooperating native platform world
- make it concrete enough that Longview can query it and a CLI can self-export from it

### Gap 4: CLI path is implied, not productized

The specs and examples already imply a CLI-worthy owner path, but the reference implementation does not yet present one cleanly.

Needed outcome:

- a CLI that consumes the standard RS API directly
- not a hidden admin script

### Gap 5: E2E docs are empty or stale

Needed outcome:

- one good `e2e/` overview doc
- one topology diagram / narrative
- one statement of what is normative vs reference architecture

### Gap 6: Generic provider-connect flow is underspecified

PDPP currently gives a strong RS model and real selection-request semantics, but not a turnkey “connect to any PDPP provider” profile for CLI/native clients.

Needed outcome:

- a companion auth/discovery profile that says exactly what a generic PDPP client can assume
- heavy reuse of OAuth standards by reference rather than a forked PDPP auth spec
- a reference implementation path that proves the profile is sufficient

### Gap 7: Live surface has no shared truth model

Right now there is no canonical substrate that all of these could consume cleanly:

- control plane
- CLI inspection
- tests
- illustrated landing-page replay

Needed outcome:

- one append-only event/trace spine with stable identifiers
- one scenario registry for deterministic flows
- one clear distinction between:
  - engine state
  - operational event history
  - curated replay/projection

Without this, any dashboard or replay surface will drift from the real system.

---

## Implementation phases

### Phase 0: Freeze the shape before writing code

Outcome:

- one target topology
- one native platform world
- one personal-server world
- one client
- one CLI
- one explicit extraction map: preserve vs isolate vs replace

Tasks:

1. Audit the existing `e2e/` substrate by file and classify each major surface as:
   - preserve as durable protocol substrate
   - isolate as legacy Vana/OpenDataLabs dialect
   - replace because it is actually stale relative to current spec
2. Settle the working native-platform brand and stream set.
3. Decide whether the native platform reuses the current `e2e/server` codebase with a different manifest and auth mode, or whether it is a distinct server instance with the same RS behavior.
4. Decide what the CLI must do on day one.
5. Decide the canonical identifiers and scenario names the rest of the system will use.
6. Identify which current state assumptions rely on process-local memory or local-disk semantics and need an explicit seam.

Recommendation:

- Reuse the existing `e2e/server` implementation as the protocol engine.
- Represent “native platform” vs “personal server” as **two deployments with different manifests, auth wrappers, and fulfillment paths**, not as two entirely different codebases.

Reason:

- that keeps the reference implementation focused on protocol behavior instead of duplicating server logic
- and it respects the fact that the current server/runtime already came from a real product substrate
- and it keeps the codebase closer to serverless-friendly deployment assumptions later

### Phase 1: Native reference world

Outcome:

- a Gusto-like native platform exists in the E2E world

Tasks:

1. Add a native HR manifest with:
   - `pay_statements`
   - `equity_grants`
   - `benefits_enrollments`
2. Seed realistic HR records.
3. Add Longview request examples against this platform.
4. Add owner self-export examples against this platform.

Acceptance criteria:

- Longview can request pay-statement fields from the native HR platform.
- Owner token can list and fetch those streams directly.
- Projection, revocation, and `changes_since` all work on at least one HR stream.

### Phase 2: Request-model convergence

Outcome:

- the reference code stops teaching a stale request shape

Tasks:

1. Introduce an internal selection-request object that mirrors current core semantics:
   - `client_display`
   - `authorization_details`
   - `client_claims`
   - `purpose_code`
   - `purpose_description`
   - `access_mode`
   - `streams` / `profile`
2. Keep the reference AS HTTP endpoint pragmatic if needed, but make the object model and examples current.
3. Update tests and demo artifacts to use the current request shape.

Acceptance criteria:

- there is no ambiguity about what the current PDPP request model is
- the code and tests no longer center the old flat request shape as the main example

Important boundary:

- this does **not** require pretending core PDPP has fully standardized AS flows
- it requires the reference to carry the right request semantics cleanly

### Phase 2.5: Auth/discovery companion profile

Outcome:

- a CLI or native app implementer can understand what it takes to support “connect to your PDPP provider”

Tasks:

1. Define the smallest profile that makes generic provider connectivity possible.
2. Reuse existing OAuth standards by reference wherever possible:
   - OAuth 2.1 / authorization code + PKCE for native apps where appropriate
   - RFC 8628 device authorization grant for CLI/device flows where appropriate
   - RFC 8414 authorization-server metadata discovery
   - RFC 7591 client metadata model and, if useful, dynamic registration
   - RFC 9396 for PDPP selection requests via `authorization_details`
3. Define only the PDPP-specific glue that OAuth does not already cover.
4. Decide whether PDPP needs:
   - a `/.well-known/pdpp` document
   - a provider metadata document that links RS + AS surfaces
   - explicit requirements around owner-token acquisition for self-export
5. Write the profile as a companion doc, not as a core-spec rewrite.

Acceptance criteria:

- the profile states what a generic CLI/client can assume without bespoke provider coordination
- the profile references OAuth RFCs directly instead of restating them
- the remaining PDPP-specific additions are small and clearly justified

Design principle:

- if the answer is “OAuth already solves this,” PDPP should cite it, not clone it
- if the answer is “OAuth leaves this specific provider-connect question open,” PDPP should define only that missing piece

### Phase 2.75: Event/trace spine and scenario registry

Outcome:

- the reference grows one shared truth model for console, CLI, tests, and illustrated replay

Tasks:

1. Define canonical identifiers such as:
   - `scenario_id`
   - `request_id`
   - `grant_id`
   - `query_id`
   - `run_id`
   - `interaction_id`
   - `client_id`
   - `provider_id`
2. Define a typed append-only event spine with protocol-shaped events such as:
   - `request.received`
   - `consent.rendered`
   - `grant.issued`
   - `grant.revoked`
   - `query.received`
   - `query.responded`
   - `collection.run.started`
   - `collection.record.accepted`
   - `collection.state.updated`
   - `collection.run.completed`
3. Decide which events are point events versus duration-bearing spans.
4. Expose the spine to tests and CLI before building a rich console.
5. Define a small scenario registry for deterministic replay and smoke testing.

Acceptance criteria:

- tests can reference stable scenario and object IDs
- the CLI can inspect real event history without database shortcuts
- a future console can be built without inventing a second state model
- the landing page can later replay traces from this substrate rather than simulating them independently

### Phase 3: Collection Profile convergence

Outcome:

- runtime and tests reflect the current Collection Profile

Tasks:

1. Change START generation to include normalized `scope`.
2. Resolve `view` to `fields` before START when collection is grant-driven.
3. Add grant-scoped state handling for `continuous` runs.
4. Preserve `state: null` and no persistence for `single_use`.
5. Align INTERACTION / INTERACTION_RESPONSE fields and statuses with the current spec.
6. Add enforcement or rejection for out-of-scope connector emissions.

Acceptance criteria:

- the runtime emits current-spec START messages
- tests actually assert `scope` and grant-scoped state behavior
- stale interaction message shapes are gone

### Phase 4: CLI

Outcome:

- there is a real operator/user-facing interface for the reference implementation

Tasks:

1. Add `e2e/cli/` with a simple Node CLI.
2. Implement commands such as:
   - `pdpp owner streams`
   - `pdpp owner records <stream>`
   - `pdpp owner export <stream>`
   - `pdpp debug introspect <token>`
   - `pdpp debug revoke <grant_id>`
3. Keep the CLI on the same RS/AS APIs as the reference implementation.
4. Use the companion profile assumptions where available, rather than hidden reference-only shortcuts.

Acceptance criteria:

- the CLI can self-export from the native platform using owner auth
- the CLI can self-export from the personal server using owner auth
- the CLI does not require private database access
- if provider-connect commands are added, they follow the companion profile rather than an ad hoc local contract

Optional:

- a dev-only grant request helper command for the reference AS

If added, it must be labeled as reference/deployment-specific, not core PDPP.

### Phase 5: Docs and artifacts

Outcome:

- the E2E reference can be read like a real implementation

Tasks:

1. Replace the placeholder [e2e/index.md](/e2e/index.md:1) with a real overview.
2. Document:
   - the topology
   - the two realization paths
   - the auth/discovery companion profile boundary
   - what is normative core vs reference architecture
   - how the CLI fits
3. Add one “golden path” walkthrough:
   - owner self-export from native platform
   - Longview request to native platform
   - Longview request to personal server polyfill
   - incremental sync
   - revocation
4. Add one concise “fork this reference safely” section:
   - what is normative
   - what is reference architecture
   - what is sample world data
   - what can be replaced without losing protocol integrity

Acceptance criteria:

- a new implementer can understand the E2E stack without reading every file
- the docs do not overclaim normative status

### Phase 6: Tests and verification

Outcome:

- the implementation proves the claims it makes

Tasks:

1. Extend `e2e/test/pdpp.test.js` for the native HR platform path.
2. Extend `e2e/test/collection-profile.test.js` to assert:
   - START carries `scope`
   - grant-scoped state for `continuous`
   - stale interaction shapes are rejected
3. Add CLI smoke tests or scriptable fixtures.
4. Add at least one test proving owner self-export against native platform.
5. Add at least one test or executable walkthrough proving the companion profile is sufficient for a generic client/CLI flow.
6. Add at least one test or executable walkthrough proving event/trace emission for a full golden path.

Acceptance criteria:

- tests cover both realization paths
- no major protocol claim exists only in prose

### Phase 7: Optional control-plane UI

Only start this once the protocol seams and event spine are cleaner.

If started, it should:

- be a consumer of the same reference APIs and event spine as the CLI
- remain visibly optional
- not block the protocol-cleanup work above
- center on topology + timeline + artifact inspection rather than actor panels or card grids

Acceptance criteria:

- the console can be removed without harming the forkable reference
- the console does not require private demo-only endpoints
- the console reads as an operator surface, not a second landing page

---

## Concrete next-hours execution order

If this is a “go hard for a few hours” session, the order should be:

1. **Extraction audit**
   - preserve / isolate / replace map for `e2e/server`, `e2e/runtime`, `e2e/client`, tests, and manifests
   - identify where the code is stronger than the current docs and where it still leaks pre-PDPP dialect
2. **Native HR world**
   - manifest
   - seed data
   - basic query path
3. **Companion auth/discovery profile**
   - define the smallest compositional profile
   - identify exactly which OAuth RFCs are reused directly
   - identify the minimum PDPP-original additions
4. **Event/trace spine**
   - identifiers
   - scenario registry
   - initial typed events
5. **CLI owner path**
   - list streams
   - fetch records
   - prove self-export
6. **Request-model cleanup**
   - internal object shape
   - examples/tests
7. **Collection Profile cleanup**
   - START.scope
   - grant-scoped state
   - interaction shape
8. **Docs**
   - `e2e/index.md`
   - one topology walkthrough
9. **Critical review**
   - what is still stale?
   - what is still just reference architecture?

This order matters.

Reason:

- the extraction audit prevents us from rewriting away the strongest inherited substrate
- the native HR world and CLI create an immediately legible production use case
- then the protocol-shape cleanup makes the implementation more honest
- then docs can describe the final state, not a transient one

---

## Design rules for avoiding bloat

1. One server engine, multiple realizations.
   Do not fork the whole codebase just to represent “native” vs “polyfill”.

2. One client, two backends.
   Longview should demonstrate the same protocol idea against both.

3. One CLI, standard surfaces only.
   Prefer RS owner endpoints and AS introspection over private shortcuts.

4. Reuse standards by reference.
   Do not define a PDPP copy of RFC 8414, PKCE, device flow, or client metadata unless a direct reference is insufficient.

5. Keep auth-boundary honesty.
   If the AS flow is reference-only, say so.

6. No new protocol features without pressure.
   If a missing feature is only needed for polish, not interoperability, keep it out.

7. Event spine before dashboard.
   Build shared truth before building surfaces over it.

8. Keep storage seams explicit.
   Local SQLite is fine as the first adapter, but stateful assumptions must stay narrow enough that remote database, Redis, or object-storage backing can be added without architectural surgery.

9. Website is downstream only.
   The landing page may replay traces and inspect artifacts, but it must not dictate the engine or control-plane contract.

7. Tests outrank demos.
   If the web demo and tests diverge, trust the tests and fix the demo.

---

## Questions to resolve early

These should be answered before too much code is moved.

1. What is the native HR platform’s final working name?
   Recommendation: use a temporary clear name like `Northstar HR` until a better one is chosen.

2. Should the native platform issue owner tokens directly for self-export?
   Recommendation: yes, in the reference implementation. Core already supports owner-authenticated RS access.

3. Should the CLI support app-grant flows or just owner/debug flows?
   Recommendation: owner + debug first. Add app-grant connectivity only once the companion profile is sharp enough that the CLI is proving a reusable contract rather than a local hack.

4. Should the personal server continue to support opportunistic/polyfill collection?
   Recommendation: yes, but keep that logic clearly separated from the core RS semantics.

5. Should PDPP define a companion profile for generic provider connectivity now?
   Recommendation: yes, as part of this E2E push, but as a composition profile over existing OAuth standards plus the minimum PDPP-specific provider metadata/discovery glue.

---

## Definition of done for this pass

This pass is done when:

1. There is a native HR realization path in `e2e/`.
2. There is a CLI that can self-export from a PDPP RS using owner auth.
3. The request model no longer teaches a stale shape as the canonical example.
4. The Collection Profile runtime and tests reflect current `scope` and state semantics.
5. There is a written companion auth/discovery profile for generic provider connectivity.
6. The docs explain the two-realization-path reference clearly.
7. The tests prove the major claims.

It is **not** done merely because the demo looks better or more complete.

---

## What I expect to learn from this pass

If this work goes well, it should answer:

1. Whether PDPP’s “native platform + polyfill personal server” framing is legible in code, not just in narrative.
2. Whether owner-authenticated self-export is enough to justify a real CLI surface now.
3. Whether a small auth/discovery companion profile is enough for generic provider connectivity without bloating core PDPP.
4. Whether the current Collection Profile boundary is sufficient, or whether implementation pressure reveals a missing wire-level contract.
5. Whether the same Longview reference world can unify native and polyfilled data sources without becoming conceptually muddy.

If it fails, the failure mode should also be informative:

- either the architecture is too mixed
- or the spec boundaries are still not sharp enough for a clean reference implementation

Both are useful outcomes.
