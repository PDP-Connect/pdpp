## ADDED Requirements

### Requirement: The reference SHALL realize the semantic-retrieval experimental extension over a single internal enforcement path

The reference implementation SHALL realize the public `semantic-retrieval` extension defined in the `semantic-retrieval` capability through one internal helper that performs grant resolution, plan construction, embedding invocation, vector-index lookup, and grant-safe snippet generation in the same code path. The public `GET /v1/search/semantic` route handler SHALL delegate to that helper. Reference-internal callers (including the website dashboard) SHALL reach semantic retrieval through the same public route over HTTP, not through a parallel direct-database path. The reference SHALL NOT define a second semantic retrieval contract.

#### Scenario: The dashboard helper reaches semantic retrieval through the public route
- **WHEN** a reference-side caller in `apps/web/src/app/dashboard/lib/rs-client.ts` requests semantic retrieval over owner records
- **THEN** it SHALL obtain those results by calling the public `GET /v1/search/semantic` endpoint with an owner-bound bearer token
- **AND** it SHALL NOT compute semantic results by reaching into the vector index or the embedding backend directly

#### Scenario: A second internal callsite is proposed
- **WHEN** any reference-side caller (CLI, dashboard, future operator surface) needs semantic retrieval over authorized records
- **THEN** that caller SHALL go through `GET /v1/search/semantic` (or, in-process, the single internal helper that the route delegates to)
- **AND** SHALL NOT reach into the vector index, the embedding backend, the manifest validator, or the grant resolver to assemble its own semantic retrieval contract

### Requirement: The reference's manifest validator SHALL enforce the v1 `semantic_fields` shape independently of `lexical_fields`

When a connector manifest declares `query.search.semantic_fields` on any stream, the reference's manifest validator SHALL enforce the v1 shape constraints. The validator SHALL reject manifests whose declarations would let the public extension embed or match anything other than top-level scalar string fields named in the stream's schema. The `semantic_fields` enforcement SHALL run independently of `lexical_fields` enforcement: either, both, or neither MAY be declared on a stream.

#### Scenario: A manifest declares a nested path as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["data.body"]` on a stream
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an array-typed schema field as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["tags"]` and the stream's schema lists `tags` as `type: "array"`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares a blob-typed schema field as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["attachment"]` and the stream's schema lists `attachment` as a blob reference
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares a non-existent field as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["nonexistent"]` and `nonexistent` is not in `schema.properties`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an empty semantic_fields array
- **WHEN** a manifest declares `query.search.semantic_fields: []`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares only `semantic_fields` (no `lexical_fields`)
- **WHEN** a manifest declares `query.search.semantic_fields: ["text"]` on a stream and does NOT declare `query.search.lexical_fields` on that stream
- **THEN** the reference's manifest validator SHALL accept the manifest
- **AND** the stream SHALL participate in semantic retrieval but not lexical retrieval

#### Scenario: A manifest declares `lexical_fields` and `semantic_fields` with different contents
- **WHEN** a manifest declares `query.search.lexical_fields: ["title", "subject"]` and `query.search.semantic_fields: ["title", "body"]` on a stream
- **THEN** the reference's manifest validator SHALL accept the manifest
- **AND** lexical retrieval SHALL match only over `["title", "subject"]` on that stream
- **AND** semantic retrieval SHALL match only over `["title", "body"]` on that stream

### Requirement: The reference SHALL publish the `capabilities.semantic_retrieval` advertisement on its existing protected-resource metadata document with truthful experimental stability

When the reference exposes the semantic-retrieval extension, the existing RFC 9728 protected-resource metadata document the reference already serves SHALL include a `capabilities.semantic_retrieval` object carrying all required keys. The `stability` key SHALL be the literal string `"experimental"` in v1. The reference SHALL NOT introduce a new metadata document for this advertisement, and SHALL NOT publish the advertisement on the authorization-server metadata document. The reference SHALL NOT publish `supported: true` unless both an embedding backend and a vector index are configured and available.

#### Scenario: The advertisement is co-located with existing RS metadata
- **WHEN** a client retrieves the reference's protected-resource metadata document
- **THEN** the response SHALL include `capabilities.semantic_retrieval` with the required keys when the extension is exposed
- **AND** the reference SHALL NOT serve the advertisement from a separately discoverable metadata document

#### Scenario: The advertisement carries the experimental stability marker
- **WHEN** the reference publishes `capabilities.semantic_retrieval.supported: true`
- **THEN** the same advertisement SHALL include `stability: "experimental"`
- **AND** the reference SHALL NOT publish `stability: "stable"` on this extension in v1

#### Scenario: The advertisement declares text-only query input
- **WHEN** the reference publishes `capabilities.semantic_retrieval.supported: true`
- **THEN** the same advertisement SHALL include `query_input: "text"` in v1
- **AND** SHALL NOT include `query_input: "vector"` or `query_input: "hybrid"` in v1

#### Scenario: The advertisement declares `lexical_blending: false` in this tranche
- **WHEN** the reference publishes `capabilities.semantic_retrieval.supported: true` in this tranche
- **THEN** the same advertisement SHALL include `lexical_blending: false`
- **AND** every result emitted on `GET /v1/search/semantic` SHALL carry `retrieval_mode: "semantic"`

#### Scenario: The advertisement's `model`, `dimensions`, and `distance_metric` come from the configured backend
- **WHEN** the reference assembles the `capabilities.semantic_retrieval` object
- **THEN** the `model` value SHALL be the server-declared model identifier returned by the configured embedding backend
- **AND** the `dimensions` value SHALL be the integer dimension returned by the configured embedding backend
- **AND** the `distance_metric` value SHALL be one of `"cosine"`, `"dot"`, or `"l2"` returned by the configured embedding backend
- **AND** these values SHALL NOT be set from static configuration unrelated to the backend actually in use

#### Scenario: A reference instance with no embedding backend configured
- **WHEN** the reference is started without an embedding backend or without a vector index
- **THEN** the protected-resource metadata document SHALL either omit `capabilities.semantic_retrieval` entirely or include it with `supported: false`
- **AND** the reference SHALL NOT register the `GET /v1/search/semantic` route
- **AND** requests to `GET /v1/search/semantic` SHALL return `404` or `not_found_error`

#### Scenario: The advertisement is discoverable without a grant
- **WHEN** an unauthenticated client requests the reference's protected-resource metadata document
- **THEN** the `capabilities.semantic_retrieval` advertisement, if present, SHALL be returned without requiring a bearer token

#### Scenario: The advertisement is independent of the lexical retrieval advertisement
- **WHEN** the reference publishes protected-resource metadata
- **THEN** the presence or absence of `capabilities.semantic_retrieval` SHALL be independent of the presence or absence of `capabilities.lexical_retrieval`
- **AND** toggling one SHALL NOT toggle the other

### Requirement: The reference's vector index SHALL embed and store only declared `semantic_fields`

The reference's local vector index SHALL contain entries only for `(stream, record_key, field, connector_id)` tuples where `field` appears in the corresponding stream's `query.search.semantic_fields` declaration. Records of streams that do not declare `semantic_fields` SHALL NOT contribute index rows. Non-declared fields of records of streams that do declare `semantic_fields` SHALL NOT be embedded and SHALL NOT contribute index rows.

#### Scenario: A non-participating stream has new records
- **WHEN** new records arrive for a stream whose manifest does not declare `query.search.semantic_fields`
- **THEN** the reference's vector index SHALL NOT receive new rows for that stream
- **AND** the embedding backend SHALL NOT be invoked for records of that stream

#### Scenario: A participating stream has new records
- **WHEN** new records arrive for a stream whose manifest declares `semantic_fields: ["a", "b"]`
- **THEN** the reference's vector index SHALL receive exactly two rows for each record (one per declared field)
- **AND** SHALL NOT receive rows for any other field of that record

#### Scenario: A stream loses its `semantic_fields` declaration
- **WHEN** a manifest update removes `query.search.semantic_fields` from a stream
- **THEN** the reference SHALL remove all vector-index rows for that stream
- **AND** the stream SHALL contribute zero hits on subsequent semantic searches

### Requirement: The reference's vector index SHALL include connector identity on every row

Because the reference's owner reads are per-connector, the vector index SHALL include the originating `connector_id` on every indexed row so that owner-mode hits can be attributed to a connector for hydration. Insert/update/delete maintenance for a record SHALL include that record's `connector_id`. Reference semantic search results SHALL carry the indexed `connector_id` through to the `search_result.connector_id` field of the public response.

#### Scenario: Records for two connectors are indexed
- **WHEN** records arrive for stream `messages` from connectors `C1` and `C2`, both of which declare `semantic_fields: ["text"]`
- **THEN** the reference's vector index SHALL contain rows attributed to `C1` for `C1`'s records and rows attributed to `C2` for `C2`'s records
- **AND** SHALL NOT silently merge rows under a single shared connector identity

#### Scenario: A search result is attributed to its originating connector
- **WHEN** the reference returns a `search_result` to a caller
- **THEN** that result's `connector_id` SHALL be the `connector_id` recorded on the matching index row at insert time
- **AND** the reference SHALL NOT fabricate `connector_id` from configuration or from the caller's identity

### Requirement: The reference SHALL report `index_state` honestly and rebuild on drift

The reference SHALL persist per-(connector_id, stream) metadata describing the declared `semantic_fields` fingerprint and the backend's `model_id`, `dimensions`, and `distance_metric` at insert time. The reference SHALL detect drift on startup and on every connector registration/update, and SHALL report `index_state` in the capability advertisement honestly.

#### Scenario: `semantic_fields` fingerprint changes
- **WHEN** a manifest update changes the declared `semantic_fields` set for a `(connector_id, stream)` tuple in a way that changes the sorted JSON fingerprint
- **THEN** the reference SHALL report `index_state: "stale"` in the advertisement until a rebuild for that `(connector_id, stream)` restores coverage
- **AND** the reference SHALL rebuild the index for the affected `(connector_id, stream)` and remove stale rows
- **AND** the rebuild SHALL be maintained in JavaScript at the record write/update/delete call sites, not by SQLite triggers

#### Scenario: The configured embedding backend's `model_id` changes
- **WHEN** the configured embedding backend's `model_id` disagrees with the `model_id` persisted in `semantic_search_meta` for any row
- **THEN** the reference SHALL report `index_state: "stale"` in the advertisement until a rebuild restores coverage

#### Scenario: The configured embedding backend's `dimensions` or `distance_metric` changes
- **WHEN** the configured embedding backend's `dimensions` or `distance_metric` disagrees with persisted metadata
- **THEN** the reference SHALL report `index_state: "stale"` in the advertisement until a rebuild restores coverage

#### Scenario: The index is actively rebuilding
- **WHEN** the reference is rebuilding the vector index for any reason
- **THEN** the reference SHALL report `index_state: "building"` in the advertisement until rebuild completes

#### Scenario: Steady state
- **WHEN** no drift signal is active and no rebuild is in progress
- **THEN** the reference SHALL report `index_state: "built"` in the advertisement

### Requirement: The reference's default semantic index SHALL persist across process restarts

The reference's default vector index SHALL store embeddings persistently in the same SQLite database used by the rest of the reference, so that semantic coverage survives process restart. The reference SHALL prefer `sqlite-vec` as the default persistent backend when its SQLite extension can be loaded, and SHALL fall back to a persistent SQLite-BLOB flat backend (same database, `BLOB`-columned table, distance computed in JavaScript) when `sqlite-vec` cannot be loaded. Both backends SHALL implement the same `VectorIndex` interface. Neither backend SHALL require ephemeral in-process state for `capabilities.semantic_retrieval.supported: true`.

#### Scenario: `sqlite-vec` loads successfully at init
- **WHEN** the reference opens its `better-sqlite3` database at startup and `sqliteVec.load(db)` succeeds
- **THEN** the reference SHALL use the `sqlite-vec`-backed `VectorIndex` implementation (a `vec0` virtual table in the same database)
- **AND** the reference SHALL log a startup line identifying the chosen backend as `sqlite-vec`
- **AND** subsequent `upsert`, `delete`, and `query` calls SHALL operate against the `vec0` virtual table

#### Scenario: `sqlite-vec` fails to load at init
- **WHEN** the reference opens its `better-sqlite3` database at startup and `sqliteVec.load(db)` throws (platform has no published binary, the environment forbids loading SQLite extensions, or any other load error)
- **THEN** the reference SHALL NOT crash at startup
- **AND** the reference SHALL log a warning identifying `sqlite-vec` as unavailable and the fallback backend as active
- **AND** the reference SHALL use the persistent SQLite-BLOB flat `VectorIndex` implementation (rows in a standard SQLite table, distance computed in JavaScript)
- **AND** the BLOB-flat backend SHALL expose the same interface and the same persistence semantics as the `sqlite-vec` backend

#### Scenario: Vectors persist across process restart (`sqlite-vec` path)
- **WHEN** the reference ingests records for a participating `(connector_id, stream)` with declared `semantic_fields`, then the process is stopped and a fresh process is started against the same `PDPP_DB_PATH`
- **THEN** the advertisement SHALL report `capabilities.semantic_retrieval.supported: true` with `index_state: "built"` immediately, without running a rebuild
- **AND** `GET /v1/search/semantic` SHALL return hits for previously-ingested records
- **AND** the reference SHALL NOT require re-ingest from the connector to make those records searchable again

#### Scenario: Vectors persist across process restart (BLOB-flat path)
- **WHEN** the reference is forced onto the BLOB-flat fallback and the same stop/start sequence as above is performed
- **THEN** the same end-to-end behavior SHALL hold: `index_state: "built"`, hits return, no re-ingest

#### Scenario: `supported: true` does not depend on ephemeral in-process state
- **WHEN** the reference advertises `capabilities.semantic_retrieval.supported: true`
- **THEN** the advertisement SHALL be backed by a persistent store on disk
- **AND** a clean restart SHALL NOT cause `supported: true` to become `supported: false` absent some other failure

### Requirement: The reference SHALL backfill the semantic index from records on startup without requiring re-ingest

Records are the source of truth for semantic retrieval in the reference. The reference SHALL provide a startup backfill path that detects drift per `(connector_id, stream)` and rebuilds the vector index from records already stored in the `better-sqlite3` database. The backfill SHALL NOT call back into any connector and SHALL NOT require re-ingest of raw data.

#### Scenario: Startup with no drift
- **WHEN** the reference starts and the persisted `semantic_search_meta` fingerprint, `model_id`, `dimensions`, and `distance_metric` all match the currently configured backend, and the row-count band check is satisfied
- **THEN** the reference SHALL advertise `index_state: "built"` immediately
- **AND** the reference SHALL NOT run a rebuild

#### Scenario: Startup after a drift signal
- **WHEN** the reference starts and any drift signal (fingerprint change, backend identity change, or row-count band divergence) is active
- **THEN** the reference SHALL advertise `index_state: "stale"` initially and `index_state: "building"` while the rebuild runs, and SHALL advertise `index_state: "built"` once the rebuild completes
- **AND** the rebuild SHALL read records from the records table and re-embed their declared `semantic_fields` using the currently configured backend
- **AND** the rebuild SHALL NOT call back into the originating connector, re-ingest raw data, or require any network traffic beyond calls to the configured embedding backend for re-embedding

#### Scenario: Historical records become searchable again after restart
- **WHEN** the reference is restarted on a database that already contains records for a participating stream
- **THEN** those historical records SHALL be searchable via `GET /v1/search/semantic` either immediately (no-drift case) or after the startup backfill completes (drift case)
- **AND** the reference SHALL NOT require a connector re-sync to make historical records searchable

### Requirement: The reference SHALL NOT substitute a non-semantic fallback behind `GET /v1/search/semantic`

The reference SHALL NOT produce results on `GET /v1/search/semantic` by invoking lexical retrieval (or any other non-semantic matching path) while emitting `retrieval_mode: "semantic"` or `retrieval_mode: "hybrid"` on those results. When the vector index reports `index_state: "building"` or `"stale"`, or when the embedding backend is otherwise unable to produce honest semantic results, the reference SHALL return zero or partial results rather than substituting a non-semantic fallback. The module `reference-implementation/server/search-semantic.js` SHALL NOT import the lexical retrieval helper.

#### Scenario: The vector index is stale
- **WHEN** `vectorIndex.state()` returns `"stale"`
- **THEN** `GET /v1/search/semantic` SHALL return zero or partial results
- **AND** SHALL NOT invoke the lexical retrieval helper
- **AND** any results returned SHALL still carry `retrieval_mode: "semantic"` (because the reference returns honest semantic results, just fewer of them)

#### Scenario: The vector index is building
- **WHEN** `vectorIndex.state()` returns `"building"`
- **THEN** `GET /v1/search/semantic` SHALL return zero or partial results
- **AND** SHALL NOT invoke the lexical retrieval helper

#### Scenario: The no-fallback invariant is visible in source
- **WHEN** a reader inspects `reference-implementation/server/search-semantic.js`
- **THEN** the file SHALL NOT import from `reference-implementation/server/search.js` (the lexical helper)
- **AND** the no-fallback invariant SHALL be verifiable by a static grep

### Requirement: The reference SHALL realize owner-token semantic retrieval through cross-connector fan-out

The reference scopes owner reads of records and stream metadata per connector. The reference SHALL realize owner-token semantic retrieval by fanning out across every owner-visible connector internally and merging results, so that the public `GET /v1/search/semantic` request shape stays identical for owner-token and client-token callers (no public `connector_id` query parameter). Each `search_result` returned to an owner-token caller SHALL carry the originating connector via `connector_id` so the caller can hydrate the record under the correct per-connector owner read scope. The reference SHALL emit a `record_url` that includes the canonical owner-mode `connector_id` query parameter for owner-token callers.

#### Scenario: An owner searches across two connectors that both expose the same stream name
- **WHEN** an owner-token caller invokes `GET /v1/search/semantic?q=alpha` on a reference instance with two owner-visible connectors `C1` and `C2`, both of which expose a `messages` stream that declares `semantic_fields: ["text"]` and both of which contain a matching record
- **THEN** the response SHALL include hits from BOTH connectors
- **AND** each hit SHALL carry its originating `connector_id` (`"C1"` for hits from `C1`, `"C2"` for hits from `C2`)
- **AND** the response SHALL NOT silently scope to a single connector

#### Scenario: An owner request includes `connector_id`
- **WHEN** an owner-token caller invokes `GET /v1/search/semantic?q=alpha&connector_id=C1`
- **THEN** the reference SHALL reject the request with `invalid_request_error` identifying `connector_id` as the rejected parameter
- **AND** SHALL NOT silently use `connector_id` to scope the search

#### Scenario: An owner-mode `record_url` is hydrated
- **WHEN** an owner-token caller takes the `record_url` from a `/v1/search/semantic` hit and issues a GET against it under the same owner token
- **THEN** the reference SHALL return the canonical record envelope at `GET /v1/streams/{stream}/records/{record_key}` for the connector identified by the URL's `connector_id` query parameter

### Requirement: The reference SHALL produce grant-safe verbatim snippets, never model-generated text

When the reference includes a `snippet` on a `search_result`, the snippet's `text` SHALL be a verbatim contiguous substring of the matched field's stored value for the hit record. The reference SHALL NOT produce snippets by summarizing, paraphrasing, translating, or otherwise synthesizing text via the embedding backend or any other model. If a verbatim excerpt cannot be produced for a hit, the reference SHALL omit the `snippet` from that result rather than fabricate one.

#### Scenario: A snippet is a verbatim substring
- **WHEN** the reference emits a `snippet` on a result for a record whose stored `text` field is a given string `S`
- **THEN** the snippet's `text` SHALL be a contiguous substring of `S`
- **AND** the snippet's `text` SHALL NOT be a paraphrase, summary, translation, or synthesized variant of any portion of `S`

#### Scenario: Snippets drawn from ungranted or undeclared fields are omitted
- **WHEN** a candidate snippet's source field is outside the caller's grant projection OR outside the stream's declared `semantic_fields`
- **THEN** the reference SHALL omit the snippet from that result
- **AND** SHALL NOT substitute a snippet derived from that field by any means

### Requirement: The reference SHALL treat embedding and vector-index backends as pluggable implementation details behind a fixed internal interface

The reference SHALL expose pluggable interfaces for the embedding backend and vector index inside `reference-implementation/server/search-semantic.js`. The reference's default embedding backend SHALL be a deterministic local stub that runs without external network access and identifies itself honestly in the advertisement's `model` field. The reference's default vector index SHALL be persistent across process restarts (see the separate "The reference's default semantic index SHALL persist across process restarts" requirement). Hosted embedding providers and alternate persistent vector backends SHALL be supportable as drop-in replacements without any change to the public contract, the spec delta, or the handler shape.

#### Scenario: The reference runs offline without a configured hosted provider
- **WHEN** the reference is started with the default stub embedding backend and the default persistent vector index
- **THEN** the reference SHALL advertise `capabilities.semantic_retrieval.supported: true` with a truthful `model` identifier that names itself as the reference stub
- **AND** the advertised `model` SHALL NOT impersonate the model identifier of a hosted provider
- **AND** the reference SHALL NOT require network access beyond the local `better-sqlite3` database to serve `GET /v1/search/semantic`

#### Scenario: A hosted provider is configured
- **WHEN** an operator configures a hosted embedding backend that implements the `EmbeddingBackend` interface
- **THEN** the reference SHALL advertise that backend's `model`, `dimensions`, and `distance_metric` in `capabilities.semantic_retrieval`
- **AND** the reference SHALL NOT require a change to the handler, the spec delta, or any other public contract

#### Scenario: The reference SHALL NOT bake hosted-provider credentials into source
- **WHEN** a reader inspects the reference source for the embedding backend
- **THEN** no hosted-provider API key, endpoint, or secret SHALL be code-resident
- **AND** any hosted-provider configuration SHALL come from operator-supplied runtime configuration

### Requirement: The reference SHALL mark `GET /v1/search/semantic` as experimental in source

The reference's source for the public semantic retrieval route SHALL include an inline comment band that identifies the surface as experimental and unstable, and SHALL cross-reference the advertisement's `stability` key and the public docs page. This makes the experimental status visible to any reader of the code, not just the advertisement.

#### Scenario: A reader inspects the semantic retrieval route source
- **WHEN** a reader reads the source for `app.get('/v1/search/semantic', …)` in `reference-implementation/server/index.js`
- **THEN** an inline comment SHALL identify the route as experimental and unstable
- **AND** the comment SHALL cross-reference `capabilities.semantic_retrieval.stability` and the public docs page

### Requirement: The reference SHALL keep `GET /v1/search/semantic` distinct from `GET /v1/search` and from reference-only surfaces

The reference SHALL NOT alias `GET /v1/search/semantic` to `GET /v1/search`, SHALL NOT serve the lexical retrieval contract from `GET /v1/search/semantic`, and SHALL NOT serve the semantic retrieval contract from `GET /v1/search` or from any reference-only surface such as `/_ref/search`. The three surfaces SHALL remain independent.

#### Scenario: A client requests `/v1/search`
- **WHEN** a client calls `/v1/search?q=...`
- **THEN** the response SHALL be the lexical retrieval contract defined by the `lexical-retrieval` extension
- **AND** the response SHALL NOT include `retrieval_mode` (which is a semantic-retrieval-specific field)

#### Scenario: A client requests `/v1/search/semantic`
- **WHEN** a client calls `/v1/search/semantic?q=...`
- **THEN** the response SHALL be the semantic retrieval contract defined by the `semantic-retrieval` extension
- **AND** every result SHALL carry `retrieval_mode: "semantic"` (or, if a future tranche enables hybrid blending, `"hybrid"`)

#### Scenario: A client requests `/_ref/search`
- **WHEN** a client calls `/_ref/search?q=...`
- **THEN** the response SHALL be the existing reference-only spine artifact-and-id-jump shape
- **AND** the response SHALL NOT match the public `search_result` list envelope returned by either `/v1/search` or `/v1/search/semantic`
