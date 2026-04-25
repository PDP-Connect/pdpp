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
