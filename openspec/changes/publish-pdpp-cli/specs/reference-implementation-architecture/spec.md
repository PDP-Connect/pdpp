## ADDED Requirements

### Requirement: Agent discovery SHALL advertise an installable CLI flow
The reference resource-server metadata SHALL advertise an executable npm CLI
command for delegated access, and related agent-discovery surfaces SHALL use the
same command.

#### Scenario: A client reads protected-resource metadata
- **WHEN** the client fetches `/.well-known/oauth-protected-resource`
- **THEN** `pdpp_agent_discovery` SHALL include the npm package name, bin name, install/run command, recommended connect command, and no-owner-token policy for delegated access
- **AND** the advertised command SHALL be generated from the configured public CLI package metadata

#### Scenario: A protected API request is missing authentication
- **WHEN** a safe resource-server request receives a bearer-token authentication error
- **THEN** the response SHALL continue to expose protected-resource metadata discovery
- **AND** it SHALL include a concise next step that directs agents to the advertised CLI connect flow before retrying `/v1/**`

#### Scenario: The CLI package name changes
- **WHEN** the configured public CLI package name changes
- **THEN** protected-resource metadata, hosted skills, llms files, web copy, and CLI help SHALL all advertise the same package and command

### Requirement: CLI connect SHALL create scoped client access without owner tokens
The public CLI SHALL provide a single-command connect flow that obtains a scoped
client grant approved by the owner and stores it in a project-local cache.

#### Scenario: An agent runs the connect command
- **WHEN** an agent runs `pdpp connect <provider-url>` or the advertised equivalent
- **THEN** the CLI SHALL discover the resource server and authorization server from the provider URL
- **AND** it SHALL request the narrowest owner-approved client grant needed for routine discovery
- **AND** it SHALL store resulting credentials only in the project-local PDPP cache with secret file permissions
- **AND** it SHALL verify the grant by calling `/v1/schema`

#### Scenario: The agent lacks a valid grant
- **WHEN** the connect flow requires owner approval
- **THEN** the CLI SHALL open or print an owner-facing approval URL
- **AND** it SHALL complete token receipt without asking the agent to paste or persist an owner bearer token

#### Scenario: The connect command is advertised publicly
- **WHEN** protected-resource metadata, hosted docs, or UI copy advertise the connect command
- **THEN** the reference implementation SHALL have a proven-safe token completion path for scoped client grants
- **AND** that path SHALL avoid exposing owner bearer tokens to the agent

#### Scenario: The current grant is insufficient
- **WHEN** the current cached grant cannot cover the requested data operation
- **THEN** the CLI SHALL stop or request an explicit scoped upgrade
- **AND** it SHALL NOT silently broaden access or ask for an owner token

#### Scenario: The CLI cannot complete routine delegated access
- **WHEN** the CLI cannot discover metadata, register or reuse a client, obtain approval, store a token, or verify `/v1/schema`
- **THEN** it SHALL return a bounded actionable error
- **AND** it SHALL NOT recommend an owner-token shortcut as the routine fallback

### Requirement: Public CLI packaging SHALL remain separate from reference-only runtime
The public CLI package SHALL contain client tooling and SHALL NOT require
the reference server, connector runtime, database, or Docker environment to run
routine delegated-access commands.

#### Scenario: A user installs the npm CLI in an empty project
- **WHEN** the user runs the advertised npm command outside this repository
- **THEN** the `pdpp` executable SHALL start, show help, and run discovery/connect commands without importing reference-server-only modules

#### Scenario: A reference-only command remains available
- **WHEN** a command depends on local reference implementation internals
- **THEN** that command SHALL remain repo-local or be clearly marked reference-only
- **AND** it SHALL NOT be required for routine external delegated access
