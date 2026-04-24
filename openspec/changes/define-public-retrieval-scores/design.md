## Context

The current reference strips internal lexical BM25 score and semantic distance before returning results. This keeps the API simple, but it blocks useful assistant behavior: thresholding, client-side reranking, explaining why a hit appeared, and comparing semantic-only additions against lexical hits.

## Goals / Non-Goals

Goals:

- Expose scores in a shape that is useful and honest.
- Distinguish lexical and semantic score types.
- Advertise score support so clients do not assume every server emits scores.
- Avoid leaking hidden fields or backend internals.

Non-goals:

- Defining a universal cross-implementation score scale.
- Defining hybrid ranking or a blended endpoint.
- Exposing vectors, token matches, raw SQL rank expressions, or candidate pool sizes.
- Guaranteeing score stability across model changes, index rebuilds, or implementation upgrades.

## Decisions

### Use typed score objects

Prefer a shape like:

```json
{
  "score": {
    "kind": "semantic_distance",
    "value": 0.182,
    "order": "lower_is_better"
  }
}
```

Lexical uses the reference implementation's existing SQLite FTS5 BM25 value:

```json
{
  "score": {
    "kind": "bm25",
    "value": -0.42,
    "order": "lower_is_better"
  }
}
```

Semantic uses the reference implementation's existing vector distance value:

```json
{
  "score": {
    "kind": "semantic_distance",
    "value": 0.182,
    "order": "lower_is_better"
  }
}
```

Typed objects avoid pretending all scores share one scale. The score object carries only `kind`, `value`, and `order`; scale, stability, and comparability limits are advertised in endpoint capability metadata.

### Advertise score semantics

Capabilities should say whether scores are present and which `kind`/`order` values a server emits. Lexical advertises implementation-relative BM25:

```json
{
  "score": {
    "supported": true,
    "kind": "bm25",
    "order": "lower_is_better",
    "value_semantics": "implementation_relative"
  }
}
```

Semantic advertises distance semantics and the identity boundary for comparing values:

```json
{
  "score": {
    "supported": true,
    "kind": "semantic_distance",
    "order": "lower_is_better",
    "value_semantics": "distance",
    "comparable_with": {
      "profile_id": "minilm",
      "model": "Xenova/all-MiniLM-L6-v2",
      "dtype": "q4",
      "dimensions": 384,
      "distance_metric": "cosine",
      "backend_identity": "profile=minilm;model=Xenova/all-MiniLM-L6-v2;dtype=q4;dimensions=384;metric=cosine"
    }
  }
}
```

For semantic search, score metadata must be tied to the active model/profile/backend identity because a model, dtype, dimensions, or distance-metric change invalidates score comparability.

### Emit by default when advertised

The reference implementation has no separate useful score feature gate: both retrieval routes already compute the ranking signal needed to order results. Default-on emission is correct because the metadata advertisement and result shape stay consistent, and the score is computed after grant field narrowing. Tests still cover the fork/server-fixture case where capability metadata omits `score`; in that case results omit `score` too.

### Keep scores post-grant

Scores must be computed only over candidate text visible under the active grant. The result must not disclose hidden matched fields or score contributions from fields outside the grant.

## Acceptance Checks

- Clients can see whether a retrieval endpoint emits scores before querying.
- Returned scores are typed and documented as implementation-relative.
- Tests prove scores are absent or present consistently with advertisement.
- Tests prove hidden fields do not influence or appear in score explanations.
