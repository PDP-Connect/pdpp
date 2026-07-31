## Why

The `snapshot_at` field on `GET /_ref/explore/records` first-page responses was
implemented as `MAX(emitted_at)` across all live records visible to the owner —
a record-derived aggregate, not the wall-clock instant the snapshot was
captured. This has two problems:

1. **Ambiguous against the existing spec text.** "An ISO-8601 timestamp
   corresponding to the ingest-sequence anchor captured at first-page time"
   (`reference-implementation-architecture/spec.md`) is consistent with
   either reading — "the anchor row's own timestamp" or "the wall-clock
   moment the anchor was captured" — and the reference implementation picked
   the record-aggregate reading without the spec text ever disambiguating it.
2. **Distorted by the domain's own documented behavior.** Records with a
   future-dated or backfilled `emitted_at` are a first-class, intentional
   case in this system (the operation's own doc cites YNAB future budget
   months as the canonical example, and the composite-cursor version history
   documents that snapshot MEMBERSHIP moved off `emitted_at` specifically
   because backfills break it). `MAX(emitted_at)` inherits exactly the
   distortion the `snapshotSeq` field was already fixed to avoid — it can
   silently report a timestamp far from "now," or one that regresses on a
   later page if a still-later-dated record existed the whole time but was
   never the max seen. A wall-clock capture is immune to both.

Performance is a secondary but real driver: `MAX(emitted_at)` has no
supporting index (no index has `emitted_at` combined with `deleted` as a
leading column) and forced a ~560-600ms full parallel sequential scan on
every first-page Explore request. This was the last unscoped full-table-scan
query on that path. The fix REMOVES the query rather than adding an index or
a cache, because the value it computed was never the right one to report.

## What Changes

- `snapshot_at`'s normative meaning becomes: the wall-clock instant the
  reference implementation captured the first-page ingest-sequence snapshot
  — the SAME instant as the (already wall-clock, already-documented) past/
  future boundary `nowCeiling` used by the main/Upcoming split. One captured
  instant serves both purposes; there is no second, independently-timed
  read.
- `snapshot_at` is NEVER derived from any record's `emitted_at`. This holds
  for every corpus state, including empty (no epoch/placeholder sentinel —
  the actual capture instant is reported).
- On a resumed or rewound page, `snapshot_at` is the ORIGINAL first page's
  capture instant, carried in the composite cursor exactly as `nowCeiling`
  and `snapshotSeq` already are — unchanged by this proposal, since the
  cursor already preserved these fields verbatim on resume.
- `fetchSnapshotAnchor`'s dependency contract narrows to `{ snapshotSeq }`
  only; it no longer returns or computes a display timestamp.

## Impact

- Affected spec: `reference-implementation-architecture` (`snapshot_at`
  scenario, `GET /_ref/explore/records` first-page response).
- Affected code: `reference-implementation/operations/rs-explore-timeline/index.ts`,
  `reference-implementation/server/explore-timeline-substrate.ts`.
- No route, cache, write path, or new configuration surface is added. No
  cursor wire-format or version-number change — `snapshot_at`'s TYPE
  (ISO-8601 string) and position in the composite cursor payload are
  unchanged; only which value the operation writes into it changes, and only
  on first-page capture (resume/rewind already carry it verbatim).
- No client contract break: `snapshot_at` was always documented as an
  opaque-to-semantics display value (`new_since_snapshot` is the field with
  UI-affordance meaning); no scenario in this spec or any consumer
  (operator-ui) parses or compares `snapshot_at` against record data.
