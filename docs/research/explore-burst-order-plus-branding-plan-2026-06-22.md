# Plan: burst-ordering fix + instance branding (one gated batch, 2026-06-22)

Gate model (Tim out of loop until deployed): this plan → **Codex plan sign-off** → autonomous fan-out build → **Codex end-review** → deploy + live Playwright/darshana acceptance. Base: worktree /home/tnunamak/.tmp/pdpp-deploy at 5c082c58 (relayout, deployed) + uncommitted branding (already built+verified by me). Authored commits = Tim Nunamaker <tnunamak@gmail.com>. No origin push.

## Part A — Burst ordering fix (the bug Tim caught: 23→19→31 across bursts)

Grounding: `docs/research/explore-burst-ordering-prior-art-2026-06-22.md`. Verdict (Stream/Gmail/GitHub/Android/Slack consensus, sourced): a burst inherits its NEWEST member's timestamp; within a day, RENDER UNITS (bursts AND singles) sort newest-first by that; members stay newest-first inside a burst. Current code = first-seen Map order + bursts-before-singles = the documented GitHub-class anti-pattern.

### Root cause (verified)
- `apps/console/src/app/dashboard/explore/explore-feed-grouping.ts` `splitDayBursts`: `bursts` from `[...burstMap.entries()]` = Map insertion (first-seen) order; no time sort. `DayGroupWithBursts` separates `singles` and `bursts` as two lists.
- `apps/console/src/app/dashboard/explore/explore-canvas.tsx` `FeedDays`: renders `g.bursts.map(...)` THEN `g.singles.map(...)` — bursts always before singles regardless of time.

### Design (to implement)
1. Each burst gets `latestAt` = max over members of the SAME time field the feed sorts by (the field behind `displayAt` / semantic time used in grouping — confirm which: entries are pre-sorted desc by that field, so `latestAt` = the first/newest member's time). Add it to `BurstGroup` (additive).
2. Produce an ordered list of RENDER UNITS per day: each unit is either a single entry (its time) or a burst (its `latestAt`), sorted DESC by time. Two clean options — pick the one that's least invasive to the canvas:
   - (A) Add an ordered `units: Array<{kind:'single', entry} | {kind:'burst', burst}>` to `DayGroupWithBursts`, sorted desc; canvas renders `units` in order. Keep `singles`/`bursts` for back-compat if other consumers read them, or migrate.
   - (B) Keep `singles`/`bursts` but have the canvas MERGE+sort them by time at render. Less structural but pushes ordering into the view.
   Prefer (A): ordering is grouping-logic's job (pure, testable), not the view's. Members within a burst stay desc (already are, since input is desc).
3. INVARIANT to enforce + test: scanning a day top-to-bottom, each render unit's representative timestamp is <= the previous one's (monotonic non-increasing across bursts AND singles AND within a burst). For the worked example: B(19m) → A(23m) → C(31m).
4. Upcoming section: it uses `groupFeedDaysNoBursts` (flat, no bursts) and is forward-chron (soonest-first) by design — do NOT apply newest-first there; only the PAST/today bursted feed gets this. Verify the fix is scoped to the bursted path.

### Tests (Part A)
- splitDayBursts/grouping: bursts carry correct `latestAt`; the ordered render units are monotonic non-increasing by time across bursts+singles; the worked 23/19/31 example yields B→A→C.
- A single that is newer than a burst's latest renders ABOVE that burst (the bursts-before-singles bug is gone).
- Within-burst members stay newest-first.
- All prior grouping tests stay green; the Upcoming/no-bursts path is unchanged.

## Part B — Instance branding (ALREADY BUILT by me + Sonnet; verified)

Design note (config mechanism decided): `docs/research/console-instance-branding-config-2026-06-22.md`. Implemented:
- env `PDPP_INSTANCE_NAME` → `getInstanceBrand()` (owner-token.ts, default "PDPP", empty→default) → `brandName` prop through `recordroom-shell-with-palette.tsx` → `RecordroomShell`.
- Visible "Recordroom" wordmark → `{brandName}` in all 3 spots (sidebar/header/drawer). Component name `RecordroomShell` unchanged (internal identifier, out of scope).
- Real PDPP logo restored: `BrandMark` renders the canonical `PdppLogo` split-P geometry inline (theme-aware OKLCH hues via existing `useThemeToggle`), accessible name = brandName. (Geometry verified IDENTICAL to pdpp-mark.svg AND the app-wide PdppLogo component — same logo, theme-capable, consistent with the rest of the app; an inline themed SVG beats a static <img> here.)
- `PDPP_INSTANCE_LOGO_URL` override: deferred per the note (optional; name+restore is the higher-value bit).
- Verified by me: zero visible "Recordroom"; tsc clean; console view-models 124/124 + brand-react 34/34; lint clean on touched files.

## Codex plan sign-off (tmp/workstreams/codex-burst-branding-plancheck.md): CHANGES → folded in below

### Part A required changes (Codex)
- Implement an explicit per-day `units` list: `{kind:'single', entry, latestAt}` | `{kind:'burst', burst, latestAt}`, sorted `latestAt DESC`; `FeedDays` renders `g.units.map(...)` (NOT separate bursts/singles arrays the JSX can re-misorder). Keep `singles`/`bursts` only if other consumers need them; canvas uses `units`.
- Deterministic tie-break: equal `latestAt` → preserve original feed order (stable) / feed secondary key. No jitter.
- Undated/invalid handling: a unit with no parseable time sorts AFTER dated units within the day; stable tie order; invariant explicitly allows "undated last".
- Burst members stay newest-first (input is desc → preserve; else sort by same comparator). `latestAt` for a burst = max member `displayAt` = `burst.entries[0].displayAt` (entries arrive desc).
- Tests (all 7): A/B/C reproduces 23→19→31 before, sorts 31→23→19 after; burst-vs-single interleave (single at 25m between 31m and 23m bursts); within-burst newest-first; tie stability; undated-last no-crash; Upcoming still groupFeedDaysNoBursts forward-chron (scope guard); monotonic-non-increasing invariant across rendered units + within expanded bursts.

### Part B required changes (Codex — BLOCKING gap I missed)
- Branding is currently HOMEPAGE-ONLY: only /dashboard/page.tsx passes `brandName`; 46 other `RecordroomShellWithPalette` JSX call sites omit it → they render hardcoded "PDPP" even when configured. Must be ROUTE-GLOBAL.
- FIX (no 46 per-site edits, no server-env in a client component): `dashboard/layout.tsx` IS a server component wrapping every dashboard route and already renders `DashboardPaletteProvider`. Resolve `getInstanceBrand()` ONCE in the layout (server), provide `brandName` via context (extend DashboardPaletteProvider or a sibling BrandProvider); `RecordroomShellWithPalette` (client) reads it from context, prop still overrides. All 46 sites inherit the configured brand with zero edits.
- `PDPP_INSTANCE_LOGO_URL`: mark DEFERRED in the design note (not in this batch) so the plan claims only what it ships.
- Tests: source invariant that all dashboard shell mounts use the resolved brand (not hardcoded default); probe that PDPP_INSTANCE_NAME=Acme renders "Acme" on /dashboard, /dashboard/explore, and a /dashboard/connect/... page; default-unset renders "PDPP"; visible "Recordroom" absent from wordmark (component name allowed).

## Combined gates (before deploy)
- tsc clean: apps/console + packages/pdpp-brand-react.
- All explore tests (grouping incl new ordering tests, invariants, navigation, etc.) + operator-ui + the branding-touched suites green.
- ultracite/lint: no NEW violations on touched files.
- `git diff --check` clean.

## Deploy + acceptance (live, after Codex end-review LAND)
- Declare/OPEN a live-stack window (ri-owner-current-state.md). FF local main → commit, `COMPOSE_PROJECT_NAME=pdpp scripts/reference-stack.sh up --build-app` from the worktree.
- Live Playwright/darshana acceptance (the method that found the bugs):
  - Burst ordering: capture a day with multiple bursts; assert across-burst timestamps are monotonic non-increasing; the 23/19/31-class scatter is gone.
  - Branding: PDPP logo renders in sidebar (light+dark); wordmark = "PDPP" (default); set PDPP_INSTANCE_NAME and confirm it changes (or confirm via the resolved prop if a redeploy with the env isn't run).
- Close the window with the result.

## Scope guard
Do NOT touch: D1/D2 relayout (shipped+proven), Upcoming forward-chron ordering, the RecordroomShell component name, count==reachability semantics, server contracts. Burst-ordering is presentation-only over already-sorted data. Branding is name+logo only.
