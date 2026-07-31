## MODIFIED Requirements

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
  - `snapshot_at`: an ISO-8601 timestamp equal to the WALL-CLOCK instant the
    reference implementation captured this first-page snapshot — the SAME
    instant used as the past/future boundary (`nowCeiling`) for the main feed
    and the Upcoming projection. `snapshot_at` SHALL NOT be derived from any
    record's `emitted_at`, under any corpus state (including an empty corpus,
    where it SHALL still be the actual capture instant, not a placeholder).
    This holds regardless of whether any record carries a future-dated or
    backfilled `emitted_at` — such records influence neither `snapshotSeq`
    (unchanged: the monotonic ingest sequence) nor `snapshot_at`.
  - `new_since_snapshot`: an integer count of records ingested after the snapshot
    anchor, for use as an "N new" affordance in the UI

#### Scenario: snapshot_at is the capture wall clock, not a record aggregate

- **WHEN** the corpus contains a record with a future-dated `emitted_at` (later
  than the actual capture instant) or a backfilled record with an `emitted_at`
  older than other already-ingested records
- **THEN** `snapshot_at` on the first-page response SHALL equal the wall-clock
  instant the reference implementation captured the snapshot
- **AND** `snapshot_at` SHALL NOT equal that record's `emitted_at`, and SHALL
  NOT change value based on which records exist in the corpus at capture time

#### Scenario: Resumed and rewound pages retain the original capture instant

- **WHEN** an authenticated owner session requests a later page (a `cursor` is
  supplied) or a rewind (`cursor` + `rewind=1`) of a prior snapshot
- **THEN** `snapshot_at` on that response SHALL equal the ORIGINAL first page's
  captured instant, carried in the composite cursor, not a freshly re-captured
  wall-clock value

#### Scenario: An empty corpus reports the actual capture instant

- **WHEN** an authenticated owner session requests `GET /_ref/explore/records`
  without a cursor parameter and the owner has no records yet
- **THEN** `snapshot_at` SHALL be the actual wall-clock capture instant (the
  same instant `nowCeiling` uses), not an epoch or other placeholder sentinel
