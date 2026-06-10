## ADDED Requirements

### Requirement: MCP `schema` compact output SHALL align with REST compact schema semantics

The MCP adapter SHALL make the `schema` tool's compact/default output use the
same compact projection semantics as `GET /v1/schema?view=compact`. The MCP
adapter SHALL keep `detail: "full"` as the exhaustive verbatim escape hatch.

#### Scenario: MCP compact schema uses the REST compact view

- **WHEN** an MCP client calls `schema` without `detail: "full"` against an RS that supports `GET /v1/schema?view=compact`
- **THEN** the adapter SHALL request `GET /v1/schema?view=compact`
- **AND** if the MCP call includes `stream=<name>`, the adapter SHALL pass the same stream as `GET /v1/schema?view=compact&stream=<name>`
- **AND** the MCP `structuredContent.data` SHALL preserve the REST compact body verbatim inside the MCP wrapper

#### Scenario: MCP compact schema falls back without diverging

- **WHEN** an MCP client calls `schema` without `detail: "full"` against an RS that ignores or rejects the compact selector
- **THEN** the adapter MAY fall back to locally projecting the full schema body
- **AND** that fallback projection SHALL preserve the REST compact semantics for field flag aliases, connector-level `granted_connections` de-duplication, stream scoping, and compact byte budgets

#### Scenario: MCP full schema remains explicit

- **WHEN** an MCP client calls `schema` with `detail: "full"`
- **THEN** the adapter SHALL return the exhaustive resource-server schema body in `structuredContent.data`
- **AND** the adapter SHALL NOT substitute the compact projection for the full detail response
