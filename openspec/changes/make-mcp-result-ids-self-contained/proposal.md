# Make MCP Search-Result Ids Self-Contained Fetch Handles

## Why

A live ChatGPT retest of the 5-tool MCP surface (2026-06-09) showed the
search→fetch journey failing on multi-source hosted packages. Search hits
carried `id` = `stream:record_id` plus a SEPARATE `connection_id` field, so a
model had to carry TWO values between tools. `fetch(id)` without
`connection_id` returned a typed 409 `ambiguous_connection`; ChatGPT's
rendered envelope buried the second field and its model never completed a
fetch (retrying with both fields was verified to work). OpenAI's search/fetch
contract treats result ids as single opaque handles; ours leaked a join
requirement into the model loop.

## What Changes

- Search result ids become self-contained: when a hit carries a connection,
  the id is `{connection_id}/{stream}:{record_id}`. The complete handle
  appears in both model-visible `content[]` text and
  `structuredContent.results`.
- `fetch` accepts both forms: the self-contained id (no other argument
  needed — the embedded connection is forwarded to the RS as the canonical
  `connection_id` query parameter) and the legacy `stream:record_id` form with
  an optional `connection_id` argument whose semantics are unchanged,
  including the typed `ambiguous_connection` 409 path.
- A self-contained id whose embedded connection disagrees with an explicit
  `connection_id` argument is rejected with a typed error before any RS call.
- The search `content[]` preview stops repeating `connection_id` as a separate
  field when it is embedded in the id, keeping the prose budget flat.
- Agent-journey regression coverage follows the model-visible-journey canon
  rule: consume only `content[]` text, extract the handle, and complete
  search→fetch on a multi-source fixture without a `connection_id` argument.

`query_records` is intentionally out of scope: its results are canonical RS
record envelopes whose `id` values are plain record ids, not composite fetch
handles minted for the OpenAI search/fetch contract, so there is no second
handle to fold in.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-adapter`: search result ids are single opaque fetch handles that encode
  the source connection; `fetch` resolves both the self-contained and legacy
  id grammars.

## Impact

- Affected package: `packages/mcp-server` (`src/tools.js`, `src/server.js`
  instructions, README).
- Hosted MCP inherits the fix through `@pdpp/mcp-server/server`
  (`handleStreamableHttpRequest`); no reference-implementation changes.
- Affected tests: MCP search/fetch integration, token-budget, and new
  self-contained-id journey suites.
- No REST contract changes, storage changes, or grant-semantics changes.
