# `runtime/index.js` decomposition plan

## Objective and hard boundaries

Reduce the 761 units of Biome excess cognitive-complexity mass in
`reference-implementation/runtime/index.js` by decomplecting the connector run
coordinator without changing exports, routes, JSONL messages, event ordering,
wire data, error text, timing semantics, or test expectations.

The baseline defect is real: `runConnector` is a roughly 2,440-line closure that
braids launch preparation, child lifecycle, protocol validation/dispatch,
ingestion/state commit, recovery evidence, assistance, and terminal projection.
Biome's mass is a proxy for that concrete local-reasoning defect, not the goal by
itself. New modules must own a coherent policy or state transition and expose a
smaller interface; moving the same branching behind a filename does not qualify.

## Evidence contract

- Baseline and post-change mass:
  `node scripts/quality-ratchet/measure-mass.mjs --files <touched runtime files>`
  from `reference-implementation/`. Aggregate touched-file mass must fall on
  every refactor commit; `runtime/index.js` mass must also fall.
- Type gate: `pnpm --dir reference-implementation typecheck`.
- Covering tests: each selected file runs alone against a newly created
  Postgres database at localhost:55432 before and after changes. Pass counts
  and expectations must remain unchanged.
- Diff gates: `git diff --check`, no public export or declaration drift, and an
  independent worker reviews the actual diff for behavior changes and
  relocation theater.
- Authoritative final gate: `pnpm test` from `reference-implementation/` with
  `PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55432/pdpp_rtindex_gate`
  so the repository runner creates one database per file.

## Pinned covering tests

The initial characterization set exercises the runtime's main external seams:

- `test/collection-profile.test.js` — START/scope, protocol envelopes, record
  ingestion, checkpoints, and state.
- `test/runtime-cancel-run.test.js` — owner cancellation and child teardown.
- `test/runtime-child-process-group.test.js` — child process-group ownership.
- `test/runtime-pipe-resilience.test.js` — stdin/JSONL failure paths.
- `test/runtime-ingest-manifest-drift.test.js` — ingestion and manifest drift.
- `test/connector-failure-diagnostics.test.js` — terminal error projection.
- `test/connector-gap-severity.test.js` — recovery/known-gap classification.
- `test/detail-coverage-recovered-gap-regression.test.js` — detail-gap state
  transitions and commit guard.

If a chosen slice touches assistance or control-plane event semantics, add the
direct assistance/control-plane test before that edit rather than relying on the
final suite.

## Decomposition sequence

1. **Pin the baseline.** Run mass, typecheck, and every covering test in
   per-file ephemeral-DB mode. Record pass counts and failures verbatim.
2. **Rank seams using actual diagnostics and dependency shape.** A Terra worker
   maps the high-mass functions and proposes only behavior-preserving seams.
   The architect verifies every proposed caller/dependency claim in the source.
3. **Extract pure launch/input policy first.** Separate deterministic START
   scope/binding/env/message construction from spawning and lifecycle effects.
   Prefer guard clauses and data tables where they preserve evaluation and
   error order. Reject a bag-of-helpers facade.
4. **Extract pure terminal/evidence projection next.** Move deterministic
   checkpoint, known-gap, and terminal payload decisions behind one cohesive
   module only if the interface replaces closure state with explicit inputs and
   aggregate touched-file mass drops.
5. **Decomplect protocol dispatch last.** Split validation/decision from effects
   for the highest-mass message cases; use a dispatch table only when it makes
   supported message types and handlers explicit without changing sequential
   queueing or switch fallthrough/error behavior. Keep ingestion, child I/O,
   cancellation, and event emission ordered exactly as characterized.
6. **Gate and commit each coherent slice.** Terra performs bounded mechanical
   edits; the architect reads every touched file and diff, runs typecheck,
   selected per-file tests, mass measurement, and `git diff --check`, then
   commits as `Tim Nunamaker <tnunamak@gmail.com>`.
7. **Independent closeout.** A fresh worker reviews the cumulative diff against
   the no-surface-change and no-relocation-theater rules. Resolve findings, run
   the authoritative full suite, grep for stale names/imports, read all touched
   files, and write `w2ri-report.md` with before/after evidence and any proposal
   that would require expectation changes.

### Execution decision after diagnostic ranking

The diagnostic pass found that `runtime/connector-gap-bounding.ts` already owns
the cohesive connector-output persistence policy while `runtime/index.js` still
contained a second, newer copy. That made facade integration the first slice:
it deletes a real duplicate reason-for-change, keeps one policy owner, and has a
smaller risk surface than introducing a new launch or protocol-session module.
The module had to be reconciled to the live inline behavior before integration,
most notably by adding `manifest_stream_unresolved` to transient gap reasons.
The remaining launch, terminalization, and protocol-session seams stay ranked
follow-ups rather than being forced into this commit.

## Stop condition

Stop only when at least one coherent decomposition is committed, all applicable
gates pass, aggregate mass across touched runtime source files is lower than its
baseline, `runtime/index.js` is below 761, the full reference suite passes, and
the final report exists. If behavior preservation cannot be proven, revert that
slice and report the exact blocker rather than changing tests.
