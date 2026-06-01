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

### Aggregate gets a dedicated result formatter

`aggregate` switches from the generic `toToolResult` (which emits
`"...: N item(s)"`) to `toAggregateToolResult`, which renders
`metric(stream)[ field=...] = <value>` for scalar results and
`metric(stream) group_by=...: N group(s) [k=count, ...]` for grouped results.
Numbers render unquoted so the text reads as the numeric answer; the canonical
`structuredContent.data` envelope is unchanged and still validates against the
output schema.

## Risks / Trade-offs

- A client that previously sent a bare non-bracket string filter and (silently)
  got unfiltered results will now get an error. This is the intended correction —
  the prior behavior was a silent data-correctness bug, and the error is
  actionable.
- The typed range object is `.strict()`, so an unknown operator key (e.g.
  `between`) is rejected at the MCP input boundary as a validation error rather
  than a handler `invalid_filter` error. Both are typed, actionable rejections;
  the test pins this behavior.

## Acceptance Checks

- Typed exact filter → `filter[field]=value` reaches the RS and narrows results.
- Typed range filter → `filter[field][op]=value` reaches the RS.
- Literal bracket string parses; any other string → `invalid_filter` error; no
  bare `filter=` param ever reaches the RS.
- `aggregate` accepts the typed filter and rejects malformed strings identically.
- `aggregate` `content[]` text contains the metric, stream, and numeric result
  and stays compact.
- `search` forwards `q` and the typed filter as bracket params and surfaces a
  readable hit count.
- All pre-existing MCP server tests stay green.
