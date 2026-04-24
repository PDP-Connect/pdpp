## Why

Assistant clients can query known streams today, but owner-token polyfill callers still need out-of-band connector IDs before they can discover per-stream metadata. The reference needs a small public discovery floor so clients can enumerate visible connector/source boundaries and then use the existing stream metadata authority.

## What Changes

- Add bearer-authenticated `GET /v1/connectors` on the Resource Server.
- For owner tokens in polyfill mode, return registered connector-backed sources and manifest-declared stream summaries without requiring `connector_id`.
- For client tokens, return only the grant-bound source and grant-authorized stream names.
- Include coarse per-stream capability hints and links to existing stream metadata/record-list URLs.
- Do not inline full schemas or change filters, expansion, changes, blobs, semantic retrieval, or dashboard behavior.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: public query discovery gains a minimal connector/source listing that points to existing per-stream metadata.

## Impact

- Public RS API adds `GET /v1/connectors`.
- Reference contract/OpenAPI/generated docs update.
- Reference server adds grant-safe discovery tests for owner and client tokens.
