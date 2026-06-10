## Why

Hosted MCP clients need a standards-aligned way to discover the PDPP reference icon. The public reference deployment already serves `/icon.svg`, but the MCP initialize response does not advertise an icon in `serverInfo`.

## What Changes

- Add MCP `serverInfo.icons` metadata for the hosted MCP server using the same-origin `/icon.svg` asset.
- Add a same-origin HTTP `Link` icon hint on hosted MCP responses.
- Keep OAuth protected-resource metadata limited to standard fields and existing PDPP extensions; do not invent `logo_uri` for that surface.
- Add focused tests proving the MCP initialize response carries the icon and that protected-resource metadata remains standards-aligned.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-adapter`: hosted MCP initialize metadata advertises a display icon when the reference can build a public icon URL.

## Impact

- Affected code: `packages/mcp-server` server construction and `reference-implementation` hosted MCP route wiring/tests.
- No new dependencies, routes, OAuth metadata fields, or token semantics.
