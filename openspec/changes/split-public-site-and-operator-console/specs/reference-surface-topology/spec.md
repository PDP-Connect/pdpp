## MODIFIED Requirements

### Requirement: Public website surfaces SHALL distinguish artifact categories

The PDPP public-site deployable SHALL distinguish protocol documentation, reference implementation explanation, mock sandbox education, project-planning/OpenSpec artifacts, and contributor workbench surfaces. The live reference-instance operator control plane SHALL NOT share a deployable with the public-site surfaces by default. Route families, navigation labels, metadata, and page copy SHALL make each surface's authority clear.

#### Scenario: A reviewer reads protocol documentation

- **WHEN** a reviewer visits `/docs/**`
- **THEN** the surface SHALL present protocol documentation and extension documentation without live owner records, traces, runs, or deployment diagnostics
- **AND** it SHALL NOT imply that reference implementation choices are normative protocol behavior unless the root PDPP specs say so

#### Scenario: A reviewer opens live dashboard pages

- **WHEN** a reviewer visits `/dashboard/**`
- **THEN** the surface SHALL be labeled and treated as a live reference-instance operator control plane served by the operator-console deployable
- **AND** it SHALL NOT be presented as protocol documentation or as a public hosted canonical PDPP service
- **AND** it SHALL NOT be served from the same deployable that serves the public-site surfaces by default

#### Scenario: A reviewer lands on the public site origin

- **WHEN** a reviewer visits the public-site origin (default `pdpp.dev`)
- **THEN** the response SHALL come from the public-site deployable
- **AND** the public-site deployable SHALL NOT proxy to a hosted live reference-instance AS/RS
- **AND** any live-experience link SHALL point at an operator-supplied origin (or the documented local default such as `http://localhost:3002`) rather than at a public AS/RS hosted by the public-site deployable

### Requirement: Live dashboard surfaces SHALL be stateful owner/operator surfaces

The dashboard route family SHALL be treated as stateful live-instance operation. It SHALL be owner-authenticated when owner authentication is configured, SHALL avoid static caching of live state, SHALL avoid search-engine indexing, SHALL be safe to disable on hosted public documentation deployments, and SHALL be owned by the operator-console deployable rather than the public-site deployable.

#### Scenario: Owner auth is configured

- **WHEN** owner authentication is configured for the reference instance
- **THEN** `/dashboard/**` SHALL require owner access before exposing live records, grants, traces, runs, deployment diagnostics, or interactions

#### Scenario: Public hosted documentation is deployed

- **WHEN** the public-site deployable is deployed without an intended live reference instance
- **THEN** `/dashboard/**` SHALL NOT be reachable from the public-site origin
- **AND** the public-site deployable SHALL build and serve without including operator-console code or a BFF to an AS/RS

#### Scenario: Operator deployment runs the console

- **WHEN** an operator runs the operator-console deployable alongside the reference-implementation AS/RS service
- **THEN** `/dashboard/**` and the BFF/proxy routes (`/_ref/**`, `/v1/**`, `/oauth/**`, `/.well-known/**`, `/consent`, `/device`, `/owner/**`, `/__pdpp/**`, `/connectors/**`, `/neko/**`, `/agent-connect`) SHALL be owned by the operator-console deployable
- **AND** the BFF/proxy SHALL terminate at the co-deployed AS/RS over the internal operator network rather than over the public internet

### Requirement: A sandbox surface SHALL be mock-backed and pedagogical

Any public sandbox surface SHALL be mock-backed, resettable, and clearly labeled as simulated. It SHALL teach protocol flows and API shapes without collecting real platform credentials or presenting itself as a live owner reference instance. The sandbox SHALL be owned by the public-site deployable so it remains reachable from `pdpp.dev` without any reference-implementation runtime.

#### Scenario: A visitor opens the sandbox

- **WHEN** a visitor uses `/sandbox/**`
- **THEN** the surface SHALL use mock or seeded data
- **AND** the visitor SHALL be told that the environment is simulated and resettable
- **AND** the sandbox SHALL NOT request real connector credentials or imply that it stores real owner data

#### Scenario: Sandbox UI reuses dashboard components

- **WHEN** sandbox pages reuse components that are also rendered by the live dashboard
- **THEN** those components SHALL be sourced from a shared workspace package (`packages/operator-ui` or its successor) so the public-site sandbox and the operator-console dashboard render the same feature components against different data sources
- **AND** the sandbox SHALL retain distinct chrome or labeling so users can distinguish simulated education from live operation

#### Scenario: Sandbox is reachable without a reference instance

- **WHEN** the public-site deployable is built and served without any reference-implementation runtime
- **THEN** `/sandbox/**` SHALL still render against deterministic mock data
- **AND** the build SHALL NOT require an AS/RS process to be running

### Requirement: Project planning surfaces SHALL not become protocol authority

OpenSpec and design-note viewer surfaces SHALL be labeled as project planning, implementation architecture, or requirements-discovery artifacts. They SHALL NOT be presented as normative PDPP protocol specifications. These surfaces SHALL be owned by the public-site deployable.

#### Scenario: A visitor opens OpenSpec pages

- **WHEN** a visitor visits `/planning/**` (or the route family the public-site deployable uses to expose OpenSpec)
- **THEN** the surface SHALL identify OpenSpec as project/change-planning material
- **AND** it SHALL link to root PDPP docs/specs for protocol semantics where relevant

#### Scenario: A planning artifact conflicts with protocol docs or code

- **WHEN** a planning artifact conflicts with root protocol docs, canonical OpenSpec specs, or executable behavior
- **THEN** the surface SHALL not resolve the conflict by implication
- **AND** maintainers SHALL update or retire the stale artifact through the governance process

## ADDED Requirements

### Requirement: The reference implementation SHALL be deployable independently of the public site

The reference implementation (AS/RS service plus operator console) SHALL be deployable by any self-hoster without requiring the public-site deployable. Conversely, the public-site deployable SHALL be deployable without requiring the reference implementation. The repository SHALL produce both deployables independently from the same source tree.

#### Scenario: An operator self-hosts only the reference

- **WHEN** an operator wants to run their own PDPP reference instance
- **THEN** they SHALL be able to deploy the operator-console deployable plus the reference-implementation AS/RS service without deploying the public-site deployable
- **AND** the operator-console deployable SHALL serve `/dashboard/**` and the BFF/proxy routes against the co-deployed AS/RS

#### Scenario: pdpp.dev is deployed as docs only

- **WHEN** the public-site deployable is built and deployed to `pdpp.dev` (or any documentation origin)
- **THEN** the build SHALL NOT include operator-console code, BFF code, or any code path that requires a running reference-implementation AS/RS
- **AND** the deployed public site SHALL serve `/`, `/docs/**`, `/reference/**`, `/sandbox/**`, `/planning/**`, contributor workbench routes, and `/llms*` from a static-friendly host

#### Scenario: A fork modifies only one surface

- **WHEN** a fork rewrites the public-site deployable for its own brand/origin
- **THEN** it SHALL be able to do so without modifying the operator-console deployable or the reference-implementation service
- **AND** the reverse SHALL also hold: a fork SHALL be able to modify the operator-console deployable without modifying the public-site deployable

### Requirement: The reference AS/RS root SHALL serve a browser-friendly landing page without changing the discovery JSON contract

The reference-implementation AS and RS root handlers SHALL preserve their existing JSON discovery responses for JSON-shaped clients (`Accept: application/json`, explicit `?format=json`, or other unambiguously JSON-shaped Accept negotiation) byte-identically to current behavior. The same handlers SHALL additionally serve a small operator/admin landing HTML page when the client requests HTML (`Accept: text/html` or other HTML-shaped Accept negotiation). The browser-friendly landing page SHALL be served by `reference-implementation` alone and SHALL NOT require the operator-console deployable to be reachable.

#### Scenario: A JSON client hits the bare AS root

- **WHEN** a client requests `GET /` against the AS process with `Accept: application/json` (or another unambiguously JSON-shaped negotiation)
- **THEN** the reference SHALL return the existing AS discovery JSON response byte-identically to current behavior
- **AND** existing discovery URLs (`/.well-known/oauth-authorization-server` on the AS, `/.well-known/oauth-protected-resource` on the RS) SHALL remain unchanged

#### Scenario: A browser hits the bare AS root

- **WHEN** a developer opens the AS root URL in a browser (`Accept: text/html` is sent by default)
- **THEN** the reference SHALL return `200 OK` with `Content-Type: text/html`
- **AND** the HTML SHALL name the reference AS/RS, name the configured operator-console origin (or `http://localhost:3002` as the documented default when none is configured), link to the AS discovery URL, and link to the RS discovery URL
- **AND** the HTML SHALL NOT claim to be the operator console or invite credential entry

#### Scenario: A browser hits the bare RS root

- **WHEN** a developer opens the RS root URL in a browser
- **THEN** the reference SHALL apply the same content-negotiated treatment as the AS root, returning HTML for browsers and the existing RS discovery JSON for JSON-shaped clients

#### Scenario: Discovery JSON is consumed by an existing client

- **WHEN** any existing client that today consumes the AS or RS root discovery JSON sends a request with the same Accept header it sends today
- **THEN** the reference SHALL return the existing JSON response unchanged
- **AND** this requirement SHALL NOT be used to alter the AS or RS discovery JSON wire shape
