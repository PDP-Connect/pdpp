## Context

The current query API already has the detailed schema surface: `GET /v1/streams/{stream}` returns source-level stream metadata including schema, primary key, cursor field, relationships, query declarations, and freshness. The missing step is discovering which connector IDs and stream names are visible under a bearer.

In polyfill mode, owner-token reads require `connector_id` on `/v1/streams` and `/v1/streams/{stream}`. `_ref/connectors` exists, but it is a reference control-plane surface, not the public Resource Server contract assistant clients should rely on.

## Decision

Add `GET /v1/connectors` as the minimal public discovery floor.

Response shape:

- list envelope: `{ "object": "list", "data": [...] }`
- connector-backed item: `{ "object": "connector", "connector_id": "...", "source": { ... }, "streams": [...] }`
- provider-native item: `{ "object": "connector", "source": { "binding_kind": "provider_native", "provider_id": "..." }, "streams": [...] }`
- stream summary: existing stream-list summary fields plus `capabilities`

Capability hints are coarse booleans or stable URLs. Full field-level schema/query declarations remain on `GET /v1/streams/{stream}`.

## Auth And Scoping

Owner-token polyfill access returns registered connector IDs visible to the local owner. It includes manifest-declared streams even when a stream has zero stored records, with `record_count: 0`, `last_updated: null`, and `freshness.status: "unknown"`.

Client-token access returns one connector/source item for the grant-bound source. Its `streams[]` contains only grant-authorized streams. It does not expose grant fields, resource selectors, time ranges, client claims, `grant_id`, hidden streams, or unrelated connectors.

Native-provider honesty remains intact: native mode returns a provider-native source descriptor and does not expose internal storage connector IDs as public connector IDs.

## Alternatives Considered

- Full one-shot schema endpoint: rejected for this slice because it duplicates `GET /v1/streams/{stream}` and broadens grant/schema semantics.
- Change owner `GET /v1/streams` to fan out across all polyfill connectors: rejected because that route is already stream-scoped by connector in polyfill mode.
- Tell clients to call `_ref/connectors`: rejected because `_ref` is a reference operator/control surface, not a public bearer-scoped Resource Server surface.

## Acceptance Checks

- `openspec validate define-query-schema-discovery-floor --strict`
- Owner token in polyfill mode can call `GET /v1/connectors` without `connector_id`.
- Client token sees only its grant-bound source and grant-authorized streams.
- Client discovery response does not include field/resource/time-range grant internals.
- Existing `GET /v1/streams` and `GET /v1/streams/{stream}` behavior remains unchanged.
