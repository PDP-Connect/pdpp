# Query Cookbook

This file lists the data-access patterns the PDPP RS supports and shows the smallest correct call for each one. Always check `/v1/schema` first — capabilities are per-grant, not global.

## Discovery

Before any data call, get the per-grant capability map:

```bash
curl -fsS "$RS_URL/v1/schema" -H "Authorization: Bearer $TOKEN" | jq .
```

The response shape:

```json
{
  "object": "schema",
  "bearer": { "token_kind": "client", "scope": "grant", "grant_id": "…", "client_id": "…" },
  "connectors": [
    {
      "source": { "binding_kind": "connector", "connector_id": "https://registry.pdpp.org/connectors/gmail" },
      "streams": [
        {
          "object": "stream_metadata",
          "name": "messages",
          "schema": { "type": "object", "properties": { "received_at": { "type": "string", "format": "date-time" } } },
          "query": { "range_filters": { "received_at": ["gte", "lt"] } },
          "field_capabilities": {
            "received_at": {
              "granted": true,
              "range_filter": { "declared": true, "usable": true, "operators": ["gte", "lt"] }
            }
          },
          "expand_capabilities": [
            { "name": "message_bodies", "stream": "message_bodies", "granted": true, "usable": true }
          ]
        }
      ]
    }
  ]
}
```

Use `field_capabilities`, `query`, and `expand_capabilities` literally. If a field's capability is not `usable`, do not call that filter/search/aggregation. If a stream does not list an `expand_capabilities` entry as `usable`, do not request that expansion. If a field is not present under `schema.properties`, it is not visible under your grant.

## Records

List records (newest first). Use `order=asc` or `order=desc` only:

```bash
curl -fsS "$RS_URL/v1/streams/pull_requests/records?limit=50&order=desc" \
  -H "Authorization: Bearer $TOKEN"
```

Filter by declared filters. Exact filters use `filter[field]=value`; range filters use `filter[field][op]=value` and require a declared range operator:

```bash
curl -fsS "$RS_URL/v1/streams/pull_requests/records?filter[repository_full_name]=acme/api&filter[updated_at][gte]=2026-04-18T00:00:00Z&limit=200&order=desc" \
  -H "Authorization: Bearer $TOKEN"
```

Get one record by id:

```bash
curl -fsS "$RS_URL/v1/streams/pull_requests/records/<id>" -H "Authorization: Bearer $TOKEN"
```

Pagination: every list response includes `next_cursor` when more results exist. Pass it back as `?cursor=…`. Don't loop unboundedly; pick a stop condition tied to the user's task ("first 200 pull requests" or "until the date drops below X").

## Changes since cursor

Use this *instead of* re-pulling the full stream when you already have a cursor from a prior call:

```bash
curl -fsS "$RS_URL/v1/streams/pull_requests/records?changes_since=$LAST_CURSOR" \
  -H "Authorization: Bearer $TOKEN"
```

Save the response's `next_changes_since` into `grants/<grant-id>.json` so the next session resumes correctly. If the response also includes `next_cursor`, use it only to page within the same changes window. To bootstrap, pass `changes_since=beginning`.

## Search

Lexical (always available when `/v1/search` is advertised):

```bash
curl -fsS "$RS_URL/v1/search?q=acme%20launch&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Scope search with repeated `streams=` entries or `streams[]=` entries, not CSV:

```bash
curl -fsS "$RS_URL/v1/search?q=acme%20launch&streams=messages&streams=pull_requests&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Hybrid or semantic (only when protected-resource metadata advertises `hybrid_retrieval` / `semantic_retrieval` and `/v1/schema` confirms the relevant fields are searchable):

```bash
curl -fsS "$RS_URL/v1/search/hybrid?q=acme%20launch&streams[]=messages&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Hybrid is the right default when available — it combines lexical and semantic. Pure-semantic search is fragile for code-history queries that depend on exact terms.

## Aggregations

Counts, sums, time histograms — when the stream metadata advertises usable aggregation for the field:

```bash
curl -fsS "$RS_URL/v1/streams/transactions/aggregate?metric=sum&field=amount&group_by=account_type&filter[date][gte]=2026-04-01" \
  -H "Authorization: Bearer $TOKEN"
```

Use aggregations before you reach for paginated record scans. "Total transaction amount by account type this month" is one aggregate call, not one full scan.

## Blobs (attachments, file bodies, binary)

Records that have attached binaries return a `blob_ref`:

```json
{
  "id": "msg_123",
  "subject": "Lease renewal",
  "attachments": [
    { "filename": "lease.pdf", "blob_ref": { "blob_id": "b_456", "fetch_url": "/v1/blobs/b_456" } }
  ]
}
```

**Always use `blob_ref.fetch_url`. Do not construct the URL yourself.** It may be relative (prepend `$RS_URL`) or absolute; the reference returns relative.

```bash
curl -fsS "$RS_URL/v1/blobs/b_456" -H "Authorization: Bearer $TOKEN" -o lease.pdf
```

If the relevant stream/field does not expose `blob_ref`, the records will not include fetchable blob pointers and `/v1/blobs/*` calls will return 404 or `insufficient_scope`.

## Relationships and `expand[]`

When the manifest declares relationships (e.g., Gmail `messages` → `message_bodies`), the schema lists them under `expand_capabilities`. Request hydration via `expand`:

```bash
curl -fsS "$RS_URL/v1/streams/messages/records?expand=message_bodies&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Don't fan out into a second query unless you actually need fields the relationship doesn't expose. `expand[]` keeps the call inside one grant boundary.

## Aggregation patterns by task

| Task | Pattern |
| --- | --- |
| "Summarize last week" | filtered records with `filter[date_field][gte]=…`, then `aggregate` for top-N grouping |
| "Find anything that mentions X" | `search/hybrid` (or `search` if hybrid unavailable) |
| "Triage anomalies" | aggregate by category/amount/sender, then drill into outliers via records |
| "Resume incremental sync" | `changes_since=<saved-cursor>` |
| "Show one specific item" | `records/<id>` directly; do not list-then-filter |
| "Pull binary content" | follow `blob_ref.fetch_url` from a records call |

## Performance and grant-safety hygiene

- Never call `records?limit=10000`. Page in chunks of 100–500. The user's machine is doing this work.
- Avoid concurrency unless the user asked for a fast result. Sequential calls are easier to inspect and don't surprise the owner with a burst pattern.
- Cache `/v1/schema` per grant for the session; it doesn't change while the grant is active.
- If a query returns nothing, do not retry with broader filters. Tell the user the answer is empty and ask whether to widen.

## Owner-token differences (for reference; do not use as default)

When `bearer.token_kind === "owner"`, `/v1/schema` lists every connector and stream the owner has provisioned. Don't take this as license to read everything — even with an owner token, the skill's narrowness rules still apply. The default agent path remains a scoped client grant.
