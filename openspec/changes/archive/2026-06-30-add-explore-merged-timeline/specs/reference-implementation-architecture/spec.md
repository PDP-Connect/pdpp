## ADDED Requirements

### Requirement: Reference implementation SHALL expose a durable owner-session explore-records endpoint

The reference implementation SHALL expose `GET /_ref/explore/records` as a durable,
owner-session-authenticated reference route that returns a page of time-ordered records
merged across all of the owner's (connector_instance_id, stream) partitions. This route
is a reference/operator surface, NOT a PDPP Core protocol route, and SHALL NOT be
reachable over `/mcp` or with a grant-scoped token. Its response shape is designed
exclusively for the console Explore canvas and clients MUST NOT depend on it as a stable
external protocol.

#### Scenario: The endpoint is gated to owner sessions

- **WHEN** a request to `GET /_ref/explore/records` lacks a valid owner session
- **THEN** the reference SHALL reject it with a 401 response
- **AND** defining this endpoint SHALL NOT make any explore-records capability
  reachable over `/mcp` or with a grant-scoped token

#### Scenario: First-page response carries a snapshot anchor and merged record list

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records` without
  a cursor parameter
- **THEN** the response SHALL have `object: "list"` and include:
  - `data`: an array of `ExploreTimelineRecord` objects, each carrying
    `connector_id` (connector TYPE, e.g. `"amazon"`), `connector_instance_id`
    (connection INSTANCE, e.g. `"cin_..."`), `stream`, `record_key`, `emitted_at`,
    and `data`
  - `has_more`: `true` when more records exist beyond this page, `false` when all
    records in the snapshot have been returned
  - `next_cursor`: an OPAQUE cursor string when `has_more` is `true`; `null` when
    the feed is exhausted. Clients MUST treat it as opaque and pass it back
    verbatim — they MUST NOT parse or depend on its internal form. The reference
    implementation returns a short server-side handle (prefix `ecr1_`) that maps
    to the composite cursor payload stored server-side (see the cursor-transport
    requirement below); raw base64url v3 blob cursors are still accepted for
    backward compatibility (a stale v2 cursor, whose keyset key was `emitted_at`,
    is rejected as `invalid_cursor` so the tab re-anchors a fresh snapshot).
  - `snapshot_at`: an ISO-8601 timestamp corresponding to the ingest-sequence
    anchor captured at first-page time
  - `new_since_snapshot`: an integer count of records ingested after the snapshot
    anchor, for use as an "N new" affordance in the UI

#### Scenario: The console assembler derives a set-descriptor that constrains Explore canvas claims

The set-descriptor is assembled by the console (operator-ui) layer, NOT returned by the
endpoint. The endpoint returns only the raw merged page (`has_more`, `next_cursor`,
`new_since_snapshot`, etc.); the descriptor's `kind` is a console/lens decision (the same
endpoint response renders as `complete_chronological` under the recent lens but as a
bounded descriptor under the time-range or search lenses), so it cannot be authored
server-side without the endpoint knowing the console's render mode.

- **WHEN** the console renders the merged timeline page from `GET /_ref/explore/records`
  under the recent lens
- **THEN** the operator-ui assembler SHALL derive a `descriptor` field typed as a
  discriminated union with `kind: "complete_chronological"` from the endpoint response
  (`has_more`, `next_cursor`, `new_since_snapshot`)
- **AND** the console Explore canvas SHALL switch on `descriptor.kind` and SHALL NOT
  claim completeness or ordering that the descriptor does not carry
- **AND** the discriminated union shape SHALL be the load-bearing enforcement
  mechanism: the renderer MUST NOT claim "newest first" or "complete" for any set
  whose descriptor does not carry `kind: "complete_chronological"`

### Requirement: The endpoint SHALL scope pagination, counts, and cursor to the selected connection/stream set

`GET /_ref/explore/records` SHALL accept optional `connection` / `connection_id` and
`stream` query parameters (comma-separated or repeated) that scope the merged timeline to
the selected `(connector_instance_id, stream)` set. The scope SHALL be applied at the
PARTITION-ENUMERATION layer (so the k-way merge only walks selected partitions) AND to the
`new_since_snapshot` count, so that pagination, `has_more`, `next_cursor`, and
`new_since_snapshot` all describe the SAME selected set. Scoping SHALL NOT be implemented
by paging a global feed and trimming records client-side, because that produces sparse or
empty pages for a selected source whose records are absent from the global page while the
descriptor still claims completeness.

#### Scenario: Selecting a single connection scopes the entire paged feed to it

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records` with a
  `connection` parameter naming one connector instance
- **THEN** exhaustively paging the cursor SHALL return EVERY record in that connection's
  partitions and NO record from any unselected connection
- **AND** `has_more`, `next_cursor`, and `new_since_snapshot` SHALL describe only the
  selected connection's set, not the owner's global corpus
- **AND** no page SHALL be sparse or empty solely because the selected connection's
  records were absent from a globally-paged window

#### Scenario: An omitted or empty scope means the full owner-visible set

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records` with no
  `connection` or `stream` parameter (or an empty value)
- **THEN** the endpoint SHALL enumerate every visible `(connector_instance_id, stream)`
  partition exactly as the unscoped merged timeline does

### Requirement: The merged timeline SHALL order by each record's SEMANTIC time, anchored by the ingest sequence for membership

The merged timeline SHALL order records by each record's SEMANTIC time — when the
thing happened — and NOT by its ingest time (`emitted_at`). Semantic time is the
stream manifest's `consent_time_field` (preferred) then `cursor_field`, read from the
record's `data`, coerced to an ISO-8601 instant (numeric Unix epochs included:
seconds below 1e12, milliseconds at/above), falling back to `emitted_at` when no
semantic field is declared or the value is missing/unparseable — so semantic time is
ALWAYS populated and ordering degrades gracefully to ingest order. The per-partition
ORDER BY and keyset seek SHALL both use semantic time; the substrate computes it as
`COALESCE(NULLIF(semantic_time, ''), emitted_at)`. The snapshot anchor for MEMBERSHIP
(`id <= snapshotSeq`) SHALL remain the monotonic ingest sequence — ordering and
membership are DIFFERENT keys, and semantic time (not monotonic) MUST NOT be used as
the membership anchor.

#### Scenario: Records sort by semantic time even when ingested out of semantic order

- **WHEN** records are ingested such that their `emitted_at` (ingest) order differs
  from their semantic time order — e.g. a backfill ingests many records in one run so
  their `emitted_at` clusters while their authored `create_time` spans months
- **THEN** exhaustively paging `GET /_ref/explore/records` SHALL return them ordered
  by semantic time DESC (newest authored first), NOT by `emitted_at`

### Requirement: The composite cursor SHALL encode per-partition keyset positions anchored on the monotonic ingest sequence

The composite cursor PAYLOAD SHALL encode the position of every live
(connector_instance_id, stream) partition as a keyset tuple (semantic time —
`COALESCE(NULLIF(semantic_time, ''), emitted_at)`, `record_key`) plus a snapshot
anchor on the MONOTONIC INGEST SEQUENCE (MAX(id) — BIGSERIAL in Postgres,
AUTOINCREMENT rowid in SQLite), not on the keyset key. The payload SHALL be a
base64url-encoded JSON blob at schema version 3 (the keyset key changed from
`emitted_at` to semantic time at v3). This payload is the INTERNAL cursor state; how
it is conveyed to the client in `next_cursor` is the cursor-transport requirement
below.

#### Scenario: Paging the composite cursor forward yields strictly older, non-duplicated records

- **WHEN** an authenticated owner session pages `GET /_ref/explore/records` by
  passing the `next_cursor` from a prior response
- **THEN** every record in the new page SHALL have a SEMANTIC time less than or equal
  to any record in the prior page (strictly non-increasing semantic-time order)
- **AND** no record from the prior page SHALL appear in the new page (no duplicates)
- **AND** records from multiple (connector_instance_id, stream) partitions SHALL
  appear interleaved in the correct semantic-time order

#### Scenario: The snapshot anchor excludes records ingested after the first page

- **WHEN** a new record is ingested into any partition AFTER the first page of a
  cursor was issued
- **THEN** that record SHALL NOT appear in any subsequent page of the SAME cursor,
  regardless of its `emitted_at` value
- **AND** the new record SHALL be counted in `new_since_snapshot` when a fresh
  first-page request is issued after the ingest

#### Scenario: An invalid or stale cursor returns a typed error

- **WHEN** an authenticated owner session provides a `cursor` string that is an
  unknown/expired server-side handle, OR a raw blob that is not valid base64url
  JSON, has an incompatible schema version (e.g. a pre-fix v2 cursor whose keyset
  key was `emitted_at`), or is missing required fields
- **THEN** the endpoint SHALL return HTTP 400 with error code `invalid_cursor`

### Requirement: The endpoint SHALL support re-rendering page 1 pinned to a cursor's original snapshot (rewind)

The endpoint SHALL accept a `rewind` request parameter that, when truthy
(`"1"`/`"true"`) AND a `cursor` is supplied, re-renders PAGE 1 pinned to that
cursor's ORIGINAL snapshot: the operation SHALL decode the cursor for its
`snapshotSeq` (and display `snapshotAt`), DISCARD the cursor's per-partition
positions, and re-enumerate all partitions from the start under the SAME
`id <= snapshotSeq` membership bound. A new snapshot SHALL NOT be captured. This
exists so the console "Load more" accumulator can re-render page 1 against the SAME
snapshot as later pages, using the ingest-sequence anchor (snapshotSeq) for
membership — never a display-timestamp (`emitted_at`) proxy. A record ingested
AFTER the original snapshot (its `id > snapshotSeq`) therefore can never appear on
a rewound page 1, even when its `emitted_at` lands inside page 1's window, so it can
never displace an original page-1 row (the "Load more hides records above" class).

#### Scenario: Rewinding a page-1 cursor re-renders the original snapshot's page 1

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records` with a
  prior page's `cursor` AND `rewind=1`
- **THEN** the response SHALL be page 1 of the snapshot encoded in that cursor
  (membership `id <= snapshotSeq`), with the partition positions reset to the start
- **AND** the snapshot SHALL NOT be re-captured (`snapshot_at` stays the cursor's)
- **AND** a record ingested after that snapshot SHALL be excluded from the rewound
  page even when its `emitted_at` falls inside page 1's window

#### Scenario: Rewind without a cursor is a no-op

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records` with
  `rewind=1` but NO `cursor`
- **THEN** the endpoint SHALL behave exactly as a normal first-page request
  (capture a fresh snapshot), because there is no prior snapshot to pin to

### Requirement: The URL `next_cursor` SHALL be opaque; the reference MAY return a server-side handle

The `next_cursor` value SHALL be treated as OPAQUE by clients, who MUST pass it back
verbatim and MUST NOT parse it. The reference implementation SHALL return a short
server-side HANDLE (prefix `ecr1_`) that maps to the composite cursor payload
persisted server-side, keeping the URL bounded regardless of partition count — the
payload grows with the partition count, so returning it inline in the URL overflows
reverse-proxy URL limits at scale (HTTP 431). The reference SHALL still accept a raw
base64url v3 blob cursor (a cursor that does not begin with the handle prefix) for
backward compatibility with cursors issued before the handle transport. An unknown or
expired handle — or a stale v2 cursor — SHALL return HTTP 400 `invalid_cursor`.

#### Scenario: A many-partition feed returns a bounded-length next_cursor

- **WHEN** an authenticated owner session pages `GET /_ref/explore/records` for an
  owner whose corpus spans many (connector_instance_id, stream) partitions
- **THEN** the `next_cursor` value SHALL be a short opaque handle whose length does
  NOT grow with the partition count
- **AND** passing that handle back SHALL resume pagination over the same snapshot,
  reaching every record with no silent cap (the handle resolves to the full
  composite payload server-side)

### Requirement: Partition enumeration SHALL NOT apply any LIMIT

The reference implementation SHALL enumerate ALL distinct (connector_instance_id, stream)
pairs the owner has records in with no LIMIT clause on the partition query, so that every
record the owner holds is reachable by exhaustively paging the composite cursor. A silent
cap that hides records in overflow partitions is a violation of this requirement.

#### Scenario: All partitions are enumerated regardless of count

- **WHEN** the owner has records across N distinct (connector_instance_id, stream)
  partitions for any finite N
- **THEN** the partition enumeration query SHALL return all N partitions
- **AND** exhaustively paging the composite cursor to completion SHALL yield every
  record in the owner's corpus, with no record permanently unreachable

#### Scenario: A corpus spanning many partitions returns records from all of them

- **WHEN** the owner's corpus spans records from P1, P2, and P3 partitions
  (different connector instances and/or streams)
- **THEN** exhaustively paging `GET /_ref/explore/records` SHALL return records from
  all three partitions interleaved by semantic time (newest first)
- **AND** no partition SHALL be silently excluded regardless of its ordinal position
  among the enumerated partitions

### Requirement: The merged timeline SHALL carry both connector TYPE and connection INSTANCE identity on every record

Every `ExploreTimelineRecord` in the `data` array SHALL carry both:
- `connector_id`: the connector TYPE identifier (e.g. `"amazon"`), used by the UI
  to resolve display labels and manifest metadata
- `connector_instance_id`: the specific connection INSTANCE identifier (e.g.
  `"cin_..."`), used by the UI to construct per-connection peek/record-detail reads
  and connection-scoped URLs

The UI SHALL use `connector_id` for display labels and SHALL use
`connector_instance_id` for API reads. The raw `connector_instance_id` value SHALL
NOT be rendered as a display name.

#### Scenario: A record from a multi-account connector carries distinct instance identity

- **WHEN** the owner has two connections of the same connector type (e.g. two Amazon
  accounts) and both have records in the merged feed
- **THEN** each record in `data` SHALL carry the specific `connector_instance_id` of
  the connection it came from
- **AND** the two records SHALL have distinct `connector_instance_id` values even
  though they share the same `connector_id`
- **AND** the console Explore canvas SHALL use the distinct `connector_instance_id`
  values to route peek reads to the correct connection scope
