# Dispatch sequencing plan — connector-health redesign

Supplemental to `tasks.md` (the approved 49-task implementation plan). This does
NOT change the tasks; it sequences them for safe parallel execution and names the
hard gates and the one simplicity constraint to hold. `tasks.md` stays the source
of truth. Authored after independent SLVP-design approval (Claude), pre-dispatch,
for the Codex RI-owner conversation.

## Status

- The change is **0% implemented.** The live bugs the owner reported (`succeeded · coverage unknown`,
  false urgency, `3/2 collected`) are **still live** on pdpp.vivid.fish; `sources-view-model.ts`
  still reads `health.state` directly; `rendered-verdict.ts` does not exist.
- The plan (proposal + design + spec deltas + tasks) is approved as SLVP-ideal-as-a-design,
  including Codex's calibration gate (phase 12). Confidence ≥95% as a design; residual is
  implementation care (concentrated in phase 7 self-heal) + the one terminal UX with no live instance.

## The execution DAG (what parallelizes, what gates)

```
Phase 1 (validate)  ── prerequisite, trivial
        │
Phase 2 (stop the lies today)  ── SHIP FIRST, standalone, additive on connection-health.ts.
        │                          Fixes the 3 live bugs without the synthesizer. Independently
        │                          deployable + verifiable. Do this before anything else.
        ▼
Phase 3 (synthesizer)  ──┐
Phase 5 (RequiredAction) ─┤  3 and 5 are tightly coupled (the verdict carries actions);
        │                 │  build together or 3 then 5. Phase 4 (invariants) is written
Phase 4 (invariants)  ───┘  ALONGSIDE 3/5 — the composite test (4.3) is the linchpin and
        │                    must exist before 3/5 are considered done.
        │
        ├── Phase 6 (refresh-contract)  ── PARALLEL with 3-5. 6.3 (Risk 1 runtime trace) is
        │                                   the highest-leverage single task; do it early —
        │                                   if refresh evidence is NOT wired at runtime, the
        │                                   Amazon headline fix is inert and the design's
        │                                   glance-correctness claim deflates. Verify before
        │                                   building the manual-stale rendering on top of it.
        │
        ├── Phase 9 (runtime cascade guard)  ── PARALLEL, small, independent.
        ├── Phase 10 (grant-scope isolation) ── PARALLEL, small, a regression test.
        ▼
Phase 12.2 (golden fixtures)  ── GATE: pin the synthesizer outputs (ChatGPT/Amazon/Chase/
        │                         terminal/runtime) BEFORE any UI migration. "Prevents UI
        │                         work from hiding a bad model." Must pass before phase 8.
        ▼
Phase 12.3 (shadow comparison)  ── HARD GATE before phase 8.2 flips owner surfaces.
        │                           Run the synthesizer over the LIVE connection set, diff
        │                           old-vs-new headlines, classify each as fixed_lie /
        │                           deliberate_silence_correction / unexpected_drift.
        │                           ANY unexpected_drift BLOCKS rollout. This is the gate that
        │                           lets us trust the migration without endless live iteration.
        ▼
Phase 8 (consumer migration)  ── ONLY after 12.2 + 12.3 pass. Surfaces stop reading state;
        │                          dashboard/detail split; the grep/lint gate (8.5) locks it in.
        │
        ▼
Phase 7 (self-heal)  ── SEPARATE GATED DISPATCH (see below). Highest implementation risk.
        │               Build LAST, after the verdict + actions + migration are stable and
        │               the shadow-run is clean. Do not bundle with 3-5.
        ▼
Phase 11 (live journeys + validate)  ── full test + tsc + lint + openspec re-validate.
Phase 12.4/12.5 (DOM assertions + calibration record)
Phase 13.1 (owner live verification + Codex RI review)  ── the close-out gate.
```

## Three hard rules for the build

1. **Phase 12.3 (shadow comparison) is a hard gate before phase 8.2.** Owner surfaces are NOT
   migrated until the shadow run over live connections is clean (no `unexpected_drift`). This is
   the difference between "we wrote a verdict function" and "we proved it introduces no NEW lie
   while fixing the old ones." It is the empirical earn-it-before-ship step.

2. **Phase 7 (self-heal) is its own dispatch, gated behind everything else + a clean shadow run.**
   It is the part most likely to harbor edge cases (re-rejection races, confirming-run storms,
   partial-recovery masking). Tasks 7.4 (identical re-failure must NOT paint false green) and 7.5
   (partial recovery keeps the unrecovered stream's action) are the load-bearing correctness
   tests. Treat self-heal as a feature that can ship a release AFTER the honest-verdict + recovery-
   surfacing, if needed — the verdict/legibility win does not depend on auto-resume existing.

3. **`satisfied_when` stays ONE unified mechanism (task 5.3) — the simplicity constraint.** A single
   predicate over the next health snapshot, shared by all action kinds; `wait | code_fix |
   contact_support` carry `{ kind: "none" }`. If the build finds itself writing per-kind bespoke
   satisfaction logic, STOP and simplify — that fragmentation is the incidental-complexity smell
   (Hickey) that would un-earn the design's simplicity. Hold this line in review.

## Suggested dispatch shape (for the Codex conversation)

- **Dispatch A — "Stop the lies today" (phase 2).** Small, additive, independently shippable.
  Lands the 3 live-bug fixes immediately. Low risk, high user-visible value, no synthesizer.
- **Dispatch B — "The honest verdict" (phases 3, 4, 5, 6, 9, 10 + 12.2 golden fixtures).** The core:
  synthesizer + invariants + RequiredAction + refresh-contract + cascade/grant guards, pinned by the
  composite test and golden fixtures. 6.3 (runtime refresh trace) verified early.
- **Gate — shadow run (12.3).** Block on `unexpected_drift`.
- **Dispatch C — "Migrate the surfaces" (phase 8 + 12.4 DOM assertions).** Only after the gate.
- **Dispatch D — "Self-heal" (phase 7).** Separate, gated, highest-care. Optionally a later release.
- **Close — phases 11, 12.5, 13.1** (validation, calibration record, owner+Codex review).

## Open coordination question for Codex (RI owner)

Codex owns the RI and refined this change (the calibration gate). Before any build dispatch:
who drives the implementation, and is the dispatch decomposition above (A–D + gates) the right
shape? the owner wants to discuss with Codex before dispatch. No build has started.
