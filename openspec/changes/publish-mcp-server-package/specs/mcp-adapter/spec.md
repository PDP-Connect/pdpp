## ADDED Requirements

### Requirement: Stdio MCP Adapter Is Installable Without Cloning The Repository

The `@pdpp/mcp-server` package SHALL be published to npm under the `@beta`
dist-tag so that operators and agents can install and run it via
`npx -y @pdpp/mcp-server@beta` without cloning the repository. This matches the
posture of `@pdpp/cli` and `@pdpp/local-collector`.

#### Scenario: Operator installs the adapter from npm

- **WHEN** an operator follows the documented install instruction
  `npx -y @pdpp/mcp-server@beta --provider-url <url>`
- **THEN** the package SHALL be resolvable from the npm registry under the `@beta`
  dist-tag
- **AND** the installed binary SHALL start successfully and accept the
  `--provider-url` argument
