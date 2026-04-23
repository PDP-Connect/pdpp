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

`changes_since` returns records whose authorized projection changed since the previous sync. Use `next_changes_since` from the terminal page to seed the next session.

```http
GET /v1/streams/top_artists/records?changes_since=<token>
```

## Expansion

Expand a relationship declared under `query.expand`. Depth is 1. Use `expand_limit[<relation>]` to bound expanded `has_many` children.

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

