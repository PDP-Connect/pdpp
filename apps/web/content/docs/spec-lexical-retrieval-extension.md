---
title: "Lexical Retrieval Extension"
description: "Optional PDPP extension defining the public lexical retrieval surface at GET /v1/search."
---

## Overview

The **lexical retrieval extension** defines a small, optional, discoverable, grant-safe public surface that lets applications and agents search records by text across the streams a caller is authorized to read. It is **not part of core PDPP**: implementations MAY expose it, and clients MUST NOT assume it exists unless the resource server explicitly advertises it (see [Discovery](#discovery)).

The extension is intentionally lexical-only in v1. It does not expose semantic / vector retrieval, embeddings, body-DSL `POST /v1/search`, portable numeric relevance scores, or connector-specific search semantics — those are out of scope. See [Non-goals](#non-goals).

For the long-form contract, see the canonical spec at `openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md` in the repo. This page is the developer-facing companion.

## Authentication and Versioning

Same as the [Data Query API](./spec-data-query-api):

```
Authorization: Bearer <access_token>
PDPP-Version: 2026-03-28
```

Both **client tokens** (third-party apps holding a grant) and **owner tokens** (the resource owner performing self-export) are accepted. Per-mode behavior differs (see [Owner-mode semantics](#owner-mode-semantics)) but the request shape is identical.

`Request-Id` is echoed in the response.

## Endpoint

```
GET /v1/search
```

A dedicated cross-stream search endpoint. The reference's `_ref/search` is a separate, reference-only operator-jump helper for traces / grants / runs and **is not** the public lexical retrieval surface — the two share neither shape nor backing.

### Query parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `q` | string | **Required.** The lexical query. |
| `limit` | integer | Page size. Default 25, max 100. |
| `cursor` | string | Opaque pagination cursor from a previous response's `next_cursor`. Search cursors are **not** interchangeable with record-list cursors and **not** with `changes_since` values. |
| `streams[]` | string (repeated) | Optional stream-scope narrowing. Omit to search every authorized stream that participates in the extension. See [Owner-mode semantics](#owner-mode-semantics) for the per-mode meaning. |

**Anything else is rejected** with `invalid_request_error`. In particular:

- `connector_id` is **not** a public parameter on this surface in v1. Owner-mode search fans out across all owner-visible connectors internally; each result carries the originating `connector_id` so clients can hydrate.
- `filter[…]`, `fields`, `expand[]`, `expand_limit[…]`, `order=`, `rank=`, `boost=`, embedding/vector/semantic params, and connector-specific semantics are explicitly out of scope.

## Result shape

```json
{
  "object": "list",
  "url": "/v1/search",
  "has_more": true,
  "next_cursor": "<opaque>",
  "data": [
    {
      "object": "search_result",
      "stream": "messages",
      "record_key": "msg_123",
      "connector_id": "https://registry.pdpp.org/connectors/messaging-app",
      "record_url": "/v1/streams/messages/records/msg_123",
      "emitted_at": "2026-04-23T12:34:56Z",
      "matched_fields": ["text"],
      "snippet": { "field": "text", "text": "…overdraft fee…" }
    }
  ]
}
```

### Required fields on every result

- `object: "search_result"`
- `stream`
- `record_key`
- `connector_id` — required because the resource server scopes owner reads per connector. Even client-token callers receive `connector_id` (it mirrors the connector identity already encoded in the grant).
- `emitted_at`
- `matched_fields` — a non-empty subset of the stream's declared `query.search.lexical_fields` intersected with the caller's authorized fields.

### Optional fields

- `record_url` — when present, resolves to the canonical `GET /v1/streams/{stream}/records/{record_key}` endpoint. For owner-token callers on a per-connector resource server (the reference today), the URL includes `?connector_id=<canonical>`.
- `snippet` — a `{ field, text }` pair drawn from a `matched_fields` entry. Implementations MAY omit `snippet` per result. **Snippet text never quotes ungranted field content** — see [Grant safety](#grant-safety).

### What is intentionally absent

- **No portable numeric relevance score.** Results are returned in relevance-oriented order, but the extension does not freeze a portable scoring formula in v1.
- **No hydrated record payload.** The extension returns candidate references; clients use the existing single-record read endpoint (or the `record_url`) to hydrate.

## Grant safety

For caller `C` and grant `G`, the extension searches only over `(stream, field)` pairs where:

1. `stream` is in `G`,
2. `field` is readable under `G`'s effective field projection for `stream`, AND
3. `stream` declares `field` in its `query.search.lexical_fields`.

Concretely:

- Streams outside the grant contribute zero hits.
- Fields outside the grant projection are **never searched** for the caller (no "filter-later" pattern).
- `matched_fields` is a non-empty subset of the searchable ∩ authorized intersection.
- `snippet.text` contains only substrings drawn from that intersection.
- A stream whose searchable ∩ authorized intersection is empty contributes zero hits, **and the response does not signal a per-stream error** for that case.

### Errors

Same error envelope as the [Data Query API](./spec-data-query-api#errors).

| Code | HTTP | When |
|------|------|------|
| `invalid_request` | 400 | Missing `q`, unsupported v1 parameter (e.g. `connector_id`, `filter[…]`, `rank`), or `streams[]` required because the server's advertisement reports `cross_stream: false`. |
| `grant_stream_not_allowed` | 403 | **Client tokens only.** A `streams[]` entry names a stream not in the grant. |
| `invalid_cursor` | 410 | Cursor refers to an expired or unknown snapshot. |

Owner-token `streams[]` is **not** a hard authorization check — naming a stream that no owner-visible connector exposes simply yields zero hits.

## Owner-mode semantics

The reference implementation (and other resource servers that scope owner reads per connector) handles owner-token search as follows:

- The request shape is identical to client-token search. There is **no public `connector_id` parameter** in v1.
- The server fans out across every owner-visible connector internally and merges results.
- `streams[]` is a soft filter: it narrows to a stream name shared across owner-visible connectors. Naming a stream that no owner-visible connector exposes yields zero hits, **not an error**.
- Each `search_result` carries `connector_id` so the caller can hydrate each hit through the correct per-connector owner read scope.
- `record_url`, when emitted, includes `?connector_id=<canonical>` so a plain GET against the URL hits the correct per-connector scope.

For **client tokens**, search is naturally scoped to the connector encoded in the grant; `connector_id` on results mirrors that grant identity.

## Discovery

### Server-level: extension advertisement

The extension advertises itself in the resource-server metadata document (RFC 9728) under a `capabilities.lexical_retrieval` block:

```json
{
  "resource": "https://example.com",
  "...": "...",
  "capabilities": {
    "lexical_retrieval": {
      "supported": true,
      "endpoint": "/v1/search",
      "cross_stream": true,
      "snippets": true,
      "default_limit": 25,
      "max_limit": 100
    }
  }
}
```

When `supported: true`, all six keys (`supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, `max_limit`) are required. The advertisement is reachable without a bearer token.

A resource server that does not expose the extension SHALL omit `capabilities.lexical_retrieval` entirely or set `supported: false`. Clients MUST NOT assume `/v1/search` is available unless the advertisement says so.

### Stream-level: `query.search.lexical_fields`

Each participating stream declares its searchable fields in its existing per-stream metadata (`GET /v1/streams/{stream}`):

```json
{
  "object": "stream_metadata",
  "name": "posts",
  "query": {
    "search": {
      "lexical_fields": ["title", "selftext"]
    }
  }
}
```

v1 accepts only top-level scalar string fields declared in the stream's `schema.properties`. Nested paths, arrays, blob references, and unknown fields are rejected by the manifest validator. A stream that does not participate in lexical retrieval SHALL omit `query.search` entirely (there is no "search-aware but searches nothing" form).

The advertisement does **not** enumerate per-stream fields; clients discover them through the existing stream-metadata endpoint.

## Pagination

```
?cursor=<opaque>
```

Pagination is opaque. Cursors are **not** interchangeable with record-list (`/v1/streams/.../records?cursor=…`) or `changes_since` cursors. Within a single search session (same `q`, same `streams[]`, same grant) cursoring is stable enough to avoid duplication and infinite loops; across server restart, snapshot expiry, or grant change the cursor MAY return `invalid_cursor` and the client recovers by issuing a fresh search.

The cursor format is implementation-defined — clients MUST treat it as opaque.

## Ranking

Results are returned in relevance-oriented order. Higher-positioned results SHOULD generally be more relevant than lower-positioned results. The extension intentionally does **not** define a portable numeric score, semantic reranking, recency blending, or per-connector custom weighting in v1.

## Non-goals

Out of scope for v1; future extensions or revisions may address them separately:

- Semantic / vector retrieval.
- Embeddings or embedding versioning.
- Cross-connector entity resolution.
- Generic boolean / predicate query DSL.
- Connector-specific search semantics on the public surface.
- A portable numeric relevance score.
- A `POST /v1/search` body-DSL surface (reserved as a possible future extension).
- Mandatory promotion of this extension to core PDPP.

## See also

- [Data Query API](./spec-data-query-api) — the core record-read contract this extension complements.
- Approved spec: `openspec/changes/add-lexical-retrieval-extension/specs/lexical-retrieval/spec.md`.
- Implementation tranche: `openspec/changes/implement-lexical-retrieval-extension/`.
