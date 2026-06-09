## MODIFIED Requirements

### Requirement: MCP Query Filters Are Agent-Usable Without Hand-Encoded Bracket Strings

The MCP adapter SHALL expose an agent-usable typed `filter` input on the record
query, aggregate, and search tools, and SHALL advertise `filter` as a typed
object record in the tool input schemas. The typed input SHALL accept an object
keyed by field name whose value is either a scalar (exact match) or a range
object keyed by `gte`, `gt`, `lte`, or `lt`. The adapter SHALL encode the typed
input into the resource server's `filter[field]=value` (exact) and
`filter[field][op]=value` (range) query parameters and SHALL NOT require an MCP
client to construct bracket keys inside a string.

The MCP adapter SHALL NOT accept a top-level string filter argument; REST
bracket query syntax is an internal adapter encoding detail, not an MCP tool
input contract. A string `filter`, an empty typed filter object, or a typed
filter key that embeds bracket syntax SHALL be rejected with a typed, actionable
error that directs the agent to the typed filter input. A `filter` argument
SHALL NOT be silently forwarded as a bare `filter=` parameter, which the
resource server ignores. The adapter SHALL NOT change resource-server filtering
semantics; field and operator legality remain owned by the resource server and
advertised by `GET /v1/schema`.

#### Scenario: Client lists filtered read tools

- **WHEN** an MCP client calls `tools/list`
- **THEN** `query_records`, `aggregate`, and `search` SHALL advertise `filter` as an object
- **AND** the `filter` schema SHALL describe scalar exact-match values and range operator objects
- **AND** the `filter` schema SHALL NOT expose a top-level string alternative

#### Scenario: Agent supplies a typed exact filter

- **WHEN** an MCP client calls the record-query tool with `filter` set to an
  object such as `{ "user_id": "U123" }`
- **THEN** the adapter SHALL forward `filter[user_id]=U123` to the resource
  server
- **AND** the adapter SHALL NOT forward a bare `filter=` parameter

#### Scenario: Agent supplies a typed range filter

- **WHEN** an MCP client calls the record-query tool with `filter` set to a range
  object such as `{ "created_at": { "gte": "2026-01-01T00:00:00Z" } }`
- **THEN** the adapter SHALL forward `filter[created_at][gte]=2026-01-01T00:00:00Z`
  using only the supported operators `gte`, `gt`, `lte`, `lt`

#### Scenario: String filter is supplied

- **WHEN** an MCP client supplies `filter` as a string (including literal
  bracket syntax such as `filter[user_id]=U123`, `amount>100`, a bare term, an
  empty string, or JSON encoded as a string)
- **THEN** the MCP input SHALL be rejected before the adapter calls the resource
  server with a typed, actionable error instructing the agent to use the typed
  filter input
- **AND** the string SHALL NOT be forwarded as a bare REST `filter=` query
  parameter

#### Scenario: Empty or pre-encoded typed filter objects are rejected

- **WHEN** an MCP client calls the record-query tool with `filter` set to an
  empty object or with an object key that embeds bracket syntax such as
  `filter[user_id]`
- **THEN** the adapter SHALL return a typed, actionable error
- **AND** the adapter SHALL NOT forward any `filter` query parameter to the
  resource server

#### Scenario: Aggregate accepts the same typed filter

- **WHEN** an MCP client calls the aggregate tool with the same typed `filter`
  input accepted by the record-query tool
- **THEN** the adapter SHALL forward the equivalent `filter[field]` /
  `filter[field][op]` parameters
- **AND** a string filter SHALL produce the same class of actionable error as
  the record-query tool
