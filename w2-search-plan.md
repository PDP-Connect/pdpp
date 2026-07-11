# w2-search decomposition plan

## Scope and invariants

- Target only `reference-implementation/server/search.js`; do not touch its semantic sibling.
- Preserve every export, route, query parameter, error shape, ordering rule, storage call, and wire envelope.
- Do not change test expectations. Any suspected behavior defect is report-only.
- Measure progress with the repository mass oracle (`maxAllowedComplexity: 5`), while judging each extraction by whether it creates an honest decision or adapter seam rather than merely moving lines.
- Gate every production commit with reference-package typecheck, the pinned lexical-search tests on fresh per-file Postgres databases, a touched-file mass measurement that strictly drops, `git diff --check`, and independent diff review.

## Baseline evidence

- Branch/worktree: `waspflow/w2-search` at `4a16f50ea`, isolated from `curation/lfdt-prep`.
- Baseline mass: `server/search.js = 205` excess points.
- Primary behavior pin: `test/lexical-retrieval.test.js` (public lexical contract, native shell, plan, SQLite and Postgres-sensitive paths).
- Backend pins: `test/lexical-retrieval-conformance-postgres.test.js` and `test/lexical-snapshot-pagination-postgres.test.js`.
- Focused shell/oracle pins: `test/search-fan-in-host-shell.test.js`, `test/records-instance-namespace.test.js`, and `test/parse-search-params-error-translation-oracle.test.js`.

## Decomposition sequence (highest mass first)

1. **Route dependency assembly:** split `runLexicalSearch` into explicit actor/owner-context derivation and a lexical-operation dependency adapter. Keep `executeSearchLexical` and its error translation in the exported shell. Extract only cohesive adapter construction; no bag-of-helpers and no public signature change.
2. **Grant-plan decisions:** separate candidate-scan policy and per-stream plan-entry construction from I/O. Use guard clauses and named intermediate facts so authorization/filter semantics remain locally auditable.
3. **Backend hit folding:** express Postgres and SQLite row-to-hit merge/update behavior through small pure decide/apply helpers only where both branches already share the same invariant. Preserve SQL, iteration order, scores, snippets, truncation detection, and candidate filtering byte-for-byte in effectful shells.
4. **Backfill orchestration (only if mass remains and tests cover it):** isolate drift decision from application with a closed decision table/dispatch. Preserve logging, job progress, cancellation points, and storage operation order.

Each step is a separate candidate commit. A step is rejected if it adds shallow one-caller wrappers, grows production LOC without hiding real depth, changes an externally observable detail, or fails to reduce measured mass. Stop when the 205-point target is eliminated or the remaining mass is demonstrated to be essential/no-go complexity.

## Independent-check contract

For every candidate diff, a fresh Terra worker must read the actual diff and return PASS/REVISE/REJECT with cited evidence for behavior preservation, no public-surface change, no semantic-search touch, no shallow extraction/relocation theater, and alignment with the plan. The architect independently reruns deterministic gates and commits only after both judged and mechanical gates pass.
