# source-backed-fulfillment Specification

## ADDED Requirements

### Requirement: The manifest declares source-backed capability; it does not select posture

The connector manifest SHALL be able to declare, per stream, that the connector's adapter supports source-backed fulfillment, via an optional `fulfillment.source_backed` capability object. The manifest declares static capability and constraints only; it SHALL NOT select the active fulfillment posture of any connection. The capability object SHALL be validated deterministically from the manifest JSON alone, with no external state.

`append_only` stream semantics are necessary but not sufficient. A stream declaring `fulfillment.source_backed` SHALL also satisfy an eligibility contract, validated from the manifest: stable source-native record identity for the declared `primary_key`; a declared `cursor_field` whose ordering the upstream adapter can produce deterministically as the Core stable sort `(cursor_field, primary_key)` in both `order` directions; and adapter support for the **full Core base query surface** (list with `limit`/`cursor`/`order`, exact top-level scalar filters, `fields`/`view` projection, and single-record detail reads) with upstream work bounded per page. An upstream that cannot enumerate the stream in bounded pages makes the stream ineligible in this version; conditional admission mechanisms such as required request filters are NOT part of this version (see design for the explicit deferral). Declaring `fulfillment.source_backed` on a `mutable_state` stream SHALL fail manifest validation, because Core Tier-1 `changes_since` conformance for mutable streams requires local version history this posture does not maintain. Declaring it on a stream whose schema carries `blob_ref` fields SHALL also fail manifest validation in this version: Core blob fetch is record-mediated, and a source-backed blob lifecycle (identity, authorization, proxy/redirect, cache, retry) is not defined by this capability — blob fulfillment is explicitly deferred to a separate extension.

The capability object SHALL carry the source-backed query surface as a `query` object using the same grammar as the stream-level `query` declaration — no parallel vocabulary. Manifest validation SHALL reject a `fulfillment.source_backed.query` declaration that is not a subset of the stream's overall `query` surface (fields, operators, expand relations, and any separately declared retrieval affordances). One stream therefore has one overall query surface and at most one declared source-backed subset of it; which of the two governs a given connection's declaration-driven affordances is decided by that connection's active posture, never by both at once.

#### Scenario: capability declaration on an eligible append-only stream

- **WHEN** a connector manifest declares `fulfillment.source_backed` on an `append_only` stream that satisfies the eligibility contract
- **THEN** manifest validation SHALL accept the manifest
- **AND** no connection's behavior SHALL change until that connection selects the posture

#### Scenario: capability declaration on a mutable-state stream

- **WHEN** a connector manifest declares `fulfillment.source_backed` on a `mutable_state` stream
- **THEN** manifest validation SHALL reject the manifest with a structured validation error identifying the stream and the reason

#### Scenario: capability declaration on a stream that cannot serve the base surface

- **WHEN** a connector manifest declares `fulfillment.source_backed` on a stream whose adapter cannot serve bounded-per-page listing, deterministic ordering in both directions, or detail reads
- **THEN** manifest validation SHALL reject the manifest with a structured validation error identifying the missing eligibility condition

#### Scenario: source-backed query subset exceeds the stream surface

- **WHEN** a manifest declares a `fulfillment.source_backed.query` shape (field, operator, or expand relation) absent from the stream's overall `query` surface
- **THEN** manifest validation SHALL reject the manifest identifying the excess declaration

### Requirement: Connection configuration selects the active fulfillment posture

The active fulfillment posture SHALL be a per-connection, per-stream selection in connection configuration, with exactly two values: `retained` (the default when unselected) and `source_backed`. Selecting `source_backed` SHALL be valid only for streams whose manifest declares the `fulfillment.source_backed` capability; selecting it elsewhere SHALL be rejected with a structured error. The composition SHALL be deterministic: given a manifest and a connection's configuration, the active posture of every stream is a pure function of the two, and validation of a connection's selections against its manifest SHALL be repeatable with no external state. Posture selection and later posture changes are owner actions and SHALL be recorded as spine events. A connection MAY mix postures across streams; each stream's reads follow that stream's active posture independently. Clients SHALL NOT observe posture as a request or grant parameter; clients see only effective query capability, freshness, provenance, and structured failure.

#### Scenario: selecting source-backed where capability is declared

- **WHEN** an owner selects `source_backed` for a stream whose manifest declares the capability
- **THEN** the selection SHALL be accepted, recorded as a spine event, and subsequent reads of that stream on that connection SHALL follow the source-backed contract

#### Scenario: selecting source-backed without declared capability

- **WHEN** an owner selects `source_backed` for a stream whose manifest does not declare `fulfillment.source_backed`
- **THEN** the selection SHALL be rejected with a structured error naming the stream and the missing capability

#### Scenario: no selection made

- **WHEN** a connection makes no fulfillment selection for any stream
- **THEN** every stream's active posture SHALL be `retained` and behavior SHALL be unchanged from the pre-change reference implementation

#### Scenario: mixed postures on one connection

- **WHEN** a connection has one stream active as `source_backed` and another as `retained`
- **THEN** each stream's reads SHALL follow its own active posture
- **AND** the retained stream's coverage, freshness, and evidence semantics SHALL be unaffected by the source-backed stream

### Requirement: The Core base query surface is never narrowed by posture

A stream actively served source-backed SHALL continue to satisfy the full Core base query surface: list reads with `limit` (including clamping and the `limit_clamped` warning), opaque direction-bound `cursor` pagination, `order`, exact top-level scalar filters on authorized fields, `fields`/`view` projection, and single-record detail reads. Posture selection SHALL NOT cause a request that is valid under Core's durable base query surface to be rejected; a posture change SHALL NOT invalidate any existing grant or any client behavior that uses only the base surface. Upstream enumeration is bounded by pagination: each page's upstream fetch SHALL be bounded by the page size plus the declared overscan bound, and sustained deep pagination is governed by the existing Core rate-limiting semantics (`rate_limit_exceeded`, `Retry-After`), not by rejecting the read.

Posture MAY narrow only declaration-driven affordances: `query.range_filters`, `query.expand`, and separately declared retrieval/aggregation affordances. When the active posture is `source_backed`, the `fulfillment.source_backed.query` subset governs those affordances; when `retained`, the stream-level declarations govern. Requests using declaration-driven shapes outside the effective declaration SHALL be rejected HTTP 400 per the existing Core rule, and the resource server SHALL NOT silently drop, weaken, or approximate a requested filter, sort, or projection. Connection-scoped discovery surfaces (stream metadata, `schema(stream)`, `field_capabilities`, `expand_capabilities`, and tool-facing derivations of them) SHALL advertise only the active posture's effective capability.

#### Scenario: bare Core list request against a source-backed stream

- **WHEN** a client under a valid grant sends a bare list request (no filters) to an actively source-backed stream
- **THEN** the resource server SHALL serve the page with upstream work bounded by the page size plus the declared overscan bound
- **AND** SHALL NOT reject the request for lacking a filter

#### Scenario: posture switch narrows only declaration-driven affordances

- **WHEN** a stream's active posture changes from `retained` to `source_backed`
- **THEN** connection-scoped discovery SHALL stop advertising declaration-driven affordances outside the source-backed subset (including index-backed search and aggregation)
- **AND** a request using such an affordance SHALL be rejected HTTP 400
- **AND** every base-surface request that succeeded before the switch SHALL still succeed

#### Scenario: posture switch back restores capability

- **WHEN** the stream's active posture changes back to `retained`
- **THEN** connection-scoped discovery SHALL advertise the full stream-level surface again and previously narrowed declaration-driven shapes SHALL succeed

#### Scenario: undeclared range filter against a source-backed stream

- **WHEN** a client sends a range filter on a field not declared in the stream's `fulfillment.source_backed.query.range_filters` subset while the stream is actively source-backed
- **THEN** the resource server SHALL respond HTTP 400 and SHALL NOT issue an upstream fetch that ignores the filter

### Requirement: Source-backed page cursors are bound and fail loudly

Page cursors for actively source-backed streams SHALL be opaque logical keyset cursors over the Core stable sort `(cursor_field, primary_key)`, direction-bound per Core, and bound to the effective filter, projection, order, connection, and an upstream consistency marker (for example a source-generation or session-validity signal such as an IMAP `UIDVALIDITY` value, and the connection credential generation). An upstream pagination token MAY be wrapped inside the cursor only when the upstream's ordering equals the declared keyset order. A presented cursor whose bindings no longer match, or whose upstream consistency marker has changed or expired, SHALL be rejected with HTTP 400 `invalid_cursor`, requiring the client to restart pagination; the resource server SHALL NOT silently continue with possible gaps or duplicates.

#### Scenario: upstream consistency marker changes mid-pagination

- **WHEN** a client presents a page cursor whose wrapped upstream consistency marker no longer matches the upstream's current state
- **THEN** the resource server SHALL respond HTTP 400 `invalid_cursor`
- **AND** SHALL NOT return a page that could contain gaps or duplicates relative to the earlier pages

#### Scenario: cursor bound to a different effective filter

- **WHEN** a client presents a page cursor minted under a different effective filter, projection, or order
- **THEN** the resource server SHALL respond HTTP 400 `invalid_cursor`

### Requirement: Source-backed responses disclose provenance and freshness

List, detail, and expanded responses served from an actively source-backed stream SHALL carry the Core `freshness` object and a response-level fulfillment disclosure `meta.fulfillment` with `origin` set to `live` (fetched from the upstream within this request) or `cache` (served from the bounded, non-canonical response cache). `freshness.captured_at` SHALL reflect the upstream fetch time relevant to the response and `freshness.last_attempted_at` the most recent attempt. `freshness.status` SHALL be `current` only when a successful upstream confirmation covers the full effective request; when coverage is partial, unconfirmed, or served from cache under staleness policy, `status` SHALL be `stale` or `unknown` accordingly. Retained streams SHALL remain unchanged; absence of `meta.fulfillment` means retained fulfillment.

#### Scenario: live-served page with full coverage

- **WHEN** a list page is fully satisfied by a successful upstream fetch within the request
- **THEN** the response SHALL carry `meta.fulfillment.origin: "live"`, `freshness.captured_at` reflecting that fetch, and `freshness.status: "current"`

#### Scenario: cache-served page

- **WHEN** a list page is satisfied from the source-backed response cache within the configured staleness bound
- **THEN** the response SHALL carry `meta.fulfillment.origin: "cache"` and `freshness.captured_at` reflecting the original upstream fetch time
- **AND** `freshness.status` SHALL reflect the staleness policy evaluation, not an unconditional `current`

### Requirement: Source-backed fulfillment is an advertised reference extension

The reference implementation SHALL advertise source-backed fulfillment as a named extension in its protected-resource metadata (following the existing retrieval-capability advertisement pattern), identifying the extension, its stability, the `meta.fulfillment` response field, and the `source_unavailable` error code. A client that ignores the advertisement SHALL still observe Core-conformant behavior on the base query surface: Core envelope shapes, additive response metadata, and structured errors from the Core error envelope. Posture narrows only declaration-driven affordances, which are always discoverable through connection-scoped stream metadata before querying.

#### Scenario: extension discovery

- **WHEN** a client reads the protected-resource metadata of a deployment with source-backed fulfillment enabled
- **THEN** the metadata SHALL name the source-backed fulfillment extension with its response fields and error codes

### Requirement: Upstream unavailability is a structured failure, not a silent degradation

When an actively source-backed read cannot be satisfied because the upstream is unreachable, rejects the credential, or throttles the request, and no cached response within the configured staleness bound exists, the resource server SHALL fail the request with a structured `source_unavailable` error carrying HTTP 503 and a `Retry-After` header when a retry hint is known. The resource server SHALL NOT return an empty successful page, and SHALL NOT serve data older than the configured staleness bound without disclosing it via `freshness.status`.

#### Scenario: upstream unreachable with no usable cache

- **WHEN** the upstream fetch fails and no cache entry within the staleness bound exists
- **THEN** the resource server SHALL respond HTTP 503 with error code `source_unavailable`
- **AND** the response SHALL NOT be an empty HTTP 200 list

#### Scenario: upstream throttled with usable cache

- **WHEN** the upstream throttles the fetch and a cache entry within the staleness bound exists
- **THEN** the resource server MAY serve the cached page with `meta.fulfillment.origin: "cache"` and honest `freshness` metadata

### Requirement: Grant enforcement, self-export, and credential boundaries stay local

Actively source-backed reads SHALL enforce grants identically to retained reads: token introspection, stream membership, `effective_filter = grant_filter AND request_filter`, field projection, and revocation semantics are unchanged. Owner self-export (Core Section 8) SHALL be supported for actively source-backed streams under the same per-page-bounded fetch contract. The upstream fetch SHALL be issued with the connection's own stored credential; neither a client access token nor an owner token SHALL be forwarded upstream in any form. Each page's upstream fetch envelope SHALL be derived from the effective filter and bounded by the page size plus the declared overscan bound; the resource server SHALL NOT issue upstream requests broader than needed to satisfy the current page.

#### Scenario: projection applied to live-fetched records

- **WHEN** a grant authorizes a field subset and a source-backed read fetches upstream records containing additional fields
- **THEN** the response SHALL contain only the grant-authorized projection
- **AND** undisclosed fields SHALL NOT be written to canonical record storage as a side effect

#### Scenario: owner self-export over a source-backed stream

- **WHEN** an owner holding a valid owner token queries an actively source-backed stream
- **THEN** the resource server SHALL serve the read under the same per-page-bounded envelope, provenance, and failure contract

#### Scenario: tokens never cross the upstream boundary

- **WHEN** a source-backed read issues any upstream request
- **THEN** the upstream request SHALL authenticate with the connection credential only
- **AND** no PDPP access or owner token material SHALL appear in the upstream request

### Requirement: Posture governs the collection and canonical-record lifecycle

While a stream's active posture is `source_backed`, that connection-stream SHALL be excluded from ordinary scheduled and manual collection scope and from ordinary canonical ingest; only an explicit owner-initiated import/migration operation may write canonical records for it. Existing canonical rows for the stream SHALL be preserved but dormant: they SHALL NOT be served by grant or owner reads (read dispatch serves exclusively from the adapter and its cache), SHALL NOT contribute to coverage or freshness evidence of currency, and SHALL NOT be advertised through connection-scoped discovery as available retained data. A posture switch SHALL NOT delete canonical rows; deletion is a separate explicit owner action. Switching a stream back to `retained` SHALL enter a catch-up posture — reads serve the preserved canonical rows with `freshness.status` of `stale` or `unknown` — until collection re-establishes coverage evidence; the switch itself SHALL never yield an instant `current` status.

#### Scenario: scheduled collection skips an actively source-backed stream

- **WHEN** a scheduled or manual collection run executes for a connection with a stream actively `source_backed`
- **THEN** that stream SHALL be excluded from the run's scope and no ordinary canonical ingest SHALL occur for it

#### Scenario: posture switch preserves but retires canonical rows

- **WHEN** an owner switches a stream from `retained` to `source_backed`
- **THEN** existing canonical rows SHALL be preserved unmodified and SHALL NOT be deleted
- **AND** subsequent reads SHALL be served from the adapter, never from the dormant rows

#### Scenario: switching back is catch-up, not instant green

- **WHEN** an owner switches the stream back to `retained`
- **THEN** reads SHALL serve the preserved canonical rows with `freshness.status` of `stale` or `unknown`
- **AND** `freshness.status: "current"` SHALL be reported only after collection re-establishes coverage evidence

### Requirement: Health and collection reporting treat source-backed streams as served on demand, not as gaps

Collection run reports SHALL carry an explicit accepted-not-collected disposition, `source_backed`, for streams whose active posture is `source_backed`, distinct from collected, skipped, deferred, unavailable, and failed. The connection and run health projection SHALL NOT classify such a stream as unknown, a skipped gap, stale, or pending-check on account of absent collection evidence: collection coverage is not applicable to the posture. Response freshness remains per-read disclosure on each response; connection readiness for the stream SHALL derive from credential/adapter readiness or probe evidence, not from collection recency. Owner surfaces SHALL label the stream as served on demand, SHALL disclose dormant retained rows (count and size) rather than hide physical retention, and SHALL offer deletion of dormant rows only as an explicit, separate owner action.

#### Scenario: mixed connection stays healthy without pretending collection

- **WHEN** a connection has a stream actively `source_backed` and its retained streams are healthy
- **THEN** collection reports SHALL record the `source_backed` disposition for that stream
- **AND** the connection health projection SHALL be able to report healthy without collection evidence for that stream and without classifying it as a gap, unknown, stale, or checking

#### Scenario: readiness follows credential and adapter evidence

- **WHEN** the health projection evaluates an actively source-backed stream
- **THEN** its readiness SHALL derive from connection credential/adapter readiness or probe evidence
- **AND** absence of collection runs SHALL NOT degrade it

#### Scenario: owner surface discloses dormancy and requires explicit deletion

- **WHEN** an owner views a stream that is actively source-backed and has dormant retained rows
- **THEN** the surface SHALL label the stream as served on demand and disclose the dormant retained row count and size
- **AND** deleting those rows SHALL require an explicit separate action, never occurring as a side effect of posture change

### Requirement: Source-backed reads leave audit evidence

Each read decision against an actively source-backed stream SHALL emit a spine event recording the connection, stream, the grant identifier (null for owner self-export), a digest of the request shape, whether an upstream fetch was attempted, and the outcome (`served_live`, `served_cache`, `source_unavailable`, or `rejected`), with timing. The event SHALL NOT contain record payloads or credential material.

#### Scenario: audit event for a live read

- **WHEN** a source-backed list request is served live
- **THEN** a spine event SHALL exist attributing the read and its upstream fetch to the grant and connection that caused it

#### Scenario: audit event for a rejected read

- **WHEN** a source-backed list request is rejected before any upstream fetch
- **THEN** a spine event SHALL record the rejection with `fetch_attempted: false`

### Requirement: The source-backed response cache is isolated, bounded, and non-canonical

Any cache used by source-backed fulfillment SHALL be non-canonical: bounded by a configured TTL and size, excluded from ingest, coverage, and freshness evidence accounting for retained records, distinguishable from canonical records in storage, and safely flushable at any time without loss of canonical data. Cache entries SHALL be partitioned at least by connection, connection credential generation, stream, grant (or owner-self-export principal), effective filter, and projection; an entry SHALL NOT be served across any of those boundaries. Cache entries SHALL be invalidated on credential rotation, connection reconfiguration, fulfillment posture change, and manifest version change for the stream. A cached entry SHALL NOT be used to satisfy a request whose effective filter or projection it does not exactly cover.

#### Scenario: cache does not cross grant or connection boundaries

- **WHEN** a page was cached for one grant on one connection
- **THEN** a read under a different grant, a different connection, or a rotated credential SHALL NOT be served from that entry

#### Scenario: posture change invalidates cache

- **WHEN** an owner changes a stream's active posture
- **THEN** the stream's source-backed cache entries SHALL be invalidated

#### Scenario: cache flush is safe

- **WHEN** the source-backed response cache is flushed
- **THEN** subsequent reads SHALL be satisfied by live fetches or fail per the unavailability rule
- **AND** no coverage, freshness, or canonical record evidence SHALL change
