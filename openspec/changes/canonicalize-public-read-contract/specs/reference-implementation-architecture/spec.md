## ADDED Requirements

### Requirement: Public read operations SHALL use a canonical response envelope
The reference implementation SHALL use one canonical envelope family for grant-authorized public read operations. List-like responses SHALL include `object`, `data`, `has_more`, `links`, and `meta`; non-list responses SHALL use the same `object`, `data`, `links`, and `meta` vocabulary without `has_more` unless list semantics apply.

#### Scenario: List response returns canonical envelope
- **WHEN** a grant-authorized client calls a public list operation such as records list or search
- **THEN** the response SHALL include `object`, `data`, `has_more`, `links`, and `meta`
- **AND** `links.self` SHALL represent the effective request
- **AND** `links.next` SHALL be either an opaque next-page URL or `null`
- **AND** `meta.warnings` SHALL be present as an array when the operation has non-fatal warnings to report.

#### Scenario: Single-record response uses the same vocabulary
- **WHEN** a grant-authorized client fetches a single record or stream metadata object
- **THEN** the response SHALL use `object`, `data`, `links`, and `meta`
- **AND** it SHALL NOT invent a different envelope vocabulary for the same public read contract.

### Requirement: Public record identity SHALL be connection-scoped
Every public read result that carries or addresses a record SHALL be scoped by `(connection_id, stream, record_id)`. `connection_id` is the canonical public noun for an owner-configured concrete data source account, device, or profile. `connector_id` identifies the connector or manifest type, and `display_name` carries the owner-facing connection label.

#### Scenario: Record-bearing result carries identity
- **WHEN** a grant-authorized client receives a record-bearing response item from records list, records detail, search, expansion, or blob metadata
- **THEN** the item SHALL carry `connection_id`, `connector_id`, `stream`, and `record_id` or their operation-specific equivalents
- **AND** the item SHALL carry `display_name` when the response needs to name the connection to a human or LLM caller.

#### Scenario: Search hit carries record identity
- **WHEN** a grant-authorized client receives a search hit
- **THEN** the hit SHALL carry enough identity to fetch the same record without inference: `connection_id`, `stream`, and `record_id`
- **AND** clients SHALL NOT need to reconstruct connection identity from connector type, dashboard state, or result ordering.

#### Scenario: Deprecated connector-instance alias is compatibility-only
- **WHEN** a response carries `connector_instance_id` during the migration window
- **THEN** it SHALL also carry canonical `connection_id`
- **AND** generated docs and MCP tools SHALL describe `connector_instance_id` as deprecated compatibility, not the primary public noun.

### Requirement: Public read parameters SHALL be strictly validated
The reference implementation SHALL reject unsupported public read parameters, fields, filter operators, sort fields, and expansion targets with typed errors rather than silently ignoring them. Temporary compatibility behavior SHALL be reported through structured warnings.

#### Scenario: Unknown parameter is rejected
- **WHEN** a grant-authorized client sends an unsupported query parameter to a public read operation
- **THEN** the operation SHALL fail with a typed `unknown_parameter` or equivalent invalid-request error
- **AND** the error SHALL identify the invalid parameter
- **AND** the error SHOULD include the valid parameter names for that operation.

#### Scenario: Unsupported filter field is rejected
- **WHEN** a client filters on a field not advertised as filterable in `/v1/schema`
- **THEN** the operation SHALL fail with a typed filter error
- **AND** it SHALL NOT return unfiltered results.

#### Scenario: Temporary compatibility emits warning
- **WHEN** the reference accepts deprecated or lossy behavior during a compatibility window
- **THEN** the response SHALL include a structured `meta.warnings` entry identifying the behavior and recovery path.

### Requirement: Public read projection SHALL use one field allowlist primitive
The reference implementation SHALL expose one projection primitive, `fields`, for public read operations. The field allowlist SHALL be machine-readable, SHALL support dotted paths where applicable, and SHALL apply consistently to top-level records and expanded child records.

#### Scenario: Client requests a subset of fields
- **WHEN** a grant-authorized client passes `fields` to a public record-list or record-detail operation
- **THEN** the response SHALL omit non-requested record fields except fields required by the envelope and identity model
- **AND** the response SHALL preserve the canonical record identity fields required to refetch or attribute the record.

#### Scenario: Projection field is not known
- **WHEN** a client passes a field path not advertised for the stream
- **THEN** the operation SHALL reject the request with a typed field error
- **AND** it SHALL NOT silently widen or ignore the projection.

### Requirement: Public read expansion SHALL be one-hop, inline, and grant-safe
The reference implementation SHALL expose `expand[]` only for manifest-declared, grant-safe, one-hop parent-to-child relations. Expanded child collections SHALL be inline, depth-capped at one, and bounded by `expand_limit` for has-many relations.

#### Scenario: Client expands a declared child relation
- **WHEN** a client requests `expand[]=<relation>` for a stream whose schema advertises that relation as expandable
- **AND** the caller's grant authorizes the child stream and projected child fields
- **THEN** the response SHALL embed the child records inline under the parent result
- **AND** the embedded children SHALL preserve their own identity and projection constraints.

#### Scenario: Client requests unsupported expansion
- **WHEN** a client requests an expansion target not advertised for the stream
- **THEN** the operation SHALL fail with a typed expansion error
- **AND** it SHALL NOT silently omit the relation while returning success.

#### Scenario: Reverse relation remains unsupported
- **WHEN** a client attempts reverse, belongs-to, nested, or arbitrary graph traversal expansion
- **THEN** the reference SHALL reject the request unless a future OpenSpec change explicitly adds that relation type.

### Requirement: Public read filters SHALL use a small advertised operator vocabulary
The reference implementation SHALL support exact filters and operator filters through a single canonical vocabulary: `filter[field]=value` for equality and `filter[field][op]=value` for advertised operators. Legal operators SHALL be declared per field in `/v1/schema`.

#### Scenario: Client uses an advertised operator
- **WHEN** `/v1/schema` advertises operator `gte` for field `sent_at`
- **AND** the client calls records list with `filter[sent_at][gte]=2026-01-01T00:00:00Z`
- **THEN** the operation SHALL enforce that range filter.

#### Scenario: Client uses an unadvertised operator
- **WHEN** a client uses an operator not declared for the field in `/v1/schema`
- **THEN** the operation SHALL fail with a typed filter-operator error
- **AND** it SHALL NOT return results as if the filter had been applied.

### Requirement: Public read sorting SHALL use advertised sign-prefix fields
The reference implementation SHALL expose sorting through a canonical sign-prefix `sort` parameter, where `sort=-field` means descending and `sort=field` means ascending. Sortable fields and default ordering SHALL be advertised in `/v1/schema`.

#### Scenario: Client sorts by advertised field
- **WHEN** `/v1/schema` advertises `emitted_at` as sortable for a stream
- **AND** the client passes `sort=-emitted_at`
- **THEN** the response SHALL be ordered by `emitted_at` descending with a deterministic tie-breaker suitable for cursor pagination.

#### Scenario: Client sorts by unsupported field
- **WHEN** a client passes a `sort` field not advertised as sortable
- **THEN** the operation SHALL fail with a typed sort error.

### Requirement: Public read pagination SHALL use opaque cursors and server links
The canonical public read contract SHALL use `limit`, opaque `cursor`, `has_more`, and server-constructed `links.next`. Cursor contents SHALL NOT be client contract.

#### Scenario: Response has another page
- **WHEN** a public list operation has more results after the returned page
- **THEN** `has_more` SHALL be `true`
- **AND** `links.next` SHALL contain an opaque server-built URL or token-bearing link that the client can follow without reconstructing query state.

#### Scenario: Cursor is reused across incompatible query shape
- **WHEN** a client reuses a cursor with incompatible filters, sort, search mode, stream, or connection scope
- **THEN** the operation SHALL reject the cursor with a typed stale or invalid cursor error
- **AND** it SHALL NOT return a plausible but incorrect page.

### Requirement: Public read counts SHALL be opt-in and cost-graded
The reference implementation SHALL NOT force exact counts on every public list response. Clients MAY request a count using a graded contract equivalent to `Prefer: count=none|estimated|exact`, and responses SHALL report `meta.count.kind` and, when available, `meta.count.value`.

#### Scenario: Client omits count preference
- **WHEN** a client calls a public list operation without a count preference
- **THEN** the response SHALL be allowed to omit a count value
- **AND** `meta.count.kind` SHALL be `none` or an equivalent explicit no-count marker.

#### Scenario: Client requests estimated count
- **WHEN** a client requests an estimated count for a stream where the reference has a maintained projection or safe estimate
- **THEN** the response SHALL include `meta.count.kind = "estimated"` and a numeric `meta.count.value`
- **AND** the response SHALL NOT imply the estimate is exact.

#### Scenario: Requested count is downgraded
- **WHEN** a client requests an exact count and the reference can only safely return an estimate or no count
- **THEN** the response SHALL state the actual `meta.count.kind`
- **AND** it SHALL include a structured warning explaining the downgrade.

### Requirement: `/v1/schema` SHALL be the canonical public read capability document
The reference implementation SHALL expose public read capabilities through `GET /v1/schema`. Tool descriptions, docs, and dashboards MAY summarize the contract, but `/v1/schema` SHALL be the machine-readable source of truth for stream fields, filter operators, sortable fields, expansions, projection support, search modes, pagination, count support, and granted connection identities.

#### Scenario: Client discovers field capabilities
- **WHEN** a client calls `/v1/schema` under a grant
- **THEN** the response SHALL identify every granted stream and its field capabilities, including filterable fields and legal operators
- **AND** a client that uses only advertised capabilities SHALL NOT hit a silent no-op.

#### Scenario: Client discovers connection identities
- **WHEN** a client calls `/v1/schema` under a grant that spans multiple connections
- **THEN** the response SHALL include the granted `connection_id`, `connector_id`, and `display_name` values needed to scope or explain subsequent reads.

#### Scenario: Client discovers search pagination support
- **WHEN** a search mode does not support cursor pagination
- **THEN** `/v1/schema` SHALL advertise that limitation instead of requiring the client to discover it by failed calls.

### Requirement: Public read warnings SHALL be structured and closed over known non-fatal outcomes
The reference implementation SHALL report non-fatal lossiness, compatibility behavior, approximation, skipped sources, or partial results through structured `meta.warnings` entries with stable codes. Warnings SHALL NOT become a prose-only catch-all.

#### Scenario: Source is skipped as not applicable
- **WHEN** a multi-source public read skips a source because the requested stream or field is not applicable
- **THEN** the response MAY still succeed for applicable sources
- **AND** it SHALL include a structured warning identifying the skipped source and reason.

#### Scenario: Deprecated alias is accepted
- **WHEN** a request succeeds because the server accepted a deprecated compatibility alias
- **THEN** the response SHALL include a warning code for deprecated alias usage unless the operation's migration window explicitly suppresses warnings for that alias.

### Requirement: MCP read tools SHALL mirror the canonical public read contract
The in-repo MCP server and hosted MCP gateway SHALL mirror the canonical public read contract instead of defining a separate read API. MCP tool input schemas SHALL expose the same public arguments as REST, tool output schemas SHALL describe the canonical envelope, `structuredContent` SHALL carry the canonical body, and prose `content[]` SHALL be a concise summary only.

#### Scenario: MCP tool returns structured content
- **WHEN** an MCP client calls a read tool such as `query_records`, `search`, `fetch`, `list_streams`, `schema`, or `aggregate_records`
- **THEN** the tool response SHALL include `structuredContent` matching the canonical read envelope or operation body
- **AND** any text content SHALL be a human summary rather than a second divergent contract.

#### Scenario: MCP validates arguments through the same contract
- **WHEN** an MCP client supplies filters, fields, sort, expand, count, cursor, or `connection_id`
- **THEN** the MCP server SHALL forward or validate them according to the same canonical public read contract as REST
- **AND** it SHALL NOT silently drop arguments that the REST surface would reject.
