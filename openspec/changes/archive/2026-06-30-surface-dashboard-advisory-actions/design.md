## Context

`tmp/workstreams/dashboard-status-ux-audit-v2-20260625.md` found live owner metadata with two owner-runnable advisory actions while the home Overview calm path could still dominate because only `channel: "attention"` enters the home attention bucket.

The underlying connection-health verdict model is correct to distinguish advisory work from urgent attention. The defect is the home summary collapsing advisory owner actions into either a subordinate "Anything wrong" row or a calm hero, instead of rendering a non-alarming review state.

## Decision

Treat owner-runnable advisory actions as a distinct home-summary category:

- `attentionConnections`: urgent owner action from `channel: "attention"`.
- `advisoryOwnerActions`: owner-runnable action from a non-attention verdict.
- `sourceIssueConnections`: maintainer/system issues and other degraded/cooling-off rows.

The hero should prioritize urgent attention first, then stale/failure projection states, then owner-runnable advisory actions, then calm. Advisory copy should avoid urgency and should route to source review rather than directly triggering connector mutation.

Source-list rows should expose a compact action cue when a row has an owner-runnable advisory action. Maintainer-only actions remain visibly non-owner-runnable.

## Alternatives

- Promote advisory owner actions to `attention`: rejected because it would over-alarm and violate the verdict channel semantics.
- Keep advisory actions only in the selected source detail: rejected because owners have to inspect each degraded row to discover whether they can act.
- Show raw retained-size/projection reasons on the home hero: rejected because current owner-safe copy is better and tests already protect it.

## Acceptance Checks

- A live-shaped Amazon `retry_gap` advisory action suppresses the calm hero without rendering urgent "needs you" copy.
- A live-shaped Reddit `refresh_now` advisory action appears in the home summary and in the source-list cue.
- Maintainer-only `code_fix` actions do not render as owner-runnable cues.
- Stale/failed projection hero copy remains owner-safe and does not include `projection`, `rebuild`, `bulk write`, `unknown connection`, or `SQL`.
- The stale `dashboard-summary-ux.test.ts` no longer protects a dead route shape.
