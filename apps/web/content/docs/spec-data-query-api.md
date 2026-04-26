---
title: "Data Query API"
description: "Companion to the Personal Data Portability Protocol (PDPP) core spec."
---

## Overview

This spec defines the HTTP API for reading personal data from a PDPP resource server. It is the app-facing interface: how applications and agents retrieve records authorized by a grant.

The design follows Stripe's API conventions: cursor-based pagination, expandable relationships, structured errors, and date-based versioning. REST is the primary interface; GraphQL is not used (grant enforcement, field-level authorization, cursor pagination, and request signing are all materially simpler with predictable REST endpoints).


## Authentication and Versioning

### Authentication

Every request includes an access token bound to a specific grant:

```
Authorization: Bearer <access_token>
```

How the token is issued and how it's bound to a grant is the authorization server's concern. The resource server resolves the token to a grant and enforces the grant's constraints on every request.

### Versioning

Date-based, via header:

```
PDPP-Version: 2026-03-28
```

The response echoes the version. Every response includes a `Request-Id` header for debugging.


## Endpoints

### Discover the schema (one shot)

```
GET /v1/schema
```

Returns the caller-visible source/stream capability graph in a single response. Owner tokens see every owner-visible connector and stream — no `connector_id` needed. Client tokens see only the source and streams authorized by the grant.

Each per-stream entry uses the same shape as `GET /v1/streams/{stream}`: `schema`, `primary_key`, `cursor_field`, `consent_time_field`, `query` (declared filters / aggregations / expansion), `field_capabilities`, `expand_capabilities`, and `freshness`. Use `field_capabilities[<field>]` to learn which exact filters, range filters, lexical/semantic search fields, and aggregation operators are valid for each field without trial-and-error errors.

**Response (excerpt):**
```json
{
  "object": "schema",
  "bearer": { "token_kind": "owner", "scope": "owner" },
  "connectors": [
    {
      "object": "connector",
      "connector_id": "conn_spotify",
      "source": { "binding_kind": "connector", "connector_id": "conn_spotify" },
      "stream_count": 3,
      "streams": [
        {
          "object": "stream_metadata",
          "name": "top_artists",
          "schema": { "type": "object", "properties": { "...": {} } },
          "query": { "range_filters": { "source_updated_at": ["gte","gt","lte","lt"] } },
          "field_capabilities": { "...": {} },
          "expand_capabilities": [],
          "freshness": { "status": "unknown" }
        }
      ]
    }
  ]
}
```

### List streams

```
GET /v1/streams
```

Returns the streams available under the current grant.

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "object": "stream",
      "name": "conversations",
      "record_count": 2196,
      "last_updated": "2026-03-28T15:01:00Z"
    },
    {
      "object": "stream",
      "name": "messages",
      "record_count": 48302,
      "last_updated": "2026-03-28T15:01:00Z"
    }
  ]
}
```

### Get stream metadata

```
GET /v1/streams/{stream}
```

Returns schema, primary key, cursor field, and expandable relations.

**Response:**
```json
{
  "object": "stream",
  "name": "conversations",
  "record_count": 2196,
  "last_updated": "2026-03-28T15:01:00Z",
  "schema": {
    "type": "object",
    "properties": {
      "id": { "type": "string" },
      "title": { "type": "string" },
      "created_at": { "type": "string", "format": "date-time" },
      "message_count": { "type": "integer" }
    },
    "required": ["id", "title"]
  },
  "primary_key": ["id"],
  "cursor_field": "created_at",
  "expandable": ["messages"]
}
```

### List records

```
GET /v1/streams/{stream}/records
```

Returns records from a stream, filtered by grant constraints and request parameters.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Records per page. Default 25, max 100. |
| `cursor` | string | Opaque pagination token from a previous response's `next_cursor` or `prev_cursor`. The server generates these tokens; clients pass them back verbatim. |
| `order` | enum | `desc` (default) or `asc` |
| `changes_since` | string | `beginning` for an initial incremental sync, or an opaque changes bookmark from a previous response's `next_changes_since`. Distinct from page cursors. |
| `filter[{field}]` | string | Exact match filter |
| `filter[{field}][gte]` | string | Greater than or equal (ISO 8601 for dates) |
| `filter[{field}][gt]` | string | Greater than |
| `filter[{field}][lte]` | string | Less than or equal |
| `filter[{field}][lt]` | string | Less than |
| `fields` | comma-separated | Sparse fieldset. `id` is always included. Schema-required fields are always included. |
| `expand[]` | string | Expand a foreign key relation inline (e.g., `expand[]=messages`). |
| `expand_limit[{relation}]` | integer | Max records per expanded relation. Default 10, max 50. |

**Grant enforcement:** The resource server computes `effective_filter = grant_filter AND request_filter`. Request filters can only narrow what the grant allows; they cannot widen it.

Note: `limit` on this API is **page size** (how many records per response). The grant constrains access through `time_range`, `fields`, and stream selection — not through record count limits. "Top 50 artists" or "recent 100 posts" are modeled as manifest-defined streams or profiles, not as grant-level constraints.

**Stable sort:** Records are sorted by `(cursor_field, primary_key)` for cursor safety.

**Request:**
```http
GET /v1/streams/conversations/records?limit=2&order=desc&filter[created_at][gte]=2026-03-01T00:00:00Z&expand[]=messages&expand_limit[messages]=3&fields=id,title,created_at
Authorization: Bearer pdq_token_abc123
PDPP-Version: 2026-03-28
```

**Response:**
```json
{
  "object": "list",
  "url": "/v1/streams/conversations/records",
  "has_more": true,
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wMy0yNVQxODoyMjoxMVoiLCJpZCI6ImNvbnZfMDFKUVc4TTJSNyJ9",
  "data": [
    {
      "object": "record",
      "id": "conv_01JQW8M2R7",
      "stream": "conversations",
      "data": {
        "id": "conv_01JQW8M2R7",
        "title": "Trip planning",
        "created_at": "2026-03-25T18:22:11Z"
      },
      "emitted_at": "2026-03-28T15:01:00Z",
      "messages": {
        "object": "list",
        "url": "/v1/streams/messages/records?filter[conversation_id]=conv_01JQW8M2R7&order=asc",
        "has_more": false,
        "data": [
          {
            "object": "record",
            "id": "msg_01JQW8P5B3",
            "stream": "messages",
            "data": {
              "id": "msg_01JQW8P5B3",
              "conversation_id": "conv_01JQW8M2R7",
              "role": "user",
              "content": "Plan a 3-day trip to Tokyo",
              "created_at": "2026-03-25T18:23:02Z"
            },
            "emitted_at": "2026-03-28T15:01:00Z"
          }
        ]
      }
    }
  ]
}
```

**Pagination:** Pass `next_cursor` from the response as the `cursor` parameter to get the next page. Cursor tokens are opaque — clients must not parse or construct them. This allows the server to handle compound primary keys and arbitrary sort orders internally.

**Incremental sync:** Pass `changes_since=beginning` to start a changes session from the beginning, then store `next_changes_since` from the response for the next sync session. Do not pass a normal list `next_cursor` as `changes_since`; `next_cursor` is only for page continuation through the `cursor` parameter.

### Get a single record

```
GET /v1/streams/{stream}/records/{id}
```

Returns a single record. Supports `expand[]`.

### Get a blob

```
GET /v1/blobs/{blob_id}
```

This is the **only** PDPP-API path for byte payload. Clients discover bytes by:

1. Querying records on a stream that declares `blob_ref` (e.g. Gmail `attachments`).
2. Reading the server-injected `blob_ref.fetch_url` from the record body.
3. Following that URL verbatim.

There is no resource-specific `/content`, `/download`, or `/file` endpoint. URL forms like `/v1/streams/attachments/records/{id}/content` or `/v1/blobs/{blob_id}/download` are **not** part of the PDPP API; do not generate or rely on them. If you need bytes and a record's `blob_ref` is missing or null, the answer is "those bytes are not available under this grant" — not "guess another URL."

The resource server authorizes blob access by verifying that:
1. The grant includes a stream containing a record that references this `blob_id`
2. The referencing record passes all grant filters (time_range, fields)
3. The `blob_ref` field itself is included in the grant's authorized field projection (if the grant uses a `fields` allowlist)

A bare `blob_id` alone does not grant access — the app must have discovered the blob through an authorized record whose `blob_ref` field is visible under the grant.

**Response headers:**
```
Content-Type: image/jpeg
Content-Length: 2048000
ETag: "a1b2c3..."
Cache-Control: private, max-age=3600
```

The server may return a `302` redirect to a short-lived signed URL for the actual blob storage. Treat `fetch_url` as opaque and follow redirects (e.g. `curl -L`); do not parse, cache, or share it across grants.

`HEAD` is supported for size checks. `Range` headers are recommended for large files.


## Expansion

Expansion hydrates foreign key relationships inline. It is bounded: expanded child collections are themselves list objects with `data[]` and `has_more`.

**Rules:**
- Only relations declared in the stream's `expandable` metadata can be expanded
- The grant must include both the parent and child streams
- Top-level pagination is applied before expansion
- Expanded children are limited by `expand_limit` (default 10, max 50)
- For full child traversal, fetch the child stream directly with a filter

**Unexpanded (default):** A conversation record has `message_count: 42` but no messages inline.

**Expanded:** The same record includes a `messages` list object with up to `expand_limit` records.

This follows Stripe's pattern: foreign keys are string IDs by default, expanded into full objects on request.


## Errors

Every non-2xx response returns a structured error:

```json
{
  "error": {
    "type": "permission_error",
    "code": "grant_stream_not_allowed",
    "message": "Grant does not include stream 'messages'.",
    "param": "expand[0]",
    "request_id": "req_01JQXA3N9Y"
  }
}
```

### Error types

| Type | HTTP Status | When |
|------|------------|------|
| `invalid_request_error` | 400 | Malformed request, invalid cursor, unknown field |
| `authentication_error` | 401 | Missing or invalid access token |
| `permission_error` | 403 | Grant violation: stream not allowed, time range exceeded, grant expired/revoked |
| `not_found_error` | 404 | Stream or record not found |
| `rate_limit_error` | 429 | Too many requests. Includes `Retry-After` header. |
| `api_error` | 500 | Internal server error |

### Error codes (non-exhaustive)

| Code | Type | Description |
|------|------|-------------|
| `invalid_cursor` | invalid_request | Cursor token is malformed or expired |
| `unknown_field` | invalid_request | Requested field not in stream schema |
| `unknown_expand` | invalid_request | Relation is not expandable |
| `grant_stream_not_allowed` | permission | Stream not in grant |
| `grant_time_range_exceeded` | permission | Request filters exceed grant's time_range |
| `grant_expired` | permission | Grant has expired |
| `grant_revoked` | permission | Grant has been revoked |
| `invalid_api_version` | invalid_request | Unrecognized PDPP-Version header |


## Ingest (Connector Runtime)

The connector runtime writes records using owner authentication (not grant-based):

```
POST /v1/ingest/{stream}
Authorization: Bearer <owner_token>
Content-Type: application/x-ndjson
```

Body is NDJSON (one record per line):

```json
{
  "key": "conv_01JQW8M2R7",
  "data": {
    "id": "conv_01JQW8M2R7",
    "title": "Trip planning",
    "created_at": "2026-03-25T18:22:11Z"
  },
  "emitted_at": "2026-03-28T15:01:00Z"
}
{
  "key": "conv_01JQW9K4P2",
  "data": {
    "id": "conv_01JQW9K4P2",
    "title": "Recipe ideas",
    "created_at": "2026-03-26T10:00:00Z"
  },
  "emitted_at": "2026-03-28T15:01:01Z"
}
```

**Response:**
```json
{
  "stream": "conversations",
  "records_accepted": 2,
  "records_rejected": 0
}
```

## Sync State

```
GET  /v1/state/{connector_id}   → returns StreamState map
PUT  /v1/state/{connector_id}   → updates StreamState map
```

Both require owner authentication. The connector runtime reads state before a run and writes it after.


## Why REST, not GraphQL

For a personal data API where grants constrain access:

- **Grant enforcement** is per-stream and per-field. REST endpoints map 1:1 to grant constraints. GraphQL queries require AST parsing to enforce the same constraints.
- **Request signing** is simpler when the URL is the thing being authorized.
- **Caching** works with standard HTTP caching. GraphQL responses are not cacheable at the CDN level.
- **AI agent ingestion** works better with stable per-stream envelopes that can be resumed record-by-record.
- **Expansion** handles the hydration use case without GraphQL's complexity.

## Lexical retrieval

Public lexical retrieval lives in the optional **lexical retrieval extension** at `GET /v1/search`. See the [Lexical Retrieval Extension](./spec-lexical-retrieval-extension) doc for the full contract: required `q`, optional `limit` / `cursor` / `streams[]`, candidate-reference results carrying `connector_id`, grant-safe snippets, and the `capabilities.lexical_retrieval` advertisement on the protected-resource metadata document.

A future `POST /v1/search` body-DSL is reserved for richer queries (boolean predicates, etc.) but is **not** specified yet. Don't rely on it.

A **separate** experimental extension, [Semantic Retrieval](./spec-semantic-retrieval-extension), adds a sibling surface at `GET /v1/search/semantic` for meaning-based matches (paraphrase / synonymy recall). It is **experimental and unstable** in v1 and is not interchangeable with `/v1/search`. Lexical retrieval remains the stable public retrieval floor.


## Design Attribution

This API follows conventions established by:
- Stripe API (cursor pagination, expandable objects, structured errors, date-based versioning)
- Google API Improvement Proposals (resource-oriented design, field masks)
- Apigee Web API Design (pragmatic REST, shallow hierarchies)
- Open Banking (date-range filtering, grant-scoped access)
