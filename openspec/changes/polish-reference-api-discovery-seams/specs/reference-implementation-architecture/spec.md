## ADDED Requirements

### Requirement: An unauthenticated discovery index points cold-start callers at the next hop

The reference AS and RS SHALL expose an unauthenticated `GET /` JSON pointer that names the well-known endpoint, the running reference revision, and (on the RS) the schema endpoint and core query base. The pointer SHALL NOT duplicate the well-known capability document; it SHALL only direct the caller to it.

#### Scenario: A cold-start caller probes the RS root

- **WHEN** an unauthenticated caller requests `GET /` on the resource server
- **THEN** the response SHALL be a 200 JSON document with `object: "pdpp_discovery_index"` and `role: "resource_server"`
- **AND** the document SHALL include a `links.well_known` value pointing to `/.well-known/oauth-protected-resource`
- **AND** the document SHALL include `links.schema` pointing to `/v1/schema`
- **AND** the document SHALL include `links.core_query_base` pointing to `/v1`
- **AND** the document SHALL include a `reference_revision` value matching the `PDPP-Reference-Revision` response header on the same server.

#### Scenario: A cold-start caller probes the AS root

- **WHEN** an unauthenticated caller requests `GET /` on the authorization server
- **THEN** the response SHALL be a 200 JSON document with `object: "pdpp_discovery_index"` and `role: "authorization_server"`
- **AND** the document SHALL include a `links.well_known_authorization_server` value pointing to `/.well-known/oauth-authorization-server`
- **AND** the document SHALL include a `reference_revision` value matching the `PDPP-Reference-Revision` response header on the same server.

#### Scenario: The discovery index is unauthenticated

- **WHEN** the discovery index is requested without an `Authorization` header
- **THEN** the server SHALL return the index document with status 200
- **AND** the server SHALL NOT redirect to a login flow or return 401.

### Requirement: Protected-resource metadata SHALL include explicit discovery hints

The resource server's protected-resource metadata document SHALL include a `pdpp_discovery_hints` block that names the canonical first-call shapes a caller needs after reading the document. The block SHALL be derived from the same runtime state that drives capability advertisement so it cannot drift from live behavior.

#### Scenario: Hints name the schema and query bases

- **WHEN** a caller reads `/.well-known/oauth-protected-resource`
- **THEN** the response SHALL include `pdpp_discovery_hints.schema_endpoint` equal to `/v1/schema`
- **AND** `pdpp_discovery_hints.query_base` equal to `/v1`.

#### Scenario: Hints name the search scoping shape

- **WHEN** the lexical retrieval extension is advertised on the resource server
- **THEN** `pdpp_discovery_hints.search.endpoint` SHALL equal `/v1/search`
- **AND** `pdpp_discovery_hints.search.scope_param` SHALL equal `streams[]`
- **AND** `pdpp_discovery_hints.search.filter_requires_single_stream` SHALL be `true` while the v1 single-stream constraint applies.

#### Scenario: Hints name the aggregate path

- **WHEN** a caller reads the protected-resource metadata
- **THEN** `pdpp_discovery_hints.aggregate.endpoint_template` SHALL equal `/v1/streams/{stream}/aggregate`.

#### Scenario: Hints name the bootstrap sentinel and blob indirection

- **WHEN** a caller reads the protected-resource metadata
- **THEN** `pdpp_discovery_hints.changes_since_bootstrap` SHALL equal `beginning`
- **AND** `pdpp_discovery_hints.blob_indirection` SHALL equal `data.blob_ref.fetch_url`.

#### Scenario: Hybrid pagination support is reported when hybrid is advertised

- **WHEN** the hybrid retrieval extension is advertised on the resource server
- **THEN** `pdpp_discovery_hints.hybrid_pagination_supported` SHALL match the live `capabilities.hybrid_retrieval.cursor_supported` value
- **AND** when hybrid retrieval is not advertised, the field SHALL be omitted rather than set to a default.

#### Scenario: Hints name the connector and stream metadata endpoints

- **WHEN** a caller reads the protected-resource metadata
- **THEN** `pdpp_discovery_hints.connectors_endpoint` SHALL equal `/v1/connectors`
- **AND** `pdpp_discovery_hints.streams_endpoint_template` SHALL equal `/v1/streams/{stream}`.

#### Scenario: Hints name the owner polyfill connector_id requirement

- **WHEN** the resource server is configured without a native manifest (i.e. owner reads are scoped to polyfilled connectors)
- **THEN** `pdpp_discovery_hints.owner_polyfill_requires_connector_id` SHALL be `true`
- **AND** when the resource server is configured with a native manifest (single-source mode), the field SHALL be omitted rather than set to `false`.

### Requirement: The discovery index links to the connector listing

The unauthenticated `GET /` discovery index on the resource server SHALL include a `links.connectors` value pointing to the canonical connector-listing endpoint, so cold-start callers can discover connector identifiers without guessing.

#### Scenario: A cold-start caller probes the RS root and discovers connectors

- **WHEN** an unauthenticated caller requests `GET /` on the resource server
- **THEN** the response SHALL include `links.connectors` equal to `/v1/connectors`.

### Requirement: Malformed `changes_since` errors SHALL name legal forms

When the resource server rejects a `changes_since` parameter as malformed, the error message SHALL name the two legal forms a caller can use: the `beginning` bootstrap sentinel and the `next_changes_since` cursor returned by a previous changes-feed response. This converts an opaque rejection into a self-teaching error that points the caller at the next valid call.

#### Scenario: Caller passes a non-cursor literal value such as an ISO timestamp

- **WHEN** a caller requests `GET /v1/streams/{stream}/records?changes_since=2024-01-01T00:00:00Z`
- **THEN** the resource server SHALL return a 400 response with `error.code` `invalid_cursor`
- **AND** the error message SHALL name `beginning` as the bootstrap sentinel
- **AND** the error message SHALL name `next_changes_since` as the cursor source returned by a prior changes-feed response.
