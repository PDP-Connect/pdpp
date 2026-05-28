## Status

Implementation change for the reference hosted MCP path. This change does not modify the PDPP core grant model: issued PDPP grants remain source-bounded.

## Problem

ChatGPT and similar hosted MCP clients expect one OAuth connection and one bearer/refresh-token pair. Owners expect a personal data assistant to be able to search across more than one connection. The current hosted MCP source picker forces a separate authorization ceremony per source, which is safe but not acceptable UX.

The unsafe shortcut would be to issue an owner token or invent one cross-source grant. That would blur source boundaries, make revocation less granular, and diverge from the current PDPP model.

## Design

### Relationship To Broad Agent Consent

This change is the narrow hosted-MCP implementation slice of
`design-fast-broad-agent-consent` Option B: one owner-facing ceremony can issue
multiple independent source-bounded grants. It intentionally does not implement
general multi-entry PAR, reusable permission sets, or agent roles.

The prior-art and owner-review synthesis in that design track remains the
design basis here: package/session grouping is allowed for UX, audit, token
routing, and revocation convenience; record authorization still comes only from
the child grants.

### Grant Package

A grant package is an AS/reference-internal grouping object:

- `grant_package_id`
- owner subject
- client id
- status
- created/issued timestamps
- child grant ids
- optional request/package trace metadata

It is not a PDPP grant. It does not carry `source`, `streams`, or field/time/resource constraints directly. Those remain on the child grants.

### Authorization Ceremony

For hosted MCP OAuth requests that do not bring explicit `authorization_details`, the reference consent flow presents a multi-select source picker. In the reference implementation, the selectable unit is the configured owner connection where available, not only the connector type. This keeps duplicate Codex, Claude, Gmail, or other multi-account connections legible and prevents a package child grant from resolving to an arbitrary default instance.

The owner sees:

- one card per configured connection or connector fallback
- owner-facing connection name, connector type, stream count, and stable connection identity
- cumulative risk summary
- clear copy that approval issues independent grants per source

Approval creates one source-bounded child grant for each selected source. A package record groups those grant ids. The PDPP grant source remains source-bounded by connector/provider identity; the reference implementation also stores a `connector_instance_id` in the child grant's storage binding so reads route to the exact configured connection the owner selected.

### Client Token

The MCP client receives one OAuth access token and, if registered, one refresh token. That token is package-bound:

- it is accepted only by the hosted MCP/read-only client surfaces
- it is not an owner token
- it is not a PDPP grant token for a single source
- it resolves to active child grants at use time

Refresh-token exchange mints a new package-bound access token for the same package. If the package is revoked, refresh exchange fails.

### MCP Tool Behavior

Package tokens preserve one-client UX while making source identity explicit:

- `schema` and `list_streams` return source-grouped information.
- `search` may search across all active child grants and returns source-qualified result ids.
- `query_records` requires a source selector when the token has more than one child grant. If multiple child grants share the same connector type, a connector-id selector is ambiguous and the client must pass the source key/token or connection identifier returned by `list_streams`.
- `fetch` accepts source-qualified ids produced by `search`.
- `fetch_blob` requires enough source/blob context to route to the correct child grant.

The MCP adapter forwards record filters using the resource server's structured filter shape. Date/time narrowing therefore uses manifest-declared fields and nested operators such as `filter[created_at][gte]=...`, not free-form strings.

MCP is intentionally not a second read API with separate semantics. The reference
MCP server is an adapter over the same scoped-token REST resource-server contract:

- tool routing uses a declarative REST-read endpoint registry rather than
  MCP-local path switches
- search modes map to the same REST endpoints exposed by the server
  (`/v1/search`, `/v1/search/semantic`, `/v1/search/hybrid`)
- query serialization is shared with the REST client, including nested
  structured filters
- package fan-out passes each child grant through the same endpoint path selected
  by the adapter, so adding a REST search mode does not require inventing a
  separate hosted-MCP behavior
- connector identity equivalence for legacy local collector ids is centralized
  outside the hosted-MCP picker, so UI curation, manifest aliasing, and future
  surfaces reuse one reference identity helper

Existing single-source grant tokens keep the current behavior for backward compatibility.

### Enforcement

The package is never the authorization proof for records. Each read resolves to one child grant before it touches records or blobs.

For fan-out operations:

1. Load active package membership.
2. For each child grant, run the same manifest/grant validation used by single-grant tokens.
3. Execute the existing source-scoped read under that child grant.
4. Merge results with source labels.

If one child grant is revoked or invalid, that source disappears or returns a source-local error without widening access to other sources. Package revocation disables package tokens and refresh tokens. Per-child-grant revocation remains independently available.

## Alternatives Considered

### Single Multi-Source Grant

Rejected. It would diverge from the current PDPP core model and weaken source-bounded audit/revocation semantics.

### Owner Token For MCP

Rejected. It would bypass the grant model and turn a data-access integration into an admin/control-plane credential.

### Multiple Separate ChatGPT Connectors

Rejected as the default UX. It preserves safety but makes the personal assistant experience fragmented and repetitive.

## Non-Goals

- No owner/admin/control-plane MCP in this change.
- No public protocol claim that PDPP grants can span multiple sources.
- No arbitrary client-authored "all data" package without owner review.
- No package-level enforcement that bypasses child grants.

## Acceptance Checks

- ChatGPT-compatible OAuth still registers with `authorization_code + refresh_token`.
- A hosted MCP source picker can approve multiple sources in one ceremony.
- The resulting OAuth token can list/search across the approved sources.
- Every returned record/result carries source identity.
- Revoking one child grant removes that source from package reads.
- Revoking the package invalidates package access and refresh exchange.
- Single-source hosted MCP grants still work.
