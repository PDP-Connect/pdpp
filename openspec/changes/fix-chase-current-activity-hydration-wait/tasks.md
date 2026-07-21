# Tasks: Fix Chase current-activity hydration wait

## 1. Connector

- [x] 1.1 Add a Chase dashboard recent-activity row selector matching the parser
  target.
- [x] 1.2 Wait for that selector before reading dashboard HTML for
  `current_activity`.
- [x] 1.3 Preserve the existing bounded selector-diagnostic path when the row
  selector does not appear.

## 2. Tests

- [x] 2.1 Prove dashboard HTML is read after the recent-activity row wait
  succeeds.
- [x] 2.2 Prove timeout still reads HTML and returns `rowSurfaceReady: false`,
  allowing the existing `selectors_pending` branch to explain real drift.

## 3. Acceptance Checks (original tranche)

- [x] 3.1 Run Chase current-activity/parser tests.
- [x] 3.2 Run reference typecheck.
- [x] 3.3 Run `openspec validate fix-chase-current-activity-hydration-wait --strict`.
- [x] 3.4 Deploy and verify a live Chase retry. (Deployed; retry
  `run_1783647087916` still emitted `selectors_pending` — see task 4 below.
  Live evidence proved the wait-then-read design regressed rather than
  confirming it; superseded by the parse-first tranche.)

## 4. Regression tranche: parse-first, wait-as-fallback

- [x] 4.1 Read the retained raw fixture capture for `run_1783647087916` inside
  the reference container (read-only; never copy owner personal data out) and
  determine whether the row surface was parseable by the real
  `parseCurrentActivityDom()` at the moment closest to the failed wait.
- [x] 4.2 Change `snapshotDashboardHtmlForCurrentActivity` to read and parse
  `page.content()` immediately, before consulting the row-selector locator;
  accept a non-empty parse as proof of readiness without waiting.
- [x] 4.3 Fall back to the existing bounded row-selector wait only when the
  immediate parse yields zero rows; re-read and re-parse once after the wait
  resolves or times out.
- [x] 4.4 Derive `rowSurfaceReady` from the final parsed result in both the
  immediate and fallback paths, never from whether the locator promise merely
  resolved.
- [x] 4.5 Add a test proving the locator is never consulted when the
  immediate parse already has rows, reusing the existing
  `__fixtures__/current-activity-dashboard-overview-real.html` fixture (same
  structural shape as the retained raw capture — row count, id/class
  pattern, `data-values` shape — so no new fixture is needed).
- [x] 4.6 Add a test proving `rowSurfaceReady` reflects the re-parsed html
  after the fallback wait, not merely whether the wait promise resolved.
- [x] 4.7 Do not add or guess a new selector, and do not claim a genuine
  empty-state distinction — no fixture/corpus evidence in this repo proves an
  empty-state marker exists on this surface; zero rows after the fallback
  wait continues to route to `selectors_pending`.

## 5. Acceptance Checks (regression tranche)

- [x] 5.1 Run Chase current-activity/parser/integration tests from the
  worktree (not a container copy).
- [x] 5.2 Run polyfill-connectors typecheck from the worktree.
- [x] 5.3 Run `openspec validate fix-chase-current-activity-hydration-wait --strict`.
- [x] 5.4 Run `git diff --check`.
- [x] 5.5 Deploy and verify a live Chase retry no longer emits
  `selectors_pending` from a wait/read ordering mismatch. Owner-only; verified
  on `run_1783649510772` with deployed revision `v0.19.3-49-g09422c80b`,
  `run.completed` succeeded, zero `selectors_pending`, zero stream gaps, and
  `current_activity batch_ingested/state_advanced` succeeded.
