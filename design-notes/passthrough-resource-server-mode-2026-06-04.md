# Passthrough Resource Server Mode

Status: captured
Owner: RI owner
Created: 2026-06-04
Updated: 2026-06-04
Related: `design-notes/bulk-import-bootstrap-2026-06-04.md`, `design-notes/connector-public-listing-honesty-2026-05-15.md`, `design-notes/source-authority-vs-schema-identity-2026-04-30.md`, `design-notes/broad-storage-abstraction-2026-04-24.md`

## Question

Should a personal server be able to satisfy PDPP requests by routing them to an upstream source at request time, without first collecting and storing the full source dataset locally?

## Context

The reference implementation primarily proves a collected-data model: connectors populate local records, and the resource server enforces grants over retained records. A future mode could instead treat the personal server as a gateway:

- an upstream service implements PDPP directly, and the operator's server wraps or delegates to it;
- an operator has an API key for a source whose API can satisfy the needed stream, query, projection, and filter semantics;
- the server keeps connection metadata, capability mappings, cursors, and lightweight indexes, but fetches records just in time.

This is not a new protocol requirement yet. It is a future reference/server capability question.

## Stakes

Passthrough mode could reduce storage, avoid unnecessary collection, and let conformant upstream services participate without duplicating data. The hard part is honesty: many upstreams will support only part of PDPP's read surface. The server must not advertise grant/query capabilities it cannot enforce.

## Current Leaning

Treat passthrough as a resource-server fulfillment mode with explicit capability disclosure:

- A passthrough connection declares which streams, fields, filters, sorting, pagination, search, expansion, and freshness semantics are served upstream.
- Unsupported PDPP operations fail explicitly or are marked unavailable; the server must not silently approximate grant constraints.
- The server may cache indexes, cursors, schemas, and selected records, but cached data should be distinguished from locally collected canonical records.
- Provenance should identify the upstream authority and whether each response was served from live upstream, cache, or local retained data.
- Grant enforcement remains the local personal server's responsibility unless delegation to an upstream PDPP server is explicitly specified.

## Open Questions

These are unresolved and should be answered in architecture mode before promotion:

- Partial support: how does a connection express that only some streams, fields, filters, or sort/search/expansion operations are passthrough-served, while the rest are unavailable or fall back to a collected copy? Mixed-fulfillment connections (some streams passthrough, some collected) need a coherent model.
- Query/filter capability gaps: when an upstream cannot evaluate a PDPP filter, sort, or projection server-side, does the personal server reject, fetch-and-locally-filter, or mark the operation unsupported? Fetch-and-filter can leak more than the grant allows during the round trip.
- Storage and indexing: what minimal local state (cursors, schema maps, secondary indexes, cached records) is justified for passthrough, and how is cache invalidation/freshness expressed without re-collecting?
- Provenance: each response should disclose whether it came from live upstream, local cache, or retained canonical records, and which upstream authority answered.
- Agent understanding of incomplete support: an MCP/agent consumer must be able to discover, before querying, that a passthrough connection serves only a subset of the read surface. Capability disclosure should be machine-readable and reuse the existing maturity/coverage honesty vocabulary rather than inventing a parallel one, so an agent does not assume a query is supported and silently get an approximated or empty answer.

## Promotion Trigger

Promote to OpenSpec when implementing any connection mode that serves records by live upstream API/PDPP delegation rather than retained local records, or when connector manifests need to declare passthrough capability subsets.

## Decision Log

- 2026-06-04: Captured as a future feature. Do not implement in the ChatGPT slow-catch-up tranche.
- 2026-06-04: Added explicit Open Questions (partial support, query/filter capability gaps, storage/indexing, provenance, agent understanding of incomplete support) and linked related notes, to make the note useful for later architecture mode. Still non-normative; no spec change.
