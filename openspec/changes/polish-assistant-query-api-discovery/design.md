## Context

The current implementation already exposes most primitives the assistant asked for:

- record and search range filters are declaration-gated and tested
- `changes_since=beginning` creates the initial bookmark
- stream metadata includes `field_capabilities`, `expand_capabilities`, `query.range_filters`, and `query.aggregations`
- blobs are fetched through `blob_ref.fetch_url`, not through an attachment-specific endpoint
- aggregations live at `GET /v1/streams/:stream/aggregate`

The problem is discoverability. A caller currently needs to know connector IDs, stream names, parameter spelling, and endpoint placement before it can learn the detailed capability model.

## Design

Add a public RS discovery endpoint:

```text
GET /v1/schema
```

The endpoint returns the caller-visible source/stream capability graph. For owner tokens in polyfill mode, it lists every owner-visible connector and stream without requiring `connector_id`. For client tokens, it is limited to the grant's source and streams. Each stream entry reuses the existing stream metadata builders where possible.

The response should include:

- connector/source identity
- stream name, primary key, cursor field, consent time field, record count, freshness
- schema
- relationships
- `query` declarations
- `field_capabilities`
- `expand_capabilities`

Do not create a second field-capability computation path. Use the same functions that power `GET /v1/streams/:stream`, or extract those functions if needed.

## Error/Docs Polish

The assistant's observed 404/400s should become self-service:

- Document that search filters require `streams[]=one_stream`, not `filter[stream]` or `filter[connector_id]`.
- Document that attachment bytes are discovered from record `data.blob_ref.fetch_url`; there is no `/attachments/:id/content` endpoint in this reference.
- Document `GET /v1/streams/:stream/aggregate?metric=count|sum|min|max&field=...&group_by=...`.
- Document `changes_since=beginning` as the first-sync bootstrap path.
- Keep 404s for truly absent endpoints, but prefer `invalid_request` guidance when the caller is on a valid endpoint with wrong params.

## Non-Goals

- No hybrid search ranking.
- No new filter grammar.
- No attachment text extraction, OCR, PDF parsing, or generic file conversion.
- No graph traversal or nested expansion.

## Acceptance

- A caller with only an owner token can discover all first-party polyfill connectors and their query capabilities through one RS call.
- A caller with a client token sees only the grant-scoped source/streams.
- Existing per-stream metadata tests still pass.
- The docs/cookbook contain copy-pasteable examples for the assistant's observed failure cases.
