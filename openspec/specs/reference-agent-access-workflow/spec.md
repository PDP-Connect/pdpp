# reference-agent-access-workflow Specification

## Purpose
TBD - created by archiving change add-agent-scoped-pdpp-access. Update Purpose after archive.
## Requirements
### Requirement: Agent assistants SHALL use scoped client grants instead of owner tokens

The reference implementation SHALL provide a documented agent access workflow in which routine third-party, coding-agent, and task-scoped assistants request and use scoped PDPP client grants rather than owner bearer tokens for data access. A trusted local owner-agent profile MAY exist separately, but it SHALL be labeled as owner-level local automation and SHALL NOT be presented as the default path for ordinary agents.

#### Scenario: Agent requests data access
- **WHEN** an agent needs PDPP data for a user task and is not explicitly operating as a trusted local owner agent
- **THEN** it SHALL request a client grant scoped to the needed source, streams, fields/views, time range, retention, and access mode
- **AND** it SHALL NOT ask the user for an owner bearer token as the default path

#### Scenario: Agent needs broader access later
- **WHEN** an existing grant is insufficient for a later task
- **THEN** the agent SHALL request an explicit upgrade or additional grant
- **AND** it SHALL NOT silently broaden access or fall back to owner authority

#### Scenario: Trusted local owner agent is selected
- **WHEN** the owner explicitly chooses a trusted local owner-agent onboarding flow
- **THEN** the workflow SHALL identify the resulting credential as owner-level local automation
- **AND** it SHALL distinguish that profile from grant-scoped client access
- **AND** it SHALL NOT imply that owner bearer credentials are appropriate for external MCP clients or routine task-scoped agents

### Requirement: The CLI SHALL make owner approval link-based and inspectable

The reference CLI SHALL let an agent create a pending grant request and communicate an owner approval URL and/or verification code that the owner can complete in a browser. After approval, the CLI SHALL also provide grant-scoped read commands that use the cached client credential to call public resource-server read endpoints without owner credentials.

#### Scenario: Approved grant is used for reads

- **WHEN** an agent has an approved cached client grant
- **THEN** the CLI SHALL be able to call grant-scoped schema, stream, record, search, and aggregate read endpoints with that grant
- **AND** it SHALL NOT require an owner token for those reads
- **AND** it SHALL surface canonical response warnings on stderr.

### Requirement: Agent grant credentials SHALL be cached locally with least-surprise safety

The reference CLI SHALL store agent grant credentials in a project-local ignored cache by default and SHALL keep secret values out of prompts, logs, tracked files, and status output.

#### Scenario: Grant is approved
- **WHEN** the owner approves a grant request for an agent client
- **THEN** the CLI SHALL persist token metadata and the client token in the project-local cache
- **AND** the persisted metadata SHALL include enough non-secret scope information for status and renewal decisions

#### Scenario: Status is printed
- **WHEN** the agent or user inspects grant status
- **THEN** the CLI SHALL show the grant's source, streams, fields/views, time range, purpose, expiry, and revocation state
- **AND** it SHALL NOT print bearer token material

### Requirement: The agent-facing skill SHALL teach effective PDPP data consumption

The repository SHALL provide an agent-facing skill that teaches agents how to discover, request, cache, use, renew, and revoke PDPP grants while consuming data efficiently and safely.

#### Scenario: A fresh agent uses the skill
- **WHEN** an agent starts from only AS/RS URLs and no token
- **THEN** the skill SHALL direct it to discover metadata and `/v1/schema` before guessing endpoints
- **AND** it SHALL direct it to request a narrow client grant when data access is needed

#### Scenario: A grant-bound agent queries data
- **WHEN** an agent has a client token
- **THEN** the skill SHALL prefer declared capabilities such as filtered retrieval, `changes_since`, record pagination, blobs via `blob_ref.fetch_url`, and aggregations
- **AND** it SHALL warn against broad unbounded scans when narrower capability-backed queries can answer the task

### Requirement: The reference SHALL publish agent skill discovery surfaces

The reference web app SHALL expose stable, machine-readable discovery surfaces for the `pdpp-data-access` skill so third-party coding agents can find the skill without receiving an owner bearer token or guessing repo paths.

#### Scenario: Agent discovers the skill catalog
- **WHEN** an agent fetches `/.well-known/skills/index.json`
- **THEN** the response SHALL list the `pdpp-data-access` skill and every served skill file
- **AND** each file entry SHALL include an allowlisted path, repository path, media type, byte length, SHA-256 digest, and absolute URL
- **AND** the file-serving route SHALL NOT expose arbitrary repository files outside the allowlist

#### Scenario: Agent reads LLM discovery files
- **WHEN** an agent fetches `/llms.txt`
- **THEN** the response SHALL point at the skill catalog and primary `SKILL.md`
- **AND** when an agent fetches `/llms-full.txt`
- **THEN** the response SHALL include the full `pdpp-data-access` skill and reference content

#### Scenario: Agent starts from protected-resource metadata
- **WHEN** an agent fetches `/.well-known/oauth-protected-resource` from a composed reference deployment
- **THEN** the response SHALL include advisory `pdpp_agent_discovery` links to the skill catalog, primary `SKILL.md`, `/llms.txt`, and `/llms-full.txt`
- **AND** the advisory block SHALL identify `pdpp agent` as the recommended flow
- **AND** direct AS/RS-only deployments that do not serve those web routes SHALL omit the advisory block

#### Scenario: Agent starts through a proxy or LAN hostname
- **WHEN** a composed reference deployment proxies AS/RS discovery through a browser-facing origin
- **THEN** the AS and RS metadata SHALL advertise the caller-visible forwarded public origin rather than a loopback development default
- **AND** skill, authorization, token, device, and PAR URLs in those metadata documents SHALL be usable by a remote caller that cannot resolve the server's `localhost`

#### Scenario: Agent follows the distributed skill
- **WHEN** an agent uses the distributed `pdpp-data-access` skill
- **THEN** the skill SHALL prefer the `pdpp agent` CLI workflow over raw HTTP
- **AND** it SHALL describe that `pdpp agent wait` polls only the local cache and does not contact the AS
- **AND** it SHALL describe that `pdpp agent use` rejects missing, expired, and locally revoked grants

#### Scenario: Agent bootstraps against an out-of-the-box local reference
- **WHEN** `pdpp agent bootstrap` targets a reference AS that accepts the documented reference-local DCR initial-access token
- **THEN** the CLI SHALL try that reference-local default automatically when the caller did not pass an explicit initial-access token
- **AND** it SHALL still fail closed and ask for an explicit initial-access token when the AS rejects the reference-local default

#### Scenario: Agent installs the skill from a repository
- **WHEN** `npx skills add <repo-url> --list` scans the repository
- **THEN** it SHALL discover `pdpp-data-access` in a standard skill discovery location
- **AND** the installable copy SHALL be kept synchronized with the canonical `docs/agent-skills/pdpp-data-access/` source by a repository check

### Requirement: CLI read workflow SHALL mirror the canonical discovery loop

The reference CLI SHALL expose the same grant-scoped public read discovery loop
as REST and MCP: compact schema discovery, stream-name scoping, source scoping
by canonical `connection_id`, structured record reads, search, fetch,
aggregate, pagination, counts, and typed errors. Recommended CLI help and docs
SHALL use `connection_id` as the public selector and SHALL NOT present
`connector_instance_id` as the ordinary setup path.

#### Scenario: Agent discovers a broad grant through CLI
- **WHEN** an agent uses `pdpp read schema` on a grant package containing common
  stream names across multiple connections
- **THEN** the CLI SHALL provide flags that map to the canonical schema
  discovery selectors, including compact view, stream scope, and
  `connection_id` source scope
- **AND** the CLI SHALL not require the agent to inspect an unscoped full-schema
  document before narrowing to one configured source

#### Scenario: CLI help describes the canonical selector
- **WHEN** an operator or agent reads CLI help for grant-scoped reads
- **THEN** the recommended examples SHALL use `--connection-id`
- **AND** any deprecated selector alias SHALL be omitted from the ordinary
  examples or explicitly labeled compatibility-only

#### Scenario: CLI executes a scoped read
- **WHEN** the CLI executes a grant-scoped read using the cached client token
- **THEN** it SHALL call the canonical public REST read endpoint with the same
  query shape that MCP would forward for equivalent semantics
- **AND** it SHALL NOT require or accept owner/control-plane bearer tokens for
  ordinary grant-scoped reads

### Requirement: Protocol-candidate semantics SHALL remain explicitly proposed

Agent access workflow behavior that would change PDPP core authorization, grant semantics, or any companion spec SHALL be labeled proposed or experimental until separately accepted by the normative spec process.

#### Scenario: A reference implementation field becomes necessary
- **WHEN** implementation requires a new request or response field beyond the current public contract
- **THEN** the change SHALL identify whether the field is reference-only, experimental, or a candidate for a root PDPP/companion spec
- **AND** it SHALL NOT present that field as finalized PDPP normativity in this OpenSpec change

### Requirement: Trusted owner-agent onboarding SHALL be discoverable from metadata

The reference implementation SHALL publish advisory discovery information for trusted local owner agents when owner-agent onboarding is supported. The advisory information SHALL be reachable from the same entrypoint and `.well-known` metadata that an agent can discover before it has a token.

#### Scenario: Local owner agent starts from the resource root
- **WHEN** a trusted local owner agent fetches the reference Resource Server root pointer or protected-resource metadata
- **THEN** the response SHALL identify the trusted owner-agent onboarding profile when supported
- **AND** it SHALL link to the owner approval, schema, stream discovery, query, token introspection, revocation, and event-subscription discovery surfaces needed for onboarding and ongoing sync

#### Scenario: Owner-agent onboarding is unavailable
- **WHEN** a deployment cannot issue owner-agent credentials safely
- **THEN** the reference SHALL omit the trusted owner-agent onboarding advisory block
- **AND** it SHALL continue to advertise the grant-scoped agent workflow where that workflow is supported

### Requirement: The agent-readable entrypoint SHALL point trusted owner agents at owner-agent onboarding

The reference public-site/operator deployment SHALL serve a compact agent-readable entrypoint at `/llms.txt` that, in addition to the grant-scoped agent skill, points a trusted local owner agent at the owner-agent onboarding surfaces without requiring it to guess a universal URL. The entrypoint SHALL reference the canonical OAuth protected-resource metadata as the live source of owner-agent onboarding fields, a fetchable owner-agent onboarding/device-flow skill, the grant-scoped MCP boundary, and the owner REST/CLI guidance, and SHALL state that bearer tokens are not to be pasted into chat or terminals.

#### Scenario: Trusted owner agent reads the entrypoint

- **WHEN** a trusted local owner agent fetches `/llms.txt` from a reference deployment
- **THEN** the response SHALL be compact agent-readable text or markdown
- **AND** it SHALL point to the canonical OAuth protected-resource metadata, a fetchable owner-agent onboarding/device-flow skill, grant-scoped MCP guidance, and owner-agent REST/CLI guidance
- **AND** it SHALL state that bearer tokens are not to be pasted into chat or terminals
- **AND** it SHALL distinguish the owner-level local-automation profile from the default grant-scoped agent path

#### Scenario: Agent probes the well-known namespace

- **WHEN** an agent requests `/.well-known/llms.txt`
- **THEN** the deployment SHALL serve the same compact entrypoint as `/llms.txt` rather than requiring the agent to guess one universal URL

### Requirement: Trusted owner-agent guidance SHALL teach token-efficient local sync

The reference implementation SHALL provide owner-agent guidance that teaches local agents to discover schema and stream metadata before reading data and to maintain incremental state instead of repeatedly scanning every record.

#### Scenario: Daisy receives an owner-agent credential
- **WHEN** a trusted local owner agent receives an owner-level credential
- **THEN** the guidance SHALL direct it to fetch `/v1/schema` and stream metadata before issuing record queries
- **AND** it SHALL direct it to store per-stream and per-connection cursors locally
- **AND** it SHALL prefer `changes_since`, pagination, declared filters, field projections, and blob references over broad unbounded scans

#### Scenario: Local agent wants future updates
- **WHEN** a trusted local owner agent needs to keep its local view current
- **THEN** the guidance SHALL direct it to use event subscriptions only when it has a durable reachable HTTPS callback
- **AND** it SHALL otherwise use cursor polling with backoff and periodic schema refresh

### Requirement: MCP client setup SHALL prefer standards-based OAuth identity

The reference SHALL present local MCP client setup as a standards-based OAuth flow: pre-registered client identity when known, Client ID Metadata Document (CIMD) identity when the client can supply a URL-shaped `client_id`, Dynamic Client Registration (DCR) as fallback, and manual bearer/API credential setup only for explicit owner-agent or headless API use. The normal Claude Code and Codex MCP setup SHALL NOT ask the operator to paste an owner/control-plane bearer token.

#### Scenario: MCP client uses CIMD identity for setup
- **WHEN** an operator has created a client metadata document for Claude Code, Codex, or a custom MCP client
- **THEN** the setup command presented to the operator SHALL include the stable PDPP-hosted `client_id` URL
- **AND** the AS SHALL accept that URL as a valid CIMD client_id without prior DCR
- **AND** the owner SHALL approve a scoped PDPP grant in the browser before the client receives a grant-scoped token

#### Scenario: MCP client falls back to DCR when no CIMD document exists
- **WHEN** no operator-created CIMD document is available for the MCP client
- **THEN** the client SHALL proceed through the existing DCR path when the client supports it
- **AND** the DCR path SHALL remain functional and unmodified

#### Scenario: Headless API credential is selected
- **WHEN** an operator chooses a headless owner-agent or API credential path instead of normal MCP OAuth setup
- **THEN** the UI SHALL label that path as owner-level or API-level automation
- **AND** it SHALL distinguish that path from grant-scoped MCP client access

### Requirement: The operator dashboard SHALL provide a low-cognitive-tax Connect Agents entrypoint

The operator dashboard SHALL provide a single "Connect Agents" page or panel for recommended agent entrypoints. The page SHALL make hosted MCP OAuth the primary path, SHALL manage PDPP-hosted CIMD documents for local MCP clients (Claude Code, Codex, and custom clients) inside that flow, and SHALL keep PDPP CLI, agent skill / `llms.txt`, local stdio MCP adapter, and owner-agent/API credential paths concise and secondary. The page SHALL NOT present owner/control-plane bearer-token setup as the normal path for MCP clients.

#### Scenario: Operator creates a client identity
- **WHEN** the operator creates a new client identity in the dashboard
- **THEN** the operator SHALL receive a stable `https://<pdpp-host>/oauth/client-metadata/<uuid>` URL
- **AND** the dashboard SHALL immediately render copy-paste setup commands for that identity

#### Scenario: Operator opens Connect Agents
- **WHEN** the operator opens the Connect Agents page or panel
- **THEN** the page SHALL show one recommended hosted MCP OAuth setup path by default
- **AND** it SHALL summarize that the flow opens browser approval and stores a grant-scoped token
- **AND** it SHALL NOT require the operator to read multiple protocol explanations before copying the recommended command

#### Scenario: Operator needs a non-MCP entrypoint
- **WHEN** the operator chooses CLI, agent skill / `llms.txt`, local stdio adapter, or owner-agent/API credentials
- **THEN** the page SHALL reveal only the selected secondary path
- **AND** it SHALL label owner-agent/API credentials as owner-level or API-level automation, distinct from grant-scoped MCP client setup

#### Scenario: Dashboard renders Claude Code setup commands
- **WHEN** the operator views a client identity in the dashboard
- **THEN** the dashboard SHALL display a default-discovery command: `claude mcp add --transport http pdpp https://<pdpp-host>/mcp`
- **AND** it SHALL display an explicit CIMD identity command: `claude mcp add --transport http --client-id https://<pdpp-host>/oauth/client-metadata/<uuid> pdpp https://<pdpp-host>/mcp`

#### Scenario: Dashboard renders Codex setup commands
- **WHEN** the operator views a client identity in the dashboard
- **THEN** the dashboard SHALL display a default-discovery command: `codex mcp add pdpp --url https://<pdpp-host>/mcp`
- **AND** it SHALL display an explicit CIMD identity command: `codex mcp add pdpp --url https://<pdpp-host>/mcp --oauth-resource https://<pdpp-host>/mcp --oauth-client-id https://<pdpp-host>/oauth/client-metadata/<uuid>`

#### Scenario: Operator revokes a client identity
- **WHEN** the operator deletes a client identity in the dashboard
- **THEN** the CIMD document SHALL no longer be served at its URL
- **AND** all grants and tokens issued to that `client_id` SHALL be revoked server-side

