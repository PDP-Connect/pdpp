## MODIFIED Requirements

### Requirement: The resource server SHALL advertise the extension through its existing metadata document, with explicit experimental stability

Implementations that expose this extension SHALL publish the advertisement as a `capabilities.semantic_retrieval` object inside the existing resource-server metadata document (the same document already used by the resource server to publish OAuth-shaped metadata and, when present, the `capabilities.lexical_retrieval` advertisement). The advertisement SHALL describe only global facts about the extension. The advertisement SHALL include, when `supported: true`, the keys `supported`, `stability`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, and `index_state`. The advertisement SHALL NOT enumerate per-stream `semantic_fields`. It SHALL NOT grow into a generalized capability-statement document.

The advertised `index_state` SHALL be computed against the active storage backend that holds the operational semantic index. An implementation that supports multiple storage backends SHALL NOT report `index_state` based on inactive-backend metadata or progress rows.

#### Scenario: A server that exposes the extension publishes the advertisement with experimental stability
- **WHEN** an implementation exposes the extension on a resource server
- **THEN** that resource server's metadata document SHALL include a `capabilities.semantic_retrieval` object
- **AND** the object SHALL include `supported: true`, `stability: "experimental"`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, and `index_state`
- **AND** `endpoint` SHALL be a path resolvable on the same resource server, and SHALL be `/v1/search/semantic` unless the resource server is mounted under a path prefix, in which case the prefix SHALL be reflected

#### Scenario: `query_input` is text-only in v1
- **WHEN** an implementation publishes the advertisement in v1
- **THEN** `query_input` SHALL be exactly the string `"text"`
- **AND** other values (such as `"vector"` or `"hybrid"`) SHALL NOT appear in v1 advertisements

#### Scenario: `stability` cannot be silently omitted or upgraded in v1
- **WHEN** an implementation publishes the advertisement in v1
- **THEN** `stability` SHALL be exactly the string `"experimental"`
- **AND** a v1 implementation SHALL NOT publish `stability: "stable"` on this extension
- **AND** the field SHALL NOT be silently omitted when the extension is advertised as supported

#### Scenario: `index_state` honestly reports the current readiness of the extension
- **WHEN** an implementation publishes the advertisement
- **THEN** `index_state` SHALL be exactly one of `"built"`, `"building"`, or `"stale"`
- **AND** the implementation SHALL report `"stale"` when the configured `model` has changed or when `semantic_fields` have changed in a way that invalidates existing index coverage, until a rebuild restores coverage
- **AND** the implementation SHALL NOT report `"built"` while the advertised `model` disagrees with the content of the operational index

#### Scenario: `index_state` is computed against the active storage backend
- **WHEN** an implementation supports more than one semantic-index storage backend (for example a local embedded store and an external database)
- **AND** the implementation has selected one of those backends as the active operational backend for the current process
- **THEN** the advertised `index_state` SHALL be derived solely from the active backend's semantic meta and backfill-progress state
- **AND** the implementation SHALL NOT report `"stale"` solely because inactive-backend storage contains orphaned progress or meta rows left from an earlier configuration
- **AND** the implementation SHALL still report `"stale"` when the active backend's meta identity disagrees with the live embedding backend identity (`model`, `dimensions`, `distance_metric`)
- **AND** the implementation SHALL still report `"building"` while an in-process backfill is active, regardless of which storage backend is active

#### Scenario: The semantic surface SHALL NOT silently substitute a non-semantic fallback
- **WHEN** `index_state` is `"building"` or `"stale"`, or when the server is otherwise unable to produce semantic results honoring the declared `model`
- **THEN** the server MAY return an empty or partial result set
- **AND** the server SHALL NOT substitute lexical-only matching (or any other non-semantic fallback) behind `GET /v1/search/semantic` while continuing to emit `retrieval_mode: "semantic"` or `retrieval_mode: "hybrid"` on results
- **AND** a server that cannot honestly produce semantic or hybrid results SHALL either return zero results or SHALL NOT advertise `capabilities.semantic_retrieval.supported: true`

#### Scenario: `lexical_blending` governs whether hybrid results are permitted
- **WHEN** an advertisement reports `lexical_blending: false`
- **THEN** every result on `GET /v1/search/semantic` SHALL carry `retrieval_mode: "semantic"`
- **AND** no result SHALL carry `retrieval_mode: "hybrid"`

- **WHEN** an advertisement reports `lexical_blending: true`
- **THEN** individual results MAY carry `retrieval_mode: "hybrid"` or `retrieval_mode: "semantic"` at the server's discretion

#### Scenario: Optional `language_bias` is published when materially known
- **WHEN** the configured `model` has materially known language or locale bias
- **THEN** the advertisement SHOULD include a `language_bias` object with at minimum a `primary` BCP-47 language tag and a free-form `note`
- **AND** the client MAY use that information to choose between semantic and lexical retrieval, or to reject the extension for its use case

#### Scenario: A server that does not expose the extension does not publish a positive advertisement
- **WHEN** a server does not implement the extension
- **THEN** the server SHALL either omit `capabilities.semantic_retrieval` from its resource-server metadata, OR include it with `supported: false`
- **AND** in either case clients SHALL treat the extension as unavailable on that server
