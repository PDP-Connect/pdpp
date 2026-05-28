## Why

Hosted MCP now works with ChatGPT-compatible OAuth, but the current setup UX only lets the owner approve one source at a time. For a personal assistant, that is a poor default: useful access often spans email, Slack, local coding history, finance, and other owner-selected sources.

The fix must not become a disguised owner token or a new cross-source PDPP grant. PDPP grants should remain source-bounded so audit, enforcement, and revocation stay understandable.

## What Changes

- Add a reference-hosted MCP grant-package flow.
- Let the owner approve multiple sources in one hosted MCP consent ceremony.
- Issue one normal source-bounded child grant per approved source.
- Issue one MCP client access/refresh-token pair bound to the package, not to a cross-source grant.
- Teach hosted MCP reads to fan out or route through active child grants while preserving each child grant's existing enforcement.
- Keep package-level revocation as a convenience without replacing per-grant revocation.

## Capabilities

### Added

- `agent-consent-bundling`: accepted reference implementation semantics for hosted MCP grant packages.

### Modified

- `reference-implementation-architecture`: hosted MCP authorization and resource-server enforcement support package tokens composed of source-bounded child grants.

## Impact

- Storage: add grant-package metadata and child-grant membership.
- OAuth: hosted MCP code/refresh-token exchange may return package-bound client tokens.
- Consent UI: source picker becomes multi-select with cumulative risk presentation.
- MCP/RS: package tokens require source-aware tool behavior and per-child-grant enforcement.
- Security: improves UX without introducing owner bearer access or multi-source PDPP grants.
