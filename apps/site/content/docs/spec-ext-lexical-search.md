---
title: "Extension Profile: Lexical Search"
description: "Optional companion profile to the Personal Data Portability Protocol (PDPP) core spec defining a discoverable, grant-safe lexical (full-text) search surface."
---

<Callout type="info" title="Spec status">
  Status: **Draft extension profile**

  Optional; not required for PDPP Core conformance. Implementations advertise support via declared capabilities (per Core §11 Extensions).

  Date: 2026-07-06
</Callout>

Companion to the Personal Data Portability Protocol (PDPP) core spec. This is an optional extension profile: it defines an additive capability and does not alter Core semantics.

---

## 1. Scope

This profile defines an optional lexical (full-text) search capability exposed at `GET /v1/search`: its capability advertisement, request surface, response envelope, grant-enforcement obligations, and error and recall-disclosure semantics. It defines lexical matching only — a discoverable, keyword-oriented search over stream-declared searchable text fields.

Core's exclusion of full-text search from the v0.1 base query surface is **unchanged**. This profile is additive and optional: a resource server that does not advertise `capabilities.lexical_retrieval.supported: true` is fully Core-conformant and MAY return `404` / `not_found` for `GET /v1/search`. A grant issued under Core authorizes exactly what Core Sections 6 and 8 define; this profile does not widen that authorization. It does **not** define semantic/vector retrieval, ranking-control parameters, a portable numeric relevance score, a generic predicate DSL, or connector-specific search semantics; those are out of scope and, if requested, MUST be rejected (§5).

## 2. Capability advertisement

A resource server that exposes this profile MUST publish a `capabilities.lexical_retrieval` object inside its existing resource-server metadata document (the same document used to publish OAuth-shaped metadata). The advertisement describes only global facts about the extension; it MUST NOT enumerate per-stream searchable fields and MUST NOT require a bearer token to read. Lexical search is advertised in the top-level `capabilities` object because it is a server-scoped capability — one endpoint spanning streams; stream-scoped capabilities (such as aggregation, whose available operations and fields depend on each stream's declared schema) are instead advertised in that stream's metadata under `query`.

```json
{
  "capabilities": {
    "lexical_retrieval": {
      "supported": true,
      "endpoint": "/v1/search",
      "cross_stream": true,
      "snippets": true,
      "default_limit": 25,
      "max_limit": 100,
      "score": {
        "supported": true,
        "kind": "bm25",
        "order": "lower_is_better",
        "value_semantics": "implementation_relative"
      }
    }
  }
}
```

| Field | Type | Requirement |
|-------|------|-------------|
| `supported` | boolean | MUST be `true` when the extension is exposed. When absent or `false`, clients MUST treat the extension as unavailable and MUST NOT assume `GET /v1/search` exists. |
| `endpoint` | string | MUST be a path resolvable on the same resource server. MUST be `/v1/search` unless the server is mounted under a path prefix, in which case the prefix MUST be reflected. |
| `cross_stream` | boolean | Whether a single search MAY match across multiple streams. |
| `snippets` | boolean | Whether results MAY carry a `snippet`. |
| `default_limit` | integer | The page size applied when the client omits `limit`. |
| `max_limit` | integer | The maximum `limit` the server accepts. |
| `score` | object | OPTIONAL. A server MUST advertise score support here before emitting scores on results. When present with `supported: true`, it MUST identify the score `kind` and the ordering direction (`order`), and results carry a typed `score` object (§3). Score values are implementation-relative unless a later revision defines portable calibration; clients MUST NOT compare values across servers or implementation changes. |

A server that does not implement this profile MUST either omit `capabilities.lexical_retrieval` or include it with `supported: false`. Per-stream searchable fields are discovered separately, through `query.search.lexical_fields` in each stream's metadata at `GET /v1/streams/{stream}`; a stream that does not participate omits `query.search` entirely.

## 3. Interface

### `GET /v1/search`

Lexical-only search over the caller's grant. The endpoint returns a list envelope of `search_result` candidate references (not hydrated records). Authentication and versioning follow the Core data query API: bearer token plus the `PDPP-Version` header; both client tokens (grant-bound third parties) and owner tokens (the resource owner performing self-export) are accepted, and the request shape is identical for both.

| Parameter | Type | Requirement |
|-----------|------|-------------|
| `q` | string | REQUIRED. The lexical query. A request without `q` MUST be rejected with `invalid_request`. |
| `streams[]` | string (repeatable) | OPTIONAL. Narrows the search to the named streams. When omitted, the server MUST search every stream the caller may search (across every owner-visible connector for owner-token callers). For client tokens, an entry naming a stream outside the grant MUST be rejected with `grant_stream_not_allowed`; for owner tokens, `streams[]` is a soft filter — naming a stream no owner-visible connector exposes yields zero hits, not an error. |
| `limit` | integer | OPTIONAL. Page size. MUST NOT exceed the advertised `max_limit`; when omitted, the server applies `default_limit`. |
| `cursor` | string (opaque) | OPTIONAL. A `next_cursor` returned by a prior page, passed back verbatim. The server MUST treat it as opaque. Search cursors MUST NOT be reused as record-list or `changes_since` cursors. |

Ranking-control (`rank`, `boost`), semantic/vector (`embedding`, `vector`, `semantic`), connector-specific search operators, and a public `connector_id` parameter MUST be rejected (§5). Results are returned in relevance-oriented order: higher-ranked results SHOULD be at least as relevant to `q` as lower-ranked results. No portable numeric relevance score is defined in v1; a typed, implementation-relative `score` MAY be emitted only when advertised (§2).

### Response envelope

Each `data[]` entry is a `search_result`. A result MUST include `stream`, `record_key`, `emitted_at`, and `connector_id`, and MUST NOT include the full record payload or a portable numeric relevance score. `matched_fields` MUST be a non-empty subset of the stream's declared-and-authorized searchable fields. `snippet` and `record_url` are OPTIONAL; a server MAY omit either on any individual result without changing the rest of the response shape.

```json
{
  "object": "list",
  "data": [
    {
      "object": "search_result",
      "stream": "messages",
      "record_key": "msg_01JQXA3N9Y",
      "connector_id": "https://registry.pdpp.org/connectors/gmail",
      "emitted_at": "2026-05-14T09:12:04Z",
      "matched_fields": ["text", "subject"],
      "snippet": { "field": "text", "text": "…confirmed the overdraft fee refund…" },
      "score": { "kind": "bm25", "value": -0.42, "order": "lower_is_better" },
      "record_url": "/v1/streams/messages/records/msg_01JQXA3N9Y"
    }
  ],
  "has_more": true,
  "next_cursor": "c2VhcmNoOjE6...",
  "meta": {
    "count": 42,
    "count_accuracy": "exact",
    "recall": {
      "complete": true,
      "ranking_scope": "all_matches",
      "truncated": false
    }
  }
}
```

**`record_url`.** When present, it MUST resolve to the canonical single-record read endpoint `GET /v1/streams/{stream}/records/{record_key}` for the same `stream` and `record_key`, and MUST NOT point to a different retrieval surface. For owner-token callers on a server that scopes owner record reads per connector, the URL MUST include the owner-mode `connector_id` query parameter for that connector. When omitted, the client reconstructs the canonical read URL from `stream`, `record_key`, and (for owner-token callers) `connector_id`.

**`snippet`.** When present, a `{ field, text }` pair: `field` MUST name one of the result's `matched_fields`, and `text` MUST contain only substrings drawn from grant-authorized, declared-searchable fields (§4).

**`score`.** Emitted only when the advertisement carries `score.supported: true` (§2); clients MUST NOT assume score fields otherwise. A typed object identifying the score `kind`, its implementation-relative `value`, and the ordering direction (`order`). Scores MUST be computed only from fields visible under the active grant, and no score explanation may disclose a hidden field.

**Pagination.** When `has_more` is `true`, the response MUST include a `next_cursor` that the client passes back as `cursor`. Within a single search session (same `q`, same `streams[]`, same grant) pagination MUST progress stably enough to avoid obvious duplication and infinite loops, but does not promise monotonic timestamp ordering, durability across restarts, or stability across grant changes or index rebuilds.

**Recall metadata.** `meta` MUST include `count`, `count_accuracy`, and `recall`. `count_accuracy` MUST be one of `exact`, `lower_bound`, `estimated`, or `not_counted`; when `not_counted`, `count` MUST be `null`, otherwise `count` MUST be a non-negative integer interpreted by `count_accuracy`. `meta.recall` MUST include `complete` (whether all known caller-visible matches were ranked before pagination), `ranking_scope` (one of `all_matches`, `candidate_window`, `unknown`), and `truncated` (whether a candidate/source window prevented representing every caller-visible match). Clients MUST NOT infer global recall completeness from `has_more`. When an implementation uses a bounded candidate window and can prove them cheaply, it MAY expose compact window facts under `meta.recall` (`ranked_candidate_count`, `candidate_window_limit`, `sources_searched_count`, `truncated_source_count`); it MUST NOT fabricate a fact it cannot prove.

## 4. Grant enforcement

The server MUST search only over `(stream, field)` pairs where the stream is in the caller's grant, the field is readable under the grant's effective field projection for that stream, and the stream declares the field in `query.search.lexical_fields`. Fields outside that intersection MUST NOT contribute to matching, ranking, scores, `matched_fields`, or snippets.

- A field that is authorized but not declared searchable MUST NOT be matched; a field that is declared searchable but not authorized MUST NOT be matched, and its text MUST NOT appear in any `snippet`.
- A stream that contributes zero searchable-and-authorized fields MUST contribute zero hits, and the response MUST NOT signal a per-stream error for this case.
- Snippet text MUST contain only substrings drawn from fields the caller is authorized to read AND that the stream declares searchable.
- Enforcement MUST be structural, not filter-later: an implementation MUST NOT match against unauthorized fields and then post-filter unauthorized hits out of the result list as its enforcement strategy.
- For owner-token callers, the search runs across every owner-visible connector; the grant-safety, declared-searchable-field, and snippet-safety invariants apply per connector identically. There is no public `connector_id` request parameter in v1; each `search_result` carries `connector_id` so the caller can hydrate the hit against the correct per-connector read scope.

Excluded streams, fields, connectors, and records MUST NOT contribute to `meta.count` or `meta.recall` window facts, and the metadata MUST NOT enumerate unavailable connectors, streams, fields, or records.

## 5. Errors and warnings

Errors reuse Core's structured error envelope (`{ "error": { type, code, message, param?, request_id } }`). This profile introduces no new codes.

| Condition | Code | HTTP | Type |
|-----------|------|------|------|
| Endpoint requested but extension unadvertised | `not_found` | 404 | `not_found_error` |
| Missing `q` | `invalid_request` | 400 | `invalid_request_error` |
| Client-token `streams[]` entry names a stream outside the grant | `grant_stream_not_allowed` | 403 | `permission_error` |
| `connector_id` passed on the public surface (v1) | `invalid_request` | 400 | `invalid_request_error` |
| `rank`, `boost`, or similar ranking-control parameter | `invalid_request` | 400 | `invalid_request_error` |
| `embedding`, `vector`, `semantic`, or any vector/semantic-shaped parameter | `invalid_request` | 400 | `invalid_request_error` |
| Connector-specific search operator | `invalid_request` | 400 | `invalid_request_error` |
| Stale/expired/rebuilt-index search cursor | `invalid_cursor` | 400 | `invalid_request_error` |

Rejected parameters MUST NOT be silently honored or silently mapped to lexical behavior. On `invalid_cursor`, the client recovers by issuing a fresh search. Non-complete recall is disclosed via `meta.recall` (§3), not via an error.

## 6. Conformance checklist

An implementation claiming this profile MUST satisfy:

1. It publishes `capabilities.lexical_retrieval` with `supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit`, readable without a bearer token, and does not enumerate per-stream `lexical_fields` there.
2. `GET /v1/search` returns a list envelope whose `data[]` entries are `search_result` objects carrying `stream`, `record_key`, `emitted_at`, and `connector_id`, with no full record payload and no portable numeric relevance score.
3. `matched_fields` is always a non-empty subset of the stream's declared-and-authorized searchable fields.
4. Snippets, when present, are `{ field, text }` pairs whose `field` names a `matched_fields` entry and whose `text` contains only substrings from authorized-and-declared searchable fields.
5. Search is restricted to the (in-grant stream × authorized field × declared `lexical_fields`) intersection, enforced structurally rather than by post-filtering.
6. Owner-token callers search across all owner-visible connectors with no public `connector_id` parameter; each result identifies its originating connector.
7. Pagination uses an opaque `next_cursor` that is not interchangeable with record-list or `changes_since` cursors; a stale cursor yields `invalid_cursor`.
8. Every response carries `meta.count`, `meta.count_accuracy` (`exact` | `lower_bound` | `estimated` | `not_counted`), and `meta.recall` (`complete`, `ranking_scope`, `truncated`) honestly; `has_more` is never used to infer recall completeness.
9. Ranking-control, semantic/vector, connector-specific, and public `connector_id` parameters are rejected with `invalid_request` and never silently honored; a client-token `streams[]` entry outside the grant is rejected with `grant_stream_not_allowed`, while owner-token `streams[]` acts as a soft filter.
10. Result `score` objects are emitted only when `capabilities.lexical_retrieval.score` advertises support, identify `kind` and `order`, are computed only from grant-visible fields, and are treated as implementation-relative (no cross-server comparison).
11. When the extension is unadvertised, `GET /v1/search` MAY return `404` / `not_found`, and the server remains Core-conformant.
