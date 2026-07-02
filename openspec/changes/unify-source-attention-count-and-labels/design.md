# Design — unify source-attention count and labels

## Problem, precisely

The console derives "how many sources need attention" in two incompatible ways and re-authors the
category copy per surface.

Verified in code (branch `waspflow/source-actionability-0702`):

- `standing-view-model.ts:1040` — the dashboard hero gates on and counts `sourceWork.needsOwner.length`
  and renders `${count} connections need a look`.
- `standing-view-model.ts:863-898` — the SAME dashboard view renders four titled sections below the
  hero: "Needs you", "Worth reviewing", "System or connector issue", "Checking". So the visible rows
  exceed the hero number whenever any non-`needsOwner` group is populated.
- `syncs-model.ts:481-482` — the Runs/Syncs band computes `needYourHand = needsOwner count` but the
  surfaced review number is `needsReview = failureCards.length`, i.e. ALL rendered cards
  (needsOwner + review + systemIssue + checking). The line-662 comment makes the intent explicit: "The
  band must count the failure cards that are actually RENDERED below it." So Runs deliberately counts a
  wider population than the dashboard hero.
- Category copy is authored three times: `standing-view-model.ts` section titles, `syncs-view.tsx`
  `FAILURE_SECTION_COPY`, and per-item `statusLabel` strings in `source-actionability.ts`. They already
  differ ("is ready for review" vs "Worth reviewing").
- `connection-health.ts:1744` emits remediation label "Reconnect or update the source credentials" for
  the `refresh_credentials` remediation, while `rendered-verdict.ts:776` emits CTA "Reconnect this
  account" for the same `reauth` action. The owner sees two different verbs for one recovery.

The shared model already exists: `source-actionability.ts` owns `SourceWorkGroupId` and
`sourceWorkFromConnectors`, and commits `9da74cb22` / `c9ce1d913` already unified the grouping and
projection. The remaining drift is (1) the rollup count meaning and (2) the label copy — not a second
taxonomy.

## Decision

Owner decision (2026-07-02): the ONE headline number means **"sources genuinely blocked on your
action"** = the `needsOwner` work group. The other three groups render as clearly-secondary rows under
a quieter heading and are NEVER summed into the headline "needs you" number. Both the dashboard hero
and the Runs header derive this number from one shared function so they cannot diverge.

This preserves the existing four-group axis (it maps cleanly to the server verdict `channel`:
attention → needsOwner, advisory+owner-runnable → review, maintainer/system → systemIssue, unknown →
checking). We are NOT collapsing the taxonomy — the task packet says do not overbuild taxonomy, and the
axis is sound; the defect is presentation consistency, not the model.

## What we build

1. **Shared headline count.** Add `sourceAttentionHeadline(groups)` (or equivalent) to
   `source-actionability.ts` returning the count and the single owner-facing meaning ("needs you" =
   `needsOwner.length`). `standing-view-model.ts` hero and `syncs-model.ts` band both call it. The Runs
   band keeps a separate, clearly-labeled secondary count for the wider "also worth reviewing" set, but
   the PRIMARY urgent number is the shared headline and equals the rendered "Needs you" section.

2. **Shared labels, action-first for the non-urgent group.** Move the four group labels + one-line axis
   notes into `source-actionability.ts` as a single exported map (`SOURCE_WORK_GROUP_COPY`), consumed by
   both `standing-view-model.ts` sections and `syncs-view.tsx`. State the axis in the note so the owner
   learns the distinction:
   - Needs you — "Requires your input before collection can continue."
   - Available actions — "Optional refreshes and retries you can start."
   - System or connector issue — "PDPP needs to fix or retry this; no account action is needed from you."
   - Checking — "PDPP is checking this source before asking you to do anything."

   Copy bar (owner, 2026-07-02): the owner-facing notes SHALL NOT say "reference" (product-facing name is
   PDPP), SHALL NOT use dramatic phrasing ("you are the only one who can clear it"), and SHALL stay
   neutral. Rows stay action-led (the review group shows the concrete CTA).

   Owner correction (2026-07-02): the non-urgent owner-action group must read as ACTUAL AVAILABLE
   ACTIONS, not a taxonomy label. The owner explicitly flagged "Amazon is ready for review" / "Worth
   reviewing" as confusing. So:
   - the group label is "Available actions" (not "Worth reviewing"), and
   - each row prefers the CONCRETE action label from the verdict CTA — "Amazon - Personal: Refresh now",
     "Chase - Personal: Retry now" — instead of "is ready for review". The advisory hero leads with the
     same concrete action ("Amazon - Personal: Retry now") rather than "One source is ready for review".
   The Runs `FailureCardPanel` already rendered the concrete `actionLabel` ("Refresh now"/"Retry now"),
   so this change mainly brings the dashboard rows and hero into line with what Runs already showed.
   The four-group MODEL is unchanged — only the review group's owner-facing COPY becomes action-first.

3. **Credential copy.** Change `connection-health.ts:1744` remediation label to "Reconnect this
   account", matching the rendered verdict CTA, so one credential rejection reads as one action.

## Alternatives considered

- **Sum all four groups into the headline** (what Runs does today): rejected by the owner — it inflates
  urgency by counting "Checking" and optional refreshes as things that "need a look".
- **Collapse four groups → two**: rejected — the four-way split maps to the verdict channel and the who-
  acts axis; collapsing loses information the owner asked us to make *clearer*, not remove. Out of scope.
- **Do the deeper Records/Runs/Sources merge here**: rejected — owned by
  `redesign-owner-console-product-experience` tasks 2.5/2.6, which are gated on an owner-reviewed mock.

## Out of scope

- Records/Explore vs stream-record view merge (redesign 2.6).
- Runs/Syncs vs Sources surface merge (redesign 2.5).
- Any change to the server verdict `channel`/`tone` computation. This change consumes the verdict as-is.

## Acceptance checks

Reproducible, no live run required:

1. `pnpm --filter @pdpp/console test` (or the repo's console test runner) passes, including updated
   `source-actionability.test.ts`, `standing-view-model.test.ts`, `syncs-model.test.ts`.
2. New/updated unit assertions:
   - Given connectors producing 1 needsOwner + ≥1 review + ≥1 systemIssue + ≥1 checking, the dashboard
     hero count == number of rows in the "Needs you" section (== needsOwner.length), and is strictly
     less than total rendered rows.
   - The dashboard hero headline number and the Runs band primary "needs you" number are equal for the
     same connector set (both call the shared function).
   - The four group labels rendered by the dashboard sections and by `syncs-view` are byte-identical to
     `SOURCE_WORK_GROUP_COPY`.
   - `computeConnectionHealth` for a rejected credential emits remediation label "Reconnect this
     account" and no surface emits "Reconnect or update".
3. `openspec validate unify-source-attention-count-and-labels --strict` passes.
4. Owner-visible check on a running console (owner-only, may be converted to a Residual Risk if it can
   only be run by the owner): dashboard hero number equals the count of "Needs you" rows, and the
   category headings match between the dashboard and the Runs page.
