# Explore SLVP redesign — AUTONOMOUS OPERATING PLAN (Tim away, run to completion)

Tim stepped away 2026-06-23 and authorized running autonomously "for hours or days until the full
true goal is complete with extreme confidence." This file is the durable spine — survives compaction;
any resuming agent reads this + `01-benchmark-synthesis-and-rubric.md` + the latest `STATUS.md` and continues.

## THE TRUE GOAL (definition of done — do NOT stop short)
Explore on pdpp.vivid.fish is redesigned to SLVP-tier and DEPLOYED, such that:
- It scores **≥4/5 on ALL 12 rubric dimensions** (01-benchmark-synthesis-and-rubric.md) against the 5 benchmarks.
- A **live re-walk on mobile (390) + desktop (1440)** confirms the visual/interaction bar in real pixels.
- **Honesty invariants intact**: count==reachability (no "0 in view · 25 returned" contradictions), no field-name/magnitude guessing, manifest-authored or honest-generic presentation, declared-only kind.
- **Dual-owner gate cleared**: Codex (waspflow, gpt-5.5) end-review LAND + Claude green (tsc/tests/lint).
- Extreme confidence = earned via design+critique loop to the bar, adversarial review, and live verification — not "it deployed."

## PHASES (each gated; do not advance until the prior clears)
- **P1 DIAGNOSIS — DONE.** 5 benchmark reports + ~28 shots (../slvp-benchmark-2026-06-23/), scored rubric (~25/60), real-data fixture (prototype/data-fixture.md).
- **P2 DESIGN+CRITIQUE LOOP (current).** Generate 3 interaction-model concepts as standalone HTML/CSS (PDPP brand tokens, real-data fixture, desktop+mobile). Critic agent scores each vs the 12-dim rubric + benchmark shots. Synthesize the winner (graft best of runners-up). Iterate with the critic until the prototype scores ≥4 on every dimension. Output: prototype/{concept-a,b,c}/ + prototype/final/ + rendered screenshots + 02-target-design.md. GATE: prototype ≥4 all dims (critic-confirmed) → this is the design Tim will see; capture screenshots for him.
- **P3 IMPLEMENTATION DELTA.** Map the approved prototype to real files (pdpp-brand-react components.css + tokens, apps/console/.../explore/explore-canvas.tsx, packages/operator-ui assembler/record-preview). Sequence into independently-shippable slices. Build each in the isolated worktree /home/tnunamak/.tmp/pdpp-explore-sweep (or a fresh one off latest deploy), gate (tsc + tests + lint + new regressions), per slice.
- **P4 DUAL-OWNER REVIEW.** Codex end-review per slice (waspflow gpt-5.5; tmux long-prompt→`revise` to submit). HOLD→fix→re-review→LAND. Adversarial: also self-critique vs rubric.
- **P5 DEPLOY + LIVE RE-WALK.** Declare window in tmp/workstreams/ri-owner-current-state.md. Cherry-pick onto /home/tnunamak/.tmp/pdpp-deploy, reference-stack up --build-app. Live re-walk (Playwright, owner session) mobile+desktop: re-score all 12 dims on the LIVE site. If any dim <4 → back to P3 for that dim. Loop until all ≥4 live.
- **P6 FINAL CONFIDENCE.** Adversarial "what did we rationalize as fine" critic on the live result. Reconcile. Only declare done when the live re-walk scores ≥4 everywhere AND the adversarial critic finds nothing material.

## HARD CONSTRAINTS (never violate, even autonomous)
- **Never touch Codex's checkout** ~/code/pdpp for git ops; never delete pdpp-mcp-*/waspflow-mcp-* worktrees. Work in ~/.tmp worktrees.
- **gpt-5.5 ONLY** for Codex (5.4/5.3 rejected). **waspflow NOT codex-cli** for reviews. waspflow long prompts can land as un-submitted [Pasted Content] chip → `waspflow revise <lane> -- "go"` to submit; reap when done.
- **Research/design findings to disk** (HARD RULE) — docs/research/ always.
- **Declare a live-stack window** before any deploy/restart on pdpp.vivid.fish.
- **Honesty bar absolute**: no field-name/stream-name/magnitude/shape guessing of MEANING; declared or honest-generic only; count==reachability; mono only for machine values.
- **Brand tokens fixed**: Schibsted Grotesk (sans, incl. the search input) + JetBrains Mono (ids/timestamps/amounts only). Express the redesign THROUGH these.
- **Reversibility**: every change committed in small slices, dual-gated, on a branch off the deployed baseline; backup branch before risky ops (the rebase near-miss earlier this session — never rebase a large divergence).

## PROGRESS LEDGER
See STATUS.md (updated each phase). Update memory project_explore_slvp_redesign_v1 at each milestone.
