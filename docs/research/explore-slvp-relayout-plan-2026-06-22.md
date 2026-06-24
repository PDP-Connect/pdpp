# Explore SLVP relayout + defect-fix plan (2026-06-22)

Owner: Claude RI. Gate model: this plan → **Codex plan-check** → autonomous build → **Codex review-gate** → deploy.
Confidence target: >95% on the bugs/objective defects; taste calls grounded in prior art (cited) so they clear the gate.

Live rev under review: `29ed0138` (deployed). Live findings came from a Playwright + darshana
full-page walkthrough (desktop 1366/1440, mobile 390, dark+light) on 2026-06-22.

## Grounding (already on disk / verified live)
- Load-more accumulation + snapshotSeq-rewind: **fully implemented + tested** (explore-loadmore-accumulate.test.ts 5/5). NOT the bug.
- Prior art research: `explore-loadmore-{replace-bug,snapshot-pin-fix}-2026-06-20.md`; SLVP feed-density + 3-pane layout (this session, cited below).
- Design system map: tokens in `packages/pdpp-brand/base.css`; `rr-x-*` in `packages/pdpp-brand-react/src/components.css`; shell in `shell.css`. MUST reuse `--space-*`, `--radius-*`, color tokens, `--motion-*`, type classes, breakpoints 861/980/1280. No new tokens/breakpoints.

## Confirmed root causes (verified by looking, not inferred)

### RC1 — Load-more "empties the feed" = burst auto-collapse, NOT pagination
- `apps/console/src/app/dashboard/explore/explore-feed-grouping.ts:78` `BURST_THRESHOLD = 10`; `:127` bursts created `expanded: false`.
- `explore-canvas.tsx:1370-1388` renders rows ONLY when `expanded`.
- Accumulating Load-more pushes a (connection,stream) day-group past 10 → whole group collapses → "N in view — expand↓" with ZERO rows. Reproduced live desktop **and** mobile: "96 in view", body = two count-headers, no rows, then dead void.
- **Prior-art verdict (cited):** Linear folds only *older system events*, keeps content; Slack groups visually but renders every body; Datadog List is default, Patterns opt-in; **Gmail collapse-by-default is the cautionary tale users disable.** Consensus: *never render a feed of pure count-headers; show content by default; collapse is opt-in; if collapsed, show first-N + counted/chevroned "show all", keep most-recent expanded, guarantee one-click reach.*

### RC2 — Dead canvas + query-bar/inspector OVERLAP = starved middle column (ONE cause)
- `.rr-x` grid `230px | minmax(0,1fr) | 420px`. At **1366px** middle = **347px** (measured). Query bar can't fit 347px → "newest/oldest" sort tokens overflow rightward and render UNDER the 420px empty inspector → the `oth…THE READING ROOM` overlap I saw (confirmed: `elementsFromPoint` returns both `.rr-x-empty__eyebrow` and `rr-lens "newest"` at the same point at 1366).
- At 1440 the gap reappears (no overlap) but feed still thin + lower 60% dead. The empty inspector reserves 420px on every wide load for nothing.
- **Prior-art verdict (cited):** for a LIST-primary explorer (Stripe ContextView, Airtable expanded-record, Notion Side Peek, Sentry) the detail is **slide-in-on-select; the list goes full-width when nothing is selected; no always-reserved empty column.** Feed is scannable data → exempt from 66ch cap; only a record BODY gets capped/centered (Linear).

## Decisions (made as expert designer; grounded above)

**D1 (burst default) — REVISED per Codex plan-check:** NOT `expanded: true` (that would dump the 772-row Upcoming wall). Instead **preview-content-by-default**: replace the boolean `expanded` with a small display-state model `preview | expanded`. Default = `preview`: show first **N≈3-5** content rows inline + an explicit `Show all M` (or `Collapse to first N`) action. Header keeps `M in view` (count==reachability for the loaded set, never implies a hidden total). Full expansion is opt-in and never required to see the feed has real records. Newer/current-day content biases toward visible rows first. Huge groups never render a wall by default. Invariant test: after accumulation crosses BURST_THRESHOLD, the default-rendered burst still contains visible content rows (not header-only); and the count label matches what its action reaches.

**D2 (layout) — confirmed by Codex (96%):** Inspector is **conditional on selection**, driven by an explicit `has-selection` class on `.rr-x` (NOT an empty placeholder reserving the column). Default (no selection) = **2-col rail|feed, feed gets the freed width**. Selected/peek on desktop = 3-col (inspector as 3rd column or slide-in) without breaking feed legibility. Record BODY in peek stays capped (~66ch, Linear); the FEED is exempt from the 66ch cap. Selection stays URL-addressable (`peek`), back-safe, keyboard-safe, focus-visible. Mobile stays route/detail-first (push-nav `<a>`) — do NOT add a desktop-style slide-in at 390px. This removes dead canvas + the query-bar/inspector overlap in one move.

## Objective defects (separate, lower-risk)
- **F3 mobile row text hard-clips** at right edge ("Event type: attachm[cut]") — needs `min-width:0` + `text-overflow:ellipsis`/clamp on the row preview line (`.rr-x-row` children). Verify at 390.
- **F4 left rail = ~70 raw stream tokens flat.** Group stream-name facets under their source/connector, collapse-by-default, show only non-empty for the current result set (counts already track query — leverage that). Desktop only (mobile already behind Filters disclosure). Reuse `.rr-x-facets`/`.rr-x-facet` + a group header.
- **F5 expanded "188 upcoming" = unpaginated 772-row wall, no date headers/time labels.** Add temporal grouping (month headers for budget-months) + the same show-first-N/paginate treatment as D1. Reuse `groupFeedDaysNoBursts` scaffolding.
- **F6 mobile orphaned center "Search" button + center-aligned burst headers** that wrap awkwardly vs left-aligned rows. Left-align burst headers; align Search button to the input (full-width or right-aligned within the query row at mobile).
- **F7 thin previews** ("attachment" + raw ISO). Where a stream has declared roles, the typed preview already works; for generic, surface a better key/value summary line than the bare type word. (Stay on the SLVP honesty path — declared-role-driven, no field-name guessing; this is presentation of already-honest data.)
- **F8 truncated connection names** (…gmail.c…) — add `title`/tooltip; consider middle-ellipsis for emails.

## Build sequencing (one worktree, incremental, gated)
0. Worktree at `29ed0138` (NOT live DB; throwaway PG for any RS tests). Commits authored `Tim Nunamaker <tnunamak@gmail.com>`.
1. RC1/D1 (the live bug) FIRST — burst show-by-default + show-first-N; invariant + regression test (feed never 0 rows after N Load-mores).
2. RC2/D2 layout — slide-in inspector + full-width feed; verify overlap gone at 1366/1440, dead canvas gone, peek still works + URL-addressable.
3. F3–F8 polish, each with a check.
4. Gates: `tsc` (console + operator-ui + reference), `openspec validate --strict` (update spec if burst/layout contract changes), operator-ui + console explore suites, reference explore both backends (per-file PG). Then darshana/Playwright full-page RE-CAPTURE desktop+mobile dark+light to PROVE the visual fixes by looking.

## Acceptance (must pass before deploy) — incl. Codex-required tests/gates
- Click Load-more ≥3× on mobile AND desktop: feed always shows content rows (preview rows), count==reachable, no header-only count wall. (the headline fix)
- 1366 + 1440 desktop, NO selection: feed gets the freed width, no reserved 420px inspector, no query-bar/inspector overlap.
- 1366 + 1440 desktop, WITH a selected record: inspector readable AND feed remains usable.
- 390 mobile: no right-edge text clipping; Search button not orphaned; burst headers/preview rows left-aligned.
- Peek still works, still URL-addressable, body legible (~66ch), back-safe, keyboard/focus-safe.
- F3–F5 are acceptance items (not optional): no mobile clip; no 70-token flat facet wall; Upcoming expanded is grouped + previewed, not a 772-row wall.

### Codex-required tests/gates (before deploy)
1. Component test: after accumulation crosses BURST_THRESHOLD, the default-rendered burst contains visible content rows (not header-only).
2. Preview-reachability test: default burst count label == what its default/expanded action reaches; never implies a hidden total.
3. Source/CSS invariant: `.rr-x` does NOT reserve the 420px inspector column unless a selected/peek state is active (`has-selection`).
4. Bounding-box gate desktop 1366 + 1440: query controls don't overlap inspector; feed not starved when nothing selected (Playwright `getBoundingClientRect` assertions).
5. Bounding-box gate mobile 390: no right-edge clipping; search action not orphaned; burst headers/preview rows align.
6. Regression: selected peek stays URL-addressable + back-safe.

## Spec / contract (Codex)
No new read-surface protocol contract this batch (D1 = presentation preview over loaded records; D2 = layout-only). BUT update the active Explore OpenSpec change: add a relayout task under the existing redesign change; update wireframe/design note to show no-selection full-width feed + selected inspector + burst preview state. Do NOT alter count==reachability semantics.

## Codex plan-check verdict (batch 1 of 2): PLAN LAND WITH REQUIRED EDITS (all folded in above)
Root causes 97% · D1-after-edit 95% · D2 96% · overall readiness 95%. Verdict file: tmp/workstreams/codex-explore-relayout-plancheck.md.
