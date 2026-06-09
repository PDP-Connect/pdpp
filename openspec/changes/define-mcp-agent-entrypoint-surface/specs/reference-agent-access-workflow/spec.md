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
