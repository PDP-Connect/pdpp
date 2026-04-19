# Reference Implementation UX Prior Art

Date: 2026-04-16  
Status: Focused prior-art memo for PDPP reference-implementation planning

## Why this memo exists

PDPP needs more than a polished landing page. It needs a forkable reference artifact that another team could actually clone, run, inspect, and adapt without dragging along the marketing site or a demo-only control plane.

The best modern precedents do not collapse all of that into one surface. They separate:

- docs and marketing
- runnable samples/reference repos
- CLIs and operator tooling
- optional local orchestration and demos

The goal of this memo is to extract the patterns that make those systems credible and forkable.

## Bottom line

The strongest prior art points to the same architectural rule:

**keep the reference implementation, sample worlds, CLI, and docs site as separate but coordinated consumers of a common public substrate.**

What the strong examples do well:

- put runnable samples in dedicated repos or dedicated top-level artifacts
- keep CLIs as real consumers of public/product surfaces, not hidden backdoors
- use docs sites to index, explain, and route people into runnable artifacts
- keep sample worlds small, concrete, and obviously replaceable
- use Docker/Compose or similar for local assembly, but not as the protocol itself

What they generally do not do:

- make the public docs site a hard dependency of the runnable reference
- hide critical behavior behind demo-only endpoints
- force every sample, control surface, and walkthrough into one app shell

## Case studies

### Stripe: product docs plus separate samples plus a serious CLI

Relevant artifacts:

- Stripe CLI docs: <https://docs.stripe.com/stripe-cli>
- Stripe CLI repo: <https://github.com/stripe/stripe-cli>
- Stripe samples org: <https://github.com/stripe-samples>

What matters:

- Stripe’s docs site is the index and teaching layer. The runnable developer artifacts live elsewhere.
- The Stripe CLI is a real tool in its own right. Stripe positions it as a way to build, test, and manage integrations from the terminal, including webhook testing, request logs, event triggering, and API object management.
- The CLI is distributed like a normal developer tool: native install methods, Docker image, its own repository, its own release cadence.
- Samples are not embedded in the docs site. They live in a dedicated GitHub org with many focused repos, each narrow in scope.

Forkability pattern:

- docs explain and route
- sample repos are standalone and cloneable
- CLI is separate and operationally useful
- each artifact has a clear primary job

Takeaway for PDPP:

- `apps/web` should explain and route
- the forkable reference should live in `reference-implementation/` or a sibling substrate, not inside the website runtime
- the CLI should be installable and useful even if the website does not exist
- sample worlds should be narrow and replaceable, like Stripe’s focused sample repos

### Plaid: one canonical quickstart, strong docs guidance, clear client/server split

Relevant artifacts:

- Plaid Quickstart docs: <https://plaid.com/docs/quickstart/>
- Plaid Quickstart repo: <https://github.com/plaid/quickstart>

What matters:

- Plaid’s docs tell developers to clone the Quickstart repo, set env vars, run a backend, then run a frontend.
- The docs explicitly explain that the flow uses both a server and a client-side component.
- The Quickstart repo is multi-language on the backend but converges on one canonical frontend and one concept of the flow.

Forkability pattern:

- one canonical quickstart with minimal ambiguity
- multi-language where it matters, but one conceptual shape
- docs and repo are clearly connected, but not physically coupled

Takeaway for PDPP:

- the PDPP reference should have one canonical end-to-end path first, not many interchangeable demos
- it is acceptable to support multiple realizations later, but only after one golden path is clear
- the docs should describe the system split directly: client, AS/RS, optional runtime/polyfill path

### Ory: product docs plus reference UIs and a migration-oriented CLI

Relevant artifacts:

- Ory CLI page: <https://www.ory.com/cli>
- Ory CLI repo: <https://github.com/ory/cli>
- Ory Kratos self-service UI reference implementation: <https://github.com/ory/kratos-selfservice-ui-node>

What matters:

- Ory keeps product docs, CLI, and reference UIs distinct.
- The CLI is explicitly positioned for automation, migration, CI/CD, and project management.
- Ory publishes reference implementations for UI flows separately from the core product. The reference UI is not disguised as the product itself.
- The docs system itself appears to treat generated CLI/API reference as downstream from source repos, not as hand-maintained prose.

Forkability pattern:

- core services stay separate from reference UIs
- CLI is an operator/developer surface, not a marketing appendage
- reference UI repos are clearly framed as examples/reference implementations

Takeaway for PDPP:

- if PDPP has a control plane or consent UI reference, it should be clearly marked as reference architecture, not core protocol ontology
- generated reference docs should ideally derive from the implementation surface, not drift as prose
- the CLI can legitimately be both an automation surface and a migration/debug surface

### Temporal: strong CLI, separate samples, local dev server in the CLI

Relevant artifacts:

- Temporal CLI docs: <https://docs.temporal.io/cli>
- Temporal samples-server repo: <https://github.com/temporalio/samples-server>

What matters:

- Temporal describes the CLI as direct access to a Temporal Service for managing, monitoring, and debugging applications.
- The CLI also embeds a local Temporal Service suitable for development and CI/CD, including SQLite persistence and the Web UI.
- Temporal keeps server samples in a separate repo, including Docker Compose samples and security-focused configurations.

Forkability pattern:

- CLI is a serious operator and developer tool
- local-dev convenience is acceptable if it is still grounded in the real service model
- deployment samples live outside the marketing/docs shell and can be read as operational examples

Takeaway for PDPP:

- a PDPP CLI can legitimately bundle or boot a local reference stack for development and CI if it is explicit about doing so
- Docker Compose and CLI can work together without becoming the protocol
- control-plane convenience is acceptable when it sits above the real engine, not instead of it

### OpenTelemetry Demo: community-grade demo as shared substrate, explicit forkability

Relevant artifacts:

- OTel Demo docs: <https://opentelemetry.io/docs/demo/>
- OTel Demo repo: <https://github.com/open-telemetry/opentelemetry-demo>

What matters:

- The OpenTelemetry Demo repo is explicitly intended to be a near-real-world distributed system.
- Its stated goals include being both a realistic example and a base for vendors and tooling authors to extend.
- The repo includes multiple Compose files, tests, and explicit fork guidance.
- The public docs route developers into the demo, but the demo remains its own runnable artifact.

Forkability pattern:

- demo exists as a real substrate, not a toy embedded in docs
- community and vendors are invited to fork and extend it
- explicit fork guidance matters
- docs site is a guide and landing layer, not the runtime shell

Takeaway for PDPP:

- PDPP should probably have a documented “fork this reference safely” section or memo, not just raw code
- reference worlds should be framed as extensible examples, not sacred product canon
- if PDPP wants both a native provider path and a polyfill path, those should be presented as forkable topologies over one substrate

## Cross-cutting patterns

### 1. Docs site as router, not runtime dependency

Strong examples keep their docs sites opinionated and useful, but the runnable artifacts live elsewhere.

Good pattern:

- docs explain the shape of the system
- docs link to cloneable repos, CLI install paths, and quickstarts
- runnable artifacts can survive without the docs site

Bad pattern:

- docs/marketing shell imports the runtime or becomes the only way to operate it

Implication for PDPP:

- `apps/web` should explain, showcase traces/artifacts, and route users into the reference
- `reference-implementation/` should remain usable without Next.js

### 2. CLI should be a first-class real client

Across Stripe, Ory, and Temporal, the CLI is not a sidecar novelty. It is a serious surface for:

- automation
- debugging
- inspection
- local development
- management tasks

Implication for PDPP:

The CLI should be a real consumer of PDPP surfaces:

- owner self-export
- stream listing and querying
- grant and introspection inspection
- scenario boot/reset if justified by the reference stack
- eventually, provider-connect/profile debugging

If the CLI needs private database access or website-only APIs, the architecture is drifting.

### 3. Reference worlds should be concrete, narrow, and swappable

Plaid Quickstart, Stripe samples, and OTel Demo all work because they choose a concrete world and stay inside it.

Implication for PDPP:

- `Longview` should stay the canonical client
- `Northstar HR` can be the canonical native provider
- personal-server polyfill remains the canonical non-native path
- these are reference worlds, not protocol assumptions

### 4. Local orchestration is acceptable when it is clearly assembly

Temporal and OTel both normalize local-dev composition and multiple run modes.

Good pattern:

- Compose or local-dev bootstrapping starts the real system
- sample deployments remain inspectable as infrastructure, not magic

Bad pattern:

- orchestration is the only place where core behavior is defined

Implication for PDPP:

- Docker Compose is fine and likely desirable
- Compose should assemble services, seed fixtures, and support scenarios
- Compose should not become a hidden control plane or a parallel protocol

### 5. Generated/reference docs should flow from source where possible

Ory’s docs posture is instructive here: generated CLI/API docs belong to source repos and automation, not manual narrative editing.

Implication for PDPP:

- protocol artifact shapes shown in docs should come from the real reference implementation where feasible
- control-plane/event docs should ideally derive from the same event/trace schema the system emits
- the more the docs hand-curate fake JSON, the more drift risk grows

## Anti-patterns to avoid

### 1. The “all-in-one demo shell”

One app tries to be:

- docs site
- marketing surface
- control plane
- runtime console
- component workbench
- reference implementation

This creates coupling, confusion, and bad forkability.

### 2. Demo-only endpoints

If a dashboard or landing page needs private endpoints that the CLI and tests do not, those endpoints are probably teaching the wrong architecture.

### 3. Sample worlds baked into core logic

The reference becomes hard to fork when example names, manifests, or connectors leak into the engine instead of staying in fixtures/world definitions.

### 4. CLIs that are only wrappers around marketing workflows

A serious CLI should expose real operational leverage. If it only reproduces a guided demo path, it will not help implementers.

### 5. Samples that are too broad to copy

The best samples are often narrow and opinionated. A sprawling “platform kit” is harder to understand and less likely to be forked well.

## What this means for PDPP

### Recommended packaging model

#### 1. Keep the forkable reference in `reference-implementation/`

This should contain:

- AS/RS reference engine
- Collection Profile runtime
- sample connectors/manifests
- seeded worlds
- tests
- CLI

This is the thing another implementer should be able to fork.

#### 2. Keep `apps/web` as a downstream consumer

`apps/web` should:

- explain the protocol
- showcase traces/artifacts and reference worlds
- point into the runnable reference and CLI
- optionally replay recorded traces from the live stack

It should not be required for the reference to make sense.

#### 3. Treat control plane as optional operator tooling

A control plane is reasonable, but it should sit above the engine and consume real APIs/events. It should not define the engine’s contract.

#### 4. Treat the CLI as a mandatory part of the reference

The CLI is not optional polish. It is one of the strongest ways to keep the reference honest and forkable.

#### 5. Publish a forkability doctrine

PDPP should explicitly document:

- which layers are normative
- which layers are reference architecture
- which pieces are sample worlds
- which surfaces are safe to replace

OpenTelemetry’s explicit fork posture is the best model here.

## Concrete takeaways for the next PDPP phase

1. Keep the reference implementation, CLI, and website in separate dependency layers.
2. Add a `fork this reference` or `reference topology` doc aimed at implementers.
3. Make the CLI consume only real reference surfaces.
4. Keep Docker Compose as assembly only.
5. Put sample worlds and manifests outside the core engine.
6. Avoid a single super-surface that tries to be docs, control plane, and runtime at once.
7. Prefer one strong golden path over a configurable demo platform.
8. If a control plane is added, make it a consumer of the same event/trace spine as tests and the landing-page illustrated flow.

## Recommended standard for PDPP

A good PDPP reference should feel closer to this blend:

- Stripe’s separation of docs, samples, and CLI
- Plaid’s canonical quickstart discipline
- Ory’s separation of core services, reference UIs, and automation tooling
- Temporal’s serious CLI plus local-dev convenience
- OpenTelemetry Demo’s explicit forkability and near-real-world substrate

That is a better target than trying to turn the website into the whole product.
