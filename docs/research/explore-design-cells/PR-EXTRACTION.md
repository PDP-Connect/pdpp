# Clean PR extraction (push-safe, post-scrub) — verified recipe

Codex rule: every cell's diff must land on FRESH origin/main with NO pre-rewrite ancestry. Each cell was
built in its own worktree off deploy tip 36d51f49 (pre-rewrite, non-pushable as ancestry).

VERIFIED (2026-06-23): the deploy tree base 36d51f49 is CLEAN, and each cell worktree was created fresh
off it — so `git diff 36d51f49` in a cell's worktree is ENTIRELY that cell's work (no inherited lane
noise; the earlier lane-noise worry was unfounded for these fresh worktrees). The date-controls diff was
audited: page.invariants edits ARE date-related (mine); the rr-x-copyview CSS "change" is just a block
MOVE (+line13/-line149, same content) from inserting rr-x-datechip — benign.

## Per-cell extraction (when ready to PR):
1. `git -C <cell-worktree> diff 36d51f49 > /tmp/<cell>.patch`  (the tracked-file diff)
2. Note the untracked NEW files: `git -C <cell-worktree> status --short | grep '^??'`
3. Re-fetch (origin/main keeps moving: 323ab3a9 → 745df34a → …). Create fresh branch:
   `git worktree add -b pr/explore-<cell> <new-wt> origin/main`
4. `git -C <new-wt> apply /tmp/<cell>.patch` + copy the untracked new files into <new-wt>.
5. Verify: tsc + the cell's tests green on the fresh base; `git log` shows NO pre-rewrite commits
   (only your new commit on top of current origin/main).
6. Commit + push that branch; open PR. NEVER push/merge from the old deploy worktree.

## Cell worktrees (all off 36d51f49):
- pdpp-exec-date-controls (DONE: logic + harness-pixel)
- pdpp-exec-record-components, pdpp-exec-sort, pdpp-exec-honesty-copy, pdpp-exec-over-time-chart (building)

## Order: apply per the integration sequence (date-controls first — owns canonical setRange widening;
then chart, sort, record-components, honesty-copy-lock). Resolve the shared explore-canvas.tsx /
setRange touch-points at apply time (date-controls + chart both widen setRange — apply date-controls
first, then chart's widening should be a no-op/compatible per its design).
