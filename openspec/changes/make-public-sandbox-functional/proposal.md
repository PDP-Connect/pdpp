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
