# Design: Fix Chase current-activity hydration wait

## Context

The Chase `current_activity` stream intentionally parses the dashboard overview's
recent-activity table, not the QFX download page. The connector already captures
dashboard HTML before navigating away for QFX and statement work.

The missing piece was readiness: `discoverAccounts()` waited for account-card
selectors, then `collect()` immediately read `page.content()` for
`current_activity`. Live evidence showed that account-card readiness does not
prove recent-activity readiness.

## Decision

Use a selector-specific readiness wait for the exact rows consumed by
`parseCurrentActivityDom()`:

```text
tr.mds-activity-table__row[data-values], tr[id*="activity" i][data-values]
```

The wait uses the existing Chase DOM wait budget. It is not a fixed sleep. It is
bounded and source-surface-specific.

## Alternatives

- Fixed delay before `page.content()`: rejected because it is slower, less
  deterministic, and still guesses.
- Treat zero rows as covered/no activity: rejected because the current parser
  cannot distinguish "no visible activity" from "surface not hydrated" or
  selector drift without a separate empty-state detector.
- Re-navigate to the dashboard after QFX work: rejected because earlier work
  proved same-document Chase hash navigation can leave the SPA on the wrong
  rendered surface.

## Acceptance Checks

- Chase integration tests prove snapshot ordering and timeout fall-through.
- Chase parser/current-activity tests remain green.
- Reference typecheck remains green.
- Live Chase retry after deploy no longer emits `selectors_pending` solely from
  reading before the recent-activity table hydrates.
