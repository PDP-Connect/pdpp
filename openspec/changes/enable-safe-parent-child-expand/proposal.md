## Why

`expand[]` is already implemented for declared, one-hop parent-child record joins, but first-party polyfill manifests do not safely expose it for high-value assistant paths such as Gmail message bodies and attachment metadata. The next slice should turn the existing mechanics into an auditable public behavior floor without broadening into graph traversal, entity resolution, aggregation, or blob hydration.

## What Changes

- Define the minimum durable public semantics for `expand[]`: only manifest-declared relationships listed under `query.expand`, one hop only, grant-safe child projection, list/detail parity, per-relation `expand_limit`, explicit unknown/missing relation errors, and explicit missing child-grant errors.
- Add manifest validation expectations so enabled expansions cannot drift from declared relationships or from child-stream schema shape.
- Enable only safe parent-to-child first-party relations where the related stream stores the parent record key as a top-level foreign key.
- Cover Gmail's high-value joins from `messages` to `message_bodies` and `attachments` as implementation-ready parent-child expansions.
- Treat Gmail `messages` to `threads` as implementation-ready only if modeled as a safe parent-to-child relation from `threads` to `messages`; reverse/belongs-to expansion from an individual message to its thread is a non-goal for this change.
- Keep Gmail attachment byte hydration, nested expansion, belongs-to reverse lookup, entity resolution, aggregations, blobs, and timeline endpoints out of scope.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: Adds reference read-path requirements for public `expand[]` enablement, manifest declaration safety, and first-party parent-child coverage.

## Impact

- Affected public surface: `GET /v1/streams/:stream/records?expand=...` and `GET /v1/streams/:stream/records/:id?expand=...`.
- Affected metadata surface: per-stream `relationships[]` and `query.expand[]` declarations returned by `GET /v1/streams/:stream`.
- Affected implementation areas for the later apply phase: `reference-implementation/server/records.js`, manifest validation, first-party polyfill manifests, and `reference-implementation/test/query-contract.test.js`.
- No new dependencies, storage tables, blob semantics, search endpoints, timeline endpoints, or new query grammar are introduced.
