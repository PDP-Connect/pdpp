## MODIFIED Requirements

### Requirement: MCP Aggregate Tool Surfaces Truncation Signals In-Band

The MCP `aggregate` tool description SHALL inform models that grouped
responses include `other_count` (the sum of counts for groups/buckets beyond
`limit`) so that truncation can be detected without a second round trip. The
tool's text summarizer SHALL include `other_count` in the model-visible
`content[]` summary when the resource server returns it.

#### Scenario: Aggregate description mentions other_count

- **WHEN** an MCP client lists tools
- **THEN** the `aggregate` tool description SHALL mention `other_count` and
  explain that a positive value signals top-N truncation

#### Scenario: Aggregate text summary includes other_count when present

- **WHEN** the resource server returns a grouped aggregate response that
  includes `other_count`
- **THEN** the `aggregate` tool's model-visible `content[]` text summary SHALL
  include the `other_count` value
- **AND** the value SHALL appear alongside the group preview so models can
  assess completeness without inspecting `structuredContent`
