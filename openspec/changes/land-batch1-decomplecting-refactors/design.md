## Context

Owner batch gate v2 (`tmp/workstreams/refactor-batch-gate-v2-0711.md`)
reviewed six `rc-*` worker-lane branches and accepted four for landing (W3
streaming, T3 safe subset, W3 ref-control, T6), rejecting or holding the
other two (`rc-t3-tail` as a branch — only a salvaged subset of its commits
was accepted; `rc-t7-tail` — held pending a completed independent checker).
The gate explicitly directed: land exact source commits, not `rc` merge
commits; never hand-merge or cherry-pick a lane's own `mass-baseline.json`;
regenerate the baseline once from the final composed tree.

## Goals / Non-Goals

- Goal: an auditable record of exactly which commits landed, in what order,
  and how the two real conflicts were resolved.
- Goal: zero observable behavior change — this is a pure internal
  restructuring batch.
- Non-goal: re-evaluating `rc-t3-tail`'s rejected commits or `rc-t7-tail`'s
  held commits. Those remain out of scope per the gate.
- Non-goal: landing `rc-w3-libruntime` (explicitly deferred by the gate
  until after T6/T7 final diffs settle, due to overlapping files).

## Decisions

- **Cherry-pick, never merge**: every accepted commit lands as an exact
  `git cherry-pick`, preserving its original message (with a landing note
  appended). No `rc-*` merge commit is used as a landing unit.
- **Baseline conflicts always resolve to "ours" mid-batch**: every
  intermediate cherry-pick's `mass-baseline.json` conflict resolves to the
  current tree's baseline (discarding the incoming lane's regenerated
  numbers), and the pre-commit hook's own auto-tightening side effect is
  reverted after each commit. The baseline is touched exactly once, at the
  end, by the dedicated regeneration script.
- **Real conflicts resolve by preserving curated semantics + adopting the
  deeper accepted boundary**: both `server/ref-control.ts` and
  `runtime/browser-surface/run-coordinator.ts` had diverged from the commit
  each incoming refactor was authored against (the curated tree had since
  added evidence-provenance fields and capacity-reclaim retry/backoff,
  respectively). Rather than take either side wholesale, the incoming
  commit's decomposition shape (the new helper functions it introduced) was
  manually re-applied on top of the curated tree's current behavior, so no
  field, type, or code path present in the curated tree before this
  integration was dropped.
