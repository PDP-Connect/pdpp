# reference-surface-topology Specification

## Purpose
TBD - created by archiving change define-reference-surface-topology. Update Purpose after archive.
## Requirements
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

### Requirement: Reference coverage SHALL be visible as a falsifiable public artifact

The reference implementation SHALL expose a coverage matrix that reports the status of important protocol concepts, flows, optional extensions, and reference-only operator surfaces. The matrix SHALL distinguish specified, documented, implemented, tested, demonstrated, deferred, and not-applicable states.

#### Scenario: A capability is partially implemented
- **WHEN** a protocol concept or reference capability is specified but not implemented, tested, or demonstrated
- **THEN** the coverage matrix SHALL show the gap explicitly rather than omitting the row

#### Scenario: A capability is claimed as demonstrated
- **WHEN** the matrix marks a capability as demonstrated
- **THEN** the row SHALL link to a sandbox flow, live-reference diagnostic, test, documentation page, or source artifact that supports the claim

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

### Requirement: A sandbox surface SHALL be mock-backed and clearly distinct from live operation

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

### Requirement: Human-facing CLI copy SHALL identify install and authority
Human-facing reference surfaces SHALL distinguish public delegated-access CLI
commands from reference-operator CLI commands and SHALL show the correct install
or execution path for each.

#### Scenario: A dashboard timeline shows a CLI command
- **WHEN** a live dashboard timeline, grant, trace, or peek surface shows a CLI command for `_ref` inspection
- **THEN** the command SHALL use the reference namespace, such as `pdpp ref run timeline <run-id>`
- **AND** the copy SHALL state whether it is runnable through the public npm CLI or from a repo checkout

#### Scenario: A surface advertises agent connection
- **WHEN** a docs, dashboard, metadata, skill, or LLM-facing surface advertises delegated access for an agent
- **THEN** it SHALL use the public install/connect command generated from the CLI package metadata
- **AND** it SHALL NOT imply that reference-operator commands are required for routine agent connection

#### Scenario: Public and reference CLI surfaces differ
- **WHEN** a command is available only in the repo-local reference wrapper
- **THEN** human-facing copy SHALL label it repo-local or compatibility-only
- **AND** it SHALL NOT link users to the public npm package as though that package supports the command

### Requirement: CLI examples SHALL remain consistent across surfaces
Reference website, dashboard, package README, and hosted docs SHALL keep CLI
examples consistent with the configured CLI package metadata and command
namespace decisions.

#### Scenario: CLI metadata changes
- **WHEN** the configured CLI package name, binary name, version policy, or reference namespace changes
- **THEN** docs and dashboard examples SHALL update from the same source of truth or fail validation

#### Scenario: Legacy operator aliases exist
- **WHEN** repo-local compatibility aliases remain for old top-level operator commands
- **THEN** rendered dashboard and documentation surfaces SHALL avoid advertising those aliases
- **AND** tests SHALL detect accidental reintroduction of the legacy examples

### Requirement: The operator dashboard SHALL separate record-content search from spine artifact lookup

The operator dashboard (`/dashboard/**`) SHALL provide two distinct search surfaces:

1. **Explore** (`/dashboard/explore`) — record-content search, time-range browsing, and the recency feed across visible connections. This surface is the sole owner-token record-content search surface.
2. **Jump** (`/dashboard/search`) — spine artifact lookup by id. Accepts trace, grant, and run ids and deep-links to the matching artifact page on exact match.

The Jump surface SHALL NOT call record-content search endpoints (`searchRecordsLexical`, `searchRecordsHybrid`, or equivalents). Free-text queries submitted to the Jump surface SHALL redirect to Explore.

#### Scenario: An operator submits a free-text query on Jump

- **WHEN** an operator submits a free-text query on the Jump surface that does not match an exact spine artifact id
- **THEN** the surface SHALL redirect to Explore with the query pre-filled (`/dashboard/explore?q=<query>`)
- **AND** the Jump surface SHALL NOT render record-content search results

#### Scenario: An operator submits an exact id on Jump

- **WHEN** an operator submits a query that exactly matches a known trace id, grant id, or run id
- **THEN** the surface SHALL redirect directly to the matching artifact detail page
- **AND** the `jump=0` query parameter SHALL opt out of the redirect and render the matching spine artifact buckets inline

#### Scenario: The operator dashboard nav labels the two surfaces distinctly

- **WHEN** a user views the operator dashboard navigation
- **THEN** the nav item for record-content search and time-range browsing SHALL be labeled "Explore"
- **AND** the nav item for spine artifact id lookup SHALL be labeled "Jump"
- **AND** no other nav item SHALL present itself as a record-content search surface

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

