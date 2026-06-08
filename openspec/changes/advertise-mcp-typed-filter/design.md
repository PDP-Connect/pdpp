## Context

The resource server accepts bracket-shaped filter query params and points callers toward typed filter objects when string parsing fails. ChatGPT's MCP host could not send typed objects because the exposed MCP schema still appeared as `filter?: string`.

## Decision

Advertise `filter` as an object record in MCP tool schemas. Runtime validation still preprocesses legacy literal bracket strings into the internal typed shape before forwarding them to the resource server.

This makes the schema usable for chat hosts while preserving compatibility for clients that already send `filter[field]=value` strings.

## Alternatives

- Keep the object/string union. Rejected because hosts can choose the string branch and hide typed input.
- Accept URL-encoded bracket strings server-side only. Rejected because ChatGPT can reach the server with encoded strings, but that keeps a hostile host-visible schema and does not solve typed object calls.
- Remove legacy string support. Rejected because existing MCP clients may still send literal bracket strings.

## Acceptance Checks

- `tools/list` advertises `filter.type: "object"` for `query_records`, `aggregate`, and `search`.
- The advertised schema does not contain a top-level `anyOf`/`oneOf` string branch for `filter`.
- Typed object filters continue to forward as bracket query params.
- Legacy literal bracket string filters continue to forward as bracket query params.
