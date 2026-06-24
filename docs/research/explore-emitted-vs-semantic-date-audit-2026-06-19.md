# Audit: records dated by ingest time (`emitted_at`) vs semantic/authored date

Status: REPORT-ONLY findings (no code changed by this audit). Triggered by Tim noticing
in Explore "records dated with the date the record was *emitted* not the semantic date of
the record itself." Audited both checkouts (`/home/tnunamak/code/pdpp` and the Explore
worktree `/home/tnunamak/.tmp/pdpp-explore`), 2026-06-19.

## TL;DR

Tim's "should be easy to fix" is **half right**:

- **Easy (display-label fixes):** the record-detail page header and peek panel hardcode
  `emitted_at` as the headline date instead of calling the existing
  `pickSemanticTimestamp()` / `primaryTimestamp()` helpers that already know how to
  resolve the per-stream semantic field. ~5-10 lines each. This is almost certainly the
  most visible instance Tim saw.
- **NOT easy (ordering + search-hit display):** the Explore "Recent" merged timeline
  *orders and paginates by `emitted_at`*, and lexical search hits carry `data: null` so
  their date falls back to `emitted_at`. Fixing those is a backend design decision (the
  semantic date lives inside the `data` JSON blob, not an indexed column), not a cosmetic
  change.

## Architecture fact (the root constraint)

Every record has two timestamps:
- `emitted_at` — when PDPP ingested it. Clusters at backfill time. Not meaningful as
  "when did this happen."
- A **semantic/authored** timestamp inside `record.data[<field>]`, where `<field>` is
  **per-stream, manifest-declared** as `consent_time_field` (preferred) then
  `cursor_field` (fallback). **There is no uniform field name** (`sent_at` iMessage,
  `created_at` GitHub, `date` YNAB...). Streams that declare neither have **no extractable
  semantic timestamp** — for those, `emitted_at` labeled "ingested" is the honest answer.

The correct abstraction already exists:
`apps/console/src/app/dashboard/lib/record-timestamps.ts` —
`pickSemanticTimestamp(metadata, data)` + `primaryTimestamp(semantic, emittedAt)`.
The bug is the surfaces that **bypass it** and hardcode `emitted_at`.

## Findings

| # | Site | Verdict | Notes |
|---|------|---------|-------|
| 1 | `apps/console/.../records/[connector]/[stream]/[recordKey]/page.tsx:187` (main) / `:167` (worktree) — record-detail `PageHeader` description | **BUG** | Renders literal `emitted_at` as the headline date of every record detail page. Does NOT call `primaryTimestamp()` (already in the codebase). Stream metadata is already fetched here. **EASY FIX.** Top candidate for what Tim saw. |
| 2 | `apps/console/.../records/[connector]/[stream]/page.tsx:880-895` (main) / `:333-348` (worktree); `RecordCard` mobile view | **BUG** | `emitted_at` is the leftmost/only timestamp column in the stream record table; no semantic-date column. Display fix easy; sort order (see #5) is not. |
| 3 | `packages/operator-ui/src/lib/search-record-timestamps.ts` + `explore-data-assembler.ts:491-525,943-957,1207,1589` | **BUG (search paths)** | `pickSearchDisplayTimestamp` falls back to `emitted_at` when `data` is null. Lexical search hits ALWAYS have `data: null`, so day-grouping headers ("Today"/"Yesterday") and card dates in search mode use ingest time. Backfilled corpus collapses to "Today." **NOT trivial** — needs the search API to return the semantic value in the hit envelope, or a per-hit body fetch. Time-range and merged-timeline paths (data present) resolve correctly. |
| 4 | `reference-implementation/operations/rs-explore-timeline/index.ts:31,66,74,247,377-384,573` | **BUG (ordering)** | The k-way merge orders/paginates by `emitted_at DESC`. The "Recent" lens is therefore ingest-newest, not authored-newest. Backfilled data all shares one ingest day → feed collapses. **NOT trivial** — semantic date is inside the `data` JSON blob, not indexable without a generated column / migration. NOTE: the snapshot cursor's use of `MAX(id)` (ingest sequence) for point-in-time STABILITY is **LEGITIMATE and correct** — that is a pagination anchor, not a displayed date; do not "fix" it. |
| 5 | `apps/console/src/app/dashboard/lib/rs-client.ts:352-355` (`order=recent` → `emitted_at DESC`) | **BUG (sort)** | Stream record list pages in ingest order; no sort-by-semantic-date option. Same root cause as #4 (RS does not index semantic dates). |
| 6 | `packages/operator-ui/src/components/views/records-explorer-view.tsx:2207-2208` | **LEGITIMATE but incomplete** | Peek panel labels the field "Emitted" (honest) but shows NO semantic date at all. Easy to add once the full body is in the peek fetch. |
| 7 | `apps/console/.../records/[connector]/[stream]/health/page.tsx:153-158` | **LEGITIMATE** | Collection-health diagnostic; `emitted_at` min/max is the correct thing to show ("when was data collected"). |
| 8 | `apps/console/src/app/dashboard/lib/record-timestamps.ts` | **LEGITIMATE (role model)** | `primaryTimestamp`/`pickSemanticTimestamp` is the correct abstraction; the bug is that #1/#2 don't use it. |
| 9 | `packages/operator-ui/src/lib/timeline.ts` | **LEGITIMATE (role model)** | Uses the semantic authored date throughout (only considers streams declaring `consent_time_field`). This is how the assembler's time-range path already behaves correctly. |

## Recommended split (when scheduled)

1. **Quick win, low risk:** Findings 1, 2 (display), 6 — replace hardcoded `emitted_at`
   headline/labels with `primaryTimestamp(pickSemanticTimestamp(metadata, data), emittedAt)`.
   Falls back to `emitted_at` labeled "ingested" when no semantic field is declared (honest).
   This likely resolves Tim's observation.
2. **Design decision needed (separate spec):** Findings 3, 4, 5 — making "Recent" /
   search ordering and grouping reflect authored date requires the semantic date as an
   indexable/returnable field (generated column or search-envelope annotation). This is a
   genuine SLVP design question, not a label fix. Honest interim: the descriptor/labels
   should not claim "newest first (authored)" while ordering by ingest — that is the same
   class as the set-descriptor lie. Worth deciding whether the "Recent" lens labels itself
   honestly as ingest-ordered until the semantic-date column exists.

## Honesty note for Tim

Do not let a quick display-label PR imply the *ordering* problem (#4/#5) is solved — it
is the harder, more important one for a backfilled corpus, and it is a backend design
decision. The display fix and the ordering fix are separable; ship #1/#2/#6 freely,
schedule #3/#4/#5 as a deliberate design slice.
