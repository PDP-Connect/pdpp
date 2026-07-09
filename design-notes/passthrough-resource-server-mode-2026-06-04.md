# Passthrough Resource Server Mode

Status: promoted — absorbed by `openspec/changes/define-source-backed-fulfillment/` under the ratified name **source-backed fulfillment**
Owner: RI owner
Created: 2026-06-04
Updated: 2026-07-09
Related: `openspec/changes/define-source-backed-fulfillment/`, `docs/research/source-backed-fulfillment-prior-art-2026-07-09.md`, `design-notes/bulk-import-bootstrap-2026-06-04.md`, `design-notes/connector-public-listing-honesty-2026-05-15.md`, `design-notes/source-authority-vs-schema-identity-2026-04-30.md`, `design-notes/broad-storage-abstraction-2026-04-24.md`

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

## Resolution (2026-07-09)

Architecture mode ran; each open question below now has a decision, recorded normatively in `openspec/changes/define-source-backed-fulfillment/` (design.md carries the full rationale; the spec delta carries the requirements). Summary:

- **Name.** "Passthrough" is retired for this feature: it collides with the MCP token-passthrough security anti-pattern, ~30 unrelated code usages, and the separate "bulk-import/passthrough drain" idea. The feature is **source-backed fulfillment**; per-response provenance is `origin: live | cache` (absence = retained).
- **Partial support / mixed fulfillment.** Capability and policy are split: the manifest declares only static adapter capability per stream (`fulfillment.source_backed` object with eligibility constraints and a `query` subset of the stream's overall surface), and connection configuration selects the active posture per stream (`retained` default, `source_backed` only where capability is declared). Mixed connections are the normal case — the pilot itself mixes retained `messages` with source-backed `message_bodies` (attachment bytes/blob fulfillment explicitly deferred). Clients never see a mode enum; they see the active posture's effective query capability via connection-scoped discovery, freshness, provenance, and structured failure. V1 restricts `source_backed` to eligible `append_only` streams because Core Tier-1 `changes_since` on `mutable_state` requires projection-scoped local version history; the mutable case is deferred with a named path (projection-hash ledger).
- **Query/filter capability gaps.** The Core base query surface (bare lists, exact filters, projection, ordering, cursors, detail reads) is never narrowed or conditionally rejected by posture — pagination bounds upstream work per page and Core rate limiting governs sustained deep pagination; streams whose upstream cannot serve that contract in bounded pages are simply ineligible in v1 (Steampipe-style required-filter admission is explicitly deferred — it would change what a valid base request is, which is Core's to decide). Posture narrows only declaration-driven affordances (range filters, expand, search, aggregation), pushdown-or-refuse: undeclared shapes stay HTTP 400, never silently approximated. Fetch-and-locally-filter is permitted only inside the per-page fetch envelope derived from the effective filter. The "leak during the round trip" worry is resolved by precise accounting: grants govern server→client disclosure, not the server's own acquisition; the new risk is client-*caused* acquisition, so the per-page envelope bound and non-canonical cache exist to cap it.
- **Storage and indexing.** Minimal state is enumerated per semantic: credentials/schema/grants/audit/cursors always; bounded non-canonical TTL cache optional; version ledger only for the deferred mutable case; search indexes only if search affordances are declared (v1 source-backed streams declare none). The broad-storage-abstraction deferral is deliberately not tripped — the seam is the injected `queryRecords` operation dependency, not a new storage API.
- **Provenance.** Response-level `meta.fulfillment.origin` composed with the existing Core `freshness` object (`captured_at` = upstream fetch time); upstream unavailability is a structured 503 `source_unavailable`, never an empty 200 or undisclosed staleness; every upstream fetch caused by a client read leaves a spine audit event.
- **Agent understanding of incomplete support.** No parallel vocabulary was invented: agents discover the reduced surface through the same connection-scoped `schema(stream)` effective-capability disclosure that gates all queries; MCP requires zero adapter changes because tools ride the same operations.

Prior art (Trino pushdown honesty, Steampipe required-quals, OData Capabilities vocabulary, Gmail/Slack/Graph heterogeneity, UMA/GNAP, fintech cache-vs-pass-through) is captured with citations in `docs/research/source-backed-fulfillment-prior-art-2026-07-09.md`.

## Open Questions

These were unresolved when captured (2026-06-04) and are now answered above; kept for history:

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
- 2026-07-09: Promotion trigger met deliberately in architecture mode. Renamed to **source-backed fulfillment** (see Resolution for the collision rationale), all five open questions answered, and the design promoted as `openspec/changes/define-source-backed-fulfillment/` with the prior-art corpus at `docs/research/source-backed-fulfillment-prior-art-2026-07-09.md`. V1 boundary: append-only streams, cooperative API/credential upstreams only (browser polyfills excluded), grant enforcement local, no Core change. Delegated enforcement to an upstream PDPP server remains explicitly out of scope, as in the original leaning.
