## Context

The MCP adapter is a thin, read-only mirror of the PDPP resource-server public
read contract. Its design posture (codified by
`canonicalize-public-read-contract`) is to forward canonical query args verbatim
and never silently drop a parameter the RS would reject. `filter` was modeled as
a single opaque string under that posture — but unlike `limit`, `order`, or
`fields`, the RS filter vocabulary is a **nested bracket structure**
(`filter[field]=value`, `filter[field][op]=value`) that `URLSearchParams` /
`RsClient.appendQuery` cannot express from a flat string or a JSON object. A
flat string became a single `filter=<value>` param; the RS's `qs.parse` finds no
`filter[...]` keys and applies no filter. "Forwarded verbatim" silently became
"forwarded uselessly."

## Goals / Non-Goals

- Goal: an agent client can express exact and range filters without hand-encoding
  bracket query-string syntax in a string.
- Goal: a malformed/ambiguous filter is an actionable error, never a silent
  no-op.
- Goal: `aggregate` numeric results are readable in `content[]` text.
- Non-Goal: changing REST filtering semantics or the RS query contract. The RS
  is correct; the fix is confined to the MCP layer.
- Non-Goal: adding new operators beyond the RS-supported `gte/gt/lte/lt`.

## Decisions

### Typed filter object mirrors the RS parsed shape

The typed input is `Record<field, scalar | { gte?, gt?, lte?, lt? }>`. This is
exactly the object the RS receives after `qs.parse`, so the adapter's encoder is
a pure, mechanical inversion (`{ field: { gte: v } } -> filter[field][gte]=v`)
with no semantic invention. Field/operator legality stays owned by the RS (it
rejects undeclared fields/operators against `field_capabilities`), preserving the
"RS owns validation" boundary. The adapter only validates the operator *spelling*
(`gte/gt/lte/lt`) so it can build a well-formed bracket key.

### Keep a parsed legacy-string path, reject everything else

A client already sending the correct literal `filter[field]=value` string keeps
working (the adapter parses it into bracket entries). Any other string is
rejected with a typed `invalid_filter` error whose message names the typed
object form. This satisfies the brief's requirement that the legacy string path
"SHALL NOT silently no-op": it either parses or errors actionably. The alternative
— dropping string support entirely — was rejected to avoid breaking a client that
had reverse-engineered the correct bracket string.

### Filter translation lives in the handler, not `RsClient`

`RsClient.appendQuery` stays dumb (scalar/array/object → query params). The
handler resolves `filter` into pre-bracketed `[key, value]` entries
(`applyFilterToQuery`) and merges them into the query object; `appendQuery` then
appends `filter[user_id]=U123` as an ordinary scalar param, which round-trips
through `qs.parse` correctly. `pickQuery` explicitly skips the raw `filter` key so
it can never be re-introduced as a bare param. This keeps the translation
explicit, unit-testable, and out of the shared transport client.

### `expand_limit` uses the same nested-query adapter pattern

The same audit found one other typed MCP object whose REST query shape is nested:
`expand_limit[relation]=N`. The adapter now handles it at the tool handler
boundary, like `filter`, rather than teaching `RsClient` how to serialize every
nested query vocabulary. Empty objects and object keys that embed bracket syntax
are rejected as `invalid_expand` before any RS call. `expand[]` itself remains a
plain repeated scalar query key and needs no translation.

`RsClient` now rejects object-valued query parameters instead of JSON-stringifying
them. Query handlers must encode any nested REST query vocabulary into explicit
bracket keys before calling the client. This turns future same-class mistakes
into local test failures rather than hosted no-ops.

The hosted package RS client follows the same fail-closed transport rule. A
package token fans out through child grant clients, but it must not become a
second serializer that accepts object-valued query params or silently reshapes
canonical REST envelopes.

### Hosted package search preserves canonical list envelopes

Hosted MCP package search fans out across child grant members, then merges their
search hits. The merge step must understand the canonical resource-server list
envelope (`data[]`) as well as compatibility shapes (`data.results[]` and
`data.data[]`). A scoped `connection_id` call bypasses fan-out and already
returned the child response directly; the unscoped path now preserves the same
hit semantics instead of interpreting canonical `data[]` as an empty result set.

### Aggregate gets a dedicated result formatter

`aggregate` switches from the generic `toToolResult` (which emits
`"...: N item(s)"`) to `toAggregateToolResult`, which renders
`metric(stream)[ field=...] = <value>` for scalar results and
`metric(stream) group_by=...: N group(s) [k=count, ...]` for grouped results.
Numbers render unquoted so the text reads as the numeric answer; the canonical
`structuredContent.data` envelope is unchanged and still validates against the
output schema.

### Owner live checks cover the active storage backend

The hosted reference deployment runs with Postgres-backed record storage. The
owner/live aggregate check therefore also verifies that the aggregate path reads
from the active record backend before applying the same grant and filter
semantics as record listing. This is still a semantic-floor scan, not a new
aggregate index.

The same owner audit also covers Postgres public-read parity for grant
visibility. Postgres-backed record list, detail, and `changes_since` reads must
apply grant `resources` and `time_range` constraints before returning data, so
the hosted MCP smoke is not proving filter usability on top of a divergent
authorization path.

The lexical retrieval backfill path also runs against the active storage
backend. In Postgres mode it reads records, index rows, and meta fingerprints
from Postgres, and writes rebuilt lexical rows back to Postgres. The drift check
uses exact indexable-text counts rather than a loose non-zero/max-row band, so a
partially populated historical index is rebuilt instead of being treated as
"good enough." When a manifest is not pinned to one connector instance, startup
backfill evaluates the active owner-visible bindings for that connector instead
of only checking the default synthetic instance.

## Risks / Trade-offs

- A client that previously sent a bare non-bracket string filter and (silently)
  got unfiltered results will now get an error. This is the intended correction —
  the prior behavior was a silent data-correctness bug, and the error is
  actionable.
- The typed range object is `.strict()`, so an unknown operator key (e.g.
  `between`) is rejected at the MCP input boundary as a validation error rather
  than a handler `invalid_filter` error. Both are typed, actionable rejections;
  the test pins this behavior.
- Exact lexical index count checks can trigger larger startup rebuilds after a
  deployment that previously accepted partial indexes. This is intentional: a
  stale search index is worse than rebuild work because it tells agents that
  existing records do not exist.

## Acceptance Checks

- Typed exact filter → `filter[field]=value` reaches the RS and narrows results.
- Typed range filter → `filter[field][op]=value` reaches the RS.
- Literal bracket string parses; any other string, empty string, empty object, or
  object key that embeds bracket syntax → `invalid_filter` error; no bare
  `filter=` param ever reaches the RS.
- `aggregate` accepts the typed filter and rejects malformed strings identically.
- `expand_limit` on `query_records` and `fetch` → `expand_limit[relation]=N`;
  empty objects and bracket-embedded object keys are rejected before any RS call.
- `aggregate` `content[]` text contains the metric, stream, and numeric result
  and stays compact.
- `search` forwards `q` and the typed filter as bracket params and surfaces a
  readable hit count.
- All pre-existing MCP server tests stay green.
- Postgres-backed aggregate count uses the active record backend and applies the
  same exact filter semantics as the record-list path.
- Postgres-backed record list, detail, and `changes_since` reads enforce grant
  `resources` and `time_range` visibility.
- Hosted package search fan-out merges canonical child search hits when
  `connection_id` is omitted.
- Postgres lexical backfill detects and rebuilds partial historical indexes
  using exact indexable-text counts for active owner-visible connector
  instances.
