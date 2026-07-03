# Night report finding harvest — 2026-07-03

Status: captured

Source: untracked agent night reports from `docs/research/night-reports-2026-07-03/`. This file preserves the actionable findings without retaining raw transcript fragments, private paths, or large diffs.

## Promote now

- `harden-runtime-tool-detection`: live security finding. The scheduler readiness path executed connector-manifest `detect.command` through `spawn(..., { shell: true })`. Promoted to OpenSpec change `openspec/changes/harden-runtime-tool-detection/` and implemented in the current worktree.

## Open PR gates

- PR #11, OSS connector adapter kit: review found it merge-quality after owner review and test execution. Keep as an owner-gated PR decision; not a lost code fix.
- PR #10, connector config/credentials schema: review found the design sound but blocked by merge conflicts against current `main`. Rebase before merge.
- PR #7, connector synthesis: review found a real runtime bug in the generated export collector. Missing source item IDs become `key: "undefined"` or `key: "null"` instead of emitting `SKIP_RESULT`. Fix this with a regression test before merge, and land after PR #10.
- Cross-cutting PR follow-up: PR #10 and PR #11 add meaningful tests that are not currently required checks. Make those tests a gate before relying on the branches.

## Runtime and data-path bugs to triage

- `finalizeRunCleanup` can delete a different live run's active-run entry if cleanup races with a superseding run. Candidate fix: identity-check the active run before deletion.
- Credential-rejected connections can project as healthy after a previous success. Candidate fix: ensure blocked readiness conditions outrank stale success evidence.
- Postgres cursor pagination can drop rows with `NULL` cursor values. Candidate fix: port the SQLite four-branch seek behavior and add dialect parity tests.
- Status-filtered Postgres spine pagination slices before filtering. Candidate fix: filter before page slicing or over-fetch with a correctness proof.
- JSONB semantic fallback applies `LIMIT` before ranking. Candidate fix: rank before limiting and add top-k tests.
- Browser streaming lifecycle has multiple race/leak candidates around concurrent attach, stop/start, and never-attached companions. Triage these against current remote-surface code before filing fixes.

## Cleanup and design-debt candidates

- Delete truly def-only app/site symbols only after the app type/build checks run green.
- Decide whether the web-push settings surface is retired; if yes, remove the component, test, and matching reference-client methods together.
- Decide whether committed `dist/` directories are policy or drift. If drift, add build hooks before removing tracked artifacts.
- Run a dependency-audit tool before pruning package dependencies; do not rely only on grep.
- Consider a shared UI package for byte-identical console/site components.
- Track remote-surface TODOs separately: n.eko instance cleanup on remount and `sendText` no-op are functional gaps, not cleanup nits.

## Scratch safe to delete after this harvest

- Raw diff dumps.
- Reconciliation playbooks and worktree-audit reports whose results have already landed or been archived elsewhere.
- Raw night-report files after their actionable items are either promoted to OpenSpec, reflected on PRs, or explicitly rejected.
