## ADDED Requirements

### Requirement: CLI read workflow SHALL mirror the canonical discovery loop

The reference CLI SHALL expose the same grant-scoped public read discovery loop
as REST and MCP: compact schema discovery, stream-name scoping, source scoping
by canonical `connection_id`, structured record reads, search, fetch, aggregate,
pagination, counts, and typed errors. Recommended CLI help and docs SHALL use
`connection_id` as the public selector and SHALL NOT present
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
