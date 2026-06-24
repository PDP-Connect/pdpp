# Pinning the "now" boundary in keyset-paginated feeds — prior art (2026-06-21)

Research (deep-research workflow, 51 agents, 35 results, 13 adversarial verify
verdicts ALL `refuted: false` / high-confidence against live-fetched primary
sources). Driver: the SLVP-ideal server-split for Explore (main feed clamped to
`semantic_time <= now`, future records in a separate Upcoming projection) raised one
contract question — must `now` be PINNED into the cursor (a version bump) so records
don't flicker between Today and Upcoming across pages, or RECOMPUTED per request?

## The decisive answer: PIN `:now` into the cursor (versioned). v3 → v4.

CORRECTION (this section supersedes an earlier draft of this doc that concluded
"recompute"): the FULL adversarial synthesis (99 agents) reaches the opposite, and is
right. Keyset pagination's DEFAULT guarantee is only POSITIONAL stability (no
offset-style skip/duplicate) — it does NOT freeze the result set. A time boundary
recomputed per page is NOT covered by that guarantee. Verbatim synthesis verdict:

> "a 'WHERE semantic_time <= :now' clamp on a keyset-paginated feed is NOT pinned by
> default in any of these sources; if you need a stable past/future boundary that does
> not drift, duplicate, or leak future rows into the past section as the user pages,
> you must EXPLICITLY PIN :now into the (versioned) cursor — exactly the opt-in
> snapshot mechanism the specs reserve for 'rare cases.'"

Why recompute IS anomalous here (the gap I under-weighted): page 1 at now=T1 returns
the newest 32 rows with `semantic_time <= T1`, keyset cursor = last row's
`(semantic_time, record_key)`. Page 2 at now=T2>T1 adds `semantic_time <= T2`, but any
row that became newly-past in (T1,T2] sorts ABOVE the cursor (it's near "now"), so the
keyset `< cursor` EXCLUDES it — it is silently SKIPPED for the whole session (a gap),
appearing only on a fresh reload. Rare (a record's scheduled time arriving mid-scroll)
but a real anomaly. SLVP = "nothing less is acceptable" → we do not ship a known gap.

Pinning `:now` makes the ENTIRE paginated view one consistent point-in-time:
membership (`id <= snapshotSeq`) AND the past/future boundary (`semantic_time <=
nowCeiling`) both frozen at first-page capture. This is the SAME snapshot discipline
this codebase ALREADY uses for snapshotSeq/snapshotAt — we extend it, not invent it.
The specs call per-traversal snapshot pinning the opt-in exception; this is exactly
the rare case it's for (a time-boundaried feed that must not drift). Trade-off: a
record that crosses into the past mid-session stays in Upcoming until reload — but the
view is CONSISTENT (one now), which is the SLVP property; recompute is INCONSISTENT
(a moving boundary that skips).

Production cursor/keyset systems do NOT pin by default (because most feeds have no
time boundary); stability there comes from the KEYSET TUPLE. But a TIME-BOUNDARIED
feed is precisely the documented opt-in-snapshot case.

- **Stripe** (list API) — cursors are object IDs (`starting_after`/`ending_before`),
  positional, NOT a time-based watermark or snapshot token. Docs describe NO
  point-in-time snapshot that freezes the result set across pages; the result set is
  allowed to change between requests. (live docs.stripe.com/api/pagination, verified)
- **Slack** ("Evolving API Pagination at Slack") — `WHERE id <= :cursor ORDER BY id
  DESC`; the anchor is the last row's id carried in the opaque cursor, not a
  recomputed offset and not a pinned clock.
- **Twitter/X** — `since_id`/`max_id` bound the range to row IDs captured in the
  first page's metadata; the anchor is a row ID, not a wall-clock.
- **Relay/GraphQL connections spec** — cursors are opaque per-item handles; the spec
  MANDATES consistent ORDERING page-to-page but does NOT mandate a stable
  point-in-time snapshot. Pinning a per-traversal snapshot is an explicit OPTIONAL
  "MAY", "the exception, not the default" (encode a session id to serve one snapshot
  — reserved for rare cases). JSON:API cursor profile (Ethan Resnick) agrees.
- **Markus Winand / use-the-index-luke, PostgreSQL seek method, graphql-connections
  gem, MongoDB practitioners** — stability is the KEYSET TUPLE `(sort_col, id)` with
  a unique tiebreaker; offset is the anti-pattern. None pin a wall-clock now.
- **Explicit-pin cases** exist (Elasticsearch PIT + search_after; "capture a max
  keyset up front to paginate up to it") but they DELIBERATELY MISS all inserts
  during the sweep — used for full exhaustive exports, not interactive feeds.

## Why recompute is WRONG here (the gap — corrects an earlier draft)
An earlier draft argued recompute was fine because `semantic_time` is immutable, so no
row mutates across the boundary. That reasoning is INCOMPLETE and the conclusion was
WRONG. The anomaly is NOT key-mutation — it is the boundary itself moving while the
keyset cursor stays put:
- Page 1 at now=T1 returns the newest rows with `semantic_time <= T1`; the keyset
  cursor = last row's `(semantic_time, record_key)` (somewhere below T1).
- Page 2 at now=T2 > T1 adds `semantic_time <= T2`. A row that became newly-past in
  (T1, T2] has a semantic_time NEAR now — i.e. ABOVE the cursor position. The keyset
  seek `(semantic_time, record_key) < cursor` therefore EXCLUDES it. It was also
  excluded from page 1 (future at T1). So it is SKIPPED for the entire session — a
  gap — surfacing only on a fresh reload.
- Pinning `nowCeiling` eliminates this: every page uses the SAME boundary, so a row's
  past/future classification is fixed for the whole traversal. The view is then
  internally consistent (one `now`), which is the SLVP property. The minor cost — a
  record that crosses into the past mid-session stays in Upcoming until reload — is a
  CONSISTENT, predictable state, not a silent gap.
This is exactly the documented opt-in snapshot case (Relay/JSON:API), and mirrors the
snapshotSeq membership pin already in this codebase.

## True total count for the Upcoming projection
Relay models `totalCount` as a first-class SERVER-SIDE connection field (a true count
of the whole connection, not loaded items); guidance: "if the server can produce a
true total count it should — it solves the 'next' problem and is more generally
useful." JSON:API allows an exact server-computed `total` (or `estimatedTotal` when
costly). So the Upcoming pill MUST show a server-computed COUNT of all future records
(`COUNT WHERE semantic_time > now`), not just the number loaded.

## SLVP-ideal contract for PDPP Explore (grounded)
1. **Pin `nowCeiling` in the cursor (v3 → v4).** Capture real wall-clock now at
   first-page (alongside snapshotSeq/snapshotAt), carry it in `CompositeCursorPayload`,
   reject v3 cursors as `invalid_cursor` so stale tabs re-anchor. The past/future
   boundary is now frozen for the whole traversal — same discipline as snapshotSeq.
2. Main `fetchPartitionPage`: clamp `semExpr <= nowCeiling` (the PINNED value, not a
   per-request clock). Keyset `(semantic_time, record_key)` unchanged.
3. A SEPARATE bounded `fetchUpcoming`: `semExpr > nowCeiling` (same pinned now),
   ascending (soonest-first), PLUS a server-side `COUNT(*)` true total (Relay
   `totalCount` precedent; the set is bounded so the count is cheap). Stripe's model:
   upcoming is a separate projection excluded from the list. (Stripe itself uses
   `has_more` not a true count on lists — but Relay models `totalCount`, and for a
   small bounded future set the true count is the more useful, SLVP-correct choice.)
4. Operation returns `{ records, upcoming, upcomingTotal }`, all consistent with the
   ONE pinned `nowCeiling`. Assembler surfaces them; client renders the server's
   Upcoming section + true count and does NOT re-derive the boundary or partition a
   page client-side (remove the client-side partitionFeedByTime — the server owns the
   split, at one pinned instant).
5. Conformance: b1-b2-b3 / rewind / semantic-order stay green; ADD a reproduce-the-bug
   test — a corpus whose newest-by-date rows are ALL future must yield a non-empty,
   today-led main feed AND a correct `upcomingTotal`; AND a pin-stability test — the
   past/future split must NOT change across pages when the wall-clock advances.
6. Dual-owner gate: Codex reviews the v4 contract before deploy (this is the keyset/
   cursor machinery it has caught real bugs in — page-1 displacement, index-scan cliff).
