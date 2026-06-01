## Why

Live external MCP testing exposed an agent-usability failure in the MCP query
tools. Connection, auth, raw record reads, `connection_id` routing, and REST
bracket filters all work when a caller hits the resource server directly with
the canonical query shape:

```
GET /v1/streams/messages/records?connector_id=slack&connection_id=cin_...&filter[user_id]=<value>
```

But the MCP `query_records`, `aggregate`, and `search` tools exposed `filter`
as a single opaque **string** forwarded verbatim. Real agent clients naturally
send either a JSON object (`filter: { "user_id": "U123" }`) or a string like
`filter: "filter[user_id]=..."`. Neither produced the REST bracket params the
resource server parses (`qs.parse(filter[field][op]=value)`):

- The MCP `RsClient.appendQuery` serializes a string filter as a single bare
  `filter=<urlencoded>` query param and an object as `filter=<JSON>`. The RS
  ignores a bare `filter=` param, so for `query_records` the filter **silently
  no-ops** (looks like filtering was applied but every row comes back), and for
  `aggregate` it is rejected as malformed.

The resource server's filtering is correct. The defect is entirely in the MCP
adapter's input schema and query translation. A secondary defect: the
`aggregate` tool mirrored its numeric result only into `structuredContent.data`;
some hosted agents cannot reliably read `structuredContent`, so the numeric
answer must also appear in the `content[]` text. The same client limitation
applies to search: a hit count without model-visible hit handles is not usable.

## What Changes

- The MCP `filter` argument on `query_records`, `aggregate`, and `search`
  becomes a **typed input**: an object keyed by field name whose value is either
  a scalar (exact match) or a range object keyed by `gte`/`gt`/`lte`/`lt`. The
  adapter encodes this into the canonical `filter[field]=value` /
  `filter[field][op]=value` query params for the RS. Agents no longer hand-encode
  bracket syntax inside a string.
- A legacy raw query string using literal `filter[field]=value` bracket syntax
  is still accepted and parsed into the same bracket params (documented
  backward-compatibility path). Any other string shape (a bare value,
  `field=value`, `field>value`, JSON-in-a-string) is **rejected with a typed,
  actionable `invalid_filter` error** instructing the agent to use the typed
  object — it is never silently forwarded as a bare `filter=` param.
- `aggregate` accepts the same typed filter input as `query_records` and rejects
  malformed string filters the same way; no query tool silently ignores them.
- `expand_limit` on `query_records` and `fetch` remains a typed object keyed by
  relation name, but the adapter now encodes it into the resource server's
  `expand_limit[relation]=N` query parameters instead of forwarding the object as
  a JSON string. Empty objects and object keys that embed bracket syntax are
  rejected before any resource-server call.
- The `aggregate` tool result includes the metric, stream, and numeric result
  (or a compact grouped-bucket preview) in `content[]` text, in addition to the
  canonical `structuredContent.data` envelope. The text stays compact and
  token-efficient (no full JSON dump).
- The `search` tool result includes a bounded top-hit preview in `content[]`
  text with the result id and available source handles such as `connection_id`.
  The canonical envelope remains in `structuredContent.data`.
- Hosted package search merges canonical child `data[]` search envelopes instead
  of interpreting them as empty on unscoped package-token search.
- Hosted package search intersects requested `streams[]` with each child grant
  before forwarding, so mixed stream filters do not fail against unrelated child
  grants in a package.
- Reference lexical backfill reads and writes the active storage backend and,
  for unpinned manifests, evaluates active owner-visible connector instances
  rather than only the default synthetic instance.
- Startup manifest reconciliation persists manifest fixes without blocking AS/RS
  listen on full retrieval index rebuilds; index repair runs through the
  post-listen startup backfill path.
- `connection_id` and the deprecated `connector_instance_id` alias continue to
  forward unchanged. REST filtering semantics are unchanged.

## Impact

- Affected specs: `mcp-adapter`, `reference-implementation-architecture`.
- Affected code: `packages/mcp-server/src/tools.js` (input schema + filter
  translation + aggregate/search text), `packages/mcp-server/test/typed-filter.test.js`
  (new), `reference-implementation/server/package-rs-client.js`,
  `reference-implementation/server/search.js`, manifest reconciliation,
  Postgres storage helpers, package docs.
- No RS contract change. No PDPP Core or REST filtering semantics change.
- The typed filter object is a superset of the prior contract for the common
  case (object/typed inputs newly work); the only removed behavior is the silent
  bare-`filter=` forward, which never produced a working filter and is replaced
  by an actionable error plus the still-supported literal bracket string.
