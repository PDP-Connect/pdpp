## Status

Superseded by `add-mock-reference-demo-instance`. Reconciled and archived with `--skip-specs` on 2026-05-28; this
delta does NOT mutate canonical specs.

This change captured the first attempt to replace placeholder sandbox copy with a scenario-first walkthrough. Owner
review rejected that as the primary product direction: `/sandbox` should behave like a mock-owner reference dashboard
backed by deterministic mock AS/RS data, with walkthrough/API examples as secondary support surfaces.

Reconciliation (2026-05-28): the three scenarios unique to this delta survive but are now canonical at a higher
altitude in `add-mock-reference-demo-instance` (archived `2026-05-28-add-mock-reference-demo-instance`):

- "A visitor completes a simulated flow" → `reference-demo-instance` requirement "Demo dashboard SHALL use the real
  dashboard experience in mock-owner mode", scenario "Visitor inspects control-plane evidence" (request, consent,
  scoped access, revocation, run success/failure timelines).
- "A visitor inspects integration shape" → `reference-demo-instance` requirement "Demo APIs SHALL be callable and
  share state with the UI".
- "A visitor resets the sandbox" → `reference-demo-instance` requirement "Demo state SHALL be safe, fictional,
  deterministic, and resettable", scenario "Visitor resets the demo".

The two non-unique scenarios ("A visitor opens the sandbox", "Sandbox UI reuses dashboard components") are already
canonical in `reference-surface-topology` in their newer superseding form. Because this delta targets the pre-rename
requirement title "A sandbox surface SHALL be mock-backed and pedagogical" (renamed by
`add-mock-reference-demo-instance`) and would duplicate already-canonical behavior, it is archived without applying
its spec delta.

## Why

`/sandbox` currently reads like a placeholder for work we intend to do. Public reviewers and prospective implementers need a concrete, useful surface that lets them experience PDPP with simulated data immediately, without connecting real accounts or running the reference stack.

## What Changes

- Replace the placeholder `/sandbox` page with a functional mock-backed product surface.
- Add seeded sandbox data for a small but realistic PDPP scenario: client request, owner consent, scoped grant, records/search, revocation, and refusal evidence.
- Make the sandbox resettable in-browser and clearly simulated without sounding like project planning.
- Add inspectable API-style request/response examples so visitors can understand what an app or agent would call.
- Link the sandbox back to `/reference/coverage`, `/reference`, and `/docs` as evidence, not as future-work copy.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-surface-topology`: strengthens the sandbox requirement from "mock-backed placeholder is acceptable" to "public sandbox SHALL provide at least one end-to-end simulated protocol walkthrough with inspectable state and reset semantics."

## Impact

- `apps/web/src/app/sandbox/**`
- Potential shared sandbox fixtures/components under `apps/web/src/components/**` or `apps/web/src/lib/**`
- `/reference/coverage` evidence links and notes if sandbox demonstration status changes
- No live reference API, no real credentials, no persistent server-side user data, and no protocol wire-format change
