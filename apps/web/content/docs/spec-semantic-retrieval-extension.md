---
title: "Semantic Retrieval Extension (Experimental)"
description: "Experimental optional PDPP extension defining a semantic retrieval surface at GET /v1/search/semantic. Unstable."
---

> **⚠️ EXPERIMENTAL / UNSTABLE.** This extension is publicly named and discoverable, but explicitly marked `stability: "experimental"`. Breaking revisions are acceptable. Clients that rely on it MUST accept that the contract may change, and SHOULD fall back to the stable [lexical retrieval extension](./spec-lexical-retrieval-extension) where it matters. Servers that advertise it carry a machine-readable `stability: "experimental"` marker that does not disappear silently — see [Stability](#stability).

## Overview

The **semantic retrieval experimental extension** defines a dedicated, optional, grant-safe public surface that lets applications and agents search records by *meaning* across the streams a caller is authorized to read. It is built to close the paraphrase / synonymy / conceptual-similarity gap that lexical retrieval does not: queries like "my bank fees" can match records containing "overdraft charges" when the configured embedding model places them nearby.

It is **not part of core PDPP** and it is **not a replacement for [lexical retrieval](./spec-lexical-retrieval-extension)**. Lexical retrieval remains the stable public retrieval floor; semantic retrieval is additive and revisable. Implementations MAY expose it, and clients MUST NOT assume it exists unless the resource server explicitly advertises it (see [Discovery](#discovery)).

The extension is intentionally **text-query only** in v1. It does not expose raw vector queries, client-supplied embeddings, model-selector parameters, ranking knobs, body-DSL `POST /v1/search/semantic`, portable numeric relevance scores, or connector-specific search semantics — those are explicit non-goals. See [Non-goals](#non-goals).

## Stability

This extension is marked `stability: "experimental"` in v1. That marker is **load-bearing** and is surfaced in three places:

- The server-level advertisement at `/.well-known/oauth-protected-resource` carries `capabilities.semantic_retrieval.stability: "experimental"` (see [Discovery](#discovery)). The marker is mandatory when `supported: true`.
- The reference implementation's source for `GET /v1/search/semantic` carries an inline `// Experimental — public semantic retrieval. Unstable.` comment band.
- This docs page, throughout.

Clients and agents that use this extension:

- MUST read `capabilities.semantic_retrieval.stability` before depending on the surface.
- SHOULD be prepared for breaking revisions during prelaunch.
- SHOULD fall back to lexical retrieval when semantic quality, consistency, or availability matters.

## Authentication and Versioning

Same as every other public PDPP surface:

- `Authorization: Bearer <access_token>` — grant-bound for client tokens; owner-bound for owner self-export.
- `PDPP-Version: <date>` header.
- `Request-Id` echoed on the response.

No new auth scheme. No capability-specific auth. Deployments that want to restrict semantic retrieval do so via grant scope on the normal scope vocabulary, not through a custom semantic-retrieval-only auth path.

## Endpoint

Dedicated, cross-stream:

```
GET /v1/search/semantic
```

The lexical retrieval route `GET /v1/search` is a **sibling surface**, not an alias: its shape is not mutated by this extension.

### Query parameters

| Parameter | Required | Type | Notes |
|---|---|---|---|
| `q` | yes | string | The text query. Opaque to clients beyond "semantic match against authorized declared semantic fields, using the server's declared model". No raw vectors. No client-supplied embeddings. |
| `limit` | no | integer | Default 25, max 100 (or whatever the server advertises via `default_limit` / `max_limit`). |
| `cursor` | no | string | Opaque semantic-search pagination cursor. MUST NOT be reused across surfaces. |
| `streams[]` | no | repeated string | Optional stream-scope narrowing. Grant semantics mirror lexical retrieval: client tokens with an unauthorized stream get `grant_stream_not_allowed`; owner tokens treat `streams[]` as a soft cross-connector filter. |

Every other parameter is rejected with `invalid_request_error` — explicitly including `vector=`, `embedding=`, `model=`/`model_id=`/`model_family=`, `rank=`/`boost=`/`weights=`/`blend=`, `connector_id=`, `filter[...]`, `fields=`, `expand=`, `expand_limit=`, `order=`, `sort=`, `mode=`, and any DSL-shaped or connector-specific parameter.

## Result shape

```json
{
  "object": "list",
  "url": "/v1/search/semantic",
  "has_more": false,
  "next_cursor": "sem1.abc...",
  "data": [
    {
      "object": "search_result",
      "stream": "messages",
      "record_key": "msg_123",
      "connector_id": "https://registry.pdpp.org/connectors/messaging-app",
      "record_url": "/v1/streams/messages/records/msg_123",
      "emitted_at": "2026-04-23T12:34:56Z",
      "matched_fields": ["text"],
      "snippet": { "field": "text", "text": "...overdraft charges..." },
      "retrieval_mode": "semantic"
    }
  ]
}
```

### Required fields on every result

- `object` = `"search_result"` (shared with lexical retrieval — agents do not have to learn two result types).
- `stream` — which stream the match came from.
- `record_key` — which record matched, within that stream.
- `connector_id` — which connector the record came from. Required on every result for per-connector hydration.
- `emitted_at` — the record's emission timestamp. NOT a relevance signal.
- `matched_fields` — the subset of declared `semantic_fields` (∩ the caller's grant projection) that the server attributes the hit to. MAY be empty when the server cannot honestly attribute.
- `retrieval_mode` — the one publicly experimental field. Values in v1 are `"semantic"` (pure vector match) or `"hybrid"` (semantic blended with lexical signal). The reference currently emits `"semantic"` on every result (`lexical_blending: false`); `"hybrid"` is reserved for a future tranche.

### Optional fields

- `record_url` — a ready-made canonical single-record read URL. For owner-token callers on a per-connector RS, includes the canonical owner-mode `connector_id` query parameter. Clients can always reconstruct this from `stream`, `record_key`, and `connector_id`.
- `snippet` — a grant-safe **verbatim contiguous substring** of the matched field's stored value. Never a paraphrase, summary, translation, or synthesized variant. See [Grant safety](#grant-safety).

### What is intentionally absent

- No portable numeric relevance score (`score`, `cosine`, `bm25`, `blend`). Cross-server comparable scores are not a v1 promise.
- No debug / trace fields (`_debug`, `_explain`, `_vector_distance`).

## Grant safety

The extension matches **only** over `(stream, field)` pairs where:

1. The stream is in the caller's grant.
2. The field is readable under the grant's effective field projection for that stream.
3. The stream has declared the field in `query.search.semantic_fields` (see [Discovery](#stream-level)).

Fields outside that intersection are **never** embedded for query matching, never ranked, and never contribute text to snippets — even if the stream declared them in `semantic_fields`. "Embed everything, filter later" is explicitly prohibited by the spec.

Snippets, when present, are drawn **verbatim** from the matched field's stored value under the caller's grant. A snippet is NEVER model-generated text. If a verbatim excerpt cannot be produced for a hit, the server omits the snippet rather than fabricating one.

### Errors

| Condition | HTTP | `error.code` |
|---|---|---|
| Missing `q`, rejected param, invalid shape | 400 | `invalid_request` |
| Missing or invalid access token | 401 | `invalid_token` |
| Client token names a stream outside its grant | 403 | `grant_stream_not_allowed` |
| Cursor predates a backend change / is malformed | 400 | `invalid_cursor` |
| Extension is not advertised on this server | 404 | — |

## Owner-mode semantics

When the caller is an owner token (the resource owner performing self-export rather than a grant-bound third-party client):

- The request shape is **identical** to the client-token request shape. No public `connector_id` query parameter.
- The server fans out across every owner-visible connector internally and merges results deterministically (see [Pagination](#pagination) for the merge-order contract).
- Each `search_result` identifies its originating connector via `connector_id` so the owner can hydrate each hit against the correct per-connector owner read scope.
- `streams[]` is a **soft** filter for owner tokens: naming a stream no owner-visible connector exposes yields zero hits, not an error. (For client tokens the same parameter is a **hard** authorization check.)

A public `connector_id` query parameter is rejected with `invalid_request_error` in both modes in v1.

## Discovery

Two layers, same as lexical retrieval.

### Server-level: extension advertisement

When a server exposes this extension, its RFC 9728 protected-resource metadata document (`/.well-known/oauth-protected-resource`) includes:

```json
{
  "capabilities": {
    "semantic_retrieval": {
      "supported": true,
      "stability": "experimental",
      "endpoint": "/v1/search/semantic",
      "cross_stream": true,
      "query_input": "text",
      "snippets": true,
      "lexical_blending": false,
      "model": "<server-declared-model-id>",
      "dimensions": 768,
      "distance_metric": "cosine",
      "default_limit": 25,
      "max_limit": 100,
      "index_state": "built",
      "language_bias": { "primary": "en", "note": "Model has reduced recall for CJK scripts" }
    }
  }
}
```

Required keys when `supported: true`:

- `supported`, `stability`, `endpoint`, `cross_stream`, `query_input`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, `index_state`.

`stability` is `"experimental"` in v1. `query_input` is `"text"` in v1. `lexical_blending` governs whether `retrieval_mode: "hybrid"` may appear on results.

`index_state` is one of:

- `"built"` — the semantic index is up to date; the extension is serving normally.
- `"building"` — the server is rebuilding; the endpoint MAY return partial or empty results.
- `"stale"` — the declared model or the declared `semantic_fields` have changed in a way that invalidates existing index coverage. The endpoint MAY return zero or partial results while `stale`. The server **MUST NOT** substitute a non-semantic fallback behind a `retrieval_mode: "semantic"` response — it either returns honestly fewer results or returns nothing.

The advertisement is reachable **without** a bearer token (the RS metadata document is itself unauthenticated).

A server that does not expose the extension either omits `capabilities.semantic_retrieval` entirely or publishes it with `supported: false`. Either way, clients treat the extension as unavailable on that server.

### Stream-level: `query.search.semantic_fields`

A stream that participates in semantic retrieval declares its semantic-searchable fields in its existing per-stream metadata:

```json
{
  "query": {
    "search": {
      "lexical_fields": ["text", "subject"],
      "semantic_fields": ["text", "body"]
    }
  }
}
```

v1 constraints:

- Top-level scalar **string** fields only.
- Every entry MUST refer to a field present in the stream's schema.
- No nested paths, no arrays, no blobs, no connector-specific semantics.

`semantic_fields` is **independent** from `lexical_fields`: a field listed in one is not automatically listed in the other. A stream may declare one, the other, both, or neither.

A stream that does not participate in semantic retrieval simply omits `semantic_fields`. Searches that include that stream contribute zero semantic hits from it.

## Pagination

Opaque cursors, distinct from every other surface:

- Semantic-search cursors carry a distinct prefix (`sem1.` in the reference) so they cannot be mistaken for lexical-search, record-list, or `changes_since` cursors. Passing a cursor from another surface here returns `invalid_cursor`, and vice versa.
- Within a single semantic-search session (same `q`, same `streams[]`, same grant), pagination progresses under a stable total order: `(distance, connector_id, scope_key, record_key)`. Pages do not repeat hits and do not skip hits.
- Cursors MAY be rejected as `invalid_cursor` across server restart, index rebuild, model change, grant change, or vendor-defined cursor expiry. Clients recover by issuing a fresh search.

## Ranking

Results are returned in relevance-oriented order. Higher-positioned results SHOULD generally be more relevant to `q` than lower-positioned results. The extension does **not** define a portable numeric score (cosine, L2, BM25, blend, or otherwise) in v1, does not define semantic reranking semantics, and does not define recency blending or per-connector custom weighting as portable contract.

## Non-goals

Explicit non-goals for this tranche:

- **Not core.** Clients MUST NOT assume availability on unadvertised servers.
- **Not cross-server comparable.** Two servers running different models return different results, and the protocol does not pretend otherwise.
- **No portable numeric score.** No `score`, `cosine`, `bm25`, `blend`, or equivalent field.
- **No canonical embedding self-export.** Self-export treatment of derived artifacts is governed separately; this extension does not pre-empt it.
- **No cross-connector entity resolution.** Same-entity-across-connectors is a separate open question.
- **No generalized vector API.** No raw vector queries, no client-supplied embeddings, no ANN-direct surface.
- **Not a replacement for lexical retrieval.** Lexical retrieval remains the stable public retrieval floor.
- **No `POST /v1/search/semantic`** body-DSL in v1.
- **No nested paths, arrays, or blobs** in `semantic_fields`.
- **No connector-specific semantic semantics** on the public surface.

## See also

- [Lexical Retrieval Extension](./spec-lexical-retrieval-extension) — the stable public retrieval floor.
- [Data Query API](./spec-data-query-api) — core record-listing contract.
- The canonical approved spec at `openspec/changes/add-semantic-retrieval-experimental-extension/specs/semantic-retrieval/spec.md`.
