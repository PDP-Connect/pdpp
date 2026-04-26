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
      "source": { "binding_kind": "connector", "connector_id": "github" },
      "streams": [
        {
          "name": "commits",
          "fields": ["sha","repo","message","committed_at","author"],
          "filters": ["repo","author","since","until"],
          "expand": [{ "name": "pull_request", "stream": "pull_requests" }],
          "supports": { "records": true, "search": true, "aggregate": true, "changes_since": true, "blobs": false }
        }
      ]
    }
  ]
}
```

**Use the `supports` map literally.** If `supports.changes_since` is false, do not call `?changes_since=…` — the server will reject. If a field isn't listed in `fields`, it's not in your grant.

## Records

List records (newest first):

```bash
curl -fsS "$RS_URL/v1/streams/commits/records?limit=50&order=newest" \
  -H "Authorization: Bearer $TOKEN"
```

Filter by declared filters (only those listed in `schema.connectors[].streams[].filters`):

```bash
curl -fsS "$RS_URL/v1/streams/commits/records?repo=acme/api&since=2026-04-18T00:00:00Z&limit=200" \
  -H "Authorization: Bearer $TOKEN"
```

Get one record by id:

```bash
curl -fsS "$RS_URL/v1/streams/commits/records/<sha>" -H "Authorization: Bearer $TOKEN"
```

Pagination: every list response includes `next_cursor` when more results exist. Pass it back as `?cursor=…`. Don't loop unboundedly; pick a stop condition tied to the user's task ("first 200 commits" or "until the date drops below X").

## Changes since cursor

Use this *instead of* re-pulling the full stream when you already have a cursor from a prior call:

```bash
curl -fsS "$RS_URL/v1/streams/commits/records?changes_since=$LAST_CURSOR" \
  -H "Authorization: Bearer $TOKEN"
```

Save the new `next_cursor` (or the response's `changes_cursor` field if present) into `grants/<grant-id>.json` so the next session resumes correctly. To bootstrap, pass `changes_since=beginning`.

## Search

Lexical (always available when `/v1/search` is advertised):

```bash
curl -fsS "$RS_URL/v1/search?q=acme%20launch&streams=messages,commits&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Hybrid or semantic (only when the AS advertises `pdpp_provider_connect_capabilities` includes the corresponding flag and `/v1/schema` confirms `supports.search` for the stream):

```bash
curl -fsS "$RS_URL/v1/search/hybrid?q=acme%20launch&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Hybrid is the right default when available — it combines lexical and semantic. Pure-semantic search is fragile for code-history queries that depend on exact terms.

## Aggregations

Counts, sums, time histograms — when `supports.aggregate` is true:

```bash
curl -fsS "$RS_URL/v1/streams/commits/aggregate?metric=count&group_by=repo&since=2026-04-01T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"
```

Use aggregations before you reach for paginated record scans. "Top 5 repos by commits this month" is one aggregate call, not one full scan.

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

If `supports.blobs` is false for the stream, the records will not include `blob_ref` and `/v1/blobs/*` calls will return 404 or `insufficient_scope`.

## Relationships and `expand[]`

When the manifest declares relationships (e.g., commits → pull_request), the schema lists them under `streams[].expand`. Request hydration via `expand`:

```bash
curl -fsS "$RS_URL/v1/streams/commits/records?expand=pull_request&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Don't fan out into a second `pull_requests` query unless you actually need fields the relationship doesn't expose. `expand[]` keeps the call inside one grant boundary.

## Aggregation patterns by task

| Task | Pattern |
| --- | --- |
| "Summarize last week" | filtered records by `since`, then `aggregate` for top-N grouping |
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
