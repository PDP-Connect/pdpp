## Shape

Expose a separate endpoint rather than changing lexical retrieval:

```text
GET /v1/search/hybrid
```

The endpoint accepts the shared retrieval query subset:

- `q`
- `limit`
- `cursor`
- repeated `streams[]`
- single-stream `filter[...]` with the same restriction as lexical and semantic search

It does not accept client embeddings, model selectors, boost knobs, arbitrary weights, `connector_id`, `fields`, `expand`, or sort parameters.

## Merge Semantics

The implementation should call the existing lexical and semantic planners under the same grant plan, deduplicate by `(connector_id, stream, record_key)`, and return one `search_result` per record.

Each result should expose provenance:

```json
{
  "retrieval_mode": "hybrid",
  "retrieval_sources": ["lexical", "semantic"],
  "scores": {
    "lexical": { "...": "existing lexical score object" },
    "semantic": { "...": "existing semantic score object" }
  }
}
```

Exact score-combination math is intentionally not portable in the first tranche. The response may include implementation-relative ordering metadata, but it must not pretend to expose a universal hybrid score.

## Pagination

Hybrid pagination must be honest. Acceptable implementation strategies:

- snapshot candidate IDs and page that snapshot with an opaque hybrid cursor
- or reject cursor support until a correct snapshot can be implemented

Do not expose offset-only pagination over independently changing lexical and semantic result sets unless the cursor encodes the snapshot identity.

## Dashboard

The dashboard may continue to blend client-side until the API endpoint is implemented. Once implemented, the dashboard should prefer the hybrid endpoint when advertised.

## Non-Goals

- No client-controlled weights in the first tranche.
- No cross-model score comparability claim.
- No change to `/v1/search` or `/v1/search/semantic`.
- No expansion/hydration of full records.
