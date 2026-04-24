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

Lexical can use `kind: "bm25"` with `higher_is_better`; semantic can use `semantic_distance` or `semantic_similarity` depending on the backend. Typed objects avoid pretending all scores share one scale.

### Advertise score semantics

Capabilities should say whether scores are present and which `kind`/`order` values a server emits. For semantic search, score metadata must be tied to the active model/profile because a model change invalidates score comparability.

### Keep scores post-grant

Scores must be computed only over candidate text visible under the active grant. The result must not disclose hidden matched fields or score contributions from fields outside the grant.

## Acceptance Checks

- Clients can see whether a retrieval endpoint emits scores before querying.
- Returned scores are typed and documented as implementation-relative.
- Tests prove scores are absent or present consistently with advertisement.
- Tests prove hidden fields do not influence or appear in score explanations.
