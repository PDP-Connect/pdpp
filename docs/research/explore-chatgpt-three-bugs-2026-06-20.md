# Explore: 3 bugs Tim hit filtering by ChatGPT on mobile

Status: DIAGNOSED (Claude RI, 2026-06-20). Tim filtered Explore by ChatGPT on mobile:
(1) "bottom record stayed at the bottom after Load more — sorting seems wrong",
(2) "no timestamp on the row for a record", (3) "click a record on mobile, can't see
any more detail."

## Bug 1 (display) — numeric epoch timestamps were dropped → FIXED
ChatGPT `conversations` declares `consent_time_field: create_time`, `cursor_field:
update_time` — but the connector emits these as Unix-epoch NUMBERS (float seconds,
e.g. 1718900000.123), not ISO strings (connector index.ts:1695 `create_time: typeof
item.create_time === "number" ? item.create_time : null`). `pickDeclaredTimestamp`
(operator-ui/src/lib/search-record-timestamps.ts) only accepted `typeof value ===
"string"`, so the number was rejected → `pickSearchDisplayTimestamp` fell back to
`emitted_at` (ingest time) and the row showed the wrong/empty time.
FIX (shipped): a `coerceTimestampValue` helper accepts a numeric epoch (seconds <1e12,
ms >=1e12) and normalizes to ISO. Robust across every connector with numeric times.

## Bug 2 (sorting) — merged timeline sorts by emitted_at (INGEST time), not semantic time — SYSTEMIC, NEEDS A DECISION
`emitted_at` is set ONCE PER RUN to `nowIso()` (connector-runtime.ts:693) and applied
to every record in the batch (lines 815/839). So all of a backfill's records share ~one
`emitted_at`. The merged-timeline endpoint sorts by `emitted_at DESC` (the records table
has ONLY `emitted_at`; the semantic `create_time` lives inside `record_json`, no column,
no index). So ChatGPT records are an undifferentiated clump at the backfill time, not
ordered by when the conversations happened → "bottom stays at bottom."
This is the long-flagged systemic issue (search/timeline rank recency by INGEST time, not
AUTHORED time). It interacts with the snapshot/cursor machinery, which DELIBERATELY pins
on the monotonic ingest sequence `id` (NOT semantic time) because semantic time isn't
monotonic and would break stable keyset pagination.

Options (each with the real trade-off):
- A. Connector sets emitted_at per-record from create_time. Smallest code change, but:
  (i) requires RE-COLLECTING all ChatGPT data (existing rows keep the clumped emitted_at),
  (ii) conflates ingest-order with authored-order — breaks the snapshot anchor's monotonic
  guarantee (a backfilled old conversation would get an old emitted_at but a new id; the
  snapshot uses id, so this is actually OK for membership but changes the SORT semantics),
  (iii) other connectors have the same per-run emitted_at, so this is connector-by-connector.
- B. Add an indexed semantic-time column (generated from record_json's consent_time_field),
  sort the merged timeline by it, keep the id-based snapshot anchor for STABILITY. This is
  the correct general fix: ORDER BY semantic_time, but PAGINATE/anchor by id. Needs a
  migration + backfill + the connector/ingest path to populate it. Biggest change; the
  right one. Touches the cursor keyset (currently (emitted_at, record_key)).
- C. Sort by a record_json-extracted expression at query time (no column). No migration but
  expensive (no index), and the keyset cursor can't keyset on an unindexed expression.
- Do-nothing interim: at least the DISPLAY (bug 1) is fixed so the row shows the true
  create_time even though the ORDER is still ingest-clustered.
RECOMMENDATION: B is the SLVP-correct fix but it's a real project (migration + ingest +
cursor change). Bug 1's display fix makes the wrong order at least legible. Decide B vs
defer with Tim — do NOT silently re-home the sort onto semantic time without addressing
the keyset/snapshot interaction.

## Bug 3 (mobile detail) — row links to ?peek=, which is hidden on mobile → FIX (clean)
SplitLayout (operator-ui/src/components/primitives.tsx:144) renders the peek pane
`<div className="hidden ... xl:block">` — hidden below 1280px. The comment says "Mobile
list rows navigate to full-page detail routes instead" — but the Explore feed row
(records-explorer-view.tsx:1044) links to `?peek=` on BOTH desktop and mobile. On mobile,
?peek sets the hidden pane → nothing renders → "can't see detail." The dual-link pattern
(mobile → full record-detail route, desktop → ?peek) exists elsewhere in the console
(per the mobile master-detail push-nav work) but was not wired for the Explore feed row.
FIX: the row needs a responsive dual-link — a mobile (block xl:hidden) link to the
full-page record detail route (buildRecordDetailHref), and a desktop (hidden xl:block)
link to ?peek. Clean, well-scoped.
