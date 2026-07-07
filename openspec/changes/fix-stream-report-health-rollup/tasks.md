## 1. Projection

- [x] 1.1 Add a connector-neutral rollup from collection-report coverage
      conditions to connection-level coverage.
- [x] 1.2 Recompute source-list/source-detail connection health with the rollup
      before rendering the verdict.

## 2. Tests

- [x] 2.1 Add a regression test proving a succeeded run with partial stream
      coverage does not render `Healthy`.
- [x] 2.2 Run focused source projection and collection-report tests.

## 3. Acceptance

- [x] 3.1 `openspec validate fix-stream-report-health-rollup --strict`
- [x] 3.2 Live projection shadow shows no `Healthy` connection with a
      degrading stream report.
