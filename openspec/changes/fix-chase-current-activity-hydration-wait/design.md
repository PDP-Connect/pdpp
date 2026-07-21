# Design: Fix Chase current-activity hydration wait

## Context

The Chase `current_activity` stream intentionally parses the dashboard overview's
recent-activity table, not the QFX download page. The connector already captures
dashboard HTML before navigating away for QFX and statement work.

The missing piece was readiness: `discoverAccounts()` waited for account-card
selectors, then `collect()` immediately read `page.content()` for
`current_activity`. Live evidence showed that account-card readiness does not
prove recent-activity readiness.

## Decision (original: wait-then-read)

Use a selector-specific readiness wait for the exact rows consumed by
`parseCurrentActivityDom()`:

```text
tr.mds-activity-table__row[data-values], tr[id*="activity" i][data-values]
```

The wait uses the existing Chase DOM wait budget. It is not a fixed sleep. It is
bounded and source-surface-specific.

## Regression and revised decision: parse-first, wait-as-fallback

The wait-then-read design above shipped and a subsequent owner-present live
run (`run_1783647087916`) still produced `selectors_pending`. The retained raw
fixture capture for that run proved the row surface was present and parseable
immediately before the row-selector wait began (`dashboard-accounts` DOM
checkpoint: 5 `tr.mds-activity-table__row[data-values]` rows, verified by
running the real `parseCurrentActivityDom()` against the captured bytes), yet
the wait still consumed its full budget and reported the surface not ready.

This proves the row-selector locator and the parser can disagree about
whether a given DOM state is "ready": the locator is a Playwright-side
attached/detached signal, while the parser is the actual consumer of the
serialized HTML bytes. Gating the read on the locator's verdict, rather than
on the parser's verdict against the bytes actually read, let the connector
discard a snapshot that was already good.

Revised decision: make the parser the readiness oracle for the Chase
`current_activity` snapshot, not the locator.

1. Read `page.content()` immediately, before consulting any locator.
2. Run `parseCurrentActivityDom()` against that content. A non-empty result
   is accepted as proof of readiness — return it. No wait is needed because
   the parser already succeeded against the exact bytes that will be used.
3. Only when the immediate parse yields zero rows, fall back to the bounded
   row-selector wait as a hydration retry trigger (today's behavior,
   unchanged in budget and selector).
4. After the wait resolves or times out, re-read `page.content()` once and
   re-parse. `rowSurfaceReady` is derived from this final parse result, never
   from whether the locator promise resolved — so the two signals can no
   longer disagree about what the caller is told.

This does not add a new selector and does not guess at markup.

### What this does NOT resolve

The parser still cannot distinguish a genuine Chase-side empty state from
unrecognized or drifted markup — no fixture or corpus evidence available here
proves Chase renders an explicit empty-state marker on this surface. Zero
rows after the fallback wait continues to route to `selectors_pending`,
exactly as before this change. A verified empty-state detector is out of
scope and would need its own evidence before implementation.

## Alternatives

- Fixed delay before `page.content()`: rejected because it is slower, less
  deterministic, and still guesses.
- Treat zero rows as covered/no activity: rejected because the current parser
  cannot distinguish "no visible activity" from "surface not hydrated" or
  selector drift without a separate empty-state detector, and no evidence in
  this repo yet proves what a genuine empty-state surface looks like.
- Re-navigate to the dashboard after QFX work: rejected because earlier work
  proved same-document Chase hash navigation can leave the SPA on the wrong
  rendered surface.
- Trust the row-selector locator's `waitFor` result as the sole readiness
  signal (the original wait-then-read design): rejected after live evidence
  showed the locator and the parser can disagree — the locator can time out
  against content that the parser would have accepted immediately if read
  first. Superseded by parse-first, wait-as-fallback above.
- Widen or change the row selector: rejected — the retained fixture proves
  the existing selector and parser already recognize the real markup; the
  defect was in wait-vs-read ordering, not selector coverage. No selector
  change is warranted by the evidence.

## Acceptance Checks

- Chase integration tests prove snapshot ordering and timeout fall-through,
  run from the isolated worktree (not a container copy).
- Chase integration tests prove the parse-first path never consults the
  row-selector locator when the immediate parse already yields rows, and that
  `rowSurfaceReady` reflects the final parsed result (not merely a resolved
  wait) after the fallback path.
- Chase parser/current-activity tests remain green.
- polyfill-connectors typecheck remains green.
- Live Chase retry after deploy no longer emits `selectors_pending` solely
  from a wait/read ordering mismatch. Owner-only; see `tasks.md` task 5.5.
