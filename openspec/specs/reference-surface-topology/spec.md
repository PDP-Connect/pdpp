# reference-surface-topology Specification

## Purpose
TBD - created by archiving change define-reference-surface-topology. Update Purpose after archive.
## Requirements
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

### Requirement: Human-facing surfaces SHALL expose a copyable agent connection command
The reference website SHALL give users and agents a minimal executable command
for connecting to the live reference provider, and dashboard, deployment docs,
hosted skill, and LLM-facing text surfaces SHALL use the same command.

#### Scenario: A user wants to give an AI agent access
- **WHEN** the user visits the live dashboard or reference deployment surface
- **THEN** the surface SHALL show a "Connect an AI agent" affordance with a copyable npm command
- **AND** the copy SHALL explain that the owner will approve scoped access in the browser
- **AND** it SHALL NOT instruct the user to share an owner bearer token

#### Scenario: An agent reads hosted instructions
- **WHEN** an agent reads the hosted PDPP skill, `llms.txt`, or `llms-full.txt`
- **THEN** the first routine access path SHALL be the public CLI install/connect command
- **AND** raw HTTP fallback SHALL be framed as an advanced/debug path after CLI failure, not the happy path

#### Scenario: The same deployment has live and sandbox surfaces
- **WHEN** a surface advertises an agent connection command
- **THEN** the command SHALL identify whether it targets live owner data or sandbox/mock data
- **AND** sandbox copy SHALL preserve the existing requirement that simulated data is clearly labeled

### Requirement: Deployment-diagnostics SHALL surface collector protocol-version and runner-version drift

The reference deployment-diagnostics dashboard surface SHALL render the bound collector's protocol version, runner version, and bundled connector versions alongside the existing runtime-capabilities bindings list, so an operator can see whether a paired collector is compatible with the running reference server.

#### Scenario: Compatible collector is paired

- **WHEN** a collector whose protocol version is in the server's accepted set is paired
- **THEN** the dashboard SHALL render `collector_protocol_version`, `runner_version`, and `connector_versions` on the runtime-capabilities row
- **AND** the dashboard SHALL NOT raise a `collector_protocol_outdated` warning

#### Scenario: Outdated collector is paired

- **WHEN** a collector whose protocol version is not in the server's accepted set is paired
- **THEN** the dashboard SHALL raise a `collector_protocol_outdated` warning distinct from `browser_connectors_need_collector`
- **AND** the warning SHALL link to the operator action (`npm i -g @pdpp/local-collector@beta` while the package is beta-tagged, then the promoted stable package after release) without exposing device tokens or local paths

### Requirement: Public operator copy SHALL advertise the npm-installable collector path as the supported public flow

The public dashboard, `pdpp connect` copy, and operator-facing docs SHALL advertise `npx -y @pdpp/local-collector@beta ...` (or a global install of the same beta-tagged package until stable promotion) as the supported public path for filesystem-class connector collection on a fresh host. Monorepo-clone instructions SHALL remain available only as a development path, not as the primary public flow.

#### Scenario: Operator reads `pdpp connect` or dashboard onboarding copy

- **WHEN** an operator reads the public onboarding copy for Claude Code / Codex collection
- **THEN** the copy SHALL show `npx -y @pdpp/local-collector@beta ...` (or `npm i -g @pdpp/local-collector@beta`) as the primary instruction while the package is beta-tagged
- **AND** the copy SHALL NOT lead with `git clone` of the monorepo for filesystem-class connectors

#### Scenario: A browser-bound connector is documented

- **WHEN** the dashboard surfaces a connector whose runtime bindings include `browser`
- **THEN** the surface SHALL clearly indicate that the public `@pdpp/local-collector` does not yet ship browser-class collection
- **AND** the surface SHALL NOT imply that `npx -y @pdpp/local-collector@beta` covers browser-bound connectors

### Requirement: Reference web surfaces SHALL support light and dark themes

The PDPP reference web app SHALL support an explicit dark theme alongside its existing light theme, the dashboard SHALL be usable for sustained operator sessions in either theme, and the theme choice SHALL apply to dashboard, docs, and reference public surfaces inside the same browser session.

#### Scenario: An operator opens the dashboard with the OS in dark mode and no prior preference

- **WHEN** the operator first loads `/dashboard` and `localStorage` contains no
  PDPP theme preference and the operating system reports
  `prefers-color-scheme: dark`
- **THEN** the dashboard SHALL render in dark mode on first paint
- **AND** there SHALL be no visible light-to-dark flash during hydration

#### Scenario: An operator picks an explicit theme

- **WHEN** the operator activates the theme toggle and selects light or dark
- **THEN** the choice SHALL persist across reloads in the same browser
- **AND** the choice SHALL apply to dashboard, docs, and reference public
  surfaces in the same session

#### Scenario: An operator returns to system tracking

- **WHEN** the operator selects "system" from the theme toggle
- **THEN** the explicit preference SHALL be cleared
- **AND** the rendered theme SHALL follow the operating system's
  `prefers-color-scheme` value, including subsequent OS changes during the
  session

### Requirement: Status colors SHALL remain identifiable in both themes

Dashboard status indicators SHALL remain distinguishable in both light and dark themes. Status indicators (online/offline, success/destructive/warning, verified/unverified) SHALL NOT be conveyed by hue alone where a non-color affordance is reasonably available.

#### Scenario: An operator scans endpoint health in dark mode

- **WHEN** the dashboard endpoint footer renders in dark mode
- **THEN** online and offline endpoints SHALL be distinguishable by indicator
  shape/position and label, not only by color
- **AND** the chosen success and destructive token SHALL meet WCAG AA
  contrast against the dark background for the indicator and label

