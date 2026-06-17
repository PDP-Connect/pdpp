## Context

`GET /v1/search` is already the public lexical retrieval surface and returns a list envelope with `data[]`, `has_more`, and optional `next_cursor`. The reference implementation now uses bounded candidate windows in some fan-in paths to keep latency acceptable on large personal stores. That is operationally reasonable as an interim implementation, but the current public envelope does not disclose whether ranking considered all matching candidates or a bounded subset.

The SLVP-ideal final ranking path remains BM25/pg_search-style global top-k without a recall cap. This change does not claim the bounded-window implementation is ideal. It makes the current and future implementations honest by exposing count accuracy and recall-window facts until the BM25 path removes the compromise.

## Goals / Non-Goals

**Goals:**

- Add an additive `meta` object to lexical search list responses.
- Expose `meta.count` and `meta.count_accuracy` so clients can distinguish exact counts from lower bounds, estimates, and uncounted searches.
- Expose `meta.recall` so clients can tell whether results were ranked over all known matches or over a bounded candidate window.
- Keep metadata compact and grant-safe; no per-record explanations, no internal SQL details, and no unauthorized connector/stream leakage.
- Preserve existing pagination and `data[]` result shape.

**Non-Goals:**

- Replace the bounded candidate window with BM25/pg_search in this tranche.
- Add portable score semantics beyond the score-advertisement contract that already exists.
- Add a client ranking knob or a `connector_id` query parameter to `/v1/search`.
- Require exact counts for every implementation.

## Decisions

### 1. Use list-envelope `meta`, not result-level fields

Recall completeness is a property of the page/query execution, not of each hit. Adding result-level fields would be noisy and would not explain missing hits. The response SHALL use:

```json
{
  "object": "list",
  "data": [],
  "has_more": false,
  "meta": {
    "count": 123,
    "count_accuracy": "exact",
    "recall": {
      "complete": true,
      "ranking_scope": "all_matches",
      "truncated": false
    }
  }
}
```

### 2. Count accuracy is explicit

`meta.count` is only meaningful with `meta.count_accuracy`.

- `exact`: `count` is the exact number of matching candidates visible to the caller.
- `lower_bound`: `count` is a minimum known number of matching candidates; additional matches may exist.
- `estimated`: `count` is approximate.
- `not_counted`: `count` is `null` and the server did not compute a count.

This avoids both false precision and a token-heavy error/warning block.

### 3. Recall disclosure is about the ranking input, not pagination

`has_more` says there is another page in the current result set. It does not say whether the result set itself was complete before pagination. `meta.recall.complete` covers that separate question.

`meta.recall.ranking_scope` SHALL use a small vocabulary:

- `all_matches`: the implementation ranked all known matching candidates.
- `candidate_window`: the implementation ranked a bounded subset.
- `unknown`: the implementation cannot honestly state the ranking scope.

When `ranking_scope` is `candidate_window`, the server SHOULD include compact window facts such as `ranked_candidate_count`, `candidate_window_limit`, `truncated_source_count`, and `sources_searched_count` where available. These are response-level facts, not a per-source dump.

### 4. Grant safety applies to metadata too

Counts and window facts SHALL be computed only over the caller-visible search scope. For client grants, unauthorized streams and fields must not contribute to counts. For owner fan-in, source counts may summarize only the sources that were actually searched under the owner-visible scope. The metadata SHALL NOT enumerate unavailable connectors or streams.

### 5. MCP should mirror, not reinterpret

The MCP search tool should carry compact recall metadata from `/v1/search` into `structuredContent.data` and concise text output. The MCP adapter should not invent completeness or count facts from `has_more`; it should mirror the RS envelope.

## Risks / Trade-offs

- **Risk: callers treat `lower_bound` as exact** -> Put `count_accuracy` beside `count` and test text rendering for non-exact values.
- **Risk: metadata grows into debug output** -> Keep the contract to compact aggregate fields; do not list every source by default.
- **Risk: implementation cannot compute count cheaply** -> Permit `not_counted` with `count: null`; honesty is better than slow exactness.
- **Risk: this normalizes the bounded-window compromise** -> The design explicitly labels `candidate_window` as incomplete and keeps BM25/pg_search as the separate restoration path.

## Migration Plan

1. Add the operation-level response metadata shape and tests.
2. Have SQLite and Postgres lexical search builders fill exact, lower-bound, or not-counted metadata according to what they can prove cheaply.
3. Update host route tests and MCP mirror tests.
4. Verify broad/common-term searches return `candidate_window` metadata when the candidate cap is active.
5. Leave older clients unaffected; `meta` is additive.

## Open Questions

None blocking. The BM25/pg_search work remains a separate restoration change.
