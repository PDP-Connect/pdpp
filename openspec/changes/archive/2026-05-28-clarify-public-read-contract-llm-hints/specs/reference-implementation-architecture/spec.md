## ADDED Requirements

### Requirement: Stream-level read operations SHALL direct callers to `/v1/schema` for field-level filters

The operation summary text published by `@pdpp/reference-contract` for `listStreams` and `getStreamMetadata` SHALL explicitly state that these endpoints return stream-level totals only, and SHALL direct the caller to `GET /v1/schema` first when they need field-level filter capabilities. This turns a class of foreseeable 400-failures (a caller attaches `filter[...]` to a stream-level endpoint that does not accept it) into a self-teaching contract hint. Connection identity on these operations' response items is owned by `expose-connection-identity-on-public-read` and is NOT defined here.

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
