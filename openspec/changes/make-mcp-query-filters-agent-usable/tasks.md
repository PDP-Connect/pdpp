## 1. Typed filter input + bracket translation

- [x] 1.1 Add a typed `filter` Zod schema (object of `scalar | {gte,gt,lte,lt}`)
      accepted alongside a legacy string, replacing the opaque `z.string()` on
      `query_records`, `aggregate`, and `search`.
- [x] 1.2 Add `resolveFilterQueryEntries` / `applyFilterToQuery` to encode the
      typed object into `filter[field]=value` / `filter[field][op]=value`
      bracket query params.
- [x] 1.3 Parse a legacy literal-bracket string into the same entries; reject any
      other string shape with a typed `invalid_filter` error naming the typed
      object form.
- [x] 1.4 Make `pickQuery` skip the raw `filter` key so it can never be forwarded
      as a bare `filter=` param.
- [x] 1.5 Keep `connection_id` / `connector_instance_id` forwarding unchanged.

## 2. Aggregate text readability

- [x] 2.1 Add `toAggregateToolResult` / `summarizeAggregate` so the `content[]`
      text includes the metric, stream, and numeric result (or a compact grouped
      bucket preview).
- [x] 2.2 Keep `structuredContent.data` as the canonical envelope (unchanged
      output schema).

## 3. Nested query object translation

- [x] 3.1 Encode typed `expand_limit` objects on `query_records` and `fetch` as
      `expand_limit[relation]=N`, not as JSON-in-a-query-param.
- [x] 3.2 Reject empty `expand_limit` objects and relation keys that embed
      bracket syntax before any RS call.
- [x] 3.3 Make `RsClient` reject object-valued query parameters so future
      nested REST query shapes must be encoded explicitly by tool handlers.

## 4. Tests

- [x] 4.1 `query_records` typed exact filter forwards as `filter[field]=value`
      and narrows results.
- [x] 4.2 `query_records` typed range filter forwards as `filter[field][op]=value`.
- [x] 4.3 `query_records` legacy bracket string parses; other strings rejected
      with `invalid_filter`; no bare `filter=` ever reaches the RS.
- [x] 4.4 Empty filters and typed object keys that embed bracket syntax are
      rejected rather than treated as "no filter".
- [x] 4.5 `aggregate` typed filter forwards and scopes the count; malformed
      string rejected identically.
- [x] 4.6 `aggregate` text includes the numeric value and stays compact; grouped
      preview shows bucket counts.
- [x] 4.7 `search` typed filter forwards as bracket params; readable hit count in
      text.
- [x] 4.8 `query_records` and `fetch` typed `expand_limit` forward as bracket
      params; malformed shapes are rejected.
- [x] 4.9 All pre-existing MCP server tests stay green.
- [x] 4.10 Postgres-backed aggregate count reads from the active record backend
      and applies exact filters under the same grant semantics as record-list
      reads.
- [x] 4.11 Postgres-backed record list, detail, and `changes_since` reads
      enforce grant `resources` and `time_range` visibility.
- [x] 4.12 `RsClient` rejects object-valued query params before fetch, preventing
      accidental JSON-in-query forwarding.

## 5. Docs + discovery guidance

- [x] 5.1 Update the `FILTER_DESCRIPTION` tool-facing text to teach the typed
      object form and the string-rejection rule.
- [x] 5.2 Update package docs (`packages/mcp-server`) to show the typed filter
      and the `list_streams -> schema(stream) -> query_records` compact path.

## 6. Validation

- [x] 6.1 `pnpm --filter @pdpp/mcp-server run test` green.
- [x] 6.2 `openspec validate make-mcp-query-filters-agent-usable --strict`.
- [ ] 6.3 Owner/live: confirm an external hosted MCP client (e.g. ChatGPT) can
      now filter with the typed object end-to-end against the live RS. Recorded
      as a residual owner-run check (worker lacks the owner token / hosted
      client).
