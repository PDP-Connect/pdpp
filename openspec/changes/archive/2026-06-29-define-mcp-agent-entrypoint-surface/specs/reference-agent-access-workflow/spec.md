## ADDED Requirements

### Requirement: Dashboard ordinary-agent setup SHALL have one primary entrypoint

The reference operator dashboard SHALL expose one ordinary-agent setup page for
grant-scoped AI-app access. The page SHALL be reachable from dashboard
navigation and deployment readiness, and SHALL remain separate from owner-token
issuance.

#### Scenario: Operator opens ordinary-agent setup
- **WHEN** the operator opens the dashboard setup page
- **THEN** the page SHALL show the running deployment's resolved MCP server URL
  as `<public-origin>/mcp`
- **AND** it SHALL show concrete setup commands for Claude Code and Codex
- **AND** it SHALL show URL-shaped setup for ChatGPT, Claude.ai, and generic
  remote MCP clients

#### Scenario: Operator needs CLI-first or agent-readable setup
- **WHEN** the operator needs a shell-agent or agent-readable entrypoint
- **THEN** the page SHALL expose `pdpp connect <public-origin>` and
  `<public-origin>/llms.txt` as secondary paths
- **AND** those secondary paths SHALL NOT appear before the primary MCP URL

#### Scenario: Operator compares ordinary MCP setup to owner-agent access
- **WHEN** the page references owner-agent access
- **THEN** owner-agent access SHALL be framed as a separate trusted-local
  automation path
- **AND** ordinary MCP setup SHALL NOT ask for owner bearers, control-plane
  bearers, bearer-token environment variables, or profile selectors

### Requirement: DCR response SHALL seed optional identity URI fields from AS_PUBLIC_URL

The AS dynamic client registration (`POST /oauth/register`) response SHALL
populate the optional identity URI fields (`client_uri`, `logo_uri`,
`policy_uri`, `tos_uri`) when `AS_PUBLIC_URL` is configured and the registrant
omits those fields. Caller-supplied values SHALL NOT be overridden.

- `client_uri` SHALL default to `AS_PUBLIC_URL` (the AS's base URL).
- `logo_uri` SHALL default to `<AS_PUBLIC_URL>/icon.svg`.
- `policy_uri` SHALL default to `AS_PUBLIC_URL`.
- `tos_uri` SHALL default to `AS_PUBLIC_URL`.

When `AS_PUBLIC_URL` is not configured, all four fields SHALL be absent from the
response when the registrant omits them (the existing omit-undefined behaviour).

#### Scenario: DCR with AS_PUBLIC_URL set and registrant omits URI fields

- **WHEN** `AS_PUBLIC_URL` is configured
- **AND** a client calls `POST /oauth/register` without `client_uri`, `logo_uri`,
  `policy_uri`, or `tos_uri`
- **THEN** the response SHALL include `client_uri` equal to `AS_PUBLIC_URL`
- **AND** `logo_uri` equal to `<AS_PUBLIC_URL>/icon.svg`
- **AND** `policy_uri` equal to `AS_PUBLIC_URL`
- **AND** `tos_uri` equal to `AS_PUBLIC_URL`

#### Scenario: DCR does not override explicit registrant-supplied URI fields

- **WHEN** `AS_PUBLIC_URL` is configured
- **AND** a client calls `POST /oauth/register` with explicit `client_uri`,
  `logo_uri`, `policy_uri`, and `tos_uri` values
- **THEN** the response SHALL echo back the caller-supplied values unchanged

#### Scenario: DCR without AS_PUBLIC_URL omits URI fields

- **WHEN** `AS_PUBLIC_URL` is not set
- **AND** a client calls `POST /oauth/register` without URI fields
- **THEN** the response SHALL omit `client_uri`, `logo_uri`, `policy_uri`,
  and `tos_uri`
