## ADDED Requirements

### Requirement: The public stream listing SHALL disambiguate multi-instance connectors

The public read contract exposed by `@pdpp/reference-contract` SHALL allow the `listStreams` response to identify the originating connector and connector instance for each stream entry, so an owner-token caller with more than one instance of the same connector can route follow-up record reads without an extra `/v1/connectors` round trip. The fields SHALL be additive and optional on the JSON Schema; they SHALL NOT be added to the `required` set so existing clients that ignore them remain valid.

#### Scenario: An owner has two instances of the same connector

- **WHEN** an owner-token caller invokes `listStreams` and the resource server has two registered instances of the same connector (for example two `claude_code` workspaces)
- **THEN** the response items SHALL carry an optional `connector_id` string and an optional `connector_instance_id` string identifying the originating connector and instance for each stream row
- **AND** the caller SHALL be able to disambiguate streams that share the same `name` across instances without first calling `/v1/connectors`.

#### Scenario: The runtime cannot attribute a stream to an instance

- **WHEN** the runtime cannot determine the connector or instance for a stream row (for example single-source native mode, or a legacy row predating the instance identifier)
- **THEN** the response SHALL omit the field rather than emit `null` or an empty string
- **AND** the JSON Schema SHALL NOT require either field, so omission is contract-valid.

### Requirement: Public search results SHALL identify the originating connector instance

The lexical, semantic, and hybrid search response schemas published by `@pdpp/reference-contract` SHALL allow each search result item to carry an optional `connector_instance_id` in addition to the existing `connector_id`, so an owner-token caller can hydrate a record under the correct per-instance owner read scope when the originating connector has more than one registered instance.

#### Scenario: A search hit comes from a known instance

- **WHEN** an owner-token caller invokes `searchRecordsLexical`, `searchRecordsSemantic`, or `searchRecordsHybrid` and a hit originates from a connector that has more than one registered instance
- **THEN** the corresponding search-result item SHALL carry both `connector_id` and `connector_instance_id` identifying the originating connector and instance
- **AND** `connector_instance_id` SHALL match the value `listStreams` reports for that same instance.

#### Scenario: A search hit cannot be attributed to an instance

- **WHEN** a search hit comes from a row that pre-dates the instance identifier or from a single-source native provider
- **THEN** the response item SHALL omit `connector_instance_id` rather than emit `null`
- **AND** the JSON Schema SHALL NOT add `connector_instance_id` to the `required` set on any of the three search response item schemas.

### Requirement: Stream-level read operations SHALL direct callers to `/v1/schema` for field-level filters

The operation summary text published by `@pdpp/reference-contract` for `listStreams` and `getStreamMetadata` SHALL explicitly state that these endpoints return stream-level totals only, and SHALL direct the caller to `GET /v1/schema` first when they need field-level filter capabilities. This turns a class of foreseeable 400-failures (a caller attaches `filter[...]` to a stream-level endpoint that does not accept it) into a self-teaching contract hint.

#### Scenario: An LLM caller reads the `listStreams` summary

- **WHEN** an LLM caller or contract-driven tool description renders the `listStreams` operation summary
- **THEN** the summary SHALL state that the endpoint returns stream-level totals
- **AND** the summary SHALL name `/v1/schema` as the endpoint to consult for field-level filter capabilities before constructing a filtered query.

#### Scenario: An LLM caller reads the `getStreamMetadata` summary

- **WHEN** an LLM caller or contract-driven tool description renders the `getStreamMetadata` operation summary
- **THEN** the summary SHALL state that the endpoint returns metadata for a single stream and SHALL NOT advertise field-level filtering
- **AND** the summary SHALL name `/v1/schema` as the endpoint to consult for field-level filter capabilities.

### Requirement: Hybrid pagination unavailability SHALL be advertised and cross-referenced

When the hybrid retrieval extension is advertised on the resource server, the protected-resource discovery hints SHALL include `hybrid_pagination_supported` derived from the same live runtime state that drives the hybrid capability advertisement, and the `searchRecordsHybrid` operation summary SHALL reference that hint and SHALL name lexical search as the cursor-pagination fallback. The agent-facing query cookbook SHALL document the same limitation, so callers learn the boundary from contract or docs before they hit a 400.

#### Scenario: Hybrid is advertised but cursor pagination is not supported

- **WHEN** the resource server advertises the hybrid retrieval extension and the runtime hybrid implementation does not support cursor pagination
- **THEN** `pdpp_discovery_hints.hybrid_pagination_supported` SHALL be present in the protected-resource metadata document with value `false`
- **AND** the `searchRecordsHybrid` operation summary SHALL reference `pdpp_discovery_hints.hybrid_pagination_supported`
- **AND** the operation summary SHALL name lexical search as the recommended fallback when cursor pagination is required.

#### Scenario: Hybrid is not advertised

- **WHEN** the resource server does not advertise the hybrid retrieval extension
- **THEN** `pdpp_discovery_hints.hybrid_pagination_supported` SHALL be omitted from the protected-resource metadata document rather than emitted with a default value
- **AND** the contract for `searchRecordsHybrid` MAY still reference the hint, but consumers SHALL treat an omitted hint as "field not applicable on this resource server."

#### Scenario: The query cookbook documents the same boundary

- **WHEN** an agent reads `docs/agent-skills/pdpp-data-access/references/query-cookbook.md`
- **THEN** the cookbook SHALL state that hybrid does not support `cursor`
- **AND** the cookbook SHALL recommend lexical search as the fallback when the caller needs more than `limit` results.

### Requirement: The `filter` parameter description SHALL point callers at `/v1/schema` `field_capabilities`

The JSON Schema `description` on the `filter` property of `ListRecordsQuerySchema` published by `@pdpp/reference-contract` SHALL describe both the exact-match shape (`filter[field]=value`) and the range shape (`filter[field][op]=value`), and SHALL name `field_capabilities` on `GET /v1/schema` as the source of the legal operator set for `op`. This is a description change only; it SHALL NOT change the parameter's type, format, or runtime validation.

#### Scenario: A caller renders the `filter` parameter description

- **WHEN** an LLM caller or contract-driven tool description renders the `description` of the `filter` parameter on the records-list operation
- **THEN** the description SHALL include both `filter[field]=value` and `filter[field][op]=value` as legal shapes
- **AND** the description SHALL name `field_capabilities` from `GET /v1/schema` as the source of the legal `op` values
- **AND** the parameter's `type`, `format`, and runtime validation SHALL NOT change relative to the pre-change contract.
