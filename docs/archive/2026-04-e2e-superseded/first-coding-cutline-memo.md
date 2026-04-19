# First Coding Cutline Memo

Date: 2026-04-16  
Status: Working recommendation  
Scope: Smallest high-leverage coding tranche after the current research convergence

## Bottom line

The first coding tranche should **not** start with:

- the control plane
- the event/trace spine
- the native provider UX
- the illustrated-flow integration
- a full provider-connect implementation

The first tranche should make the forkable substrate honest at its most important seams.

That means:

1. make the request/auth front door stop teaching a stale dialect
2. make the Collection Profile runtime stop teaching a stale dialect
3. make the CLI a real owner-path consumer instead of a demo helper shell
4. prove a connector-free native path at the engine level

If those four things are not done first, the rest of the project will be built on top of soft ambiguity.

## Exact deliverables

### 1. Standards-shaped request object in the E2E engine

Deliver:

- a canonical internal selection-request object in `e2e/server/`
- current fields represented explicitly:
  - `authorization_details`
  - `client_display`
  - `client_claims`
  - purpose metadata
  - access mode
- legacy flat request route kept only as an explicitly compat/demo adapter if still needed

Not required in this tranche:

- a polished final provider-connect flow
- full OAuth profile implementation

Why this is first:

- it is the largest core-spec drift
- it stops new code and tests from centering the wrong shape

### 2. Collection Profile wire-contract convergence

Deliver:

- runtime `START.scope` support
- grant-scoped state path for `continuous` runs
- explicit `state: null` handling for `single_use`
- current `INTERACTION` / `INTERACTION_RESPONSE` field names and statuses
- updated Collection Profile tests that prove the current contract rather than legacy behavior

Not required in this tranche:

- scheduler redesign
- import/webhook polishing
- connector UX work

Why this is first:

- the runtime seam is the second biggest spec drift
- a future control plane will be worthless if this seam is still lying

### 3. Day-one CLI with a hard scope

Deliver:

- one real CLI entrypoint under `e2e/cli/`
- day-one commands limited to:
  - owner self-export
  - list streams
  - query records
  - inspect grant metadata if it can be done without demo-only backdoors
- CLI consumes real RS surfaces, not direct DB access

Must be explicit:

- whether token acquisition for local development is using a compat/admin route
- if so, that route is labeled compat/admin and not presented as the reference public contract

Not required in this tranche:

- generic `connect to any PDPP provider`
- device-flow UX
- full client-connect support

Why this is first:

- it forces the team to prove the owner path is real
- it creates an immediate consumer that is not the website

### 4. Minimal connector-free native path proof

Deliver:

- one native HR deployment or mode using the same engine
- seeded streams:
  - `pay_statements`
  - optionally `equity_grants`
  - optionally `benefits_enrollments`
- at least one acceptance test proving:
  - Longview-style request shape works
  - owner self-export works
  - projection and `changes_since` work
  - no connector lifecycle assumptions leak into the request/query path

Not required in this tranche:

- Northstar HR branding polish
- separate provider UI
- full dual-deployment orchestration

Why this is first:

- it answers the sharpest unresolved red-team question:
  - is the native provider real, or just a disguised connector world?

## What must be deferred

### 1. Rich control plane

Defer:

- topology dashboard
- run inspector UI
- timeline UI
- reseed/reset operator surface

Reason:

- the core request/runtime/CLI seams are still moving
- building the console now will pressure the engine in the wrong direction

### 2. Full event/trace spine

Defer:

- append-only canonical trace model
- replay integration for `/`
- scenario registry beyond the minimum needed for tests

Reason:

- the shape of the right events depends on stabilized request/runtime/CLI surfaces
- building it now risks creating a second architecture project

### 3. Full provider-connect profile implementation

Defer:

- generic discovery flow across arbitrary providers
- device flow support matrix
- registration policy matrix
- polished provider metadata publication

Reason:

- the profile still needs one pinned discovery anchor decision first
- the first coding cut should prove local truth, not ecosystem reach

### 4. Website integration

Defer:

- live illustrated-flow replay
- landing-page integration with engine traces
- any website-driven runtime coupling

Reason:

- the website is downstream
- it should consume stabilized artifacts, not drive early engine design

### 5. Native-provider product surface

Defer:

- Northstar HR UI
- native-provider-specific admin screens
- polished public-facing provider shell

Reason:

- the first job is to prove the native path in protocol behavior, not product chrome

## Verification strategy

### 1. Code-level acceptance tests before UI work

The tranche is only done if these are black-box-proven:

- request object shape is current internally
- runtime START/state/interaction semantics are current
- owner CLI path works against the RS
- native path works without connector leakage

### 2. Explicit compatibility accounting

Before calling the tranche done:

- list every legacy compat/demo route still present
- mark whether it is:
  - still required for tests
  - still required for local dev
  - ready for removal later

If this is not written down, legacy surfaces will quietly remain primary.

### 3. Grep and reread discipline after naming/shape changes

For this tranche in particular:

- grep for old flat request assumptions
- grep for old Collection Profile field names
- grep for demo/admin token helper routes
- reread every touched file, not just tests

### 4. One hard native-path test

There should be at least one explicit test whose purpose is:

- prove the native path is not secretly using connector assumptions

If that test cannot be written cleanly, the architecture is not yet honest.

## Biggest ways the team could still overbuild

### 1. Turning “CLI” into a mini platform

Overbuild pattern:

- too many commands
- hidden admin affordances
- multiple auth flows in the first cut

Correct move:

- keep it narrow and owner-path-first

### 2. Building the console before the substrate earns it

Overbuild pattern:

- dashboard first
- trace model second
- actual seam cleanup never fully finished

Correct move:

- engine truth first, console later

### 3. Building a full provider-connect ecosystem too early

Overbuild pattern:

- custom well-known docs
- registration UX
- multiple discovery paths
- provider matrices

Correct move:

- pick one real discovery anchor and one reference-local flow later, not now

### 4. Over-polishing Northstar HR

Overbuild pattern:

- brand/UI work before connector-free native semantics are proven

Correct move:

- treat Northstar HR first as a disciplined deployment of the engine, not as a product design exercise

### 5. Inventing abstractions to feel “serverless-ready”

Overbuild pattern:

- giant storage abstraction layers
- speculative multi-adapter frameworks
- premature distributed orchestration

Correct move:

- add only the narrow seams needed so SQLite is not the architecture

## Recommended execution order

1. current internal request object
2. Collection Profile wire-contract cleanup
3. day-one CLI
4. native connector-free acceptance test and minimal deployment
5. only then revisit trace spine, provider-connect profile implementation, and console

## Final judgment

The first coding cut should be defined by one principle:

- `stabilize the truth-bearing seams before building projections over them`

That means the first tranche is not the most exciting one visually, but it is the one most likely to prevent months of subtle architectural drift.
