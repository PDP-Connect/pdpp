# Passthrough Resource Server Mode

Status: captured
Owner: RI owner
Created: 2026-06-04
Updated: 2026-06-04
Related: none

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

## Promotion Trigger

Promote to OpenSpec when implementing any connection mode that serves records by live upstream API/PDPP delegation rather than retained local records, or when connector manifests need to declare passthrough capability subsets.

## Decision Log

- 2026-06-04: Captured as a future feature. Do not implement in the ChatGPT slow-catch-up tranche.
