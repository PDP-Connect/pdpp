# w2-search lane report

## Outcome

`reference-implementation/server/search.js` was decomposed without changing its
exports, route contract, query/wire shapes, storage SQL, or lexical/semantic
boundary. Cognitive-complexity mass fell from **205 to 87** (**-118, 57.6%**).
`reference-implementation/server/search-semantic.js` and all test expectations
remain untouched.

The landed seams are domain boundaries rather than file-movement or tiny-method
extraction:

- lexical route invocation context and native operation dependencies;
- shared SQLite/Postgres hit folding with the original score/snippet semantics;
- grant-plan eligibility and candidate-scan application;
- pure ordered records-page parsing with explicit scan/index deltas;
- one connector instance's complete stream/backfill/orphan-cleanup lifecycle.

## Commits and mass gates

| Commit | Change | Mass |
| --- | --- | ---: |
| `2ea0c4922` | isolate lexical operation wiring | 205 -> 198 |
| `304f25e0d` | separate lexical hit folding | 198 -> 127 |
| `5ccc70540` | isolate grant-plan decisions | 127 -> 107 |
| `296fea8b2` | separate lexical page parsing | 107 -> 97 |
| final commit | isolate per-instance backfill + lane artifacts | 97 -> 87 |

Every production commit was independently reviewed by a fresh Terra worker,
then gated by the architect with `pnpm typecheck`, `git diff --check`, a strict
mass decrease, and these tests against a freshly created Postgres database per
file:

- `lexical-retrieval.test.js`
- `lexical-retrieval-conformance-postgres.test.js`
- `lexical-snapshot-pagination-postgres.test.js`
- `search-fan-in-host-shell.test.js`
- `records-instance-namespace.test.js`
- `parse-search-params-error-translation-oracle.test.js`

All six pins were green before the refactor and after every landed commit.

## Review findings and rejected changes

- The first hit-folding candidate changed `NaN` score behavior. The checker
  caught it; the comparison was revised to preserve the original negative
  predicate before the commit was gated.
- A proposed pure drift-decision protocol reduced mass only 97 -> 96 while
  adding 24 lines and advancing a `declaredFields.length` read. The independent
  checker rejected it as shallow complexity laundering; it was discarded.
- A guard-only eligibility rewrite reduced mass only one point by removing
  useful names. It was discarded rather than optimizing the metric.

The remaining 87 points are deliberately not papered over. The largest residual
cluster is protocol-sensitive backfill and progress orchestration; further
attempted extraction either moved evaluation timing or introduced a shallow
decision protocol. The rest is spread across low-excess adapters, comparators,
parsers, and pure policy functions. A follow-up should add narrower behavioral
oracles before changing those semantics, rather than treating the remaining
metric as permission to churn.

## Final verification

- `pnpm install` from the worktree root: passed.
- Final `pnpm typecheck`: passed.
- Final mass oracle: `server/search.js = 87`.
- Final `git diff --check`: passed.
- Full-file read and old-pattern sweep: completed; rejected helper names are
  absent, the intended named eligibility predicates remain, and the semantic
  sibling has no diff.
- Authoritative `pnpm test` was run twice. Both runs completed the suite but
  failed only `scheduler progress watchdog allows long direct runs that keep
  reporting progress` under full-suite load. The same `scheduler.test.js` file
  passed **43/43** immediately in isolation. All lexical tests in both full
  runs passed. This is therefore recorded as a reproducible suite-load timing
  limitation, not claimed as a green authoritative gate.

No behavior changes or test-expectation changes are proposed by this lane.
