## Context

The reference deployment serves `/icon.svg` and `/favicon.ico`, but MCP clients do not necessarily crawl web favicons for a custom connector. The in-repo `@modelcontextprotocol/sdk` version accepts `icons` on the MCP `Implementation` object and returns that object as `serverInfo` in the initialize response.

## Goals / Non-Goals

**Goals:**

- Advertise the PDPP icon through MCP `serverInfo.icons` for hosted MCP clients.
- Use a same-origin `/icon.svg` URL derived from the public resource origin.
- Preserve existing OAuth protected-resource metadata semantics.

**Non-Goals:**

- Guarantee Claude's connector directory UI displays the icon.
- Add non-standard OAuth protected-resource metadata such as `logo_uri`.
- Add or change icon assets.

## Decisions

Use MCP `serverInfo.icons` rather than OAuth metadata. MCP `Implementation` already includes `icons`, and the SDK returns it during initialize. OAuth protected-resource metadata in this repo has no standard `logo_uri` field, so adding one would be speculative and client-specific.

Pass the icon URL from the hosted route into the shared MCP server factory. The stdio adapter has no stable public origin, so it continues to omit icons unless a caller supplies them.

Add an HTTP `Link: </icon.svg>; rel="icon"; type="image/svg+xml"` header on hosted MCP responses. This is a safe web-discovery hint for clients that inspect response headers and does not alter JSON-RPC payloads or OAuth metadata.

## Risks / Trade-offs

- Claude may still ignore both MCP icons and favicon hints → Treat this as best-effort advertisement; directory listing or product-side support may still be required.
- SVG support varies by client → Declare `mimeType: "image/svg+xml"` and `sizes: ["any"]`, matching the existing scalable asset.
- Header discovery is optional → Keep `serverInfo.icons` as the authoritative standards-aligned channel and test it directly.
