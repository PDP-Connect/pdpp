# Unify source-attention count and labels

## Why

The owner reported that the console misrepresents how many sources need attention and blurs the
attention categories:

- The dashboard hero says a small number of connections "need a look" while the rows rendered below it
  show more. The hero counts only the `needsOwner` work group, but the same view renders four groups
  (`needsOwner`, `review`, `systemIssue`, `checking`) below it, and the Runs/Syncs header counts a
  different, wider set. Two surfaces, two rollup rules, so the headline number never matches the rows.
- The four attention categories — "Needs you", "Worth reviewing", "System or connector issue",
  "Checking" — are hard to distinguish. Their labels and one-line explanations are re-authored per
  surface (dashboard sections, Syncs failure sections, per-item status strings), so they drift and the
  axis that separates them (who must act, and how urgent) is never stated to the owner.
- The credential-recovery copy is confusing: the rendered verdict tells the owner "Reconnect this
  account", but the connection-health remediation label still says "Reconnect or update the source
  credentials", reading as two different actions for one credential re-authorization.

The shared work-group projection already exists (`source-actionability.ts`), but the spec does not
require the *headline count* to equal its primary section, nor require the *group labels* to come from
one source, nor forbid a second credential-action string competing with the rendered verdict CTA. This
change closes those three gaps. It is deliberately scoped below the larger
`redesign-owner-console-product-experience` change, which owns the deeper Records/Runs/Sources merge.

## What Changes

- The owner-facing headline attention count SHALL equal the count of its own primary "needs you" work
  group, and the dashboard and Runs surfaces SHALL derive that headline count from one shared function.
  Non-urgent groups (review, system-issue, checking) render as clearly-secondary rows and SHALL NOT be
  summed into the headline "needs you" number.
- The four source-attention work-group labels and their one-line "who acts / how urgent" notes SHALL
  come from the shared actionability projection, so dashboard and Runs render identical category copy.
- The credential-rejection remediation label SHALL match the rendered verdict's single reconnect CTA
  instead of introducing a competing "reconnect or update" phrasing.

## Capabilities

- Modified: `reference-connection-health`

## Impact

- `apps/console/src/app/dashboard/lib/source-actionability.ts` — add shared headline-count and label model.
- `apps/console/src/app/dashboard/components/views/standing-view-model.ts` — hero + sections consume shared.
- `apps/console/src/app/dashboard/runs/syncs-model.ts`, `syncs-view.tsx` — band + labels consume shared.
- `reference-implementation/runtime/connection-health.ts` — align credential remediation label.
- Existing tests: `source-actionability.test.ts`, `standing-view-model.test.ts`, `syncs-model.test.ts`,
  `rendered-verdict.test.js`.
- No protocol, grant, manifest, or wire-format change. Owner-facing console copy and rollup semantics only.
