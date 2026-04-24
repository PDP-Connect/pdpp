# PDPP query cookbook

All examples below target the public record-query surface at `/v1/streams/...`. Tokens are Bearer access tokens bound to a PDPP grant (see spec §7).

## Exact filter

Exact filters apply only to authorized top-level scalar fields. Unknown, unauthorized, or non-scalar fields are rejected.

```http
GET /v1/streams/top_artists/records?filter[name]=Aphex Twin
Authorization: Bearer pdq_token_abc123
```

## Range filter (on a declared field)

Range operators are valid only for fields declared under `query.range_filters` in the stream metadata. Supported operators: `gte`, `gt`, `lte`, `lt`. Coercion handles integer, number, date, and date-time fields.

```http
GET /v1/streams/top_artists/records?filter[source_updated_at][gte]=2026-01-01T00:00:00Z&order=asc
```

## Filtered retrieval

`GET /v1/search` and `GET /v1/search/semantic` accept the same `filter[...]` syntax as record listing when the request names exactly one `streams` value. Range filters are still valid only for fields declared under that stream's `query.range_filters`; use stream metadata to discover the supported fields and operators.

```http
GET /v1/search?q=invoice&streams=messages&filter[received_at][gte]=2026-04-01T00:00:00Z
Authorization: Bearer pdq_token_abc123
```

Cross-stream filtered search, public score/reranking output, and caller-controlled hybrid ranking remain deferred.

## Aggregation

`GET /v1/streams/<stream>/aggregate` computes one grant-safe aggregation over one stream. Supported metrics are `count`, numeric `sum`, and numeric/date `min`/`max`. Grouped counts use `metric=count&group_by=<field>&limit=N` and return buckets ordered by count descending, then key ascending. Aggregate fields and grouping fields must be explicitly declared under `query.aggregations` and authorized by the caller grant.

```http
GET /v1/streams/transactions/aggregate?metric=sum&field=amount&filter[date][gte]=2026-01-01
Authorization: Bearer pdq_token_abc123
```

```http
GET /v1/streams/messages/aggregate?metric=count&group_by=has_attachments&limit=2
Authorization: Bearer pdq_token_abc123
```

## Sparse fieldset

Field selection is limited to top-level field names. Schema-required fields are always included. Mutually exclusive with `view`.

```http
GET /v1/streams/top_artists/records?fields=id,name,genres
```

## Named view

```http
GET /v1/streams/top_artists/records?view=basic
```

## Logical cursor pagination

Records are sorted by `(cursor_field, primary_key)`. Null cursor values sort after present values. Cursors are opaque — clients must not parse or construct them.

```http
GET /v1/streams/top_artists/records?order=asc&limit=50
... then ...
GET /v1/streams/top_artists/records?order=asc&limit=50&cursor=<next_cursor>
```

## Incremental sync (changes_since)

`changes_since` returns records whose authorized projection changed since the previous sync. Use `changes_since=beginning` for the initial sync, then use `next_changes_since` from the terminal page to seed the next session. Do not pass list-page `next_cursor` values as `changes_since`.

```http
GET /v1/streams/top_artists/records?changes_since=beginning
... later ...
GET /v1/streams/top_artists/records?changes_since=<next_changes_since>
```

## Expansion

Expand a relationship declared under `query.expand`. Depth is 1. Use `expand_limit[<relation>]` to bound expanded `has_many` children. Expansion is incompatible with `changes_since`; incremental sync pages return changed parent records only.

```http
GET /v1/streams/saved_tracks/records?expand[]=recently_played&expand_limit[recently_played]=5
```

## Blob fetch

```http
GET /v1/blobs/<blob_id>
Authorization: Bearer pdq_token_abc123
```

Authorized only if the caller holds a grant that includes a record referencing this `blob_id` via a visible `blob_ref` field.

## Provider-connect flow (reference)

1. Register a client: `POST /oauth/register` (DCR initial access token required).
2. Start a grant request: `POST /oauth/par` with `authorization_details[0].type = https://pdpp.org/data-access`.
3. Approve via the hosted consent page or `POST /consent/approve` with `request_uri` + subject id.
4. In the current thin reference flow, `POST /consent/approve` returns `{ grant_id, token, grant }` directly; there is no follow-on `/oauth/token` exchange for third-party client connect yet.

## Owner device flow

1. `POST /oauth/device_authorization` → returns `device_code` + `user_code`.
2. `POST /device/approve` with `user_code` + `subject_id`.
3. `POST /oauth/token` with `grant_type = urn:ietf:params:oauth:grant-type:device_code` → returns the owner bearer token.

## Error codes (spec §8)

- `400 invalid_request` — malformed query shape (unknown param, bad filter shape, nested path).
- `400 unknown_field` — `fields=` references a field outside the stream schema.
- `400 invalid_expand` — expansion requests an undeclared or non-`has_many` relation.
- `400 invalid_cursor` — cursor token malformed.
- `403 field_not_granted` — filter targets a field outside the grant projection.
- `403 grant_stream_not_allowed` — stream not in grant.
- `403 insufficient_scope` — expansion requests a stream not in the grant.
- `404 not_found` — stream or record not found.
- `404 blob_not_found` — `blob_id` is unknown or stale.
- `410 cursor_expired` — `changes_since` cursor too old; full re-sync required.

