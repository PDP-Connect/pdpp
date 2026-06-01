## MODIFIED Requirements

### Requirement: The website is a downstream consumer

The reference implementation's downstream consumer SHALL be split into two Next deployables — a public-site deployable (`apps/site` or its successor) and an operator-console deployable (`apps/console` or its successor) — that consume the reference implementation independently. Neither deployable SHALL define the primary reference contract. The public-site deployable SHALL NOT depend on a running reference-implementation AS/RS. The operator-console deployable SHALL act as the BFF in front of a co-deployed reference-implementation AS/RS for the operator's `/dashboard/**` experience.

#### Scenario: A bridge route exists for the operator console

- **WHEN** the operator-console deployable exposes a bridge route to the reference implementation
- **THEN** that bridge SHALL reflect the current reference contract honestly and SHALL not invent a stronger or different protocol contract than the underlying reference implementation exposes
- **AND** the bridge SHALL be owned by the operator-console deployable rather than by the public-site deployable

#### Scenario: The public site renders documentation and demos

- **WHEN** the public-site deployable renders protocol docs, the reference explainer, the mock sandbox, the OpenSpec viewer, the contributor workbench, or LLM index files
- **THEN** those artifacts SHALL be treated as derived explanatory surfaces rather than as the implementation boundary itself
- **AND** the public-site deployable SHALL build and serve without a running reference-implementation AS/RS process

#### Scenario: A downstream deployable changes independently

- **WHEN** the public-site deployable or the operator-console deployable changes its internal implementation
- **THEN** the forkable reference substrate in `reference-implementation/` SHALL remain the authoritative runnable implementation artifact rather than becoming coupled to deployable-specific code paths
- **AND** the other deployable SHALL be unaffected unless it explicitly shares code through the operator UI workspace package

### Requirement: The reference implementation remains a forkable substrate

The forkable implementation substrate SHALL live in `reference-implementation/` and SHALL remain usable without either Next deployable runtime (the public-site deployable or the operator-console deployable).

#### Scenario: An implementer evaluates the reference
- **WHEN** an implementer clones the repository to study or fork the reference implementation
- **THEN** they SHALL be able to run and understand the core reference substrate from `reference-implementation/` without depending on the public-site or operator-console deployable

#### Scenario: The website changes independently
- **WHEN** either Next deployable changes its internal implementation
- **THEN** the forkable reference substrate SHALL remain the authoritative runnable implementation artifact rather than becoming coupled to deployable-only code paths

### Requirement: The reference SHALL realize the semantic-retrieval experimental extension over a single internal enforcement path

The reference implementation SHALL realize the public `semantic-retrieval` extension defined in the `semantic-retrieval` capability through one internal helper that performs grant resolution, plan construction, embedding invocation, vector-index lookup, and grant-safe snippet generation in the same code path. The public `GET /v1/search/semantic` route handler SHALL delegate to that helper. Reference-internal callers (including the operator-console dashboard) SHALL reach semantic retrieval through the same public route over HTTP, not through a parallel direct-database path. The reference SHALL NOT define a second semantic retrieval contract.

#### Scenario: The dashboard helper reaches semantic retrieval through the public route
- **WHEN** a reference-side caller in `apps/console/src/app/dashboard/lib/rs-client.ts` requests semantic retrieval over owner records
- **THEN** it SHALL obtain those results by calling the public `GET /v1/search/semantic` endpoint with an owner-bound bearer token
- **AND** it SHALL NOT compute semantic results by reaching into the vector index or the embedding backend directly

#### Scenario: A second internal callsite is proposed
- **WHEN** any reference-side caller (CLI, dashboard, future operator surface) needs semantic retrieval over authorized records
- **THEN** that caller SHALL go through `GET /v1/search/semantic` (or, in-process, the single internal helper that the route delegates to)
- **AND** SHALL NOT reach into the vector index, the embedding backend, the manifest validator, or the grant resolver to assemble its own semantic retrieval contract

### Requirement: Browser-surface substrate SHALL be isolated from reference-owned runtime integrations

The reference implementation SHALL consume backend-agnostic remote-surface lease/state-machine substrate from a private internal package. That package SHALL own remote-surface types, browser-surface lease state transitions, capacity policy, fencing tokens, queue ordering, restart reconciliation policy, and backend allocator interfaces. The package SHALL NOT import reference implementation, server, Docker, dashboard/Next-deployable, or connector modules.

Reference-owned code SHALL continue to own persistence adapters, spine and run events, connector launch integration, Docker Compose wiring, and allocator sidecar process implementation.

#### Scenario: Reference runtime acquires a browser-surface lease

- **WHEN** reference controller code needs browser-surface lease policy
- **THEN** it SHALL use the package-backed substrate implementation
- **AND** reference-specific storage, event emission, and connector launch env assembly SHALL remain outside the package

#### Scenario: Dynamic allocator work adds backend lifecycle support

- **WHEN** dynamic n.eko allocation adds allocator lifecycle behavior
- **THEN** allocator contracts MAY be defined in the substrate package
- **AND** Docker Engine access, Compose wiring, and the allocator sidecar process SHALL remain reference-owned

#### Scenario: Package dependency boundaries are checked

- **WHEN** `packages/remote-surface` is inspected
- **THEN** it SHALL NOT import from `reference-implementation`, server modules, Docker implementation code, the public-site or operator-console deployable (`apps/site`, `apps/console`), or connector modules

### Requirement: Remote-surface streaming primitives SHALL be package-owned and host-adapted

The reference implementation SHALL extract backend-neutral remote-surface streaming primitives into `@pdpp/remote-surface` before treating the architecture as OSS-spinnable. The package SHALL own generic protocol shapes, session broker interfaces, client viewer interfaces, backend adapter interfaces, input/viewport/clipboard channel shapes, diagnostics schema, and allocator/session seams. The reference implementation SHALL remain the host adapter for PDPP-specific routes, run timelines, auth, persistence, and connector handoff.

#### Scenario: A host creates a remote-surface session

- **WHEN** reference owner auth has authorized a stream mint request for a pending run interaction
- **THEN** the reference SHALL map that authorized request into a package remote-surface session creation call
- **AND** the package session descriptor SHALL use generic remote-surface identity and capability fields
- **AND** PDPP `run_id`, `interaction_id`, owner auth, spine event names, and `_ref` route paths SHALL remain host-owned metadata and routing concerns

#### Scenario: The in-memory session broker is extracted

- **WHEN** the package provides a default in-memory session broker
- **THEN** it SHALL preserve token minting, idempotency replay, attach and authorize semantics, expiry, revocation, and invalidation behavior through package conformance tests
- **AND** hosts SHALL remain able to supply a durable store or host-specific persistence adapter

#### Scenario: A browser client opens a stream

- **WHEN** the dashboard opens a stream through reference `_ref` routes
- **THEN** the reference SHALL adapt the request to package attach, authorize, event-channel, input-channel, viewport-channel, clipboard-channel, and diagnostics primitives
- **AND** the browser-visible descriptor SHALL expose only scoped remote-surface capabilities and token-scoped proxy/session information
- **AND** it SHALL NOT expose raw CDP WebSocket URLs, allocator credentials, Docker hostnames, or connector-owned backend lifecycle authority

#### Scenario: Package dependency boundaries are checked

- **WHEN** `packages/remote-surface` is inspected
- **THEN** it SHALL NOT import from `reference-implementation`, the public-site or operator-console deployable (`apps/site`, `apps/console`), `packages/polyfill-connectors`, Docker implementation code, or server route modules

## ADDED Requirements

### Requirement: The reference deployable shape SHALL be three independent artifacts

The reference implementation SHALL produce three independently buildable and deployable artifacts from this repository: the public-site deployable, the operator-console deployable, and the reference-implementation AS/RS service. Each SHALL be deployable without the others. Shared UI between the public-site sandbox and the operator-console dashboard SHALL live in a workspace package consumed by both rather than being duplicated.

#### Scenario: Three deployable artifacts exist

- **WHEN** the repository is built for release
- **THEN** the build SHALL produce a public-site deployable, an operator-console deployable, and a reference-implementation AS/RS deployable
- **AND** each artifact SHALL be deployable in isolation

#### Scenario: Sandbox and dashboard share UI

- **WHEN** the public-site sandbox and the operator-console dashboard render the same feature surface (records, search, grants, runs, traces, deployment, timelines, or related operator UI)
- **THEN** the shared feature components SHALL live in a workspace package (e.g. `packages/operator-ui`) imported by both deployables
- **AND** neither deployable SHALL duplicate those feature components in its own source tree

#### Scenario: The operator deploys console + reference only

- **WHEN** an operator runs `docker compose up` (or the equivalent local deploy) for a self-hosted PDPP reference instance
- **THEN** the operator-console deployable and the reference-implementation AS/RS service SHALL be sufficient to serve `/dashboard/**` and the AS/RS routes
- **AND** the public-site deployable SHALL NOT be required for that deployment to function

#### Scenario: The reference-implementation service stays a substrate

- **WHEN** the public-site deployable or the operator-console deployable evolves
- **THEN** the reference-implementation service SHALL remain runnable on its own (its existing CLI entrypoints, AS/RS HTTP routes, and `hosted-ui.js`-served `/consent`, `/device`, `/owner/login` pages SHALL keep working without the operator-console deployable)
- **AND** the reference-implementation service SHALL NOT acquire build-time or runtime dependencies on either Next deployable
