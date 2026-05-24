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
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/gmail" },
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

Save the response's `next_changes_since` in your own project-local task state so the next session resumes correctly; do not edit the CLI credential cache for cursor bookkeeping. If the response also includes `next_cursor`, use it only to page within the same changes window. To bootstrap, pass `changes_since=beginning`.

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

Pagination caveat: hybrid search does **not** support `cursor` on this reference. Check the protected-resource metadata's `pdpp_discovery_hints.hybrid_pagination_supported`; when it is `false` or absent, fall back to lexical `GET /v1/search` (which supports `cursor`) for any query that needs more than `limit` results in a single pass.

## Aggregations

Counts, sums, time histograms — when the stream metadata advertises usable aggregation for the field:

```bash
curl -fsS "$RS_URL/v1/streams/transactions/aggregate?metric=sum&field=amount&group_by=account_type&filter[date][gte]=2026-04-01" \
  -H "Authorization: Bearer $TOKEN"
```

Use aggregations before you reach for paginated record scans. "Total transaction amount by account type this month" is one aggregate call, not one full scan.

## Blobs (attachments, file bodies, binary)

`blob_ref.fetch_url` is the **only** PDPP-API way to discover and fetch byte payload. There is no resource-specific `/content`, `/download`, or `/file` URL; do not construct one. Walking the chain looks like this:

1. List records on a stream that carries binary payload (e.g. Gmail `attachments`). Make sure your grant covers both the stream itself **and** the `blob_ref` field — without the field grant the response omits `blob_ref` entirely.
2. The response's record body includes `blob_ref` with `blob_id`, `mime_type`, `size_bytes`, `sha256`, and a server-injected `fetch_url`:

   ```json
   {
     "id": "att_789",
     "filename": "lease.pdf",
     "content_type": "application/pdf",
     "size_bytes": 184320,
     "hydration_status": "hydrated",
     "blob_ref": {
       "blob_id": "b_456",
       "mime_type": "application/pdf",
       "size_bytes": 184320,
       "sha256": "a1b2c3...",
       "fetch_url": "/v1/blobs/b_456"
     }
   }
   ```

3. Fetch the bytes by following `fetch_url` exactly as returned. Treat it as opaque: it may be relative (prepend `$RS_URL`) or absolute, and a future RS may return a 302 to a short-lived signed URL — your code should `--location` follow but not parse.

   ```bash
   curl -fsSL "$RS_URL/v1/blobs/b_456" -H "Authorization: Bearer $TOKEN" -o lease.pdf
   ```

**Common mistakes to avoid:**

- ❌ Building a `/v1/streams/attachments/records/{id}/content` URL. That endpoint does not exist; the byte transport is always `/v1/blobs/{blob_id}` reached via `fetch_url`.
- ❌ Building a `/v1/blobs/{blob_id}/download` URL or appending query strings. `GET /v1/blobs/{blob_id}` is the contract; `HEAD` works for size checks and `Range` is supported for large files.
- ❌ Caching `fetch_url` across grants or sharing it between tokens. The bytes are gated by the same grant that surfaced the record; a stale or wrong-grant fetch will 404 or 403.

If your records call returns no `blob_ref` field at all, the issue is one of:

- The grant doesn't cover the `blob_ref` field on this stream — re-request the grant including that field.
- The record's `hydration_status` is `deferred`, `failed`, `too_large`, `unavailable`, or `blocked`. The metadata row is real; the bytes are not. Surface the status to the user honestly rather than retrying.
- The connector for this stream has not yet been migrated to emit `blob_ref` (see [openspec/changes/hydrate-first-party-blob-streams](../../../../openspec/changes/hydrate-first-party-blob-streams/) for the hydration audit). Today, only Gmail `attachments` ships hydration.

### Cookbook example: fetch a recent attachment end-to-end

```bash
# 1. Find an attachment record with a hydrated blob.
curl -fsS "$RS_URL/v1/streams/attachments/records?filter[hydration_status]=hydrated&limit=5" \
  -H "Authorization: Bearer $TOKEN" | jq '.data[0]'

# 2. The response includes blob_ref. Pull blob_id and fetch_url out of it.
BLOB_FETCH_URL=$(curl -fsS "$RS_URL/v1/streams/attachments/records?filter[hydration_status]=hydrated&limit=1" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data[0].blob_ref.fetch_url')

# 3. Follow fetch_url verbatim. -L follows any 302 the RS may emit to a signed URL.
curl -fsSL "$RS_URL$BLOB_FETCH_URL" -H "Authorization: Bearer $TOKEN" -o downloaded.bin
```

If you reached this stream via `expand=attachments` on a parent record (e.g. `messages`), the same `blob_ref.fetch_url` field appears inside the expanded child object. Same rule: use it as-is.

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
