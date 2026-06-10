## Context

The resource server accepts bracket-shaped filter query params because REST encodes nested filters as query keys. MCP is a JSON tool-call surface, so exposing that REST encoding directly as `filter?: string` gives agents a brittle contract and can turn intended filters into a bare `filter=` parameter.

External testing showed ChatGPT still saw `filter?: string` after a fresh app registration. Official source review did not find OpenAI or Claude documentation saying MCP hosts intentionally collapse object/string unions. The proven issue in this repo is enough: the MCP adapter exposed a non-ideal schema shape for structured data. The fix is to make the MCP contract object-only instead of depending on undocumented host behavior.

## Source Review

- MCP `Tool.inputSchema` is an object-root JSON Schema (`type: "object"`, `properties`, `required`): https://modelcontextprotocol.io/specification/2025-11-25/schema
- MCP SEP-2106 describes the current object-root restriction as real ecosystem friction and proposes broader JSON Schema support, but the current interoperable shape remains object-root: https://modelcontextprotocol.io/seps/2106-json-schema-2020-12
- OpenAI Structured Outputs requires root schemas to be objects and not root `anyOf`, which supports avoiding top-level union schemas for host interoperability: https://platform.openai.com/docs/guides/structured-outputs
- OpenAI's MCP guide and Anthropic's MCP connector guide do not document object/string union branch collapse as expected host behavior: https://platform.openai.com/docs/mcp/ and https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector

## Decision

Advertise and accept `filter` as an object record in MCP tool schemas. The adapter converts that object to REST bracket query parameters when calling the resource server.

String filters are rejected by MCP validation. `filter[field]=value` is not an MCP input shape; it is the REST wire encoding below the adapter boundary.

## Alternatives

- Keep the object/string union. Rejected because hosts can choose the string branch and hide typed input.
- Accept URL-encoded bracket strings server-side only. Rejected because ChatGPT can reach the server with encoded strings, but that keeps a hostile host-visible schema and does not solve typed object calls.
- Preserve legacy string support behind an object-shaped schema. Rejected because it preserves a non-ideal contract, complicates validation, and this reference deployment has no compatibility burden that justifies keeping raw REST query strings in the MCP surface.

## Acceptance Checks

- `tools/list` advertises `filter.type: "object"` for `query_records`, `aggregate`, and `search`.
- The advertised schema does not contain a top-level `anyOf`/`oneOf` string branch for `filter`.
- Typed object filters continue to forward as bracket query params.
- String filters are rejected before any REST request is made.
