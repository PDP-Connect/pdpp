# Design-cell recipe (the fan-out template) — corrected by the date-controls pilot

> **STATUS 2026-06-23: ALL 5 CELLS LANDED at >95% (Codex gpt-5.5 adversarial review each).**
> date-controls · over-time-chart · record-components · sort · honesty-copy — each has prior-art.md +
> design.md, each Codex-LAND'd (most after real HOLD→revise cycles). The Explore design set is COMPLETE:
> nothing unbuilt in terms of design. Remaining = the integration pass (step 7) + execution. See each
> cell's design.md for the execution-ready spec + test matrix.

Goal of each cell: a design at **>95% execution-ready confidence** — an executing agent needs zero
further decisions. Validated by the date-controls pilot, which Codex HOLD'd then (expected) LAND'd; the
HOLD added steps 2 and 3, which the original recipe lacked.

Run per cell, in order. A cell may NOT claim >95% until step 6 returns LAND.

1. **Prior-art research (on disk, product-specific).** Not "how to design X" — "how do Linear / Stripe /
   Grafana / Primer / Superhuman / Things specifically do X," with real URLs. Capture the canonical
   reference AND the named **anti-pattern** to avoid (e.g. Primer's "preset that hid the resolved range").
   Write to `<cell>/prior-art.md`.

2. **Re-audit the defect BY CONTENT on the pinned tip.** Pin the exact target tip (currently deploy tree
   `<deploy-worktree>`, tip `36d51f49`, branch `workstream/explore-feel-integration`).
   `grep` for the ACTUAL code by content — never trust a research agent's line numbers (the pilot cited
   stale ~L1170 refs; real date buttons were L1102-1106). State file:line you verified yourself.

3. **Canonical-state check (highest-value step).** Does this control overlap an EXISTING one — typed
   operators, URL params, facets, another chip? If yes, the design MUST define the single canonical
   object everything normalizes INTO, or it recreates "same thing two ways" (the pilot's Date chip vs
   `before:`/`after:` operators — fixed by one `(since,until)` object that operators lift into). This is
   the catch self-review misses most.

4. **Honesty semantics in FULL.** For anything touching time / money / counts / coverage, specify the
   exact math: timezone, inclusive/exclusive boundaries, sliding-vs-fixed, what a number counts. "Honest
   label" as a phrase is not enough — boundary lies are the failure mode for a personal-data tool.

5. **Design-writer.** Output `<cell>/design.md` = chosen pattern (prior-art-cited) + any NEW honesty
   invariants (fold back into THE-LENS Gate 1) + exact UI/states + an **executable test matrix** (label
   cases, boundary cases, normalization, reload roundtrip, clear) + a bounded <5% residual that does NOT
   touch correctness.

6. **Adversarial Codex review (gpt-5.5; effort by difficulty).** Hand it the cell + THE-LENS Part 0 +
   gates; ask it to BREAK the design (better pattern? honesty hole? canonical-state overlap? stale code
   claim? Part-0 trigger?). HOLD → revise → re-review → LAND. Self-scoring alone = the forbidden
   "self-authored verdict." Only after LAND is the cell >95%.

7. **Integration pass (after all cells LAND).** One agent checks the cells COMPOSE — shared layout, no
   conflicting interactions, shared brand components where SLVP products reuse them — and produces the
   single execution-ready design set.

Effort tiers for the fan-out: chart = high; unified record components + sort = medium; date (done) +
honesty-copy cleanup = low.

## Pixel gate — the high-velocity self-verify loop (added 2026-06-23)
Each cell's "Definition of Done — pixel gate" runs as a SELF-VERIFY loop BEFORE the owner sees it, so the owner
confirms a near-final result instead of hunting for defects:
1. Build the cell → render the live surface via Playwright (desktop 1440 + mobile 390).
2. Capture the live screenshot. Read it AND the kept reference shot as images in the same context.
3. Diff myself on ANATOMY + TOKENS (title-leads, mono discipline, spacing/density, control pattern,
   active-state) — this I can self-verify to high confidence.
4. Iterate build→capture→diff until I judge it matches the reference. THEN show the owner the side-by-side
   (my live capture next to the reference) for a fast yes/no.
5. FEEL (calm/restraint/"reads as a product") stays the owner's final call — I get close, he's the better
   judge. So the loop is: I self-verify anatomy to near-final, the owner ratifies feel in seconds.
This keeps velocity high (the owner isn't the defect-finder) without overclaiming (feel is still gated on the owner).

## EXECUTION STATUS (2026-06-23, autonomous run)
- ✅ date-controls — built, defect fixed (URL-path canonical leak), 41/41 tests, harness-pixel-verified.
- ✅ honesty-copy — built, HOLD (3 sibling-warning leaks beyond the named 4) → fixed + negative-controlled,
  34/34 invariants + 43/43, tsc clean. DONE.
- ✅ record-components — built, HOLD (header-H1 UUID leak: derived key rendered as bold H1) → fixed CSS-only
  (declared title stays bold H1, derived key demotes to mono-secondary), 11/11 + 30/30, negative-controlled. DONE.
- ✅ sort — PASS first try (no HOLD): declared-field-only structurally closed at client AND server; oldest-paging
  reachability bug fixed (real server ascending re-page, client .reverse() removed); membership invariant proven.
  48 sort tests + 30 invariants. DONE.
- 🔄 over-time-chart — building/verifying (the high-effort cell; chart worktree's TimeBucketGranularity tsc error
  seen mid-flight — expected in-progress state).
RECIPE VALIDATED: 3 of 4 HOLDs were real defects the gate missed; sort passed clean. Adversarial verify earns its keep.

## ALL 5 CELLS LOGIC-COMPLETE + ADVERSARIALLY VERIFIED (2026-06-23)
- ✅ over-time-chart — built, HOLD (the run's most important catch: bars from server aggregate but NOT
  scoped to search query/date filter while captioned "Matching records" = a count==reachability LIE) →
  FIXED: suppress chart during search (aggregate can't scope to free-text q), structural connection/stream
  filter scope (test-pinned), honest caption "Records over time" (never "Matching"). 33/33 chart + 5/5 scope
  (negative-controlled: search→bucketSeries null + aggregate never fired) + 105/105 explore. DONE (logic).
TALLY: 4 of 5 cells HOLD'd on a REAL defect the gate missed; sort passed clean. The adversarial verify
phase caught: a URL-path canonical leak, 3 copy leaks, a CSS-cascade H1-uuid violation, and the chart
scope lie — NONE caught by tsc+passing-tests. Recipe decisively validated.
PIXEL: date-controls + record-components harness-checked ✓. chart owes a harness check w/ a real Grafana
reference (no corpus shot for histogram-over-feed — flagged residual). sort/honesty-copy = behavior/copy
(human-read gate at deploy, not pixel-diff).

## ⛔ DEPLOY/PR BLOCKED — branch↔main divergence (2026-06-23, awaiting Codex)
The 5 cells build on the explore FOUNDATION (full explore-data-assembler 2726 lines, set-descriptor.ts,
exclusion/recomposition) that lives ONLY on the deploy branch workstream/explore-feel-integration
(@36d51f49). The PII-scrubbed origin/main (2cbce1a2) has ~HALF the assembler (1250 lines), set-descriptor.ts
ABSENT, and merge-base(deploy, origin/main) is EMPTY (fully disjoint after the history rewrite). So the
cells CANNOT extract/PR onto rewritten main — main lacks what they extend.
Tim's call: ask Codex to reconcile branch↔main first (Codex owns branch strategy + rewrote main). Sent
9:pdpp RI the blocker w/ evidence (queued, Codex was Working 38m). AWAITING Codex's decision: does the
explore foundation land on main first (cells extract onto it), or do cells deploy onto the LIVE deploy
branch pending separate reconciliation. Cells committed local-only in their worktrees; nothing pushed;
stack untouched. NO deploy/PR until Codex sets the path.

## CODEX VERDICT (2026-06-23) — foundation-to-main reconciliation FIRST, then cells
Codex (branch-strategy owner): do NOT PR/extract the 5 cells from the disjoint live deploy branch.
workstream/explore-feel-integration / 36d51f49 = live OPERATIONAL lineage only, NOT pushable mainline
after the rewrite. CORRECT PATH:
  1. Port/reconcile the FULL Explore foundation (assembler, set-descriptor, exclusion, recomposition)
     onto current rewritten origin/main as CLEAN reviewable diffs/commits — needs a plan + owner gate.
  2. THEN rebase/cherry-pick the 5 cells onto that reconciled foundation.
Do NOT deploy cells onto the deploy branch as a substitute (unless Tim explicitly asks for an emergency
live-only experiment). Cells stay LOCAL-ONLY, stack untouched, until the foundation-mainline plan + owner
gate. Codex continues MCP from the clean rewritten-main worktree, not touching live stack.
STATUS: 5 cells DONE (built + adversarially verified + committed local-only). Deploy/PR BLOCKED on the
upstream foundation-to-main reconciliation (a large reviewable migration — plan + owner gate required,
NOT a unilateral autonomous start).

## FOUNDATION PORT — PROVEN SIMPLE (2026-06-23, trial worktree)
"Major project" was WRONG (raw 13.8k-line count was misleading — mostly ADDITIONS). PROVEN in
trial/explore-foundation off origin/main 2cbce1a2: the port is a mechanical dependency-closure checkout:
  git checkout 36d51f49 -- <explore surface + its closure>
= 57 files (28 new explore + deploy-ahead supersets + named deps: data-source/ref-client/rs-client types
both packages, record-preview/kind/field-format/declared-field-roles/field-label, ui/timestamp, package.json
export map, record-inspector.tsx, AND brand-react components.css — the CSS was the only initial miss).
Converged in ~6 checkout→re-tsc rounds; each error NAMED the next file. ZERO scope creep (all explore/lib/
components/ui). RESULT: operator-ui tsc clean + console tsc clean + set-descriptor 20/20 + exclusion 13/13 +
feed-declared-roles 2/2 + loadmore 10/10 + page.invariants 30/30. The foundation WORKS on main, not just
compiles. → This collapses to ONE clean reviewable commit; the 5 cells then rebase straight onto it.
