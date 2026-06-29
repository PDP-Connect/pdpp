## Design

The server-owned `RefConnectorSummary.rendered_verdict` remains the source of truth. The console adds one pure dashboard-local projection in `apps/console/src/app/dashboard/lib/source-actionability.ts` for the cross-surface facts that are easy to drift:

- whether the primary action is owner-satisfiable,
- whether the verdict requires owner action now,
- status flag derived from verdict pill plus freshness annotations,
- source-work group (`needsOwner`, `review`, `systemIssue`, `checking`),
- stream actionability by `action_ref`.

Surfaces still own their layouts. Runs still merges `_ref/runs` with connector summaries. Schedules still owns schedule editing. Source detail still owns diagnostics. Those surfaces should call the shared projection when they need source actionability semantics instead of reading `required_actions[0]` or status tones ad hoc.

## Alternatives

- Server-side grouping endpoint: rejected for this tranche. The server already returns the necessary typed verdict. The drift is in console projection code, so the smallest correct fix is a shared console projection.
- One renderer for every surface: rejected. Overview, Sources, Runs, Schedules, and source detail have different layouts and data joins. Forcing one renderer would be shallow abstraction. The shared layer should own semantics, not presentation.

## Acceptance Checks

- Overview source groups still show owner-required, review, system, and checking rows with scoped counts.
- Sources list status/action cues derive from the same projection helpers as Overview.
- Runs ranking and “need your hand” counts derive owner-required semantics from the same projection.
- Runs action cards are visibly sectioned by the same source-work groups used by Overview and Sources.
- Connection detail stream owner-action availability and primary action display use the same owner-satisfiable predicate.
- Tests cover a maintainer-primary `attention` verdict so it cannot be counted as owner-required on any surface.
