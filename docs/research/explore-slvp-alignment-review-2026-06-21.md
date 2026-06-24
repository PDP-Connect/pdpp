# Explore SLVP alignment review + fixes (2026-06-21)

Status: 5 fixes DEPLOYED + live-verified (branch `explore-slvp-high-fixes` @ `f38109e6`,
NOT merged/pushed). Follow-ups named below for owner decision.

## Post-review CRITICAL fix (`f38109e6`) — "an old date is shown first"
After the 4 fixes below, Tim noticed the feed showed "Monday, April 20" ABOVE
"Tuesday, June 16" with USAA transaction rows timed "10:40 PM". Investigation found
a GLOBAL timeline-display bug: every row's displayed date/time was its INGEST time
(`emitted_at`), not its event time — so the displayed dates contradicted the
semantic-time SORT (which is correct, server-side `semantic_time` column).

ROOT CAUSE: bundled manifests (`packages/polyfill-connectors/manifests/*.json`) set
top-level `connector_id` to the registry URI
(`https://registry.pdpp.org/connectors/usaa`) and `connector_key` to the plain key
(`usaa`); stored records carry the plain key. `buildManifestMetadata` indexed the
per-connector timestamp metadata by `connector_id` (the URI), so EVERY lookup against
a record's plain `connector_id` missed → null metadata → the client's display-time
derivation (`pickSearchDisplayTimestamp`) fell back to `emitted_at` for ALL connectors.
The USAA `2026-12-26` charge sorted first (correct) but displayed under an "April 20"
header with a "10:40 PM" (emitted_at) row time.

FIX: index the metadata by the canonical short key (`manifestConnectorKey`: prefer
`connector_key`, else strip the registry URL). LIVE PROOF: first header now "Saturday,
December 26"; USAA rows show `2026-12-26` / "Dec 26, 2026" / row time "—" (bare-date →
no fake time). Display now agrees with the sort. 4 tests incl. reproduce-the-bug
(URI-keyed → emitted_at; canonical-keyed → real date). DEEPER follow-up: the server
already computes the authoritative `semanticTime` (it's the sort/cursor key) but DROPS
it from the timeline output (`rs-explore-timeline/index.ts` ~L661); returning it and
using it directly as `displayAt` would make display==sort by construction, immune to
any future metadata-keying drift.

This closes Tim's ask: "use a dynamic workflow to ensure Explore is visually aligned
with my feedback and SLVP products with all the right affordances and behavior." It
followed Step A (semantic-time sort, deployed `5e0fc607`) + Step B (live backfill of
2.83M rows, `6067b807`).

## Method
A dynamic Workflow (9 review agents, one per rubric dimension R1–R11) read the
SLVP rubric (`tmp/workstreams/explore-slvp-alignment-brief.md`) + 9 live screenshots
(`/home/tnunamak/.tmp/ri-ops/explore-shots/`, desktop/tablet/mobile × initial/load-more/
peek/mobile-tap/dark + a message-filtered slice) + a live DOM probe, then audited the
implementation. Every candidate gap was adversarially verified against BOTH the
screenshot AND the code (a gap survives only if both confirm it). Codex (gpt-5.5 xhigh,
main:9) ran an independent parallel pass on the deploy tree; its verdict is in
`tmp/workstreams/codex-explore-slvp-verdict.md` and corroborated the findings.

Net pre-fix: ~85–90% SLVP-aligned, no blockers. 11 false positives were ruled out
(mostly stale-branch-vs-deploy-tree confusion). 5 real gaps survived; the 2 HIGH +
2 of the polish gaps are now fixed and live.

## The dead-component discovery (root of why earlier "fixes" didn't take)
The LIVE console Explore page is rendered by `apps/console/.../explore-canvas.tsx`
(`FeedRow`), NOT by `packages/operator-ui/.../records-explorer-view.tsx` — the console
only imports TYPES from the latter. So earlier work that edited `records-explorer-view.tsx`
(e.g. `<Timestamp precision="time">` on the card) never affected the live surface. All
fixes below target the live `explore-canvas.tsx` / assembler / brand CSS.

## Fixed + deployed (verified live)

### R4-BUG (HIGH) — mobile record-open was broken
`buildRecordDetailHref` appended the record key to the stream href, which already
carried `?order=desc`, producing `/dashboard/records/<conn>/<stream>?order=desc/<recordId>`.
The key was swallowed into the order value, the path was only `[connector]/[stream]`,
so a tap silently loaded the WHOLE-STREAM list (1,838 rows) instead of the record —
and on mobile, where the desktop inspector is hidden, there was no working path to
record detail at all. Tim's "on mobile I can't see any more detail for that record."
Fix (`9982dbde`): moved `buildRecordDetailHref` into the pure, unit-tested
`explore-control-state.ts` (sharing one routeId resolver with `buildCompleteStreamHref`),
built from clean encoded path segments with no query. Updated `page.invariants.test.ts`
(it had PINNED the buggy shape) to pin the import + a no-append regression guard; added
3 behavioral tests incl. a reproduce-the-bug assertion (no `?`, record key is the final
segment). LIVE PROOF: tap now → `/dashboard/records/cin_.../transactions/d495b98f...`,
lands on the single record detail (h1 = record id, full field view), not the stream list.

### R2 (HIGH) — feed rows showed no per-record time
The live `FeedRow` rendered zero `<time>` elements (live probe: `timeCount=0`). Tim's
"I don't see a time stamp on the row for a record." Fix (`9982dbde`): render
`<Timestamp precision="time" value={entry.displayAt}>` in `FeedRow.inner()` + a
`rr-x-row__time` CSS rule + an invariant pinning the render. `<Timestamp>` shows
time-of-day for instants (messages) and a quiet em-dash for honestly date-only records
(USAA/YNAB bare dates; full date in hover title), so the day-group header carries the
date and the row carries the time (Slack/iMessage/Outlook prior art). LIVE PROOF:
message rows now show e.g. `1:49 PM`, hover `Fri, Jun 12, 2026, 1:49:45 PM CDT`,
`datetime` attr; `timeCount` 0→30.

### R11-P1 — raw `<mark>` highlight markup leaked into rows (`bb76f47a`)
Lexical search-hit snippets carry `<mark>…</mark>` in `snippet.text`; rendered as plain
React text (dangerouslySetInnerHTML is guarded), they surfaced as literal
`<mark>stream</mark>` — reading as broken machinery. Fix: `plainSnippetText()` in the
assembler strips the tags (case-insensitive) and decodes the entities the wrapper can
introduce (`&amp;` last). Applied at all 3 search-hit snippet sites; 4 tests incl.
residual-tag guard + `&amp;`-last ordering. LIVE PROOF: `rawMarkInBody: false`; snippets
read clean ("message · Error in message stream").

### R11-P1 — search-mode header had no layout (`4745adae`)
`.rr-x-search-header` had NO CSS, so the descriptor-claim title and its escape ramp
rendered inline and ran together ("…'stream:messages'Browse matching records…"). Fix:
a wrapping flex layout (title weight 600 as the primary claim, escape as a secondary
underlined action). Pure additive CSS — the descriptor/relevance-claim TSX is untouched;
invariant pins the flex layout. LIVE PROOF: title and escape now on separate lines.

## Confirmed PASS (solid, no work)
R1 semantic-time sort (Step A/B — feed spans real event time, chatgpt 2023→2026, gmail
2018, amazon 2005; index-backed read, no Sort node). R3 reusable `<Timestamp>` with hover
full precision. R7 feed stays interactive during load (`.rr-x-main` not dimmed). R8
load-more append-only via `rewindToFirstPage` against the original snapshotSeq. R9
new-records affordance is correctly ABSENT in idle (appears only when `newSinceAnchor>0`;
SSR-snapshot model) — not a gap. R10 opaque server-side `ecr1_` cursors, no giant URL.

## Refuted (false positives, ruled out by the screenshot-AND-code bar)
11 claims, incl. several "loading state missing" reports that were stale-branch-vs-deploy
mismatches, an "ungated chevron animation" that's invisible/unrendered, and a
"new-records entirely absent" claim contradicted by the SSR-snapshot code.

## Open follow-ups (owner decision — NOT done)
1. **Day-group header omits the year** (`explore-feed-grouping.ts`). For a multi-year
   personal corpus, "Monday, April 20" is ambiguous. Add the year unless Today/Yesterday
   or unambiguous same-year context. Medium. Pairs with R2.
2. **Search-hit `displayAt` = ingest time, not authored.** Search rows fall back to
   `emitted_at` (ingest), so message search rows show ingest time, not `sent_at`. The
   row-time render is correct; the underlying search-hit timestamp is the limitation.
   Low–medium. (Visible as 8 search rows sharing one `1:49 PM`.)
3. **R5/R6 soft-nav pending feedback** (route progress / link-pending on query/facet/
   stream/range/order/peek/clear-all `router.push`). Genuinely absent on the current
   branch, but already AUTHORED in unmerged worktree commit `198a2eaf` (pendingKind +
   top progress bar). Owner decision: port that commit forward rather than re-implement.
   Medium polish; must NOT dim the feed (R7).
4. **R11 density** (Codex P2): the surface still reads more workbench than reading-room.
   Not a defect — a deliberate hierarchy pass (one primary search/filter row, calmer
   empty inspector, row alignment). Owner-scoped, do not churn randomly.

## Tooling (reusable)
- Capture harness: `/home/tnunamak/.tmp/explore-shots-run/explore-capture.mjs` (owner-login
  + multi-viewport/state screenshots + DOM probe). Fresh playwright install (the prior
  ink-carbon node_modules was corrupted).
- Workflow script: persisted under the session's `workflows/scripts/`.
