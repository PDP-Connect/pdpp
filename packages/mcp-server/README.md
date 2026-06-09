# @pdpp/mcp-server

Local stdio and hosted Streamable HTTP [Model Context Protocol](https://modelcontextprotocol.io/)
adapter for grant-scoped access to a [PDPP](https://pdpp.vivid.fish) resource server.

The adapter is a thin client of the PDPP resource server (RS). It does not run connectors,
issue grants, or replicate any RS authorization logic. Every data-bearing tool call is a
forwarded request to an existing `/v1/*` endpoint, authenticated with the scoped client
access token already cached by `pdpp connect`. The MCP setup is a profile-free normal
read surface; event-subscription management is not part of the recommended MCP tool list.

## What this is not

- **Not a grant-issuance surface.** If the cache is empty or the token is invalid, the
  adapter exits / surfaces an error directing the operator at `pdpp connect`.
- **Not an owner-mode bypass.** `PDPP_OWNER_TOKEN` and other owner credentials are
  refused by default.
- **Not a proxy.** Per-client consent and confused-deputy mitigations would be required
  before this package accepted unvalidated MCP-client tokens. Hosted callers must
  validate the bearer before passing it to this package.

## Publication status

This package is a private workspace package (`"private": true`). It is consumed
in-repo by the agent skill and integration tests. Promoting it to a published
`@pdpp/mcp-server@beta` on npm requires a follow-up OpenSpec change under the
[package release policy](../../docs/package-release-policy.md) (manifest opt-in,
release-train wiring, and npm trusted-publisher bootstrap), matching the
precedent established for `@pdpp/cli` and `@pdpp/local-collector`.

## Install (local agent harness)

```jsonc
// claude_desktop_config.json (or equivalent)
{
  "mcpServers": {
    "pdpp": {
      "command": "npx",
      "args": ["-y", "@pdpp/mcp-server@beta", "--provider-url", "https://pdpp.example.com"]
    }
  }
}
```

Run `pdpp connect https://pdpp.example.com` first so a scoped client token is cached at
`.pdpp/clients/<host>.json`.

## CLI

```
pdpp-mcp-server --provider-url <url> [--cache-root <dir>] [--server-name <name>]
```

Flags can also come from environment variables: `PDPP_PROVIDER_URL`,
`PDPP_CACHE_ROOT`, `PDPP_MCP_SERVER_NAME`.

The adapter writes only MCP protocol messages to stdout. Diagnostics go to stderr.

## Tools

### Read tools (read-only, idempotent)

| Tool | RS endpoint |
| --- | --- |
| `schema` | `GET /v1/schema` |
| `query_records` | `GET /v1/streams/{stream}/records` |
| `aggregate` | `GET /v1/streams/{stream}/aggregate` |
| `search` | `GET /v1/search` |
| `fetch` | `GET /v1/streams/{stream}/records/{record_id}` |

Plus one resource template: `pdpp://stream/{name}` → `GET /v1/streams/{name}`.

`search` preserves the RS envelope in `structuredContent.data` and also returns
ChatGPT-compatible `structuredContent.results[]` entries with `id`, `title`, `url`,
and available source handles such as `connection_id`. Its `content[]` text also
previews a bounded set of top hits so clients that cannot inspect structured
tool output can still fetch a result.
`fetch` accepts result ids in `stream:record_id` form and follows the
MCP/OpenAI search-fetch document contract: `structuredContent` is exactly
`id`, `title`, `text`, `url`, and `metadata`, and `content[]` contains the same
object as JSON text for hosts that hide structured output. It does not return a
canonical PDPP record envelope under `structuredContent.data`; use
`query_records` for canonical structured record reads. `fetch(fields)` projects
the source record before rendering the document so unrequested source-native
payload fields do not leak into `text` or `metadata`; source handles such as
stream, `connection_id`, and `connector_key` remain in `metadata`.

The `schema` tool includes concise parseable text with stream
names, `connection_id`, `connector_key`, display labels, and schema field-capability
essentials so MCP clients whose models read only `content[]` can still choose streams,
fields, and connection scopes.

`schema` defaults to a **compact** schema document under `structuredContent.data`
(`detail: "compact"`). It does not wrap the REST `/v1/schema` body again, so
callers read `structuredContent.data.connectors`, not `structuredContent.data.data.connectors`.
A real owner's grant-scoped `GET /v1/schema` body can exceed 2 MB once every connector
advertises full per-field JSON Schema, which is too large as the default agent-facing
payload. The compact projection collapses each field to a terse capability flag string
(declared type, grant, and usable filter/search/aggregation flags — e.g.
`type=string,granted=true,exact,range=gte|lt,agg=group_by_time`) and drops the raw
per-field JSON Schema, while preserving connection identities (`connection_id`,
`display_name`) and canonical `connector_key` metadata. This keeps
the discovery path `schema -> schema(stream) -> schema(stream, connection_id) -> query_records`
cheap: the package-level text summary lists streams without per-field flags and
points the agent at scoped schema calls for them. Stream names are not globally
unique; `schema(stream)` returns every granted connector/connection with that
stream name. Add `connection_id` when you need one configured source, especially
before requesting `detail: "full"`. Pass `detail: "full"` only together with
`stream`; if that stream name spans multiple sources, retry with `connection_id`
to get deduped exhaustive schema for one configured source. Full detail
preserves raw per-field JSON Schema and structured capability sub-objects, but
does not repeat the same selected stream list in both top-level and
connector-nested locations.

`query_records` also preserves the full RS envelope in `structuredContent.data`, and its
text content includes a bounded preview of returned records. This keeps agents that can
only reason over MCP `content[]` from seeing only a count summary while preserving
`structuredContent` as the canonical machine-readable result.

The `query_records` page is bounded by the spec-core §8 contract: omitting `limit` returns
at most 25 records, and `limit` is capped at 100. This tool advertises `100` as the input
maximum and rejects a larger `limit` at input validation, so the page size you request is
the page size you get — page forward with the returned `cursor` rather than asking for a
bigger page. (A direct REST client that sends `limit > 100` is clamped to 100 and told so
via a `limit_clamped` entry in the response `meta.warnings[]`; the cap is never silent on
either surface.)

### Filtering (`query_records`, `aggregate`, `search`)

Pass `filter` as a **typed object**, not a pre-encoded query string. The adapter
encodes it into the resource server's `filter[field]=value` (exact) and
`filter[field][op]=value` (range) parameters for you:

```jsonc
// exact match
{ "filter": { "user_id": "U123" } }
// range (operators: gte, gt, lte, lt; AND together across fields)
{ "filter": { "created_at": { "gte": "2026-01-01T00:00:00Z", "lt": "2026-02-01T00:00:00Z" } } }
```

Allowed fields and operators are advertised per stream by `GET /v1/schema`
(`field_capabilities`) — discover them with the cheap
`schema -> schema(stream) -> schema(stream, connection_id) -> query_records`
path before constructing a filter. A legacy raw string using literal bracket syntax
(`"filter[user_id]=U123"`) is still accepted and parsed. Any other string shape
(a bare term like `"Vana"`, `"field=value"`, `"amount>100"`, or JSON encoded as a
string) is **rejected with a typed `invalid_filter` error** — it is never
silently forwarded as a bare `filter=` parameter (which the resource server
ignores). `aggregate` and `search` accept the same typed `filter` input.

`expand_limit` is typed the same way: pass an object keyed by relation name, for
example `{ "expand": ["messages"], "expand_limit": { "messages": 3 } }`. The
adapter encodes it as `expand_limit[messages]=3`; do not pre-encode bracket keys.

`aggregate` is the token-efficient way to answer count / sum / min / max / distinct-count and
grouped or time-bucketed rollup questions. It returns small bucket rows from
`GET /v1/streams/{stream}/aggregate`, never record bodies — so an agent that needs "how many
orders", "total spend by month", or "distinct senders" should call `aggregate` instead of
paging `query_records` and counting client-side. Group with exactly one dimension per call
(`group_by` for a scalar field XOR `group_by_time` + `granularity` for a date field).
Groupable, time-bucketable, and distinct-able fields are advertised by `GET /v1/schema`
(`field_capabilities.*.aggregation`). The aggregate tool result `content[]` text includes
the metric, stream, and numeric result (or a compact preview of grouped buckets with their
counts) so an agent that can read only `content[]` still gets the answer; the canonical
envelope remains in `structuredContent.data`.

`search` is bounded the same way: omitting `limit` returns at most 25 hits, and `limit` is
capped at 100 — the bound the published `/v1/search`, `/v1/search/semantic`, and
`/v1/search/hybrid` contract declares and every mode honors (advertised as
`capabilities.{lexical,semantic,hybrid}_retrieval.max_limit`). This tool advertises `100` as
the input maximum and rejects a larger `limit` at input validation, so the page size you
request is the page size you get — page forward with the returned `cursor` (lexical and
semantic; hybrid does not page) rather than asking for a bigger page. The MCP input cap is
the primary safeguard against an agent silently losing the page size it asked for: an over-cap
`limit` never reaches the RS from this tool. A _direct REST_ caller that sends `limit > 100`
is still served a bounded page, and — like `query_records` — now receives a structured
`limit_clamped` warning in `meta.warnings[]` (carrying `detail.requested_limit` /
`detail.max_limit`) on all three search modes, so the clamp is never silent on any read
surface.

Use lexical search for exact known terms. Semantic search is approximate
retrieval; it can surface conceptually related records but is not a replacement
for exact-term lookup when a user names a literal string.

When a response or typed `ambiguous_connection` error includes both `connection_id` and
`grant_id`, use `connection_id` as the stable data-source selector. `grant_id` identifies
the current authorization grant and can change when the owner reconnects or re-authorizes
the client. Do not persist `grant_id` as a reconnect-stable source identifier.

## Hosted Streamable HTTP helper

Reference servers can mount hosted MCP by authenticating the incoming bearer themselves,
then passing a Web `Request` plus scoped token to `handleStreamableHttpRequest()`:

```js
import { handleStreamableHttpRequest } from '@pdpp/mcp-server';

const response = await handleStreamableHttpRequest(request, {
  providerUrl: 'https://pdpp.example.com',
  accessToken: scopedClientBearer,
});
```

The helper creates a fresh server and Streamable HTTP transport per request with MCP
session ids disabled. `/mcp` serves the profile-free normal read surface.

## Errors

Resource-server error responses (4xx/5xx including `invalid_token`, `insufficient_scope`,
`needs_broader_grant`, `invalid_cursor`) are surfaced as MCP `isError: true` results with
the original envelope preserved in `structuredContent.error`. The adapter does not retry
with broader credentials.
