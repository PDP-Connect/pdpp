## ADDED Requirements

### Requirement: Public website surfaces SHALL distinguish artifact categories

The PDPP website SHALL distinguish protocol documentation, reference implementation explanation, live reference-instance operation, mock sandbox education, and project-planning/OpenSpec artifacts. Route families, navigation labels, metadata, and page copy SHALL make each surface's authority clear.

#### Scenario: A reviewer reads protocol documentation
- **WHEN** a reviewer visits `/docs/**`
- **THEN** the surface SHALL present protocol documentation and extension documentation without live owner records, traces, runs, or deployment diagnostics
- **AND** it SHALL NOT imply that reference implementation choices are normative protocol behavior unless the root PDPP specs say so

#### Scenario: A reviewer opens live dashboard pages
- **WHEN** a reviewer visits `/dashboard/**`
- **THEN** the surface SHALL be labeled and treated as a live reference-instance operator control plane
- **AND** it SHALL NOT be presented as protocol documentation or as a public hosted canonical PDPP service

### Requirement: The reference implementation SHALL have a public explainer surface distinct from protocol docs

The website SHALL provide a public reference-implementation explainer surface that describes the reference implementation as code and as a forkable substrate. This surface SHALL include design principles, architecture, current implementation status, coverage honesty, and clone/run/deploy calls to action without claiming protocol authority.

#### Scenario: A reviewer wants to understand the reference implementation
- **WHEN** a reviewer visits the reference explainer surface
- **THEN** they SHALL be able to understand what the reference implementation is, what it is not, how to run it, and how it relates to the protocol docs
- **AND** the surface SHALL point to code/tests for current implementation behavior and to `/docs/**` for protocol semantics

#### Scenario: A reference claim is made
- **WHEN** the surface claims that a flow, capability, or concept is implemented
- **THEN** the claim SHALL link to supporting docs, tests, routes, coverage-matrix rows, or source files where practical

### Requirement: Live dashboard surfaces SHALL be stateful owner/operator surfaces

The dashboard route family SHALL be treated as stateful live-instance operation. It SHALL be owner-authenticated when owner authentication is configured, SHALL avoid static caching of live state, SHALL avoid search-engine indexing, and SHALL be safe to disable on hosted public documentation deployments.

#### Scenario: Owner auth is configured
- **WHEN** owner authentication is configured for the reference instance
- **THEN** `/dashboard/**` SHALL require owner access before exposing live records, grants, traces, runs, deployment diagnostics, or interactions

#### Scenario: Public hosted documentation is deployed
- **WHEN** the website is deployed as a public documentation site without an intended live reference instance
- **THEN** `/dashboard/**` SHALL be disabled, hidden, or clearly unavailable rather than implying Vana operates a canonical live owner dashboard

### Requirement: A sandbox surface SHALL be mock-backed and pedagogical

Any public sandbox surface SHALL be mock-backed, resettable, and clearly labeled as simulated. It SHALL teach protocol flows and API shapes without collecting real platform credentials or presenting itself as a live owner reference instance.

#### Scenario: A visitor opens the sandbox
- **WHEN** a visitor uses `/sandbox/**`
- **THEN** the surface SHALL use mock or seeded data
- **AND** the visitor SHALL be told that the environment is simulated and resettable
- **AND** the sandbox SHALL NOT request real connector credentials or imply that it stores real owner data

#### Scenario: Sandbox UI reuses dashboard components
- **WHEN** sandbox pages reuse components from the live dashboard
- **THEN** the sandbox SHALL retain distinct chrome or labeling so users can distinguish simulated education from live operation

### Requirement: Reference coverage SHALL be visible as a falsifiable public artifact

The reference implementation SHALL expose a coverage matrix that reports the status of important protocol concepts, flows, optional extensions, and reference-only operator surfaces. The matrix SHALL distinguish specified, documented, implemented, tested, demonstrated, deferred, and not-applicable states.

#### Scenario: A capability is partially implemented
- **WHEN** a protocol concept or reference capability is specified but not implemented, tested, or demonstrated
- **THEN** the coverage matrix SHALL show the gap explicitly rather than omitting the row

#### Scenario: A capability is claimed as demonstrated
- **WHEN** the matrix marks a capability as demonstrated
- **THEN** the row SHALL link to a sandbox flow, live-reference diagnostic, test, documentation page, or source artifact that supports the claim

### Requirement: Project planning surfaces SHALL not become protocol authority

OpenSpec and design-note viewer surfaces SHALL be labeled as project planning, implementation architecture, or requirements-discovery artifacts. They SHALL NOT be presented as normative PDPP protocol specifications.

#### Scenario: A visitor opens OpenSpec pages
- **WHEN** a visitor visits `/openspec/**`
- **THEN** the surface SHALL identify OpenSpec as project/change-planning material
- **AND** it SHALL link to root PDPP docs/specs for protocol semantics where relevant

#### Scenario: A planning artifact conflicts with protocol docs or code
- **WHEN** a planning artifact conflicts with root protocol docs, canonical OpenSpec specs, or executable behavior
- **THEN** the surface SHALL not resolve the conflict by implication
- **AND** maintainers SHALL update or retire the stale artifact through the governance process
